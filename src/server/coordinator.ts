import { binToHex } from '@bitauth/libauth';
import { randomUUID } from 'node:crypto';
import {
  addressBytecode,
  decodeTransaction,
  nftAsset,
  tokenAddress,
} from '../shared/bitcoin.js';
import { findCycles, outpointKey } from '../shared/cycles.js';
import { DomainError } from '../shared/errors.js';
import {
  buildSwap,
  validatePartialSignature,
  type SwapActor,
} from '../shared/transactions.js';
import type {
  AddressPath,
  Circle,
  CreateOffer,
  InventorySnapshot,
  MarketSnapshot,
  Network,
  Offer,
} from '../shared/types.js';
import type { Chain } from './chain.js';
import { digest, Store, type CircleRecord } from './store.js';

const canonicalPaths = (network: Network, paths: readonly AddressPath[]) => {
  const normalized = paths.map((path) => ({
    ...path,
    address: tokenAddress(addressBytecode(path.address, network), network),
  }));
  if (
    new Set(normalized.map((path) => path.address)).size !== normalized.length
  ) {
    throw new DomainError(
      'DUPLICATE_ADDRESS',
      'Scan each wallet address only once.',
      400,
    );
  }
  return normalized;
};

export class Coordinator {
  constructor(
    public readonly store: Store,
    public readonly chain: Chain,
    public readonly enabledNetworks: readonly Network[] = [
      'chipnet',
      'mainnet',
    ],
  ) {}

  private mainnet(network: Network, acknowledged: boolean): void {
    if (!this.enabledNetworks.includes(network)) {
      throw new DomainError(
        'NETWORK_DISABLED',
        'Trading on this network is disabled by the server.',
        403,
      );
    }
    if (network === 'mainnet' && !acknowledged) {
      throw new DomainError(
        'MAINNET_CONFIRMATION_REQUIRED',
        'Explicitly acknowledge real Mainnet funds before continuing.',
        409,
      );
    }
  }

  private member(circle: CircleRecord, sessionId: string): void {
    if (
      !circle.offerIds.some(
        (id) => this.store.getOffer(id).sessionId === sessionId,
      )
    ) {
      throw new DomainError(
        'FORBIDDEN',
        'Only a participant browser can perform that action.',
        403,
      );
    }
  }

  private failPending(id: string, error: unknown, staleOffer?: string): void {
    const current = this.store.getCircle(id);
    if (['preparing', 'awaiting_signatures'].includes(current.status)) {
      this.store.closeCircle(
        id,
        'failed',
        error instanceof DomainError
          ? error.message
          : 'The node could not verify this circle.',
      );
    }
    const unavailable = error instanceof DomainError && error.outpoint;
    const invalid =
      staleOffer ??
      (unavailable
        ? current.offerIds.find(
            (offerId) =>
              outpointKey(this.store.getOffer(offerId).offer.asset) ===
              outpointKey(unavailable),
          )
        : undefined);
    if (invalid) this.store.invalidateOffer(invalid);
  }

  private view(circle: CircleRecord, sessionId: string): Circle {
    const approvals = this.store.approvals(circle.id);
    const participants = circle.offerIds.map((id) => {
      const { offer, sessionId: owner } = this.store.getOffer(id);
      const approval = approvals.find((item) => item.offerId === id);
      return {
        offerId: offer.id,
        receiveAddress: offer.receiveAddress,
        label: offer.label,
        asset: offer.asset,
        signed: Boolean(approval),
        isMine: owner === sessionId,
        ...(approval && { signedAt: approval.signedAt }),
      };
    });
    return {
      id: circle.id,
      network: circle.network,
      status: circle.status,
      participants: participants as Circle['participants'],
      createdAt: circle.createdAt,
      expiresAt: circle.expiresAt,
      version: circle.version,
      confirmations: circle.confirmations,
      ...(circle.txid && { txid: circle.txid }),
      ...(circle.error && { error: circle.error }),
      ...(participants.some((participant) => participant.isMine) &&
        circle.proposal && { proposal: circle.proposal }),
    };
  }

  market(network: Network, sessionId: string): MarketSnapshot {
    this.store.expire();
    const offers = this.store
      .listOffers(network)
      .filter(
        (record) =>
          record.sessionId === sessionId ||
          ['open', 'reserved'].includes(record.offer.status),
      )
      .map((record) => ({
        ...record.offer,
        isMine: record.sessionId === sessionId,
      }));
    const circles = this.store
      .listCircles(network)
      .filter((circle) =>
        circle.offerIds.some(
          (id) => this.store.getOffer(id).sessionId === sessionId,
        ),
      )
      .map((circle) => this.view(circle, sessionId));
    return { offers, cycles: findCycles(offers, this.store.now()), circles };
  }

  circle(id: string, sessionId: string): Circle {
    this.store.expire();
    return this.view(this.store.getCircle(id), sessionId);
  }

  async inventory(
    network: Network,
    paths: readonly AddressPath[],
  ): Promise<InventorySnapshot> {
    const normalized = canonicalPaths(network, paths);
    const utxos = await this.chain.getUtxos(network, normalized);
    return {
      utxos: utxos.slice(0, 500),
      truncated: utxos.length > 500,
      scannedAddresses: normalized.length,
      checkedAt: this.store.now(),
    };
  }

  async createOffer(
    sessionId: string,
    request: CreateOffer,
    mainnetAcknowledged = false,
  ): Promise<Offer> {
    this.mainnet(request.network, mainnetAcknowledged);
    const receiveAddress = tokenAddress(
      addressBytecode(request.receiveAddress, request.network),
      request.network,
    );
    const paths = canonicalPaths(request.network, request.addressPaths);
    const utxos = await this.chain.getUtxos(request.network, paths);
    const nft = utxos.find(
      (utxo) => outpointKey(utxo) === outpointKey(request.offered),
    );
    if (!nft)
      throw new DomainError(
        'ASSET_SPENT',
        'The selected NFT is not an unspent output in these wallet addresses.',
        409,
      );
    const asset = nftAsset(nft);
    await this.chain.verifyUtxos(request.network, [nft]);
    if (
      request.wanted.outpoint &&
      outpointKey(request.wanted.outpoint) === outpointKey(asset)
    ) {
      throw new DomainError(
        'SELF_TRADE',
        'Choose an NFT other than the one you are offering.',
        400,
      );
    }
    const offer: Offer = {
      id: randomUUID(),
      network: request.network,
      receiveAddress,
      label: request.label,
      asset,
      wanted: request.wanted,
      createdAt: this.store.now(),
      expiresAt: this.store.now() + 86_400_000,
      status: 'open',
    };
    this.store.addOffer({ offer, sessionId, addressPaths: paths });
    return { ...offer, isMine: true };
  }

  async prepare(
    offerIds: readonly string[],
    sessionId: string,
    mainnetAcknowledged = false,
  ): Promise<Circle> {
    this.mainnet(
      this.store.getOffer(offerIds[0]!).offer.network,
      mainnetAcknowledged,
    );
    const circle = this.store.createCircle(offerIds, sessionId);
    let staleOffer: string | undefined;
    try {
      const actors: SwapActor[] = [];
      for (const id of circle.offerIds) {
        const { offer, addressPaths } = this.store.getOffer(id);
        const utxos = await this.chain.getUtxos(circle.network, addressPaths);
        const nft = utxos.find(
          (utxo) => outpointKey(utxo) === outpointKey(offer.asset),
        );
        if (!nft) {
          staleOffer = id;
          throw new DomainError(
            'ASSET_SPENT',
            'An offered NFT has already been spent. Its offer has been removed.',
            409,
          );
        }
        actors.push({
          offer,
          nft,
          funding: utxos.filter(
            (utxo) =>
              !utxo.token &&
              !this.store.isReserved(circle.network, utxo, circle.id),
          ),
        });
      }
      const proposal = buildSwap(
        actors as [SwapActor, SwapActor, SwapActor],
        circle.id,
      );
      const available = new Map(
        actors
          .flatMap((actor) => [actor.nft, ...actor.funding])
          .map((utxo) => [outpointKey(utxo), utxo]),
      );
      const sourceUtxos = decodeTransaction(
        proposal.unsignedTransaction,
      ).inputs.map((input) =>
        available.get(
          `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
        )!,
      );
      await this.chain.verifyUtxos(circle.network, sourceUtxos);
      this.store.saveProposal(circle.id, proposal, sourceUtxos);
      return this.circle(circle.id, sessionId);
    } catch (error) {
      this.failPending(circle.id, error, staleOffer);
      throw error;
    }
  }

  async approve(
    id: string,
    sessionId: string,
    offerId: string,
    fingerprint: string,
    signedHex: string,
    mainnetAcknowledged = false,
  ): Promise<Circle> {
    this.store.expire();
    const circle = this.store.getCircle(id);
    this.member(circle, sessionId);
    this.mainnet(circle.network, mainnetAcknowledged);
    if (
      !circle.offerIds.includes(offerId) ||
      this.store.getOffer(offerId).sessionId !== sessionId
    ) {
      throw new DomainError(
        'FORBIDDEN',
        'Your browser does not own that participant offer.',
        403,
      );
    }
    if (circle.proposal?.fingerprint !== fingerprint) {
      throw new DomainError(
        'STALE_PROPOSAL',
        'Refresh and review the current immutable proposal.',
        409,
      );
    }
    const existing = this.store
      .approvals(id)
      .find((approval) => approval.offerId === offerId);
    if (
      existing &&
      !['cancelled', 'expired', 'failed'].includes(circle.status)
    ) {
      if (existing.signatureDigest !== digest(signedHex))
        throw new DomainError(
          'ALREADY_APPROVED',
          'A different approval was already recorded.',
          409,
        );
      return this.circle(id, sessionId);
    }
    if (circle.status !== 'awaiting_signatures')
      throw new DomainError(
        'CIRCLE_CLOSED',
        'This circle is no longer accepting signatures.',
        409,
      );
    validatePartialSignature(circle.proposal!, offerId, signedHex);
    try {
      await this.chain.verifyUtxos(circle.network, circle.sourceUtxos!);
    } catch (error) {
      if (
        error instanceof DomainError &&
        ['INPUT_SPENT', 'SOURCE_MISMATCH'].includes(error.code)
      ) {
        this.failPending(id, error);
      }
      throw error;
    }
    this.store.recordApproval(id, offerId, signedHex);
    return this.circle(id, sessionId);
  }

  cancelCircle(id: string, sessionId: string): Circle {
    const circle = this.store.getCircle(id);
    this.member(circle, sessionId);
    this.store.closeCircle(id, 'cancelled');
    return this.circle(id, sessionId);
  }

  signedTransaction(
    id: string,
    sessionId: string,
  ): { signedTransaction: string; txid: string } {
    const circle = this.store.getCircle(id);
    this.member(circle, sessionId);
    if (!circle.signedTransaction || !circle.txid)
      throw new DomainError(
        'MISSING_APPROVALS',
        'All three signatures are required before export.',
        409,
      );
    return { signedTransaction: circle.signedTransaction, txid: circle.txid };
  }

  async refresh(id: string, sessionId: string): Promise<Circle> {
    const circle = this.store.getCircle(id);
    this.member(circle, sessionId);
    if (!circle.signedTransaction || !circle.txid)
      return this.circle(id, sessionId);
    const observation = await this.chain.observe(
      circle.network,
      circle.txid,
      circle.offerIds.map(
        (offerId) => this.store.getOffer(offerId).offer.receiveAddress,
      ),
    );
    if (observation.found)
      this.store.observed(id, observation.confirmations, circle.version);
    else if (['broadcast', 'confirmed'].includes(circle.status)) {
      this.store.markUnknown(
        id,
        'The transaction is no longer observed on-chain. Recheck before retrying the identical transaction.',
        circle.version,
      );
    }
    return this.circle(id, sessionId);
  }

  async settle(
    id: string,
    sessionId: string,
    mainnetAcknowledged = false,
  ): Promise<Circle> {
    this.store.expire();
    let circle = this.store.getCircle(id);
    this.member(circle, sessionId);
    this.mainnet(circle.network, mainnetAcknowledged);
    if (['broadcasting', 'broadcast', 'confirmed'].includes(circle.status))
      return this.circle(id, sessionId);
    if (
      !circle.signedTransaction ||
      !circle.txid ||
      !['ready', 'broadcast_unknown'].includes(circle.status)
    ) {
      throw new DomainError(
        'MISSING_APPROVALS',
        'All three approvals must exist before settlement.',
        409,
      );
    }
    const addresses = circle.offerIds.map(
      (offerId) => this.store.getOffer(offerId).offer.receiveAddress,
    );
    try {
      const observation = await this.chain.observe(
        circle.network,
        circle.txid,
        addresses,
      );
      if (observation.found) {
        this.store.observed(id, observation.confirmations, circle.version);
        return this.circle(id, sessionId);
      }
      await this.chain.verifyUtxos(circle.network, circle.sourceUtxos!);
    } catch {
      this.store.markUnknown(
        id,
        'The chain could not establish the transaction outcome. Retry only this identical signed transaction.',
        circle.version,
      );
      return this.circle(id, sessionId);
    }
    if (!this.store.beginBroadcast(id)) return this.circle(id, sessionId);
    circle = this.store.getCircle(id);
    try {
      await this.chain.broadcast(circle.network, circle.signedTransaction!);
      this.store.observed(id, 0, circle.version);
    } catch {
      this.store.markUnknown(
        id,
        'The node reply was inconclusive. Funds may have moved. Check the chain, then retry the identical transaction.',
        circle.version,
      );
    }
    return this.circle(id, sessionId);
  }
}
