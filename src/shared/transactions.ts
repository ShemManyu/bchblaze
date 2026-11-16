import {
  binToHex,
  createVirtualMachineBch,
  encodeDataPush,
  encodeTransactionCommon,
  sha256,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import {
  addressBytecode,
  assertCondition,
  bytes,
  decodeTransaction,
  deserializeOutput,
  isP2pkh,
  nftAsset,
  sameOutput,
  serializeOutput,
  utxoOutput,
} from './bitcoin.js';
import { matchesWanted, outpointKey } from './cycles.js';
import { DomainError } from './errors.js';
import type {
  Offer,
  ProposalParticipant,
  SwapProposal,
  WalletUtxo,
} from './types.js';

export interface SwapActor {
  offer: Offer;
  nft: WalletUtxo;
  funding: WalletUtxo[];
}

const NFT_SATOSHIS = 1_000n;
const BASE_FEE_SATOSHIS = 1_000n;
const CHANGE_DUST = 546n;
const MAX_PARTICIPANT_FEE = 2_000n;
const MAX_INPUTS_PER_PARTICIPANT = 4;
const vm = createVirtualMachineBch();

function encode(transaction: TransactionCommon): string {
  return binToHex(encodeTransactionCommon(transaction));
}

export function proposalFingerprint(proposal: SwapProposal): string {
  const canonicalOutputs = proposal.sourceOutputs.map((output) =>
    serializeOutput(deserializeOutput(output)),
  );
  return binToHex(
    sha256.hash(
      new TextEncoder().encode(
        proposal.unsignedTransaction + JSON.stringify(canonicalOutputs),
      ),
    ),
  );
}

function maximumSignedSize(transaction: TransactionCommon): number {
  return encodeTransactionCommon({
    ...transaction,
    inputs: transaction.inputs.map((input) => ({
      ...input,
      unlockingBytecode: new Uint8Array(108),
    })),
  }).length;
}

function circleAnchor(circleId: string): Output {
  assertCondition(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      circleId,
    ),
    'INVALID_CIRCLE_ID',
    'Expected a valid circle identifier.',
  );
  return {
    valueSatoshis: 0n,
    lockingBytecode: Uint8Array.from([
      0x6a,
      ...encodeDataPush(new TextEncoder().encode(`SC1:${circleId}`)),
    ]),
  };
}

function selectInputs(actor: SwapActor): WalletUtxo[] {
  const selected = [actor.nft];
  let value = BigInt(actor.nft.satoshis);
  const needed = NFT_SATOSHIS + BASE_FEE_SATOSHIS;
  const funding = actor.funding
    .filter(
      (utxo) => !utxo.token && outpointKey(utxo) !== outpointKey(actor.nft),
    )
    .toSorted((a, b) => {
      const difference = BigInt(b.satoshis) - BigInt(a.satoshis);
      return difference === 0n
        ? outpointKey(a).localeCompare(outpointKey(b))
        : difference > 0n
          ? 1
          : -1;
    });
  for (const utxo of funding) {
    if (value >= needed) break;
    if (selected.length >= MAX_INPUTS_PER_PARTICIPANT) break;
    selected.push(utxo);
    value += BigInt(utxo.satoshis);
  }
  assertCondition(
    value >= needed,
    'INSUFFICIENT_FUNDS',
    'Each participant needs BCH for the NFT output and network fee. Token-bearing UTXOs are never used for fee funding.',
  );
  return selected;
}

export function buildSwap(
  actors: readonly [SwapActor, SwapActor, SwapActor],
  circleId: string = crypto.randomUUID(),
): SwapProposal {
  const network = actors[0].offer.network;
  assertCondition(
    actors.length === 3 &&
      new Set(
        actors.map((actor) =>
          binToHex(addressBytecode(actor.offer.receiveAddress, network)),
        ),
      ).size === 3 &&
      new Set(actors.map((actor) => actor.offer.id)).size === 3 &&
      actors.every((actor) => actor.offer.network === network),
    'INVALID_CIRCLE',
    'A circle requires three distinct receiving addresses on one network.',
  );
  actors.forEach((actor, index) => {
    assertCondition(
      matchesWanted(actor.offer.wanted, actors[(index + 1) % 3]!.offer.asset),
      'INVALID_CIRCLE',
      'Every participant must receive the NFT requested in their offer.',
    );
    const actualAsset = nftAsset(actor.nft);
    assertCondition(
      outpointKey(actualAsset) === outpointKey(actor.offer.asset) &&
        actualAsset.category === actor.offer.asset.category &&
        actualAsset.commitment === actor.offer.asset.commitment,
      'ASSET_CHANGED',
      'The offered NFT no longer matches the on-chain output.',
    );
  });
  const transaction: TransactionCommon = {
    version: 2,
    locktime: 0,
    inputs: [],
    outputs: [],
  };
  const sourceOutputs: Output[] = [];
  const participants: ProposalParticipant[] = [];
  const changeOutputs: Output[] = [];
  const seen = new Set<string>();
  actors.forEach((actor, index) => {
    const selected = selectInputs(actor);
    const inputIndexes: number[] = [];
    for (const utxo of selected) {
      const key = outpointKey(utxo);
      assertCondition(
        !seen.has(key),
        'DUPLICATE_INPUT',
        'An output cannot be spent twice in the same circle.',
      );
      seen.add(key);
      assertCondition(
        binToHex(addressBytecode(utxo.address, network)) ===
          utxo.lockingBytecode,
        'INPUT_OWNER_MISMATCH',
        'The input does not match its wallet address.',
      );
      inputIndexes.push(transaction.inputs.length);
      transaction.inputs.push({
        outpointTransactionHash: bytes(utxo.txid),
        outpointIndex: utxo.vout,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: new Uint8Array(),
      });
      sourceOutputs.push(utxoOutput(utxo));
    }
    const inputSatoshis = selected.reduce(
      (sum, utxo) => sum + BigInt(utxo.satoshis),
      0n,
    );
    const remainder = inputSatoshis - NFT_SATOSHIS - BASE_FEE_SATOSHIS;
    const changeSatoshis = remainder >= CHANGE_DUST ? remainder : 0n;
    const feeSatoshis = inputSatoshis - NFT_SATOSHIS - changeSatoshis;
    const token = utxoOutput(actor.nft).token!;
    transaction.outputs.push({
      valueSatoshis: NFT_SATOSHIS,
      lockingBytecode: addressBytecode(
        actors[(index + 2) % 3]!.offer.receiveAddress,
        network,
      ),
      token,
    });
    if (changeSatoshis > 0n) {
      changeOutputs.push({
        valueSatoshis: changeSatoshis,
        lockingBytecode: addressBytecode(actor.offer.receiveAddress, network),
      });
    }
    participants.push({
      offerId: actor.offer.id,
      receiveAddress: actor.offer.receiveAddress,
      label: actor.offer.label,
      sendAsset: actor.offer.asset,
      receiveAsset: actors[(index + 1) % 3]!.offer.asset,
      inputIndexes,
      inputPaths: selected.map((utxo, offset) => [
        inputIndexes[offset]!,
        utxo.path,
        utxo.index,
      ]),
      inputSatoshis: inputSatoshis.toString(),
      changeSatoshis: changeSatoshis.toString(),
      feeSatoshis: feeSatoshis.toString(),
    });
  });
  transaction.outputs.push(...changeOutputs, circleAnchor(circleId));
  const proposal: SwapProposal = {
    circleId,
    network,
    unsignedTransaction: encode(transaction),
    sourceOutputs: sourceOutputs.map(serializeOutput),
    participants: participants as SwapProposal['participants'],
    fingerprint: '',
    feeSatoshis: participants
      .reduce((sum, participant) => sum + BigInt(participant.feeSatoshis), 0n)
      .toString(),
    maximumSignedSize: maximumSignedSize(transaction),
  };
  proposal.fingerprint = proposalFingerprint(proposal);
  validateProposal(
    proposal,
    actors.map((actor) => actor.offer),
  );
  return proposal;
}

export function validateProposal(
  proposal: SwapProposal,
  expectedOffers?: readonly Offer[],
): void {
  const transaction = decodeTransaction(proposal.unsignedTransaction);
  const sourceOutputs = proposal.sourceOutputs.map(deserializeOutput);
  const participants = proposal.participants;
  assertCondition(
    participants.length === 3 &&
      new Set(participants.map((participant) => participant.offerId)).size ===
        3 &&
      new Set(
        participants.map((participant) =>
          binToHex(
            addressBytecode(participant.receiveAddress, proposal.network),
          ),
        ),
      ).size === 3 &&
      transaction.version === 2 &&
      transaction.locktime === 0 &&
      transaction.inputs.length === sourceOutputs.length &&
      transaction.inputs.length <= 12 &&
      transaction.inputs.every(
        (input) =>
          input.sequenceNumber === 0xffffffff &&
          input.unlockingBytecode.length === 0,
      ),
    'INVALID_PROPOSAL',
    'The proposal is not a supported three-party transaction.',
  );
  if (expectedOffers) {
    assertCondition(
      expectedOffers.length === 3 &&
        expectedOffers.every((offer, index) => {
          const participant = participants[index]!;
          return (
            participant.offerId === offer.id &&
            participant.receiveAddress === offer.receiveAddress &&
            offer.network === proposal.network &&
            outpointKey(participant.sendAsset) === outpointKey(offer.asset) &&
            participant.sendAsset.category === offer.asset.category &&
            participant.sendAsset.commitment === offer.asset.commitment &&
            matchesWanted(offer.wanted, participant.receiveAsset)
          );
        }),
      'OFFER_MISMATCH',
      'The proposal does not fulfill the published offers.',
    );
  }
  const assigned = new Set<number>();
  const expectedOutputs: Output[] = [];
  const changeOutputs: Output[] = [];
  let totalFee = 0n;
  participants.forEach((participant, index) => {
    assertCondition(
      participant.inputIndexes.length > 0 &&
        participant.inputIndexes.length <= MAX_INPUTS_PER_PARTICIPANT &&
        participant.inputPaths.length === participant.inputIndexes.length,
      'INVALID_PROPOSAL',
      'The participant input assignments are incomplete.',
    );
    let inputValue = 0n;
    let nftCount = 0;
    let nftToken: Output['token'];
    for (const [offset, inputIndex] of participant.inputIndexes.entries()) {
      assertCondition(
        Number.isInteger(inputIndex) &&
          inputIndex >= 0 &&
          inputIndex < sourceOutputs.length &&
          !assigned.has(inputIndex) &&
          participant.inputPaths[offset]?.[0] === inputIndex &&
          ['receive', 'change', 'defi'].includes(
            participant.inputPaths[offset]![1],
          ) &&
          Number.isSafeInteger(participant.inputPaths[offset]![2]) &&
          participant.inputPaths[offset]![2] >= 0 &&
          participant.inputPaths[offset]![2] <= 10_000,
        'INVALID_PROPOSAL',
        'Each input must belong to exactly one participant.',
      );
      assigned.add(inputIndex);
      const input = transaction.inputs[inputIndex]!;
      const source = sourceOutputs[inputIndex]!;
      assertCondition(
        source.valueSatoshis >= 0n &&
          source.valueSatoshis <= 2_100_000_000_000_000n,
        'INVALID_SOURCE_VALUE',
        'The source output has an invalid BCH value.',
      );
      assertCondition(
        isP2pkh(source.lockingBytecode),
        'UNSUPPORTED_INPUT',
        'Only standard P2PKH wallet inputs are supported.',
      );
      inputValue += source.valueSatoshis;
      if (source.token) {
        assertCondition(
          source.token.amount === 0n &&
            source.token.nft?.capability === 'none' &&
            source.token.nft.commitment.length <= 40 &&
            binToHex(input.outpointTransactionHash) ===
              participant.sendAsset.txid &&
            input.outpointIndex === participant.sendAsset.vout &&
            binToHex(source.token.category) ===
              participant.sendAsset.category &&
            binToHex(source.token.nft.commitment) ===
              participant.sendAsset.commitment,
          'UNEXPECTED_TOKEN',
          'No extra tokens or minting rights may be spent.',
        );
        nftToken = source.token;
        nftCount += 1;
      }
    }
    const change = BigInt(participant.changeSatoshis);
    const fee = inputValue - NFT_SATOSHIS - change;
    assertCondition(
      nftCount === 1 &&
        inputValue === BigInt(participant.inputSatoshis) &&
        change >= 0n &&
        (change === 0n || change >= CHANGE_DUST) &&
        fee >= BASE_FEE_SATOSHIS &&
        fee <= MAX_PARTICIPANT_FEE &&
        fee === BigInt(participant.feeSatoshis) &&
        outpointKey(participant.receiveAsset) ===
          outpointKey(participants[(index + 1) % 3]!.sendAsset) &&
        participant.receiveAsset.category ===
          participants[(index + 1) % 3]!.sendAsset.category &&
        participant.receiveAsset.commitment ===
          participants[(index + 1) % 3]!.sendAsset.commitment,
      'INVALID_FEE_OR_ASSET',
      'The fee, change, or received NFT does not match the agreed circle.',
    );
    totalFee += fee;
    expectedOutputs.push({
      valueSatoshis: NFT_SATOSHIS,
      lockingBytecode: addressBytecode(
        participants[(index + 2) % 3]!.receiveAddress,
        proposal.network,
      ),
      token: nftToken,
    });
    if (change > 0n) {
      changeOutputs.push({
        valueSatoshis: change,
        lockingBytecode: addressBytecode(
          participant.receiveAddress,
          proposal.network,
        ),
      });
    }
  });
  expectedOutputs.push(...changeOutputs, circleAnchor(proposal.circleId));
  const inputKeys = transaction.inputs.map(
    (input) =>
      `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
  );
  assertCondition(
    assigned.size === transaction.inputs.length &&
      new Set(inputKeys).size === inputKeys.length &&
      transaction.outputs.length === expectedOutputs.length &&
      transaction.outputs.every((output, index) =>
        sameOutput(output, expectedOutputs[index]!),
      ) &&
      totalFee === BigInt(proposal.feeSatoshis) &&
      proposal.maximumSignedSize === maximumSignedSize(transaction) &&
      totalFee >= BigInt(proposal.maximumSignedSize) &&
      proposal.fingerprint === proposalFingerprint(proposal),
    'PROPOSAL_MISMATCH',
    'The proposal changes approved outputs, fees, or source outputs.',
  );
}

export function assertSameTransactionTemplate(
  unsignedHex: string,
  candidateHex: string,
): void {
  const strip = (hex: string) => {
    const transaction = decodeTransaction(hex);
    return encode({
      ...transaction,
      inputs: transaction.inputs.map((input) => ({
        ...input,
        unlockingBytecode: new Uint8Array(),
      })),
    });
  };
  assertCondition(
    strip(unsignedHex) === strip(candidateHex),
    'TRANSACTION_CHANGED',
    'The wallet changed the approved transaction.',
  );
}

function assertSafeUnlockingBytecode(script: Uint8Array): void {
  const signatureLength = script[0] ?? 0;
  assertCondition(
    signatureLength >= 9 &&
      signatureLength <= 73 &&
      script.length === signatureLength + 35 &&
      script[signatureLength + 1] === 33,
    'INVALID_SIGNATURE',
    'Expected a standard compressed-key P2PKH signature.',
  );
  // 0x61 binds all inputs, outputs, and source UTXOs, including CashTokens.
  assertCondition(
    script[signatureLength] === 0x61,
    'UNSAFE_SIGHASH',
    'The wallet must use SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS.',
  );
}

export function validatePartialSignature(
  proposal: SwapProposal,
  offerId: string,
  signedHex: string,
): void {
  validateProposal(proposal);
  assertSameTransactionTemplate(proposal.unsignedTransaction, signedHex);
  const transaction = decodeTransaction(signedHex);
  const sourceOutputs = proposal.sourceOutputs.map(deserializeOutput);
  const participant = proposal.participants.find(
    (candidate) => candidate.offerId === offerId,
  );
  assertCondition(
    participant,
    'NOT_A_PARTICIPANT',
    'This offer is not a participant in the circle.',
  );
  const own = new Set(participant.inputIndexes);
  transaction.inputs.forEach((input, inputIndex) => {
    if (!own.has(inputIndex)) {
      assertCondition(
        input.unlockingBytecode.length === 0,
        'FOREIGN_SIGNATURE',
        'A wallet may only fill its assigned input signatures.',
      );
      return;
    }
    assertSafeUnlockingBytecode(input.unlockingBytecode);
    const result = vm.stateSuccess(
      vm.evaluate({ inputIndex, sourceOutputs, transaction }),
    );
    assertCondition(
      result === true,
      'INVALID_SIGNATURE',
      'The signature does not authorize this input.',
    );
  });
}

export function mergeSignatures(
  proposal: SwapProposal,
  signatures: Readonly<Record<string, string>>,
): string {
  const transaction = decodeTransaction(proposal.unsignedTransaction);
  for (const participant of proposal.participants) {
    const signedHex = signatures[participant.offerId];
    if (!signedHex) {
      throw new DomainError(
        'MISSING_APPROVALS',
        'All three participants must approve before settlement.',
        409,
      );
    }
    validatePartialSignature(proposal, participant.offerId, signedHex);
    const partial = decodeTransaction(signedHex);
    for (const inputIndex of participant.inputIndexes) {
      transaction.inputs[inputIndex]!.unlockingBytecode =
        partial.inputs[inputIndex]!.unlockingBytecode;
    }
  }
  const result = vm.verify({
    transaction,
    sourceOutputs: proposal.sourceOutputs.map(deserializeOutput),
  });
  assertCondition(
    result === true,
    'CONSENSUS_REJECTED',
    'The completed transaction failed BCH consensus verification.',
  );
  const encoded = encode(transaction);
  assertCondition(
    encoded.length / 2 <= proposal.maximumSignedSize,
    'TRANSACTION_TOO_LARGE',
    'The signed transaction exceeds its quoted size.',
  );
  return encoded;
}
