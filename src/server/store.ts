import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findCycles, outpointKey } from '../shared/cycles.js';
import { DomainError } from '../shared/errors.js';
import { mergeSignatures } from '../shared/transactions.js';
import { transactionId } from '../shared/bitcoin.js';
import type {
  AddressPath,
  CircleStatus,
  Network,
  Offer,
  SwapProposal,
  WalletUtxo,
} from '../shared/types.js';

export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export interface OfferRecord {
  offer: Offer;
  sessionId: string;
  addressPaths: AddressPath[];
}

export interface CircleRecord {
  id: string;
  network: Network;
  status: CircleStatus;
  offerIds: [string, string, string];
  createdAt: number;
  expiresAt: number;
  version: number;
  proposal?: SwapProposal;
  sourceUtxos?: WalletUtxo[];
  signedTransaction?: string;
  txid?: string;
  confirmations: number;
  error?: string;
}

interface CircleRow {
  id: string;
  network: Network;
  status: CircleStatus;
  offer_ids: string;
  created_at: number;
  expires_at: number;
  version: number;
  proposal: string | null;
  source_utxos: string | null;
  signed_transaction: string | null;
  txid: string | null;
  confirmations: number;
  error: string | null;
}

export interface ApprovalRecord {
  offerId: string;
  signedAt: number;
  signatureDigest: string;
  signedTransaction?: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(
    path = ':memory:',
    public readonly now: () => number = Date.now,
    journalMode: 'wal' | 'delete' = 'wal',
  ) {
    if (journalMode !== 'wal' && journalMode !== 'delete')
      throw new Error('Unsupported SQLite journal mode.');
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    // One coordinator owns the file, including crash recovery of broadcast state.
    this.db.exec(`
      PRAGMA locking_mode=EXCLUSIVE;
      PRAGMA busy_timeout=1000;
      PRAGMA journal_mode=${journalMode.toUpperCase()};
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY, network TEXT NOT NULL, session_id TEXT NOT NULL,
        asset_key TEXT NOT NULL, status TEXT NOT NULL, circle_id TEXT,
        expires_at INTEGER NOT NULL, offer_json TEXT NOT NULL, paths_json TEXT NOT NULL
      );
      DROP INDEX IF EXISTS active_asset;
      CREATE UNIQUE INDEX IF NOT EXISTS active_asset_per_session
        ON offers(session_id, network, asset_key) WHERE status IN ('open','reserved');
      CREATE TABLE IF NOT EXISTS circles (
        id TEXT PRIMARY KEY, network TEXT NOT NULL, status TEXT NOT NULL,
        offer_ids TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, proposal TEXT, source_utxos TEXT,
        signed_transaction TEXT, txid TEXT, confirmations INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS reservations (
        network TEXT NOT NULL, asset_key TEXT NOT NULL, circle_id TEXT NOT NULL
        REFERENCES circles(id), PRIMARY KEY(network, asset_key)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        circle_id TEXT NOT NULL REFERENCES circles(id), offer_id TEXT NOT NULL,
        signed_at INTEGER NOT NULL, signature_digest TEXT NOT NULL,
        signed_transaction TEXT, PRIMARY KEY(circle_id, offer_id)
      );
      UPDATE circles SET status='broadcast_unknown', version=version+1,
        error='The coordinator restarted during broadcast. Check the chain before retrying.'
        WHERE status='broadcasting';
    `);
    this.expire();
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ensureSession(id: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO sessions VALUES (?,?)')
      .run(id, this.now() + 7 * 86_400_000);
  }

  hasSession(id: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT id FROM sessions WHERE id=? AND expires_at>?')
        .get(id, this.now()),
    );
  }

  getOffer(id: string): OfferRecord {
    const row = this.db.prepare('SELECT * FROM offers WHERE id=?').get(id);
    if (!row)
      throw new DomainError(
        'OFFER_NOT_FOUND',
        'That offer was not found.',
        404,
      );
    const offer = JSON.parse(row.offer_json as string) as Offer;
    offer.status = row.status as Offer['status'];
    if (row.circle_id) offer.circleId = row.circle_id as string;
    else delete offer.circleId;
    return {
      offer,
      sessionId: row.session_id as string,
      addressPaths: JSON.parse(row.paths_json as string) as AddressPath[],
    };
  }

  listOffers(network: Network): OfferRecord[] {
    return this.db
      .prepare(
        'SELECT id FROM offers WHERE network=? ORDER BY expires_at DESC LIMIT 300',
      )
      .all(network)
      .map((row) => this.getOffer(row.id as string));
  }

  addOffer(record: OfferRecord): void {
    this.expire();
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM offers WHERE session_id=? AND status IN ('open','reserved')",
      )
      .get(record.sessionId)!;
    if (Number(count.count) >= 10)
      throw new DomainError(
        'OFFER_LIMIT',
        'Keep at most 10 active offers.',
        409,
      );
    if (
      this.isReserved(record.offer.network, record.offer.asset) ||
      this.db
        .prepare(
          "SELECT id FROM offers WHERE session_id=? AND network=? AND asset_key=? AND status IN ('open','reserved')",
        )
        .get(
          record.sessionId,
          record.offer.network,
          outpointKey(record.offer.asset),
        )
    ) {
      throw new DomainError(
        'ASSET_ALREADY_LISTED',
        'That NFT is already listed or committed to a circle.',
        409,
      );
    }
    this.db
      .prepare('INSERT INTO offers VALUES (?,?,?,?,?,NULL,?,?,?)')
      .run(
        record.offer.id,
        record.offer.network,
        record.sessionId,
        outpointKey(record.offer.asset),
        record.offer.status,
        record.offer.expiresAt,
        JSON.stringify(record.offer),
        JSON.stringify(record.addressPaths),
      );
  }

  cancelOffer(id: string, sessionId: string): void {
    const record = this.getOffer(id);
    if (record.sessionId !== sessionId)
      throw new DomainError(
        'FORBIDDEN',
        'Only the listing browser can cancel this offer.',
        403,
      );
    if (record.offer.status === 'reserved')
      throw new DomainError(
        'OFFER_RESERVED',
        'Cancel its pending circle first.',
        409,
      );
    if (record.offer.status === 'open')
      this.db
        .prepare("UPDATE offers SET status='cancelled' WHERE id=?")
        .run(id);
  }

  invalidateOffer(id: string): void {
    this.db
      .prepare(
        "UPDATE offers SET status='invalid', circle_id=NULL WHERE id=? AND status='open'",
      )
      .run(id);
  }

  getCircle(id: string): CircleRecord {
    const row = this.db
      .prepare('SELECT * FROM circles WHERE id=?')
      .get(id) as unknown as CircleRow | undefined;
    if (!row)
      throw new DomainError(
        'CIRCLE_NOT_FOUND',
        'That circle was not found.',
        404,
      );
    return {
      id: row.id,
      network: row.network,
      status: row.status,
      offerIds: JSON.parse(row.offer_ids) as CircleRecord['offerIds'],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      version: row.version,
      confirmations: row.confirmations,
      ...(row.proposal && {
        proposal: JSON.parse(row.proposal) as SwapProposal,
      }),
      ...(row.source_utxos && {
        sourceUtxos: JSON.parse(row.source_utxos) as WalletUtxo[],
      }),
      ...(row.signed_transaction && {
        signedTransaction: row.signed_transaction,
      }),
      ...(row.txid && { txid: row.txid }),
      ...(row.error && { error: row.error }),
    };
  }

  listCircles(network: Network): CircleRecord[] {
    return this.db
      .prepare(
        'SELECT id FROM circles WHERE network=? ORDER BY created_at DESC LIMIT 100',
      )
      .all(network)
      .map((row) => this.getCircle(row.id as string));
  }

  isReserved(
    network: Network,
    outpoint: { txid: string; vout: number },
    circleId?: string,
  ): boolean {
    const row = this.db
      .prepare(
        'SELECT circle_id FROM reservations WHERE network=? AND asset_key=?',
      )
      .get(network, outpointKey(outpoint));
    return Boolean(row && row.circle_id !== circleId);
  }

  private reserve(
    network: Network,
    outpoint: { txid: string; vout: number },
    circleId: string,
  ): void {
    if (this.isReserved(network, outpoint, circleId)) {
      throw new DomainError(
        'INPUT_RESERVED',
        'Another circle is already using an NFT or fee input.',
        409,
      );
    }
    this.db
      .prepare('INSERT OR IGNORE INTO reservations VALUES (?,?,?)')
      .run(network, outpointKey(outpoint), circleId);
  }

  createCircle(offerIds: readonly string[], sessionId: string): CircleRecord {
    this.expire();
    return this.transaction(() => {
      if (offerIds.length !== 3 || new Set(offerIds).size !== 3) {
        throw new DomainError(
          'INVALID_CIRCLE',
          'Select three different offers.',
          400,
        );
      }
      const records = offerIds.map((id) => this.getOffer(id));
      if (!records.some((record) => record.sessionId === sessionId)) {
        throw new DomainError(
          'FORBIDDEN',
          'Your browser must own an offer in this circle.',
          403,
        );
      }
      const cycle = findCycles(
        records.map((record) => record.offer),
        this.now(),
        1,
      )[0];
      if (!cycle)
        throw new DomainError(
          'CIRCLE_UNAVAILABLE',
          'Those offers no longer form an available circle.',
          409,
        );
      const id = randomUUID();
      const ids = cycle.offers.map((offer) => offer.id);
      this.db
        .prepare(
          `INSERT INTO circles
        (id,network,status,offer_ids,created_at,expires_at) VALUES (?,?,'preparing',?,?,?)`,
        )
        .run(
          id,
          cycle.offers[0].network,
          JSON.stringify(ids),
          this.now(),
          this.now() + 10 * 60_000,
        );
      for (const offer of cycle.offers) {
        this.reserve(offer.network, offer.asset, id);
        this.db
          .prepare(
            "UPDATE offers SET status='reserved', circle_id=? WHERE id=?",
          )
          .run(id, offer.id);
      }
      return this.getCircle(id);
    });
  }

  saveProposal(
    id: string,
    proposal: SwapProposal,
    sourceUtxos: WalletUtxo[],
  ): void {
    this.transaction(() => {
      const circle = this.getCircle(id);
      if (circle.status !== 'preparing' || circle.expiresAt <= this.now()) {
        throw new DomainError(
          'CIRCLE_CLOSED',
          'This preparation was cancelled or expired.',
          409,
        );
      }
      if (
        proposal.circleId !== id ||
        proposal.network !== circle.network ||
        !proposal.participants.every(
          (participant, index) =>
            participant.offerId === circle.offerIds[index],
        )
      )
        throw new DomainError(
          'PROPOSAL_MISMATCH',
          'The proposal belongs to a different circle.',
          409,
        );
      for (const utxo of sourceUtxos) this.reserve(circle.network, utxo, id);
      this.db
        .prepare(
          `UPDATE circles SET status='awaiting_signatures', proposal=?,
        source_utxos=?, version=version+1 WHERE id=?`,
        )
        .run(JSON.stringify(proposal), JSON.stringify(sourceUtxos), id);
    });
  }

  approvals(id: string): ApprovalRecord[] {
    return this.db
      .prepare('SELECT * FROM approvals WHERE circle_id=?')
      .all(id)
      .map((row) => ({
        offerId: row.offer_id as string,
        signedAt: row.signed_at as number,
        signatureDigest: row.signature_digest as string,
        ...(row.signed_transaction && {
          signedTransaction: row.signed_transaction as string,
        }),
      }));
  }

  recordApproval(id: string, offerId: string, signedHex: string): void {
    this.transaction(() => {
      const circle = this.getCircle(id);
      if (
        circle.status !== 'awaiting_signatures' ||
        circle.expiresAt <= this.now() ||
        !circle.offerIds.includes(offerId)
      ) {
        throw new DomainError(
          'CIRCLE_CLOSED',
          'This circle is no longer accepting approvals.',
          409,
        );
      }
      const existing = this.approvals(id).find(
        (approval) => approval.offerId === offerId,
      );
      if (existing) {
        if (existing.signatureDigest !== digest(signedHex))
          throw new DomainError(
            'ALREADY_APPROVED',
            'This participant already approved a different response.',
            409,
          );
        return;
      }
      this.db
        .prepare('INSERT INTO approvals VALUES (?,?,?,?,?)')
        .run(id, offerId, this.now(), digest(signedHex), signedHex);
      const approvals = this.approvals(id);
      if (approvals.length === 3) {
        const finalHex = mergeSignatures(
          circle.proposal!,
          Object.fromEntries(
            approvals.map((approval) => [
              approval.offerId,
              approval.signedTransaction!,
            ]),
          ),
        );
        this.db
          .prepare(
            `UPDATE circles SET status='ready', signed_transaction=?, txid=?,
          version=version+1 WHERE id=?`,
          )
          .run(finalHex, transactionId(finalHex), id);
        this.db
          .prepare(
            'UPDATE approvals SET signed_transaction=NULL WHERE circle_id=?',
          )
          .run(id);
      } else {
        this.db
          .prepare('UPDATE circles SET version=version+1 WHERE id=?')
          .run(id);
      }
    });
  }

  closeCircle(
    id: string,
    status: 'cancelled' | 'expired' | 'failed',
    error?: string,
  ): void {
    this.transaction(() => {
      const circle = this.getCircle(id);
      if (!['preparing', 'awaiting_signatures'].includes(circle.status)) {
        throw new DomainError(
          'CANNOT_CANCEL',
          'All signatures exist or settlement has started. Off-chain cancellation cannot revoke them.',
          409,
        );
      }
      this.db
        .prepare(
          'UPDATE circles SET status=?,error=?,version=version+1 WHERE id=?',
        )
        .run(status, error ?? null, id);
      this.db
        .prepare(
          `UPDATE offers SET status=CASE WHEN expires_at>? THEN 'open' ELSE 'expired' END,
        circle_id=NULL WHERE circle_id=? AND status='reserved'`,
        )
        .run(this.now(), id);
      this.db.prepare('DELETE FROM reservations WHERE circle_id=?').run(id);
      this.db
        .prepare(
          'UPDATE approvals SET signed_transaction=NULL WHERE circle_id=?',
        )
        .run(id);
    });
  }

  beginBroadcast(id: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE circles SET status='broadcasting', error=NULL,
      version=version+1 WHERE id=? AND status IN ('ready','broadcast_unknown')`,
        )
        .run(id).changes === 1
    );
  }

  markUnknown(id: string, error: string, expectedVersion?: number): boolean {
    return this.transaction(() => {
      const circle = this.getCircle(id);
      if (expectedVersion !== undefined && circle.version !== expectedVersion)
        return false;
      this.db
        .prepare(
          `UPDATE circles SET status='broadcast_unknown',confirmations=0,error=?,
        version=version+1 WHERE id=? AND signed_transaction IS NOT NULL`,
        )
        .run(error, id);
      return true;
    });
  }

  observed(
    id: string,
    confirmations: number,
    expectedVersion?: number,
  ): boolean {
    return this.transaction(() => {
      const circle = this.getCircle(id);
      if (expectedVersion !== undefined && circle.version !== expectedVersion)
        return false;
      if (!circle.signedTransaction)
        throw new DomainError(
          'MISSING_APPROVALS',
          'The circle is not fully signed.',
          409,
        );
      this.db
        .prepare(
          `UPDATE circles SET status=?,confirmations=?,error=NULL,
        version=version+1 WHERE id=?`,
        )
        .run(confirmations > 0 ? 'confirmed' : 'broadcast', confirmations, id);
      this.db
        .prepare("UPDATE offers SET status='settled' WHERE circle_id=?")
        .run(id);
      // Signed transactions do not expire. Keep old outpoints reserved even after a reorg.
      return true;
    });
  }

  expire(): void {
    const pending = this.db
      .prepare(
        `SELECT id FROM circles WHERE expires_at<=?
      AND status IN ('preparing','awaiting_signatures')`,
      )
      .all(this.now());
    for (const row of pending)
      this.closeCircle(
        row.id as string,
        'expired',
        'The off-chain coordination window expired.',
      );
    this.db
      .prepare(
        "UPDATE offers SET status='expired' WHERE status='open' AND expires_at<=?",
      )
      .run(this.now());
  }

  close(): void {
    this.db.close();
  }
}
