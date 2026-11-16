import { randomBytes } from 'node:crypto';
import {
  binToHex,
  createVirtualMachineBch,
  encodeTransactionCommon,
} from '@bitauth/libauth';
import {
  addressBytecode,
  decodeTransaction,
  isP2pkh,
  sameOutput,
  serializeOutput,
  transactionId,
  utxoOutput,
} from '../../src/shared/bitcoin.js';
import { outpointKey } from '../../src/shared/cycles.js';
import { DomainError } from '../../src/shared/errors.js';
import type {
  AddressPath,
  Network,
  NetworkStatus,
  WalletUtxo,
} from '../../src/shared/types.js';
import type { Chain, TransactionObservation } from '../../src/server/chain.js';
import type { TestActor } from './actors.js';

export function barrier() {
  let entered!: () => void;
  let release!: () => void;
  let fail!: (error: Error) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return {
    entered: started,
    release,
    fail,
    wait: async () => {
      entered();
      await blocked;
    },
  };
}

export class FixtureChain implements Chain {
  readonly utxos = new Map<string, WalletUtxo>();
  readonly rawTransactions = new Map<string, string>();
  readonly broadcasts: string[] = [];
  readonly confirmations = new Map<string, number>();
  broadcastMode:
    'ok' | 'timeout_before_acceptance' | 'timeout_after_acceptance' = 'ok';
  verifyBarrier?: ReturnType<typeof barrier>;
  broadcastBarrier?: ReturnType<typeof barrier>;
  private readonly vm = createVirtualMachineBch();

  addActors(actors: readonly TestActor[], extraNft = false): void {
    for (const actor of actors) {
      const outputs = [utxoOutput(actor.nft), utxoOutput(actor.funding[0]!)];
      if (extraNft) outputs.push(utxoOutput(actor.nft));
      const raw = binToHex(
        encodeTransactionCommon({
          version: 2,
          locktime: 0,
          inputs: [
            {
              outpointTransactionHash: Uint8Array.from(randomBytes(32)),
              outpointIndex: 0,
              sequenceNumber: 0xffffffff,
              unlockingBytecode: Uint8Array.of(0),
            },
          ],
          outputs,
        }),
      );
      const txid = transactionId(raw);
      actor.nft.txid = txid;
      actor.funding[0]!.txid = txid;
      actor.funding[0]!.vout = 1;
      actor.offer.asset = { ...actor.offer.asset, txid, vout: 0 };
      this.utxos.set(outpointKey(actor.nft), structuredClone(actor.nft));
      this.utxos.set(
        outpointKey(actor.funding[0]!),
        structuredClone(actor.funding[0]!),
      );
      if (extraNft) {
        const extra = { ...structuredClone(actor.nft), vout: 2 };
        this.utxos.set(outpointKey(extra), extra);
      }
      this.rawTransactions.set(txid, raw);
    }
  }

  async getUtxos(
    network: Network,
    paths: readonly AddressPath[],
  ): Promise<WalletUtxo[]> {
    const result: WalletUtxo[] = [];
    for (const path of paths) {
      const bytecode = binToHex(addressBytecode(path.address, network));
      for (const utxo of this.utxos.values()) {
        if (utxo.lockingBytecode === bytecode)
          result.push({ ...structuredClone(utxo), ...path });
      }
    }
    return result;
  }

  async verifyUtxos(
    network: Network,
    expected: readonly WalletUtxo[],
  ): Promise<void> {
    if (this.verifyBarrier) {
      const gate = this.verifyBarrier;
      this.verifyBarrier = undefined;
      await gate.wait();
    }
    for (const utxo of expected) {
      addressBytecode(utxo.address, network);
      const fresh = this.utxos.get(outpointKey(utxo));
      if (!fresh)
        throw new DomainError(
          'INPUT_SPENT',
          'A selected input has been spent.',
          409,
          utxo,
        );
      const raw = this.rawTransactions.get(utxo.txid);
      const source =
        raw && decodeTransaction(raw, 1_000_000).outputs[utxo.vout];
      if (
        !source ||
        transactionId(raw!) !== utxo.txid ||
        !sameOutput(source, utxoOutput(utxo)) ||
        !sameOutput(source, utxoOutput(fresh))
      ) {
        throw new DomainError(
          'SOURCE_MISMATCH',
          'The source output is inconsistent.',
          409,
          utxo,
        );
      }
    }
  }

  async broadcast(_network: Network, raw: string): Promise<string> {
    this.broadcasts.push(raw);
    if (this.broadcastMode === 'timeout_before_acceptance')
      throw new Error('https://node.invalid?apikey=DO_NOT_LEAK');
    const transaction = decodeTransaction(raw);
    const sourceOutputs = transaction.inputs.map((input) => {
      const utxo = this.utxos.get(
        `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
      );
      if (!utxo) throw new Error('Input is already spent.');
      return utxoOutput(utxo);
    });
    const result = this.vm.verify({ transaction, sourceOutputs });
    if (result !== true)
      throw new Error(
        `Fixture ledger rejected the actual transaction: ${result}`,
      );
    const txid = transactionId(raw);
    for (const input of transaction.inputs) {
      this.utxos.delete(
        `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
      );
    }
    transaction.outputs.forEach((output, vout) => {
      if (!isP2pkh(output.lockingBytecode)) return;
      const serialized = serializeOutput(output);
      this.utxos.set(`${txid}:${vout}`, {
        txid,
        vout,
        address: '',
        path: 'receive',
        index: 0,
        satoshis: serialized.valueSatoshis,
        lockingBytecode: serialized.lockingBytecode,
        ...(serialized.token && { token: serialized.token }),
      });
    });
    this.rawTransactions.set(txid, raw);
    this.confirmations.set(txid, 0);
    if (this.broadcastBarrier) {
      const gate = this.broadcastBarrier;
      this.broadcastBarrier = undefined;
      await gate.wait();
    }
    if (this.broadcastMode === 'timeout_after_acceptance')
      throw new Error('https://node.invalid?apikey=DO_NOT_LEAK');
    return txid;
  }

  async observe(
    network: Network,
    txid: string,
    addresses: readonly string[],
  ): Promise<TransactionObservation> {
    const confirmations = this.confirmations.get(txid);
    const raw = this.rawTransactions.get(txid);
    if (confirmations === undefined || !raw)
      return { found: false, confirmations: 0 };
    const bytecodes = new Set(
      addresses.map((address) => binToHex(addressBytecode(address, network))),
    );
    const found = decodeTransaction(raw).outputs.some((output) =>
      bytecodes.has(binToHex(output.lockingBytecode)),
    );
    return { found, confirmations: found ? confirmations : 0 };
  }

  async health(network: Network): Promise<NetworkStatus> {
    return {
      network,
      available: true,
      blockHeight: 890_000,
      checkedAt: Date.now(),
    };
  }
}
