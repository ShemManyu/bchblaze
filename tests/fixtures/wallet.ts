import { randomBytes } from 'node:crypto';
import {
  binToHex,
  deriveHdPath,
  deriveHdPathRelative,
  deriveHdPrivateNodeFromSeed,
  deriveHdPublicNode,
  encodeDataPush,
  encodeHdPublicKey,
  encodeTransactionCommon,
  generateSigningSerializationBch,
  secp256k1,
  sha256,
  type HdPrivateNodeValid,
  type Output,
} from '@bitauth/libauth';
import {
  toBigInt,
  toUint8Array,
  type SignTransactionRequest,
} from '@wizardconnect/core';
import {
  DerivationPath,
  WalletConnectionManager,
  type WalletAdapter,
} from '@wizardconnect/wallet';
import { generateSecretKey } from 'nostr-tools';
import {
  decodeTransaction,
  publicKeyBytecode,
  tokenAddress,
} from '../../src/shared/bitcoin.js';
import type { Network } from '../../src/shared/types.js';
import { testActors, type TestActor } from './actors.js';

export interface HdActor extends TestActor {
  account: HdPrivateNodeValid;
}

const privateChild = (
  account: HdPrivateNodeValid,
  path: number,
  index: number,
) => deriveHdPathRelative(account, `${path}/${index}`).privateKey;

export function hdActors(
  network: Network = 'chipnet',
): [HdActor, HdActor, HdActor] {
  return testActors().map((actor) => {
    const master = deriveHdPrivateNodeFromSeed(
      Uint8Array.from(randomBytes(32)),
    );
    const account = deriveHdPath(master, "m/44'/145'/0'");
    const address = (path: number, index: number) => {
      const publicKey = secp256k1.derivePublicKeyCompressed(
        privateChild(account, path, index),
      );
      if (typeof publicKey === 'string')
        throw new Error('Test wallet derivation failed.');
      const bytecode = publicKeyBytecode(publicKey);
      return {
        address: tokenAddress(bytecode, network),
        lockingBytecode: binToHex(bytecode),
      };
    };
    const nft = {
      ...actor.nft,
      ...address(0, 3),
      path: 'receive' as const,
      index: 3,
    };
    const funding = [
      {
        ...actor.funding[0]!,
        ...address(1, 2),
        path: 'change' as const,
        index: 2,
      },
    ];
    return {
      ...actor,
      account,
      privateKey: privateChild(account, 0, 3),
      nft,
      funding,
      offer: { ...actor.offer, network, receiveAddress: address(0, 0).address },
    };
  }) as [HdActor, HdActor, HdActor];
}

const pathIndex = (name: string) => {
  if (name === 'receive') return 0;
  if (name === 'change') return 1;
  if (name === 'defi') return 7;
  throw new Error('Unsupported test wallet path.');
};

export class FixtureWallet implements WalletAdapter {
  readonly walletName: string;
  readonly walletIcon = '';
  readonly requests: SignTransactionRequest[] = [];
  rejectNext = false;
  private readonly relayKeys = new Map<string, Uint8Array>();

  constructor(public readonly actor: HdActor) {
    this.walletName = `Fixture ${actor.offer.label}`;
  }

  getRelayPrivateKey(uri: string): Uint8Array {
    if (!this.relayKeys.has(uri)) this.relayKeys.set(uri, generateSecretKey());
    return this.relayKeys.get(uri)!;
  }

  getPublicKey(path: DerivationPath, index: bigint): Uint8Array {
    const publicKey = secp256k1.derivePublicKeyCompressed(
      privateChild(this.actor.account, path, Number(index)),
    );
    if (typeof publicKey === 'string')
      throw new Error('Test wallet derivation failed.');
    return publicKey;
  }

  getXpub(path: DerivationPath): string {
    return encodeHdPublicKey({
      network: 'mainnet',
      node: deriveHdPublicNode(
        deriveHdPathRelative(this.actor.account, String(path)),
      ),
    }).hdPublicKey;
  }

  async signTransaction(
    request: SignTransactionRequest,
  ): Promise<{ signedTransaction: string }> {
    this.requests.push(request);
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error('Test user declined.');
    }
    if (
      request.transaction.broadcast !== false ||
      typeof request.transaction.transaction !== 'string'
    ) {
      throw new Error(
        'Test wallet refuses automatic broadcast or an unsupported transaction encoding.',
      );
    }
    const transaction = decodeTransaction(request.transaction.transaction);
    const sourceOutputs: Output[] = request.transaction.sourceOutputs.map(
      (source) => ({
        valueSatoshis: toBigInt(source.valueSatoshis),
        lockingBytecode: toUint8Array(source.lockingBytecode),
        ...(source.token && {
          token: {
            category: toUint8Array(source.token.category),
            amount: toBigInt(source.token.amount),
            ...(source.token.nft && {
              nft: {
                capability: source.token.nft.capability,
                commitment: toUint8Array(source.token.nft.commitment),
              },
            }),
          },
        }),
      }),
    );
    for (const [inputIndex, path, index] of request.inputPaths) {
      const privateKey = privateChild(
        this.actor.account,
        pathIndex(path),
        index,
      );
      const publicKey = this.getPublicKey(pathIndex(path), BigInt(index));
      if (
        binToHex(publicKeyBytecode(publicKey)) !==
        binToHex(sourceOutputs[inputIndex]!.lockingBytecode)
      ) {
        throw new Error('Test wallet refuses a foreign input.');
      }
      const serialization = generateSigningSerializationBch(
        { inputIndex, transaction, sourceOutputs },
        {
          coveredBytecode: sourceOutputs[inputIndex]!.lockingBytecode,
          signingSerializationType: Uint8Array.of(0x61),
        },
      );
      const signature = secp256k1.signMessageHashSchnorr(
        privateKey,
        sha256.hash(sha256.hash(serialization)),
      );
      if (typeof signature === 'string')
        throw new Error('Test wallet could not sign.');
      transaction.inputs[inputIndex]!.unlockingBytecode = Uint8Array.from([
        ...encodeDataPush(Uint8Array.from([...signature, 0x61])),
        ...encodeDataPush(publicKey),
      ]);
    }
    return {
      signedTransaction: binToHex(encodeTransactionCommon(transaction)),
    };
  }
}

export function fixtureWalletHost(actor: HdActor) {
  const adapter = new FixtureWallet(actor);
  const manager = new WalletConnectionManager(adapter);
  manager.on('pendingSignRequest', (pending) => {
    void (async () => {
      try {
        const result = await adapter.signTransaction(pending.request);
        await manager.sendSignResponse(
          pending.connectionId,
          pending.request.sequence,
          result.signedTransaction,
        );
      } catch {
        await manager.sendSignError(
          pending.connectionId,
          pending.request.sequence,
          'Test wallet declined the request.',
        );
      }
    })();
  });
  return { adapter, manager };
}
