import express from 'express';
import { resolve } from 'node:path';
import { createApplication } from './app.js';
import { ElectrumChain } from './chain.js';
import { Coordinator } from './coordinator.js';
import { Store } from './store.js';

const store = new Store(
  resolve(process.env.DATA_DIR ?? './data', 'swapcircle.sqlite'),
);
const chain = new ElectrumChain({
  chipnet: process.env.CHIPNET_ELECTRUM_HOST,
  mainnet: process.env.MAINNET_ELECTRUM_HOST,
});
const coordinator = new Coordinator(store, chain);
const app = createApplication(coordinator, {
  development: process.env.NODE_ENV !== 'production',
  publicOrigin: process.env.PUBLIC_ORIGIN,
  prizeAddress: process.env.VITE_PRIZE_ADDRESS,
  relayUrls: process.env.VITE_WIZARD_RELAYS?.split(',')
    .map((url) => url.trim())
    .filter(Boolean),
});

let closeVite: (() => Promise<void>) | undefined;
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve('dist/client')));
  app.get('/{*path}', (_request, response) => {
    response.sendFile(resolve('dist/client/index.html'));
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
}

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5173);
const server = app.listen(port, host, () => {
  const address = server.address();
  const listeningPort =
    typeof address === 'object' && address ? address.port : port;
  console.info(`SwapCircle ready at http://${host}:${listeningPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const timeout = setTimeout(() => process.exit(0), 5_000);
    timeout.unref();
    server.close(() => {
      void (async () => {
        await closeVite?.();
        store.close();
        process.exit(0);
      })();
    });
    server.closeAllConnections();
  });
}
