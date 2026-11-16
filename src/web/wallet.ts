import { binToHex } from '@bitauth/libauth';
import type { DappConnectionManager } from '@wizardconnect/dapp';
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import {
  addressBytecode,
  assertCondition,
  decodeTransaction,
  deserializeOutput,
  publicKeyBytecode,
  tokenAddress,
} from '../shared/bitcoin.js';
import {
  validatePartialSignature,
  validateProposal,
} from '../shared/transactions.js';
import { DomainError } from '../shared/errors.js';
import type {
  AddressPath,
  Network,
  Offer,
  PathName,
  ProposalParticipant,
  SwapProposal,
} from '../shared/types.js';

const childIndexes: Record<PathName, number> = {
  receive: 0,
  change: 1,
  defi: 7,
};
type SignRequest = Parameters<DappConnectionManager['signTransaction']>[0];

export function receiveAddress(
  manager: DappConnectionManager,
  network: Network,
): string {
  const publicKey = manager.getPubkey(0, 0n);
  assertCondition(
    publicKey,
    'WALLET_PATH_UNAVAILABLE',
    'This wallet did not provide its receiving public key.',
  );
  return tokenAddress(publicKeyBytecode(publicKey), network);
}

export function scanPaths(
  manager: DappConnectionManager,
  network: Network,
  start = 0,
  count = 20,
): AddressPath[] {
  assertCondition(
    Number.isInteger(start) &&
      start >= 0 &&
      Number.isInteger(count) &&
      count >= 1 &&
      count <= 20 &&
      start + count <= 10_001,
    'INVALID_SCAN',
    'Scan 1 to 20 addresses per path, starting between index 0 and 10000.',
  );
  const paths: AddressPath[] = [];
  for (const path of ['receive', 'change'] as const) {
    if (!manager.hasPath(childIndexes[path])) continue;
    for (let index = start; index < start + count; index += 1) {
      const publicKey = manager.getPubkey(childIndexes[path], BigInt(index));
      if (!publicKey)
        throw new DomainError(
          'WALLET_PATH_UNAVAILABLE',
          'The wallet cannot derive that address.',
        );
      paths.push({
        path,
        index,
        address: tokenAddress(publicKeyBytecode(publicKey), network),
      });
    }
  }
  return paths;
}

export function signingRequest(
  proposal: SwapProposal,
  participant: ProposalParticipant,
): SignRequest {
  const transaction = decodeTransaction(proposal.unsignedTransaction);
  const sources = proposal.sourceOutputs.map((source, index) =>
    sourceOutputToRelay({
      ...transaction.inputs[index]!,
      ...deserializeOutput(source),
    }),
  );
  return {
    transaction: {
      transaction: proposal.unsignedTransaction,
      // WizardConnect requires its canonical JSON encoding, not native bigint values.
      sourceOutputs:
        sources as unknown as SignRequest['transaction']['sourceOutputs'],
      broadcast: false,
      userPrompt: `SwapCircle ${proposal.network.toUpperCase()}. Circle ${proposal.circleId}. Sign only your assigned inputs with SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS (0x61). Do not broadcast. Fee: ${participant.feeSatoshis} sats. Change to you: ${participant.changeSatoshis} sats. Receive token ${participant.receiveAsset.category}, commitment ${participant.receiveAsset.commitment || '(empty)'}. Once all three approve, any participant can settle this exact trade.`,
    },
    inputPaths: participant.inputPaths,
  };
}

export function assertWalletOwnsInputs(
  manager: DappConnectionManager,
  proposal: SwapProposal,
  offer: Offer,
): ProposalParticipant {
  const participant = proposal.participants.find(
    (item) => item.offerId === offer.id,
  );
  assertCondition(
    participant,
    'NOT_A_PARTICIPANT',
    'Your original offer is not in this circle.',
  );
  assertCondition(
    receiveAddress(manager, proposal.network) === offer.receiveAddress,
    'WRONG_WALLET',
    'Reconnect the wallet that created this offer. The receiving address must remain yours.',
  );
  for (const [inputIndex, path, index] of participant.inputPaths) {
    const publicKey = manager.getPubkey(childIndexes[path], BigInt(index));
    assertCondition(
      publicKey &&
        binToHex(publicKeyBytecode(publicKey)) ===
          proposal.sourceOutputs[inputIndex]!.lockingBytecode,
      'WRONG_WALLET',
      'A proposed input is not controlled by this connected wallet.',
    );
  }
  assertCondition(
    binToHex(addressBytecode(participant.receiveAddress, proposal.network)) ===
      binToHex(addressBytecode(offer.receiveAddress, proposal.network)),
    'WRONG_RECIPIENT',
    'The receiving address changed after you published the offer.',
  );
  return participant;
}

export async function signSwap(
  manager: DappConnectionManager,
  proposal: SwapProposal,
  expectedOffers: readonly Offer[],
  offerId: string,
  signal?: AbortSignal,
): Promise<string> {
  validateProposal(proposal, expectedOffers);
  const offer = expectedOffers.find((item) => item.id === offerId);
  assertCondition(
    offer,
    'ORIGINAL_OFFER_MISSING',
    'Use the browser with your original saved offer.',
  );
  const participant = assertWalletOwnsInputs(manager, proposal, offer);
  let response: Awaited<ReturnType<DappConnectionManager['signTransaction']>>;
  try {
    response = await manager.signTransaction(
      signingRequest(proposal, participant),
      { signal },
    );
  } catch {
    signal?.throwIfAborted();
    throw new DomainError(
      'WALLET_REJECTED',
      'The wallet declined or could not sign with the required flags. No new approval was submitted.',
    );
  }
  signal?.throwIfAborted();
  if (response.error || !response.signedTransaction) {
    throw new DomainError(
      'WALLET_REJECTED',
      'The wallet declined or could not sign with the required flags. No new approval was submitted.',
    );
  }
  validatePartialSignature(proposal, offerId, response.signedTransaction);
  return response.signedTransaction;
}
