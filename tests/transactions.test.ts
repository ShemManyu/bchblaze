import {
  binToHex,
  createVirtualMachineBch,
  encodeTransactionCommon,
  lockingBytecodeToCashAddress,
  hexToBin,
} from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { decodeTransaction, deserializeOutput } from '../src/shared/bitcoin.js';
import {
  assertSameTransactionTemplate,
  buildSwap,
  mergeSignatures,
  proposalFingerprint,
  validatePartialSignature,
  validateProposal,
} from '../src/shared/transactions.js';
import { signActor, signedFixture, testActors } from './fixtures/actors.js';

describe('real BCH CashTokens settlement', () => {
  it('combines three independently signed responses into a consensus-valid transaction', () => {
    const { proposal, signatures } = signedFixture();
    const finalHex = mergeSignatures(proposal, signatures);
    const transaction = decodeTransaction(finalHex);
    expect(
      createVirtualMachineBch().verify({
        transaction,
        sourceOutputs: proposal.sourceOutputs.map(deserializeOutput),
      }),
    ).toBe(true);
    expect(
      transaction.outputs
        .filter((output) => output.token)
        .map((output) => binToHex(output.token!.category)),
    ).toEqual(proposal.participants.map((value) => value.sendAsset.category));
    expect(proposal.feeSatoshis).toBe('3000');
  });

  it('cannot settle with only two approvals', () => {
    const { proposal, signatures } = signedFixture();
    delete signatures.carol;
    expect(() => mergeSignatures(proposal, signatures)).toThrow(
      'All three participants must approve',
    );
  });

  it('cannot reuse approvals in another room with the same assets and recipients', () => {
    const { actors, signatures } = signedFixture();
    const anotherRoom = buildSwap(actors);
    expect(() => mergeSignatures(anotherRoom, signatures)).toThrow(
      'changed the approved transaction',
    );
  });

  it('recognizes the same receiving script despite different CashAddress encodings', () => {
    const actors = testActors();
    const alternate = lockingBytecodeToCashAddress({
      bytecode: hexToBin(actors[0].nft.lockingBytecode),
      prefix: 'bchtest',
      tokenSupport: false,
    });
    if (typeof alternate === 'string') throw new Error(alternate);
    actors[2].offer.receiveAddress = alternate.address;
    expect(() => buildSwap(actors)).toThrow('distinct receiving addresses');
  });

  it('rejects negative source values before asking a wallet to approve', () => {
    const actors = testActors();
    actors[0].nft.satoshis = '-1';
    expect(() => buildSwap(actors)).toThrow('source output');
  });

  it('rejects invalid derivation paths even when the transaction is unchanged', () => {
    const proposal = buildSwap(testActors());
    proposal.participants[0].inputPaths[0]![2] = -1;
    expect(() => validateProposal(proposal)).toThrow('exactly one participant');
  });

  it('rejects a changed transaction template even when the wallet signs it again', () => {
    const { actors, proposal } = signedFixture();
    const changed = decodeTransaction(proposal.unsignedTransaction);
    changed.outputs[0]!.lockingBytecode = changed.outputs[1]!.lockingBytecode;
    const changedHex = binToHex(encodeTransactionCommon(changed));
    const signed = signActor(proposal, actors[0], 0x61, changedHex);
    expect(() =>
      assertSameTransactionTemplate(proposal.unsignedTransaction, signed),
    ).toThrow('changed the approved transaction');
    expect(() =>
      validatePartialSignature(proposal, actors[0].offer.id, signed),
    ).toThrow('changed the approved transaction');
  });

  it('rejects otherwise-valid signatures without SIGHASH_UTXOS', () => {
    const actors = testActors();
    const proposal = buildSwap(actors);
    const legacySignature = signActor(proposal, actors[0], 0x41);
    const vm = createVirtualMachineBch();
    for (const inputIndex of proposal.participants[0].inputIndexes) {
      expect(
        vm.stateSuccess(
          vm.evaluate({
            inputIndex,
            transaction: decodeTransaction(legacySignature),
            sourceOutputs: proposal.sourceOutputs.map(deserializeOutput),
          }),
        ),
      ).toBe(true);
    }
    expect(() =>
      validatePartialSignature(proposal, actors[0].offer.id, legacySignature),
    ).toThrow('SIGHASH_UTXOS');
  });

  it('does not accept a wallet signing another participant input', () => {
    const { proposal, signatures } = signedFixture();
    const allSigned = mergeSignatures(proposal, signatures);
    expect(() =>
      validatePartialSignature(proposal, 'alice', allSigned),
    ).toThrow('only fill its assigned input');
  });

  it('rejects the wrong private key instead of recording a false approval', () => {
    const actors = testActors();
    const proposal = buildSwap(actors);
    const wrongKeyActor = {
      ...actors[0],
      privateKey: actors[1].privateKey,
    };
    expect(() =>
      validatePartialSignature(
        proposal,
        'alice',
        signActor(proposal, wrongKeyActor),
      ),
    ).toThrow('does not authorize');
  });

  it('returns BCH attached to an NFT rather than giving it to the NFT recipient', () => {
    const actors = testActors();
    actors[0].nft.satoshis = '5000000000';
    const proposal = buildSwap(actors);
    expect(proposal.participants[0].changeSatoshis).toBe('4999998000');
    expect(proposal.participants[0].feeSatoshis).toBe('1000');
    expect(
      decodeTransaction(proposal.unsignedTransaction).outputs[0]!.valueSatoshis,
    ).toBe(1000n);
  });

  it('excludes minting rights and attached fungible balances', () => {
    const actors = testActors();
    actors[0].nft.token!.nft!.capability = 'minting';
    expect(() => buildSwap(actors)).toThrow('immutable NFT');
    actors[0].nft.token!.nft!.capability = 'none';
    actors[0].nft.token!.amount = '2';
    expect(() => buildSwap(actors)).toThrow('immutable NFT');
  });

  it('never spends fungible token outputs to fund transaction fees', () => {
    const actors = testActors();
    actors[0].funding[0]!.token = {
      category: 'd'.repeat(64),
      amount: '100',
    };
    expect(() => buildSwap(actors)).toThrow(
      'Token-bearing UTXOs are never used',
    );
  });

  it('independently rejects hidden output changes even if the coordinator recomputes its fingerprint', () => {
    const { proposal } = signedFixture();
    const changed = decodeTransaction(proposal.unsignedTransaction);
    changed.outputs[0]!.valueSatoshis = 2000n;
    proposal.unsignedTransaction = binToHex(encodeTransactionCommon(changed));
    proposal.fingerprint = proposalFingerprint(proposal);
    expect(() => validateProposal(proposal)).toThrow(
      'changes approved outputs',
    );
  });

  it('does not let fabricated receive metadata disguise a different NFT', () => {
    const actors = testActors();
    const proposal = buildSwap(actors);
    actors[0].offer.wanted.category = 'd'.repeat(64);
    proposal.participants[0].receiveAsset = {
      ...proposal.participants[0].receiveAsset,
      category: actors[0].offer.wanted.category,
    };
    expect(() =>
      validateProposal(
        proposal,
        actors.map((actor) => actor.offer),
      ),
    ).toThrow('received NFT');
  });

  it('keeps approvals invalid after any output is altered', () => {
    const { proposal, signatures } = signedFixture();
    const finalHex = mergeSignatures(proposal, signatures);
    const transaction = decodeTransaction(finalHex);
    transaction.outputs[0]!.lockingBytecode =
      transaction.outputs[1]!.lockingBytecode;
    expect(
      createVirtualMachineBch().verify({
        transaction,
        sourceOutputs: proposal.sourceOutputs.map(deserializeOutput),
      }),
    ).not.toBe(true);
  });
});
