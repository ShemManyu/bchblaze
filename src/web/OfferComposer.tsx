import { useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, Wallet } from 'lucide-react';
import { nftAsset } from '../shared/bitcoin.js';
import { outpointKey } from '../shared/cycles.js';
import { formatBch } from '../shared/format.js';
import type {
  CreateOffer,
  Offer,
  WantedAsset,
  WalletUtxo,
} from '../shared/types.js';
import { AssetLabel, Modal, SafetyNote, TokenArt } from './components.js';

export function OfferComposer({
  utxos,
  offers,
  initialWanted,
  receiveAddress,
  network,
  busy,
  onClose,
  onSubmit,
  feedback,
}: {
  utxos: WalletUtxo[];
  offers: Offer[];
  initialWanted?: Offer;
  receiveAddress: string;
  network: CreateOffer['network'];
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    asset: WalletUtxo,
    wanted: WantedAsset,
    label: string,
  ) => Promise<void>;
  feedback?: string;
}) {
  const eligible = utxos.filter(
    (utxo) =>
      utxo.token?.nft?.capability === 'none' &&
      utxo.token.amount === '0' &&
      utxo.token.nft.commitment.length <= 80,
  );
  const available = eligible.filter(
    (utxo) =>
      !offers.some(
        (offer) =>
          offer.isMine &&
          ['open', 'reserved'].includes(offer.status) &&
          outpointKey(offer.asset) === outpointKey(utxo),
      ),
  );
  const [selection, setSelected] = useState('');
  const selected = available.some((utxo) => outpointKey(utxo) === selection)
    ? selection
    : available[0] && outpointKey(available[0]);
  const [label, setLabel] = useState('');
  const [wantedOfferId, setWantedOfferId] = useState(initialWanted?.id ?? '');
  const [category, setCategory] = useState('');
  const [commitment, setCommitment] = useState('');
  const [error, setError] = useState('');
  const candidates = offers.filter(
    (offer) =>
      offer.receiveAddress !== receiveAddress && offer.status === 'open',
  );
  const funding = utxos
    .filter((utxo) => !utxo.token)
    .reduce((sum, utxo) => sum + BigInt(utxo.satoshis), 0n);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const asset = available.find((utxo) => outpointKey(utxo) === selected);
    if (!asset)
      return setError('Choose an available NFT from your scanned wallet.');
    const target = candidates.find((offer) => offer.id === wantedOfferId);
    if (
      !target &&
      (!/^[0-9a-f]{64}$/i.test(category) ||
        !/^(?:[0-9a-f]{2}){0,40}$/i.test(commitment))
    ) {
      return setError(
        'Use a 64-character category ID and up to 40 bytes of hexadecimal commitment.',
      );
    }
    const wanted: WantedAsset = target
      ? {
          category: target.asset.category,
          commitment: target.asset.commitment,
          outpoint: { txid: target.asset.txid, vout: target.asset.vout },
        }
      : {
          category: category.toLowerCase(),
          commitment: commitment.toLowerCase(),
        };
    await onSubmit(asset, wanted, label.trim());
  }
  return (
    <Modal
      title="Start with what you have."
      wide
      onClose={onClose}
      closeDisabled={busy}
    >
      <form
        className="offer-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="composer-columns">
          <section>
            <div className="step-heading">
              <span>01</span>
              <h3>Your side of the trade</h3>
            </div>
            <label className="field">
              Collector name
              <input
                required
                maxLength={40}
                placeholder="How should others know you?"
                autoComplete="nickname"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <p className="field-title">Choose an immutable NFT</p>
            {available.length ? (
              <div
                className="inventory-grid"
                role="group"
                aria-label="Your available NFTs"
              >
                {available.map((utxo) => (
                  <button
                    type="button"
                    className={`inventory-option ${selected === outpointKey(utxo) ? 'selected' : ''}`}
                    aria-pressed={selected === outpointKey(utxo)}
                    aria-label={`Offer NFT ${utxo.token!.category}`}
                    key={outpointKey(utxo)}
                    onClick={() => setSelected(outpointKey(utxo))}
                  >
                    <TokenArt {...nftAsset(utxo)} compact />
                    <AssetLabel {...nftAsset(utxo)} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty compact-empty">
                <Wallet size={28} />
                <h3>No available immutable NFTs</h3>
                <p>
                  Scan more wallet addresses, receive an immutable CashToken, or
                  cancel an existing listing. Mutable NFTs, minting rights, and
                  fungible balances cannot be traded here.
                </p>
              </div>
            )}
            <div className="funding-note">
              <Wallet size={14} />
              <span>
                {formatBch(funding)} token-free fee funding in this scan
              </span>
            </div>
          </section>
          <section>
            <div className="step-heading">
              <span>02</span>
              <h3>The piece you are missing</h3>
            </div>
            <label className="field">
              I want
              <select
                value={wantedOfferId}
                onChange={(event) => setWantedOfferId(event.target.value)}
              >
                <option value="">Specify a CashToken</option>
                {candidates.map((offer) => (
                  <option value={offer.id} key={offer.id}>
                    {offer.label}'s NFT ({offer.asset.category.slice(0, 10)}...)
                  </option>
                ))}
              </select>
            </label>
            {wantedOfferId ? (
              (() => {
                const target = candidates.find(
                  (offer) => offer.id === wantedOfferId,
                );
                return target ? (
                  <div className="wanted-preview">
                    <TokenArt {...target.asset} />
                    <AssetLabel {...target.asset} />
                    <p>Matches this exact NFT outpoint, not another copy.</p>
                  </div>
                ) : (
                  <p className="inline-error">
                    This offer is no longer available. Choose another.
                  </p>
                );
              })()
            ) : (
              <>
                <label className="field">
                  Wanted category
                  <input
                    required
                    className="mono"
                    value={category}
                    onChange={(event) => setCategory(event.target.value.trim())}
                    placeholder="64-character token category ID"
                    minLength={64}
                    maxLength={64}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  Commitment (hex)
                  <input
                    className="mono"
                    value={commitment}
                    onChange={(event) =>
                      setCommitment(event.target.value.trim())
                    }
                    placeholder="Leave blank for an empty commitment"
                    maxLength={80}
                    spellCheck={false}
                  />
                </label>
                <p className="field-help">
                  Matches an immutable NFT with this category and commitment.
                  Different copies may exist. Select a listed item above to
                  request its exact outpoint.
                </p>
              </>
            )}
            <div className="quote-preview">
              <span>Network</span>
              <strong>
                {network === 'mainnet'
                  ? 'Mainnet: real assets'
                  : 'Chipnet: test assets'}
              </strong>
              <span>Expected network fee</span>
              <strong>1,000 to 1,545 sats / person</strong>
              <span>Platform fee</span>
              <strong>0 sats</strong>
            </div>
          </section>
        </div>
        <SafetyNote>
          An offer is an off-chain wish, not an escrow deposit. You will review
          the exact NFT, change, and fee in your wallet before anything can
          move. Listing an address is not proof of spending authority.
        </SafetyNote>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {feedback && (
          <p role="alert" className="inline-error">
            {feedback}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-quiet"
            onClick={onClose}
            disabled={busy}
          >
            Not yet
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || !available.length}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <ArrowRight size={17} />
            )}
            Publish offer
          </button>
        </div>
      </form>
    </Modal>
  );
}
