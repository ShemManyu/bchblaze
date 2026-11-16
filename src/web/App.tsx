import { useCallback, useEffect, useRef, useState } from 'react';
import { AlphanumericQRCode, useWizardConnect } from '@wizardconnect/react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleDashed,
  CircleHelp,
  CodeXml,
  ExternalLink,
  Layers3,
  Link2,
  LoaderCircle,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Unplug,
  Wallet,
  X,
} from 'lucide-react';
import { addressBytecode, nftAsset, tokenAddress } from '../shared/bitcoin.js';
import { outpointKey } from '../shared/cycles.js';
import { DomainError } from '../shared/errors.js';
import { formatBch, shortHex } from '../shared/format.js';
import type {
  AddressPath,
  Circle,
  CreateOffer,
  InventorySnapshot,
  MarketSnapshot,
  Network,
  NetworkStatus,
  Offer,
  PublicConfig,
  WantedAsset,
  WalletUtxo,
} from '../shared/types.js';
import {
  api,
  errorMessage,
  originalOffer,
  sameAsset,
  saveOriginalOffer,
} from './api.js';
import {
  AssetLabel,
  CircleGraph,
  CopyButton,
  Modal,
  SafetyNote,
  Status,
  TokenArt,
} from './components.js';
import { OfferComposer } from './OfferComposer.js';
import { Pitch } from './Pitch.js';
import { TradeRoom } from './TradeRoom.js';
import { receiveAddress, scanPaths, signSwap } from './wallet.js';

const emptyMarket: MarketSnapshot = { offers: [], cycles: [], circles: [] };
const initialRoom = () => {
  const id = new URLSearchParams(location.search).get('circle');
  return id && /^[0-9a-f-]{36}$/.test(id) ? id : null;
};
const sameWanted = (a: WantedAsset, b: WantedAsset) =>
  a.category === b.category &&
  a.commitment === b.commitment &&
  ((!a.outpoint && !b.outpoint) ||
    (a.outpoint &&
      b.outpoint &&
      outpointKey(a.outpoint) === outpointKey(b.outpoint)));

export function App({ config }: { config: PublicConfig }) {
  const [network, setNetwork] = useState<Network>('chipnet');
  const [mainnetConfirmed, setMainnetConfirmed] = useState(false);
  const [mainnetDialog, setMainnetDialog] = useState(false);
  const [mainnetCheckbox, setMainnetCheckbox] = useState(false);
  const wallet = useWizardConnect({
    dappName: 'SwapCircle',
    sessionKey: `swapcircle-wizard-${network}`,
    relayUrls: config.relayUrls.length ? config.relayUrls : undefined,
  });
  const connected = wallet.state === 'connected';
  const [showWallet, setShowWallet] = useState(false);
  const [composeAfterConnect, setComposeAfterConnect] = useState(false);
  const [offerDialog, setOfferDialog] = useState(false);
  const [initialWanted, setInitialWanted] = useState<Offer>();
  const [pitch, setPitch] = useState(location.hash === '#pitch');
  const [how, setHow] = useState(false);
  const [market, setMarket] = useState<MarketSnapshot>(emptyMarket);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketError, setMarketError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>();
  const [roomId, setRoomId] = useState<string | null>(initialRoom);
  const [room, setRoom] = useState<Circle>();
  const [inventory, setInventory] = useState<InventorySnapshot>();
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState('');
  const [addressPaths, setAddressPaths] = useState<AddressPath[]>([]);
  const [address, setAddress] = useState('');
  const [scanStart, setScanStart] = useState(0);
  const [scanInput, setScanInput] = useState('0');
  const [scanKey, setScanKey] = useState(0);
  const [tab, setTab] = useState<'market' | 'mine' | 'rooms'>('market');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    type: 'success' | 'error';
    text: string;
  }>();
  const signatureAbort = useRef<AbortController | null>(null);
  const refresh = () => setRefreshKey((value) => value + 1);
  const updateRoom = useCallback((next: Circle) => {
    setRoom((previous) =>
      previous?.id === next.id && previous.version > next.version
        ? previous
        : next,
    );
    setMarket((previous) => ({
      ...previous,
      circles: previous.circles.map((item) =>
        item.id === next.id && item.version < next.version ? next : item,
      ),
    }));
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let running = false;
    async function load() {
      if (running) return;
      running = true;
      try {
        const snapshot = await api<MarketSnapshot>(
          `/market?network=${network}`,
          { signal: abort.signal },
        );
        if (!active) return;
        setMarket((previous) => ({
          ...snapshot,
          circles: snapshot.circles.map((item) => {
            const existing = previous.circles.find(
              (candidate) => candidate.id === item.id,
            );
            return existing && existing.version > item.version
              ? existing
              : item;
          }),
        }));
        setMarketLoading(false);
        setMarketError('');
        if (roomId) {
          const current =
            snapshot.circles.find((item) => item.id === roomId) ??
            (await api<Circle>(`/circles/${roomId}`, { signal: abort.signal }));
          if (active) updateRoom(current);
        }
      } catch (error) {
        if (active) {
          setMarketLoading(false);
          setMarketError(errorMessage(error));
        }
      } finally {
        running = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 5_000);
    return () => {
      active = false;
      abort.abort();
      clearInterval(timer);
    };
  }, [network, roomId, refreshKey, updateRoom]);

  useEffect(() => {
    const abort = new AbortController();
    setNetworkStatus(undefined);
    void api<NetworkStatus>(`/network/${network}`, { signal: abort.signal })
      .then(setNetworkStatus)
      .catch(() => undefined);
    return () => abort.abort();
  }, [network]);

  useEffect(() => {
    const abort = new AbortController();
    if (!connected || !wallet.manager) {
      setInventory(undefined);
      setAddressPaths([]);
      setAddress('');
      return;
    }
    setInventoryLoading(true);
    setInventoryError('');
    let paths: AddressPath[];
    try {
      setAddress(receiveAddress(wallet.manager, network));
      paths = scanPaths(wallet.manager, network, scanStart);
      setAddressPaths(paths);
    } catch (error) {
      setInventoryError(errorMessage(error));
      setInventoryLoading(false);
      return;
    }
    void api<InventorySnapshot>('/wallet/inventory', {
      body: { network, addressPaths: paths },
      signal: abort.signal,
    })
      .then((result) => {
        if (!abort.signal.aborted) setInventory(result);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setInventoryError(errorMessage(error));
      })
      .finally(() => {
        if (!abort.signal.aborted) setInventoryLoading(false);
      });
    return () => abort.abort();
  }, [connected, wallet.manager, network, scanStart, scanKey]);

  useEffect(() => {
    if (!connected) return;
    setShowWallet(false);
    if (composeAfterConnect) {
      setOfferDialog(true);
      setComposeAfterConnect(false);
    }
  }, [connected, composeAfterConnect]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(
      () => setNotice(undefined),
      notice.type === 'error' ? 12_000 : 6_000,
    );
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => signatureAbort.current?.abort(), []);

  async function run(name: string, operation: () => Promise<void>) {
    setBusy(name);
    setNotice(undefined);
    try {
      await operation();
    } catch (error) {
      setNotice({ type: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
      refresh();
    }
  }
  function connect() {
    setShowWallet(true);
    if (!['connected', 'connecting', 'reconnecting'].includes(wallet.state))
      wallet.connect();
  }
  function compose(wanted?: Offer) {
    setInitialWanted(wanted);
    if (connected) setOfferDialog(true);
    else {
      setComposeAfterConnect(true);
      connect();
    }
  }
  function selectRoom(next: Circle) {
    setRoomId(next.id);
    updateRoom(next);
    history.replaceState(
      null,
      '',
      `?circle=${next.id}&network=${next.network}`,
    );
  }
  function closeRoom() {
    setRoomId(null);
    setRoom(undefined);
    history.replaceState(null, '', location.pathname);
  }
  function copied() {
    setNotice({ type: 'success', text: 'Copied to clipboard.' });
  }
  async function changeNetwork(next: Network) {
    if (busy) return;
    if (next === 'mainnet') {
      setMainnetCheckbox(false);
      setMainnetDialog(true);
      return;
    }
    await wallet.disconnect();
    setNetwork(next);
    setMarket(emptyMarket);
    setMarketLoading(true);
    setMainnetConfirmed(false);
    setScanStart(0);
    setScanInput('0');
  }
  async function publish(
    asset: WalletUtxo,
    wanted: WantedAsset,
    label: string,
  ) {
    await run('offer', async () => {
      if (!wallet.manager || !address || !connected)
        throw new DomainError('WALLET_REQUIRED', 'Connect your wallet first.');
      const request: CreateOffer = {
        network,
        receiveAddress: address,
        addressPaths,
        offered: { txid: asset.txid, vout: asset.vout },
        wanted,
        label,
      };
      const saved = await api<Offer>('/offers', {
        body: request,
        mainnet: mainnetConfirmed,
      });
      if (
        saved.network !== network ||
        saved.receiveAddress !==
          tokenAddress(addressBytecode(address, network), network) ||
        !sameAsset(saved.asset, nftAsset(asset)) ||
        !sameWanted(saved.wanted, wanted)
      ) {
        throw new DomainError(
          'OFFER_CHANGED',
          'The coordinator returned an altered offer. Do not sign a trade for it.',
        );
      }
      saveOriginalOffer({
        ...saved,
        asset: nftAsset(asset),
        wanted,
        receiveAddress: address,
      });
      setOfferDialog(false);
      setTab('mine');
      setNotice({
        type: 'success',
        text: 'Your wish is live. A matching third collector can close the loop.',
      });
    });
  }
  async function approve(circle: Circle, offerId: string) {
    await run('wallet', async () => {
      if (!wallet.manager || !connected || !circle.proposal)
        throw new DomainError(
          'WALLET_REQUIRED',
          'Connect your wallet before approving.',
        );
      if (
        circle.proposal.circleId !== circle.id ||
        circle.proposal.network !== circle.network ||
        circle.network !== network
      ) {
        throw new DomainError(
          'WRONG_CIRCLE',
          'The proposal does not belong to this room and selected network.',
        );
      }
      const original = originalOffer(offerId);
      if (!original)
        throw new DomainError(
          'ORIGINAL_OFFER_MISSING',
          'Your original offer is not saved in this browser.',
        );
      const expected = circle.proposal.participants.map(
        (participant) =>
          originalOffer(participant.offerId) ??
          market.offers.find((offer) => offer.id === participant.offerId),
      );
      if (!expected.every((offer): offer is Offer => Boolean(offer))) {
        throw new DomainError(
          'OFFERS_UNAVAILABLE',
          'Refresh the market and review all three original offers.',
        );
      }
      const abort = new AbortController();
      signatureAbort.current = abort;
      try {
        const signedTransaction = await signSwap(
          wallet.manager,
          circle.proposal,
          expected,
          offerId,
          abort.signal,
        );
        abort.signal.throwIfAborted();
        setBusy('approval');
        const next = await api<Circle>(`/circles/${circle.id}/approve`, {
          body: {
            offerId,
            fingerprint: circle.proposal.fingerprint,
            signedTransaction,
          },
          mainnet: mainnetConfirmed,
        });
        updateRoom(next);
        setNotice({
          type: 'success',
          text: 'Your signature is verified. Spending keys stayed in your wallet.',
        });
      } finally {
        signatureAbort.current = null;
      }
    });
  }
  async function exportTransaction() {
    if (!room) return;
    await run('export', async () => {
      const result = await api<{ signedTransaction: string; txid: string }>(
        `/circles/${room.id}/transaction`,
      );
      const blob = new Blob(
        [
          JSON.stringify(
            { network: room.network, circleId: room.id, ...result },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `swapcircle-${room.id}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice({
        type: 'success',
        text: 'Signed transaction exported. Anyone with this file can broadcast this exact trade.',
      });
    });
  }
  const openOffers = market.offers.filter((offer) => offer.status === 'open');
  const mine = market.offers.filter((offer) => offer.isMine);
  const displayedOffers = tab === 'mine' ? mine : openOffers;
  const myCycles = market.cycles.filter((cycle) =>
    cycle.offers.some((offer) => offer.isMine),
  );
  const activeCircles = market.circles.filter(
    (circle) => !['cancelled', 'expired', 'failed'].includes(circle.status),
  );
  const nftCount =
    inventory?.utxos.filter(
      (utxo) =>
        utxo.token?.nft?.capability === 'none' && utxo.token.amount === '0',
    ).length ?? 0;
  const balance =
    inventory?.utxos
      .filter((utxo) => !utxo.token)
      .reduce((sum, utxo) => sum + BigInt(utxo.satoshis), 0n) ?? 0n;

  return (
    <>
      <a className="skip-link" href="#market">
        Skip to marketplace
      </a>
      <div
        className={`event-banner ${config.mode === 'local-demo' ? 'demo-banner' : ''}`}
      >
        <div>
          <span className="event-dot" />
          <strong>
            {config.mode === 'local-demo'
              ? 'LOCAL DEMO LEDGER'
              : 'BUILT FOR BCH BLAZE 2026'}
          </strong>
          <span className="event-description">
            {config.mode === 'local-demo'
              ? 'Ephemeral test assets. No real blockchain funds.'
              : 'A new way to trade what you already have.'}
          </span>
        </div>
        <div className="banner-links">
          {config.mode === 'local-demo' && (
            <a href="/demo" target="_blank" rel="noreferrer">
              Test wallets
              <ArrowUpRight size={12} />
            </a>
          )}
          <a
            href="#pitch"
            onClick={(event) => {
              event.preventDefault();
              setPitch(true);
            }}
          >
            The pitch
            <ArrowUpRight size={12} />
          </a>
          <a
            href="https://github.com/ShemManyu/bchblaze"
            target="_blank"
            rel="noreferrer"
          >
            Source
            <CodeXml size={12} />
          </a>
          <span
            className={config.prizeAddress ? 'prize-configured' : undefined}
            title={
              config.prizeAddress ||
              'The repository owner has not configured a prize address.'
            }
          >
            {config.prizeAddress ? (
              <>
                Prize address{' '}
                <CopyButton
                  value={config.prizeAddress}
                  label={shortHex(config.prizeAddress, 5)}
                  onCopy={copied}
                />
              </>
            ) : (
              'Prize address: not configured'
            )}
          </span>
        </div>
      </div>
      <div className="shell">
        <header className="site-header">
          <a className="brand" href="/" aria-label="SwapCircle home">
            <span className="brand-icon">
              <CircleDashed size={27} strokeWidth={2.2} />
              <ArrowUpRight size={14} />
            </span>
            SwapCircle<span className="beta">BETA</span>
          </a>
          <nav className="desktop-nav" aria-label="Primary navigation">
            <a href="#market" onClick={() => setTab('market')}>
              The wish board
            </a>
            <button type="button" onClick={() => setHow(true)}>
              How it works
            </button>
          </nav>
          <div className="header-actions">
            <label className={`network-select ${network}`}>
              <span className="sr-only">BCH network</span>
              <span className="network-dot" />
              <select
                aria-label="BCH network"
                value={network}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  void changeNetwork(event.target.value as Network);
                }}
              >
                <option value="chipnet">Chipnet</option>
                <option value="mainnet">Mainnet</option>
              </select>
              <ChevronDown size={12} />
            </label>
            <button
              className={`button ${connected ? 'button-secondary' : 'button-primary'} wallet-button`}
              type="button"
              onClick={connect}
              disabled={Boolean(busy)}
            >
              <Wallet size={16} />
              <span>
                {connected
                  ? shortHex(address || 'Connected', 4)
                  : wallet.state === 'reconnecting'
                    ? 'Reconnecting'
                    : 'Connect wallet'}
              </span>
              {connected && <span className="connected-dot" />}
            </button>
          </div>
        </header>
        {network === 'mainnet' && (
          <div className="mainnet-strip">
            <Radio size={16} />
            <strong>Mainnet uses real BCH and CashTokens.</strong>
            <span>
              Experimental software. Start with low-value assets. Never share a
              seed phrase.
            </span>
          </div>
        )}
        <main>
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">
                <span className="tiny-orbit" />
                THE THIRD SIDE OF A GOOD TRADE
              </p>
              <h1>
                Good trades
                <br />
                come <span>full circle.</span>
              </h1>
              <p className="hero-description">
                You want theirs. They want someone else's.
                <br className="desktop-only" /> Bring a third collector into the
                loop and trade all three CashTokens in one atomic transaction.
              </p>
              <div className="hero-actions">
                <button
                  type="button"
                  className="button button-primary button-large"
                  onClick={() => compose()}
                >
                  Find my circle
                  <ArrowUpRight size={19} />
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setHow(true)}
                >
                  <CircleHelp size={17} />
                  Wait, how does this work?
                </button>
              </div>
              <div className="hero-proof">
                <span>
                  <ShieldCheck size={14} />
                  No escrow
                </span>
                <span>
                  <Wallet size={14} />
                  Your keys, your wallet
                </span>
                <span>
                  <Link2 size={14} />
                  Native CashTokens
                </span>
              </div>
            </div>
            <div className="hero-graphic">
              <span className="graphic-caption">
                <span className="live-dot" />
                THE CIRCLE EFFECT <span>ILLUSTRATIVE EXAMPLE</span>
              </span>
              <CircleGraph />
              <div className="graph-footnote">
                <span>
                  <Layers3 size={15} />3 collectors
                </span>
                <span className="footnote-line" />
                <span>
                  <Link2 size={15} />1 atomic transaction
                </span>
              </div>
            </div>
          </section>
          <section className="principle-strip" aria-label="Trading principles">
            <div>
              <span>01</span>
              <p>
                <strong>A wish, not a deposit.</strong>
                <br />
                Your NFT stays in your wallet until settlement.
              </p>
            </div>
            <div>
              <span>02</span>
              <p>
                <strong>Everyone gets their missing piece.</strong>
                <br />
                We match a complete three-way circle.
              </p>
            </div>
            <div>
              <span>03</span>
              <p>
                <strong>All three move. Or none do.</strong>
                <br />
                Three approvals. One exact transaction.
              </p>
            </div>
          </section>
          <section className="market-section" id="market">
            <div className="section-heading">
              <div>
                <p className="eyebrow">
                  A LITTLE LESS FRICTION. A LOT MORE POSSIBILITY.
                </p>
                <h2>
                  The wish board<span className="heading-dot">.</span>
                </h2>
              </div>
              <span className="live-label">
                <span
                  className={
                    networkStatus?.available ? 'live-dot' : 'offline-dot'
                  }
                />
                {config.mode === 'local-demo'
                  ? 'Local fixture chain'
                  : networkStatus?.available
                    ? `${network} node connected`
                    : networkStatus
                      ? 'Node unavailable'
                      : 'Checking node'}
              </span>
            </div>
            <div className="market-layout">
              <div className="market-main">
                <div className="market-toolbar">
                  <div
                    className="tabs"
                    role="tablist"
                    aria-label="Marketplace view"
                  >
                    {(
                      [
                        ['market', 'All wishes', openOffers.length],
                        ['mine', 'My offers', mine.length],
                        ['rooms', 'My circles', activeCircles.length],
                      ] as const
                    ).map(([id, title, count]) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        aria-controls="market-panel"
                        id={`tab-${id}`}
                        className={tab === id ? 'active' : ''}
                        key={id}
                        onClick={() => setTab(id)}
                      >
                        {title}
                        <span>{count}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Refresh market"
                    onClick={refresh}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
                {marketError && (
                  <div className="warning-box" role="alert">
                    {marketError}
                    <button
                      type="button"
                      className="button button-quiet button-small"
                      onClick={refresh}
                    >
                      Try again
                    </button>
                  </div>
                )}
                <div
                  id="market-panel"
                  role="tabpanel"
                  aria-labelledby={`tab-${tab}`}
                >
                  {marketLoading ? (
                    <div className="empty">
                      <LoaderCircle size={30} className="spin" />
                      <h3>Finding the open wishes...</h3>
                      <p>Loading actual offers from the coordinator.</p>
                    </div>
                  ) : tab === 'rooms' ? (
                    market.circles.length ? (
                      <div className="room-list">
                        {market.circles.map((circle) => (
                          <button
                            type="button"
                            className="room-card"
                            key={circle.id}
                            onClick={() => selectRoom(circle)}
                          >
                            <div className="room-card-icon">
                              <CircleDashed size={26} />
                            </div>
                            <div>
                              <h3>
                                {circle.participants
                                  .map((participant) => participant.label)
                                  .join(' + ')}
                              </h3>
                              <p>
                                {
                                  circle.participants.filter(
                                    (participant) => participant.signed,
                                  ).length
                                }{' '}
                                of 3 approved<span>/</span>
                                <span className="mono">
                                  {shortHex(circle.id, 4)}
                                </span>
                              </p>
                            </div>
                            <Status status={circle.status} />
                            <ArrowUpRight size={18} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="empty">
                        <CircleDashed size={35} />
                        <h3>Your next trade starts with a wish.</h3>
                        <p>
                          Post an offer. When three wants line up, your shared
                          signing room appears here.
                        </p>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => compose()}
                        >
                          Create my first offer
                          <Plus size={16} />
                        </button>
                      </div>
                    )
                  ) : displayedOffers.length ? (
                    <div className="offer-grid">
                      {displayedOffers.map((offer) => (
                        <article
                          className={`offer-card ${offer.status !== 'open' ? 'offer-inactive' : ''}`}
                          key={offer.id}
                        >
                          <div className="offer-art">
                            <TokenArt {...offer.asset} />
                            <span className="asset-kind">IMMUTABLE NFT</span>
                            {offer.isMine && (
                              <span className="mine-tag">YOUR OFFER</span>
                            )}
                          </div>
                          <div className="offer-body">
                            <div className="offer-author">
                              <span className="avatar">
                                {offer.label.slice(0, 1).toUpperCase()}
                              </span>
                              <strong>{offer.label}</strong>
                              <span>
                                {offer.status === 'open'
                                  ? 'has a wish'
                                  : offer.status}
                              </span>
                            </div>
                            <AssetLabel {...offer.asset} />
                            <div className="offer-wants">
                              <ArrowDownLeft size={16} />
                              <div>
                                <span>WANTS TO RECEIVE</span>
                                <AssetLabel {...offer.wanted} />
                                {offer.wanted.outpoint && (
                                  <small>Exact NFT outpoint requested</small>
                                )}
                              </div>
                            </div>
                            <footer>
                              {offer.isMine ? (
                                offer.circleId ? (
                                  <button
                                    type="button"
                                    className="button button-secondary button-small"
                                    onClick={() => {
                                      setRoomId(offer.circleId!);
                                      refresh();
                                    }}
                                  >
                                    Open circle
                                    <ArrowUpRight size={14} />
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="button button-quiet button-small"
                                    disabled={
                                      Boolean(busy) || offer.status !== 'open'
                                    }
                                    onClick={() => {
                                      void run('cancel-offer', async () => {
                                        await api(`/offers/${offer.id}`, {
                                          method: 'DELETE',
                                          body: {},
                                        });
                                        setNotice({
                                          type: 'success',
                                          text: 'Offer cancelled. No on-chain transaction was created.',
                                        });
                                      });
                                    }}
                                  >
                                    {offer.status === 'open'
                                      ? 'Cancel offer'
                                      : offer.status}
                                  </button>
                                )
                              ) : (
                                <button
                                  className="button button-quiet button-small"
                                  type="button"
                                  disabled={offer.status !== 'open'}
                                  onClick={() => compose(offer)}
                                >
                                  I want this one
                                  <ArrowUpRight size={14} />
                                </button>
                              )}
                              <span className="offer-chain">BCH / CT</span>
                            </footer>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="empty empty-board">
                      <div className="empty-orbit">
                        <CircleDashed size={43} />
                        <Plus size={17} />
                      </div>
                      <span className="eyebrow">
                        SPACE FOR YOUR NEXT GOOD TRADE
                      </span>
                      <h3>
                        {tab === 'mine'
                          ? 'Your wish belongs here.'
                          : 'Every circle begins with one wish.'}
                      </h3>
                      <p>
                        No{' '}
                        {tab === 'mine'
                          ? 'offers from this browser'
                          : 'open offers on this network'}{' '}
                        yet. Bring something you have.
                        <br />
                        Tell the community what you want.
                      </p>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => compose()}
                      >
                        Make the first move
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  )}
                </div>
                <p className="board-footnote">
                  <ShieldCheck size={13} />
                  Listings are discovery wishes. Only valid wallet signatures
                  establish spending authority. Identicons are generated from
                  token IDs, not collection artwork.
                </p>
              </div>
              <aside className="market-sidebar">
                <section className="sidebar-card wallet-panel">
                  <header>
                    <span className="eyebrow">YOUR SIDE OF THE CIRCLE</span>
                    <Wallet size={17} />
                  </header>
                  {connected ? (
                    <>
                      <div className="wallet-name">
                        <span className="connected-dot" />
                        {wallet.walletName || 'External wallet'}
                        <button
                          className="icon-button"
                          type="button"
                          aria-label="Disconnect wallet"
                          disabled={Boolean(busy)}
                          onClick={() => {
                            void wallet.disconnect();
                          }}
                        >
                          <Unplug size={15} />
                        </button>
                      </div>
                      <p className="wallet-address mono">
                        {shortHex(address, 7)}
                        <CopyButton
                          value={address}
                          label="Copy address"
                          onCopy={copied}
                        />
                      </p>
                      <div className="wallet-metrics">
                        <div>
                          <span>IMMUTABLE NFTs</span>
                          <strong>
                            {inventoryLoading ? (
                              <LoaderCircle size={18} className="spin" />
                            ) : (
                              nftCount
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>FEE FUNDING</span>
                          <strong>
                            {inventoryLoading
                              ? 'Scanning...'
                              : formatBch(balance)}
                          </strong>
                        </div>
                      </div>
                      {inventoryError && (
                        <p className="inline-error">{inventoryError}</p>
                      )}
                      {inventory?.truncated && (
                        <p className="warning-box">
                          Only the first 500 UTXOs are shown. This is a partial
                          inventory.
                        </p>
                      )}
                      <details className="scan-settings">
                        <summary>
                          Scanned receive/change indexes {scanStart} to{' '}
                          {scanStart + 19}
                        </summary>
                        <p>
                          Only these 40 addresses are checked. Other wallet
                          paths and indexes are not discovered.
                        </p>
                        <label className="field">
                          Start index
                          <input
                            type="number"
                            min={0}
                            max={9981}
                            value={scanInput}
                            onChange={(event) =>
                              setScanInput(event.target.value)
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          disabled={inventoryLoading || Boolean(busy)}
                          onClick={() => {
                            const start = Number(scanInput);
                            if (
                              !Number.isInteger(start) ||
                              start < 0 ||
                              start > 9981
                            )
                              return setNotice({
                                type: 'error',
                                text: 'Choose a start index between 0 and 9981.',
                              });
                            setScanStart(start);
                            setScanKey((value) => value + 1);
                          }}
                        >
                          <RefreshCw size={13} />
                          Scan this range
                        </button>
                      </details>
                      <button
                        className="button button-primary full-width"
                        type="button"
                        disabled={inventoryLoading || Boolean(busy)}
                        onClick={() => compose()}
                      >
                        <Plus size={16} />
                        Make an offer
                      </button>
                    </>
                  ) : (
                    <>
                      <h3>
                        Your wallet.
                        <br />
                        Your missing piece.
                      </h3>
                      <p>
                        Connect an external BCH wallet to scan your CashTokens
                        and post a wish. No seed phrases. Ever.
                      </p>
                      <button
                        className="button button-primary full-width"
                        type="button"
                        onClick={connect}
                      >
                        <Wallet size={16} />
                        Connect wallet
                      </button>
                      <span className="wallet-provider">
                        POWERED BY WIZARDCONNECT
                      </span>
                    </>
                  )}
                </section>
                <section
                  className={`sidebar-card matches-panel ${myCycles.length ? 'has-matches' : ''}`}
                >
                  <header>
                    <span className="eyebrow">CIRCLES THAT FIT</span>
                    <Sparkles size={17} />
                  </header>
                  {myCycles.length ? (
                    <>
                      <h3>
                        {myCycles.length} circle
                        {myCycles.length === 1 ? '' : 's'} found.
                      </h3>
                      <p>
                        All three wants line up. Open a shared room to check
                        inputs and collect approvals.
                      </p>
                      {myCycles.slice(0, 5).map((cycle) => (
                        <div className="match-card" key={cycle.id}>
                          <div>
                            {cycle.offers.map((offer, index) => (
                              <span key={offer.id}>
                                {index > 0 && (
                                  <span className="match-plus">+</span>
                                )}
                                {offer.label}
                              </span>
                            ))}
                          </div>
                          <button
                            type="button"
                            className="button button-secondary full-width"
                            disabled={Boolean(busy)}
                            onClick={() => {
                              void run('prepare', async () => {
                                const circle = await api<Circle>('/circles', {
                                  body: {
                                    offerIds: cycle.offers.map(
                                      (offer) => offer.id,
                                    ),
                                  },
                                  mainnet: mainnetConfirmed,
                                });
                                selectRoom(circle);
                                setTab('rooms');
                              });
                            }}
                          >
                            {busy === 'prepare' ? (
                              <LoaderCircle size={16} className="spin" />
                            ) : (
                              <CircleDashed size={16} />
                            )}
                            Build this circle
                            <ArrowUpRight size={14} />
                          </button>
                        </div>
                      ))}
                    </>
                  ) : (
                    <>
                      <div className="mini-circles">
                        <span />
                        <span />
                        <span />
                      </div>
                      <h3>The third side is out there.</h3>
                      <p>
                        When your wish completes a three-person loop, it appears
                        here. No matching bilateral trade needed.
                      </p>
                      <span className="muted-tiny">
                        {market.cycles.length} total open circles on {network}
                      </span>
                    </>
                  )}
                </section>
              </aside>
            </div>
          </section>
          <section className="bottom-statement">
            <span className="eyebrow">BUILT ON BITCOIN CASH</span>
            <h2>
              Not another marketplace.
              <br />
              <span>Another way to make a trade.</span>
            </h2>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => setPitch(true)}
            >
              Meet the idea behind SwapCircle
              <ArrowUpRight size={16} />
            </button>
          </section>
        </main>
        <footer className="site-footer">
          <span className="brand footer-brand">
            <CircleDashed size={20} />
            SwapCircle
          </span>
          <span>Three collectors. One atomic transaction.</span>
          <div>
            <button type="button" onClick={() => setHow(true)}>
              Trust & limitations
            </button>
            <a
              href="https://github.com/ShemManyu/bchblaze"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
              <ArrowUpRight size={12} />
            </a>
            <span>Built at BCH BLAZE</span>
          </div>
        </footer>
      </div>
      {notice && (
        <div
          className={`toast toast-${notice.type}`}
          role={notice.type === 'error' ? 'alert' : 'status'}
        >
          {notice.type === 'success' ? (
            <Check size={17} />
          ) : (
            <CircleHelp size={17} />
          )}
          <span>{notice.text}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(undefined)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {offerDialog && (
        <OfferComposer
          utxos={inventory?.utxos ?? []}
          offers={market.offers}
          initialWanted={initialWanted}
          receiveAddress={address}
          network={network}
          busy={busy === 'offer'}
          onClose={() => setOfferDialog(false)}
          onSubmit={publish}
          feedback={notice?.type === 'error' ? notice.text : undefined}
        />
      )}
      {roomId && room?.id === roomId && (
        <TradeRoom
          key={room.id}
          circle={room}
          offers={market.offers}
          walletConnected={connected}
          busy={busy}
          currentNetwork={network}
          onClose={closeRoom}
          onConnect={connect}
          onApprove={approve}
          onCopy={copied}
          onCancelRequest={() => signatureAbort.current?.abort()}
          feedback={notice?.type === 'error' ? notice.text : undefined}
          onSettle={() => {
            void run('settle', async () => {
              updateRoom(
                await api<Circle>(`/circles/${room.id}/settle`, {
                  body: {},
                  mainnet: mainnetConfirmed,
                }),
              );
              setScanKey((value) => value + 1);
            });
          }}
          onRefresh={() => {
            void run('refresh', async () => {
              updateRoom(
                await api<Circle>(`/circles/${room.id}/refresh`, { body: {} }),
              );
              setScanKey((value) => value + 1);
            });
          }}
          onCancel={() => {
            void run('cancel', async () => {
              updateRoom(
                await api<Circle>(`/circles/${room.id}/cancel`, { body: {} }),
              );
            });
          }}
          onExport={() => {
            void exportTransaction();
          }}
        />
      )}
      {showWallet && (
        <Modal
          title={
            connected ? 'Your wallet is connected.' : 'Your keys stay with you.'
          }
          onClose={() => {
            setShowWallet(false);
            setComposeAfterConnect(false);
          }}
        >
          {connected ? (
            <>
              <p className="wallet-modal-name">
                <span className="connected-dot" />
                {wallet.walletName}
              </p>
              <code className="address-block">{address}</code>
              <SafetyNote>
                SwapCircle stores relay session credentials and wallet public
                paths in this browser to reconnect. The server sees only scanned
                addresses and listings, never your xpub or spending keys.
              </SafetyNote>
              <div className="modal-actions">
                <CopyButton
                  value={address}
                  label="Copy receiving address"
                  onCopy={copied}
                />
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    void wallet.disconnect();
                  }}
                >
                  Disconnect
                  <Unplug size={15} />
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="modal-intro">
                Scan with a WizardConnect-compatible wallet, or open the link on
                this device. Choose a <strong>{network}</strong> wallet account.
                SwapCircle will never ask for your seed.
              </p>
              {wallet.qrUri ? (
                <>
                  <div className="qr-box" data-testid="wallet-qr">
                    <AlphanumericQRCode value={wallet.qrUri} size={252} />
                  </div>
                  <a
                    className="button button-primary full-width"
                    href={wallet.uri!}
                  >
                    Open in wallet
                    <ExternalLink size={16} />
                  </a>
                  <div className="pairing-uri">
                    <input
                      readOnly
                      aria-label="Wallet pairing URI"
                      value={wallet.uri ?? ''}
                    />
                    <CopyButton
                      value={wallet.uri!}
                      label="Copy"
                      onCopy={copied}
                    />
                  </div>
                  <p className="relay-state">
                    <LoaderCircle className="spin" size={14} />
                    {wallet.state === 'reconnecting'
                      ? 'Reconnecting to encrypted relay...'
                      : 'Waiting for your wallet...'}
                  </p>
                </>
              ) : (
                <button
                  type="button"
                  className="button button-primary full-width"
                  onClick={() => wallet.connect()}
                >
                  Create a pairing link
                  <ArrowRight size={15} />
                </button>
              )}
              {wallet.error && (
                <p role="alert" className="inline-error">
                  The relay could not connect. Close this dialog, disconnect if
                  needed, and try again.
                </p>
              )}
              <SafetyNote>
                Your wallet must support partial P2PKH signing with
                SIGHASH_UTXOS (0x61) and token-aware outputs. If it does not,
                SwapCircle rejects its signatures rather than weakening approval
                rules. Your wallet must never auto-broadcast a partial trade.
              </SafetyNote>
            </>
          )}
        </Modal>
      )}
      {mainnetDialog && (
        <Modal
          title="This is real-value territory."
          onClose={() => setMainnetDialog(false)}
        >
          <div className="mainnet-icon">
            <Radio size={29} />
          </div>
          <p>
            Mainnet trades spend real BCH and transfer real CashTokens.
            SwapCircle is experimental, has not been independently audited, and
            cannot undo a confirmed trade.
          </p>
          <SafetyNote>
            Use Chipnet first. Never share a seed phrase. All three valid
            approvals create a transaction that has no on-chain expiry.
          </SafetyNote>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={mainnetCheckbox}
              onChange={(event) => setMainnetCheckbox(event.target.checked)}
            />
            <span>
              I understand this uses real funds and accept the risks of
              experimental, unaudited software.
            </span>
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button button-quiet"
              onClick={() => setMainnetDialog(false)}
            >
              Stay on Chipnet
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={!mainnetCheckbox}
              onClick={() => {
                void run('network', async () => {
                  await wallet.disconnect();
                  setNetwork('mainnet');
                  setMarket(emptyMarket);
                  setMarketLoading(true);
                  setMainnetConfirmed(true);
                  setMainnetDialog(false);
                  setScanStart(0);
                  setScanInput('0');
                });
              }}
            >
              Use Mainnet
              <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
      {how && (
        <Modal title="Meet the third side." wide onClose={() => setHow(false)}>
          <div className="how-grid">
            <CircleGraph />
            <div>
              <h3>A wants B. B wants C. C wants A.</h3>
              <p>
                No pair can trade. A complete circle can, because every
                collector receives the asset they requested in one Bitcoin Cash
                transaction.
              </p>
              <ol className="how-steps">
                <li>
                  <strong>Post a wish, not a deposit.</strong> List an immutable
                  NFT from your wallet and identify what you want.
                </li>
                <li>
                  <strong>Open the matching circle.</strong> We recheck real
                  UTXOs and reserve both NFTs and token-free fee inputs.
                </li>
                <li>
                  <strong>Review with your wallet.</strong> Each participant
                  sees their exact assets, receiving address, change, and
                  network fee.
                </li>
                <li>
                  <strong>Close it together.</strong> Only three valid
                  signatures produce a spendable transaction. Any member can
                  export or broadcast it.
                </li>
              </ol>
            </div>
          </div>
          <div className="limitations">
            <h3>Know the edges before you sign.</h3>
            <p>
              The MVP supports three-party trades of immutable, standalone NFTs
              using P2PKH wallets. No fungible balances, mutable NFTs, minting
              rights, or escrow. A category and commitment may identify several
              copies; exact outpoints distinguish units.
            </p>
            <p>
              Discovery does not prove a listing's spending authority. The
              coordinator can censor or go offline. A valid final transaction
              never expires. Off-chain cancellation cannot revoke signed copies.
              Mempool acceptance is not irreversible confirmation.
            </p>
            <p>
              Wallet scanning covers a bounded receive/change range, not an
              entire wallet. Public Electrum nodes can be unavailable or
              dishonest. Use your own trusted node for valuable trades. This
              software has not been independently audited.
            </p>
          </div>
        </Modal>
      )}
      {pitch && (
        <Pitch
          onClose={() => {
            setPitch(false);
            if (location.hash === '#pitch')
              history.replaceState(
                null,
                '',
                location.pathname + location.search,
              );
          }}
        />
      )}
    </>
  );
}
