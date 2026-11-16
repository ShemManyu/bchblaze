import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import type { PublicConfig } from '../shared/types.js';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
try {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Coordinator unavailable.');
  const config = (await response.json()) as PublicConfig;
  root.render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
} catch {
  root.render(
    <main className="startup-error">
      <h1>The coordinator is unavailable.</h1>
      <p>Your spending keys stay with your wallet.</p>
      <button
        type="button"
        className="button button-primary"
        onClick={() => location.reload()}
      >
        Reload SwapCircle
      </button>
    </main>,
  );
}
