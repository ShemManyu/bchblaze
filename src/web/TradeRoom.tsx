import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Download,
  LoaderCircle,
  Radio,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { explorerUrl, formatBch, shortHex } from '../shared/format.js';
import { validateProposal } from '../shared/transactions.js';
import type { Circle, Offer } from '../shared/types.js';
import { originalOffer } from './api.js';
import {
  AssetLabel,
  CircleGraph,
  CopyButton,
  Direction,
  Modal,
  SafetyNote,
  Status,
} from './components.js';

export function TradeRoom({
  circle,
  offers,
  walletConnected,
  busy,
  onClose,
  onConnect,
  onApprove,
  onSettle,
  onRefresh,
  onCancel,
  onExport,
  onCancelRequest,
  onCopy,
  currentNetwork,
  feedback,
}: {
  circle: Circle;
  offers: Offer[];
  walletConnected: boolean;
  busy: string | null;
  currentNetwork: Circle['network'];
  onClose: () => void;
  onConnect: () => void;
  onApprove: (circle: Circle, offerId: string) => Promise<void>;
  onSettle: () => void;
  onRefresh: () => void;
  onCancel: () => void;
  onExport: () => void;
  onCancelRequest: () => void;
  onCopy: () => void;
  feedback?: string;
}) {
  const mine = circle.participants.filter((participant) => participant.isMine);
  const defaultParticipant =
    mine.find((participant) => !participant.signed)?.offerId ??
    mine[0]?.offerId ??
    '';
  const [reviewFor, setReviewFor] = useState(defaultParticipant);
  const [acknowledged, setAcknowledged] = useState(false);
  const [cancelReview, setCancelReview] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
  }, [circle.proposal?.fingerprint, reviewFor]);
  const participant = circle.proposal?.participants.find(
    (item) => item.offerId === reviewFor,
  );
  const approval = circle.participants.find(
    (item) => item.offerId === reviewFor,
  );
  const original = originalOffer(reviewFor);
  const canCancel = ['preparing', 'awaiting_signatures'].includes(
    circle.status,
  );
  const signed = circle.participants.filter((item) => item.signed).length;
  const settled = ['broadcast', 'confirmed'].includes(circle.status);
  let valid = false;
  try {
    if (
      circle.proposal?.circleId === circle.id &&
      circle.proposal.network === circle.network
    ) {
      const expected = circle.proposal.participants.map(
        (item) =>
          originalOffer(item.offerId) ??
          offers.find((offer) => offer.id === item.offerId),
      );
      if (expected.every((offer): offer is Offer => Boolean(offer))) {
        validateProposal(circle.proposal, expected);
        valid = true;
      }
    }
  } catch {
    valid = false;
  }
  const shareUrl = new URL(
    `?circle=${circle.id}&network=${circle.network}`,
    location.origin,
  ).href;
  return (
    <Modal
      title={
        settled ? 'A good trade, full circle.' : 'Your circle is taking shape.'
      }
      wide
      onClose={onClose}
      closeDisabled={busy === 'wallet' || busy === 'approval'}
    >
      <div className="room-topline">
        <Status status={circle.status} />
        <span className={`network-label ${circle.network}`}>
          {circle.network === 'mainnet'
            ? 'REAL ASSETS / MAINNET'
            : 'TEST ASSETS / CHIPNET'}
        </span>
        <CopyButton
          value={shareUrl}
          label="Invite the other collectors"
          onCopy={onCopy}
        />
      </div>
      {canCancel && (
        <p className="field-help">
          This signing window closes at{' '}
          {new Date(circle.expiresAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
          . A fully signed transaction has no on-chain expiry.
        </p>
      )}
      <div className="room-columns">
        <section className="room-visual">
          <CircleGraph
            live
            settled={settled}
            people={circle.participants.map((item) => ({
              label: item.label,
              category: item.asset.category,
              signed: item.signed,
            }))}
          />
          <div className="approval-list">
            {circle.participants.map((item) => (
              <div key={item.offerId}>
                <span
                  className={`avatar ${item.signed ? 'avatar-approved' : ''}`}
                >
                  {item.signed ? (
                    <Check size={14} />
                  ) : (
                    item.label.slice(0, 1).toUpperCase()
                  )}
                </span>
                <strong>
                  {item.label}
                  {item.isMine && <span className="you-label">YOU</span>}
                </strong>
                <span>{item.signed ? 'Approved' : 'Not approved'}</span>
              </div>
            ))}
          </div>
          <p className="room-fact">
            <ShieldCheck size={15} />
            {settled
              ? 'The transaction moved all three NFTs together.'
              : 'No NFT moves before all three valid signatures exist.'}
          </p>
        </section>
        <section className="room-review">
          {mine.length > 1 && (
            <label className="field">
              Review for
              <select
                value={reviewFor}
                onChange={(event) => setReviewFor(event.target.value)}
              >
                {mine.map((item) => (
                  <option key={item.offerId} value={item.offerId}>
                    {item.label}
                    {item.signed ? ' (approved)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {participant ? (
            <>
              <h3>{approval?.label}'s exact trade</h3>
              <Direction send>
                <span>
                  You send
                  <AssetLabel {...participant.sendAsset} />
                </span>
              </Direction>
              <Direction>
                <span>
                  You receive
                  <AssetLabel {...participant.receiveAsset} />
                </span>
              </Direction>
              <dl className="trade-accounting">
                <div>
                  <dt>Your total BCH inputs</dt>
                  <dd>{formatBch(participant.inputSatoshis)}</dd>
                </div>
                <div>
                  <dt>BCH attached to your outgoing NFT</dt>
                  <dd>1,000 sats</dd>
                </div>
                <div>
                  <dt>BCH returned to you</dt>
                  <dd>{formatBch(participant.changeSatoshis)}</dd>
                </div>
                <div className="accounting-total">
                  <dt>Your network fee</dt>
                  <dd>{participant.feeSatoshis} sats</dd>
                </div>
              </dl>
              <p className="field-help">
                You also receive an NFT carrying 1,000 sats. Network fee only.
                No platform fee.
              </p>
              <details className="transaction-details">
                <summary>Inspect the exact assets and transaction</summary>
                <p>
                  <strong>Sending category / commitment</strong>
                  <AssetLabel {...participant.sendAsset} full />
                </p>
                <p>
                  <strong>Receiving category / commitment</strong>
                  <AssetLabel {...participant.receiveAsset} full />
                </p>
                <p>
                  <strong>Receiving address and BCH change</strong>
                  <code>{participant.receiveAddress}</code>
                </p>
                <p>
                  <strong>Proposal fingerprint</strong>
                  <code>{circle.proposal!.fingerprint}</code>
                </p>
                <p>
                  <strong>Total network fee</strong>{' '}
                  {circle.proposal!.feeSatoshis} sats
                </p>
                <p>
                  <strong>Maximum signed size</strong>{' '}
                  {circle.proposal!.maximumSignedSize} bytes
                </p>
                <p>
                  <strong>Unsigned transaction</strong>
                  <code>{circle.proposal!.unsignedTransaction}</code>
                </p>
              </details>
            </>
          ) : (
            <>
              <h3>Three collectors. Equal control.</h3>
              <p>
                This is a shared room. Only the browsers that published its
                offers can request or submit their own wallet signatures.
              </p>
              <SafetyNote>
                Open this link in the same browser that published your offer.
                Your browser session and your external wallet are both required.
              </SafetyNote>
            </>
          )}

          {circle.error && (
            <div role="status" className="warning-box">
              {circle.error}
            </div>
          )}
          {currentNetwork !== circle.network && (
            <p className="warning-box">
              This room is on {circle.network}. Close it and explicitly switch
              networks before approving or settling.
            </p>
          )}
          {circle.status === 'awaiting_signatures' &&
            participant &&
            !approval?.signed && (
              <>
                {!original && (
                  <p className="warning-box">
                    The original offer is not saved in this browser. Signing is
                    disabled rather than trusting a replacement supplied by the
                    coordinator.
                  </p>
                )}
                {original && !valid && (
                  <p className="warning-box">
                    The current proposal could not be independently matched to
                    the published offers. Do not sign it.
                  </p>
                )}
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    disabled={Boolean(busy)}
                  />
                  <span>
                    I reviewed the exact assets, receiving address, change, and
                    fee. All three signatures authorize this trade without an
                    on-chain expiry.
                  </span>
                </label>
                {walletConnected ? (
                  <button
                    className="button button-primary full-width"
                    type="button"
                    disabled={
                      !acknowledged ||
                      !valid ||
                      !original ||
                      Boolean(busy) ||
                      currentNetwork !== circle.network
                    }
                    onClick={() => {
                      void onApprove(circle, reviewFor);
                    }}
                  >
                    {busy === 'wallet' || busy === 'approval' ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <ShieldCheck size={17} />
                    )}
                    {busy === 'wallet'
                      ? 'Confirm in your wallet'
                      : busy === 'approval'
                        ? 'Submitting approval'
                        : 'Approve in wallet'}
                  </button>
                ) : (
                  <button
                    className="button button-primary full-width"
                    type="button"
                    onClick={onConnect}
                  >
                    <ArrowRight size={17} />
                    Connect your wallet to approve
                  </button>
                )}
              </>
            )}
          {circle.status === 'awaiting_signatures' && approval?.signed && (
            <div className="approval-confirmation">
              <Check size={18} />
              <div>
                <strong>Your approval is recorded.</strong>
                <p>
                  {signed} of 3 approvals. The other collectors must review and
                  sign the same transaction.
                </p>
              </div>
            </div>
          )}
          {['ready', 'broadcast_unknown'].includes(circle.status) &&
            mine.length > 0 && (
              <>
                <div className="approval-confirmation">
                  <ShieldCheck size={20} />
                  <div>
                    <strong>All three signatures are verified.</strong>
                    <p>
                      {circle.status === 'broadcast_unknown'
                        ? 'A retry sends only the identical signed transaction. It cannot create a second trade.'
                        : 'Any participant can broadcast the one complete transaction.'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="button button-primary full-width"
                  disabled={Boolean(busy) || currentNetwork !== circle.network}
                  onClick={onSettle}
                >
                  {busy === 'settle' ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <Radio size={18} />
                  )}
                  {circle.status === 'broadcast_unknown'
                    ? 'Check and retry same transaction'
                    : 'Settle the circle'}
                </button>
              </>
            )}
          {circle.status === 'broadcasting' && (
            <p className="approval-confirmation">
              <LoaderCircle className="spin" size={18} />
              Broadcasting the exact signed transaction.
            </p>
          )}
          {settled && (
            <div className="settlement-card">
              <span className="settlement-check">
                <Check size={28} />
              </span>
              <h3>
                {circle.status === 'confirmed'
                  ? 'Confirmed on-chain.'
                  : 'All three NFTs, one transaction.'}
              </h3>
              <p>
                {circle.status === 'confirmed'
                  ? `${circle.confirmations} confirmation${circle.confirmations === 1 ? '' : 's'}. Confirmation counts can change during a reorg.`
                  : 'Accepted into the mempool. Not yet confirmed or irreversible.'}
              </p>
              <a
                className="button button-secondary"
                href={explorerUrl(circle.network, circle.txid!)}
                target="_blank"
                rel="noreferrer"
              >
                View on block explorer
                <ArrowUpRight size={15} />
              </a>
            </div>
          )}
        </section>
      </div>
      <div className="room-bottom">
        <span className="mono">CIRCLE {shortHex(circle.id, 6)}</span>
        {circle.txid && (
          <span className="mono">
            TX {shortHex(circle.txid, 6)}
            <CopyButton
              value={circle.txid}
              label="Copy transaction ID"
              onCopy={onCopy}
            />
          </span>
        )}
        {busy === 'wallet' && (
          <button
            className="button button-quiet button-small"
            type="button"
            onClick={onCancelRequest}
          >
            Cancel wallet request
          </button>
        )}
      </div>
      {mine.length > 0 && (
        <div className="room-actions">
          {canCancel && !cancelReview && (
            <button
              type="button"
              className="button button-quiet button-small danger-text"
              disabled={Boolean(busy)}
              onClick={() => setCancelReview(true)}
            >
              Cancel this circle
            </button>
          )}
          {canCancel && cancelReview && (
            <div className="cancel-confirm">
              <span>
                Cancel coordination? Existing signatures cannot be
                cryptographically revoked.
              </span>
              <button
                type="button"
                className="button button-danger button-small"
                disabled={Boolean(busy)}
                onClick={onCancel}
              >
                Yes, cancel circle
              </button>
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={() => setCancelReview(false)}
              >
                Keep it
              </button>
            </div>
          )}
          <div className="room-action-end">
            {circle.txid && (
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={onExport}
                disabled={Boolean(busy)}
              >
                <Download size={14} />
                Export signed transaction
              </button>
            )}
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={onRefresh}
              disabled={Boolean(busy)}
            >
              <RefreshCw size={14} />
              Refresh chain status
            </button>
          </div>
        </div>
      )}
      {feedback && (
        <p className="inline-error" role="alert">
          {feedback}
        </p>
      )}
      <SafetyNote>
        Before the third approval, cancelling stops this coordinator and
        releases its reservations. It does not erase signed copies elsewhere.
        After all three approve, the transaction does not expire and
        cancellation is disabled.
      </SafetyNote>
    </Modal>
  );
}
