import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, CircleDashed } from 'lucide-react';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="foundation">
      <span className="brand">
        <CircleDashed size={28} /> SwapCircle
      </span>
      <p className="eyebrow">BITCOIN CASH / CASHTOKENS</p>
      <h1>
        Three collectors.
        <br />
        One circle.
      </h1>
      <p>
        A wants B's token. B wants C's. C wants A's.
        <br />
        Close the loop in one noncustodial transaction.
      </p>
      <a href="https://github.com/ShemManyu/bchblaze">
        Follow the build <ArrowUpRight size={16} />
      </a>
      <small>Protocol foundation. Trading workflow is being implemented.</small>
    </main>
  </StrictMode>,
);
