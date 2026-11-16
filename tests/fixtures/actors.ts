import { randomBytes } from 'node:crypto';
import {
  binToHex,
  encodeDataPush,
  encodeTransactionCommon,
  generateSigningSerializationBch,
  secp256k1,
  sha256,
} from '@bitauth/libauth';
import {
  decodeTransaction,
  deserializeOutput,
  publicKeyBytecode,
  tokenAddress,
} from '../../src/shared/bitcoin.js';
import { buildSwap, type SwapActor } from '../../src/shared/transactions.js';
import type {
  Offer,
  SwapProposal,
  WalletUtxo,
} from '../../src/shared/types.js';

export interface TestActor extends SwapActor {
  privateKey: Uint8Array;
}

export function testActors(): [TestActor, TestActor, TestActor] {
  const categories = [0, 1, 2].map(() => binToHex(randomBytes(32)));
  const actors = ['Alice', 'Bob', 'Carol'].map((label, index) => {
    const privateKey = Uint8Array.from(randomBytes(32));
    const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
    if (typeof publicKey === 'string') throw new Error(publicKey);
    const bytecode = publicKeyBytecode(publicKey);
    const address = tokenAddress(bytecode, 'chipnet');
    const nft: WalletUtxo = {
      txid: binToHex(randomBytes(32)),
      vout: 0,
      address,
      path: 'receive',
      index: 0,
      lockingBytecode: binToHex(bytecode),
      satoshis: '1000',
      token: {
        category: categories[index]!,
        amount: '0',
        nft: { capability: 'none', commitment: '01' },
      },
    };
    const funding: WalletUtxo = {
      ...nft,
      txid: binToHex(randomBytes(32)),
      token: undefined,
      satoshis: '10000',
    };
    const offer: Offer = {
      id: label.toLowerCase(),
      label,
      network: 'chipnet',
      receiveAddress: address,
      asset: {
        txid: nft.txid,
        vout: nft.vout,
        category: nft.token!.category,
        commitment: '01',
      },
      wanted: {
        category: categories[(index + 1) % 3]!,
        commitment: '01',
      },
      status: 'open',
      createdAt: 0,
      expiresAt: Date.now() + 86_400_000,
    };
    return { privateKey, offer, nft, funding: [funding] };
  });
  return actors as [TestActor, TestActor, TestActor];
}

export function signActor(
  proposal: SwapProposal,
  actor: TestActor,
  flags = 0x61,
  candidateHex = proposal.unsignedTransaction,
): string {
  const transaction = decodeTransaction(candidateHex);
  const sourceOutputs = proposal.sourceOutputs.map(deserializeOutput);
  const participant = proposal.participants.find(
    (value) => value.offerId === actor.offer.id,
  )!;
  for (const inputIndex of participant.inputIndexes) {
    const serialization = generateSigningSerializationBch(
      { inputIndex, transaction, sourceOutputs },
      {
        coveredBytecode: sourceOutputs[inputIndex]!.lockingBytecode,
        signingSerializationType: Uint8Array.of(flags),
      },
    );
    const hash = sha256.hash(sha256.hash(serialization));
    const signature = secp256k1.signMessageHashSchnorr(actor.privateKey, hash);
    const publicKey = secp256k1.derivePublicKeyCompressed(actor.privateKey);
    if (typeof signature === 'string' || typeof publicKey === 'string') {
      throw new Error('Could not sign the test transaction.');
    }
    transaction.inputs[inputIndex]!.unlockingBytecode = Uint8Array.from([
      ...encodeDataPush(Uint8Array.from([...signature, flags])),
      ...encodeDataPush(publicKey),
    ]);
  }
  return binToHex(encodeTransactionCommon(transaction));
}

export function signedFixture() {
  const actors = testActors();
  const proposal = buildSwap(actors);
  const signatures = Object.fromEntries(
    actors.map((actor) => [actor.offer.id, signActor(proposal, actor)]),
  );
  return { actors, proposal, signatures };
}
