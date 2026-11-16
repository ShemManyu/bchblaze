import { binToHex, sha256 } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';
import {
  addressBytecode,
  decodeTransaction,
  sameOutput,
  transactionId,
  utxoOutput,
} from '../shared/bitcoin.js';
import { outpointKey } from '../shared/cycles.js';
import { DomainError } from '../shared/errors.js';
import type {
  AddressPath,
  Network,
  NetworkStatus,
  WalletUtxo,
} from '../shared/types.js';

export interface TransactionObservation {
  found: boolean;
  confirmations: number;
}

export interface Chain {
  getUtxos(
    network: Network,
    paths: readonly AddressPath[],
  ): Promise<WalletUtxo[]>;
  verifyUtxos(network: Network, utxos: readonly WalletUtxo[]): Promise<void>;
  broadcast(network: Network, signedHex: string): Promise<string>;
  observe(
    network: Network,
    txid: string,
    addresses: readonly string[],
  ): Promise<TransactionObservation>;
  health(network: Network): Promise<NetworkStatus>;
}

async function networkRequest<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DomainError(
                'NETWORK_UNAVAILABLE',
                'The BCH node did not respond. Try again.',
                503,
              ),
            ),
          15_000,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'NETWORK_UNAVAILABLE',
      'The BCH node is unavailable. No replacement transaction was created.',
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}

export class ElectrumChain implements Chain {
  private readonly providers: Record<Network, ElectrumNetworkProvider>;
  private readonly rawTransactions = new Map<string, string>();

  constructor(private readonly hosts: Partial<Record<Network, string>> = {}) {
    this.providers = {
      chipnet: new ElectrumNetworkProvider(
        'chipnet',
        hosts.chipnet ? { hostname: hosts.chipnet } : {},
      ),
      mainnet: new ElectrumNetworkProvider(
        'mainnet',
        hosts.mainnet ? { hostname: hosts.mainnet } : {},
      ),
    };
  }

  async getUtxos(
    network: Network,
    paths: readonly AddressPath[],
  ): Promise<WalletUtxo[]> {
    const result: WalletUtxo[] = [];
    const provider = new ElectrumNetworkProvider(network, {
      manualConnectionManagement: true,
      ...(this.hosts[network] ? { hostname: this.hosts[network]! } : {}),
    });
    try {
      await networkRequest(provider.connect());
      for (let index = 0; index < paths.length; index += 4) {
        const group = await Promise.all(
          paths.slice(index, index + 4).map(async (path) => ({
            path,
            utxos: await networkRequest(provider.getUtxos(path.address)),
          })),
        );
        for (const { path, utxos } of group) {
          const expectedBytecode = binToHex(
            addressBytecode(path.address, network),
          );
          for (const utxo of utxos) {
            if (utxo.lockingBytecode !== expectedBytecode) {
              throw new DomainError(
                'NODE_INCONSISTENCY',
                'The node returned an output for a different address.',
                503,
              );
            }
            result.push({
              ...path,
              txid: utxo.txid.toLowerCase(),
              vout: utxo.vout,
              satoshis: utxo.satoshis.toString(),
              lockingBytecode: utxo.lockingBytecode,
              ...(utxo.token && {
                token: {
                  category: utxo.token.category.toLowerCase(),
                  amount: utxo.token.amount.toString(),
                  ...(utxo.token.nft && { nft: { ...utxo.token.nft } }),
                },
              }),
            });
          }
        }
      }
      return result;
    } finally {
      await networkRequest(provider.disconnect()).catch(() => undefined);
    }
  }

  private async rawTransaction(
    network: Network,
    txid: string,
  ): Promise<string> {
    const key = `${network}:${txid}`;
    const cached = this.rawTransactions.get(key);
    if (cached) return cached;
    const hex = await networkRequest(
      this.providers[network].getRawTransaction(txid),
    );
    decodeTransaction(hex, 1_000_000);
    if (transactionId(hex) !== txid) {
      throw new DomainError(
        'NODE_INCONSISTENCY',
        'The source transaction does not match its transaction ID.',
        503,
      );
    }
    if (this.rawTransactions.size >= 1_000) {
      this.rawTransactions.delete(this.rawTransactions.keys().next().value!);
    }
    this.rawTransactions.set(key, hex);
    return hex;
  }

  async verifyUtxos(
    network: Network,
    utxos: readonly WalletUtxo[],
  ): Promise<void> {
    const paths = [
      ...new Map(
        utxos.map((utxo) => [
          utxo.address,
          {
            address: utxo.address,
            path: utxo.path,
            index: utxo.index,
          },
        ]),
      ).values(),
    ];
    const fresh = new Map(
      (await this.getUtxos(network, paths)).map((utxo) => [
        outpointKey(utxo),
        utxo,
      ]),
    );
    for (const expected of utxos) {
      const actual = fresh.get(outpointKey(expected));
      if (!actual) {
        throw new DomainError(
          'INPUT_SPENT',
          'An NFT or fee input has already been spent. This circle cannot be signed.',
          409,
          { txid: expected.txid, vout: expected.vout },
        );
      }
      const transaction = decodeTransaction(
        await this.rawTransaction(network, actual.txid),
        1_000_000,
      );
      const source = transaction.outputs[actual.vout];
      if (
        !source ||
        !sameOutput(source, utxoOutput(actual)) ||
        !sameOutput(source, utxoOutput(expected))
      ) {
        throw new DomainError(
          'SOURCE_MISMATCH',
          'The selected input does not match the actual source transaction.',
          409,
          { txid: expected.txid, vout: expected.vout },
        );
      }
      const firstInput = transaction.inputs[0];
      if (
        firstInput?.outpointIndex === 0xffffffff &&
        firstInput.outpointTransactionHash.every((value) => value === 0)
      ) {
        const observation = await this.observe(network, actual.txid, [
          actual.address,
        ]);
        if (observation.confirmations < 100) {
          throw new DomainError(
            'IMMATURE_COINBASE',
            'Mining rewards need 100 confirmations before they can fund a circle.',
            409,
          );
        }
      }
    }
  }

  async broadcast(network: Network, signedHex: string): Promise<string> {
    const expected = transactionId(signedHex);
    const returned = await networkRequest(
      this.providers[network].sendRawTransaction(signedHex),
    );
    if (returned.toLowerCase() !== expected) {
      throw new DomainError(
        'BROADCAST_UNCERTAIN',
        'The node returned an unexpected transaction ID.',
        503,
      );
    }
    return expected;
  }

  async observe(
    network: Network,
    txid: string,
    addresses: readonly string[],
  ): Promise<TransactionObservation> {
    const heights: number[] = [];
    for (const address of new Set(addresses)) {
      const hash = binToHex(
        sha256.hash(addressBytecode(address, network)).slice().reverse(),
      );
      const history = await networkRequest(
        this.providers[network].performRequest(
          'blockchain.scripthash.get_history',
          hash,
        ),
      );
      if (!Array.isArray(history)) {
        throw new DomainError(
          'NODE_INCONSISTENCY',
          'The node returned an invalid transaction history.',
          503,
        );
      }
      for (const entry of history) {
        if (
          entry &&
          typeof entry === 'object' &&
          'tx_hash' in entry &&
          entry.tx_hash === txid &&
          'height' in entry &&
          typeof entry.height === 'number' &&
          Number.isInteger(entry.height)
        ) {
          heights.push(Math.max(0, entry.height));
        }
      }
    }
    if (heights.length === 0) return { found: false, confirmations: 0 };
    if (heights.some((height) => height === 0))
      return { found: true, confirmations: 0 };
    const tip = await networkRequest(this.providers[network].getBlockHeight());
    return {
      found: true,
      confirmations: Math.max(0, tip - Math.max(...heights) + 1),
    };
  }

  async health(network: Network): Promise<NetworkStatus> {
    try {
      const blockHeight = await networkRequest(
        this.providers[network].getBlockHeight(),
      );
      return { network, available: true, blockHeight, checkedAt: Date.now() };
    } catch {
      return { network, available: false, checkedAt: Date.now() };
    }
  }
}
