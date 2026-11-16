import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  LockKeyhole,
  Network,
  Sparkles,
} from 'lucide-react';
import { CheckItem, CircleGraph, Modal } from './components.js';

export function Pitch({ onClose }: { onClose: () => void }) {
  const [slide, setSlide] = useState(0);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight')
        setSlide((value) => Math.min(4, value + 1));
      if (event.key === 'ArrowLeft')
        setSlide((value) => Math.max(0, value - 1));
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  const slides = [
    <div className="pitch-grid" key="opening">
      <div>
        <p className="eyebrow">01 / THE MISSING LINK</p>
        <h2>
          Some trades need
          <br />a third person.
        </h2>
        <p>
          Nova wants Kai's collectible. Kai wants Remi's. Remi wants Nova's.
        </p>
        <p>
          No two-person swap works.
          <br />
          <strong>One circle does.</strong>
        </p>
      </div>
      <CircleGraph />
    </div>,
    <div className="pitch-content" key="problem">
      <p className="eyebrow">02 / THE COLLECTOR'S PROBLEM</p>
      <Network size={40} />
      <h2>
        The right asset.
        <br />
        The wrong counterparty.
      </h2>
      <p>
        CashTokens collectors in clubs, events, and small communities can hold
        something valuable to someone else, but not to the person whose item
        they want.
      </p>
      <p>
        Buying with BCH needs fresh funds. Coordinating separate sends requires
        trust. Bilateral swaps cannot clear a three-way mismatch.
      </p>
      <div className="pitch-callout">
        Target: communities trading immutable, standalone CashTokens NFTs, not
        price speculation or generic crypto users.
      </div>
    </div>,
    <div className="pitch-content" key="solution">
      <p className="eyebrow">03 / A NEW TRADING PRIMITIVE</p>
      <Sparkles size={40} />
      <h2>
        Trade the loop.
        <br />
        Not three promises.
      </h2>
      <div className="pitch-steps">
        <div>
          <span>01</span>
          <h3>List a wish</h3>
          <p>
            Choose an NFT you have and the exact category/commitment or outpoint
            you want.
          </p>
        </div>
        <div>
          <span>02</span>
          <h3>Find the third side</h3>
          <p>
            A deterministic matcher finds three offers whose wants close a
            complete cycle.
          </p>
        </div>
        <div>
          <span>03</span>
          <h3>Approve one transaction</h3>
          <p>
            Each external wallet signs only its own inputs. All three NFTs
            settle together.
          </p>
        </div>
      </div>
    </div>,
    <div className="pitch-content" key="trust">
      <p className="eyebrow">04 / WHY BITCOIN CASH</p>
      <LockKeyhole size={40} />
      <h2>
        Atomic by construction.
        <br />
        Not by reputation.
      </h2>
      <CheckItem>
        Native CashTokens in one consensus-verified BCH transaction.
      </CheckItem>
      <CheckItem>
        WizardConnect signatures. Spending keys never enter SwapCircle.
      </CheckItem>
      <CheckItem>
        Every approval binds all inputs, source UTXOs, and exact outputs.
      </CheckItem>
      <CheckItem>
        Fee inputs are token-free. Extra BCH returns to its owner.
      </CheckItem>
      <p className="field-help">
        No covenant deployment or escrow deposit. The coordinator can fail or
        censor; it cannot change a signed trade. A complete transaction has no
        on-chain expiry. Mempool acceptance is not confirmation.
      </p>
    </div>,
    <div className="pitch-content" key="business">
      <p className="eyebrow">05 / FROM DEMO TO A USEFUL MARKET</p>
      <h2>
        Start with a community.
        <br />
        Measure circles closed.
      </h2>
      <p>
        Launch with one event-badge or collector community. Bring its existing
        catalog and members, rather than asking everyone to join another broad
        marketplace.
      </p>
      <div className="pitch-steps">
        <div>
          <span>PROVE</span>
          <h3>Completed trades</h3>
          <p>
            Time to a match, approval completion, and trades that a two-party
            market could not clear.
          </p>
        </div>
        <div>
          <span>GROW</span>
          <h3>Community integrations</h3>
          <p>
            Embed a wish board into existing collector communities. Catalog
            integration is a next step, not a feature claim.
          </p>
        </div>
        <div>
          <span>SUSTAIN</span>
          <h3>Transparent service</h3>
          <p>
            The MVP charges no platform fee. Community tooling or an explicitly
            approved settlement fee are future business hypotheses.
          </p>
        </div>
      </div>
      <button className="button button-primary" type="button" onClick={onClose}>
        Open the working app
        <ArrowUpRight size={17} />
      </button>
    </div>,
  ];
  return (
    <Modal title="The SwapCircle pitch" wide onClose={onClose}>
      <div className="pitch-slide">{slides[slide]}</div>
      <footer className="pitch-controls">
        <span className="mono">
          BCH BLAZE 2026 / {String(slide + 1).padStart(2, '0')} OF 05
        </span>
        <div>
          <button
            className="button button-quiet button-small"
            type="button"
            disabled={slide === 0}
            onClick={() => setSlide((value) => value - 1)}
          >
            <ArrowLeft size={16} />
            Previous
          </button>
          <button
            className="button button-secondary button-small"
            type="button"
            disabled={slide === 4}
            onClick={() => setSlide((value) => value + 1)}
          >
            Next
            <ArrowRight size={16} />
          </button>
        </div>
      </footer>
    </Modal>
  );
}
