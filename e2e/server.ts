import express from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createApplication } from '../src/server/app.js';
import { Coordinator } from '../src/server/coordinator.js';
import { Store } from '../src/server/store.js';
import { FixtureChain } from '../tests/fixtures/chain.js';
import { fixtureRelay } from '../tests/fixtures/relay.js';
import { fixtureWalletHost, hdActors } from '../tests/fixtures/wallet.js';

const relay = await fixtureRelay();
const actors = hdActors();
const chain = new FixtureChain();
chain.addActors(actors);
const wallets = actors.map(fixtureWalletHost);
const store = new Store();
const app = createApplication(new Coordinator(store, chain), {
  localDemo: true,
  relayUrls: [relay.url],
});

app.use('/__demo', (request, response, next) => {
  const expected = `http://${request.get('host')}`;
  if (
    request.get('sec-fetch-site') === 'cross-site' ||
    (request.get('origin') && request.get('origin') !== expected) ||
    (!['GET', 'HEAD'].includes(request.method) &&
      !request.is('application/json'))
  ) {
    response
      .status(403)
      .json({ error: 'Use the local demo on its own origin.' });
    return;
  }
  next();
});
app.get('/__demo/state', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json({
    actors: actors.map((actor) => ({
      label: actor.offer.label,
      receiveAddress: actor.offer.receiveAddress,
      asset: actor.offer.asset,
      wanted: actor.offer.wanted,
    })),
    utxos: [...chain.utxos.values()],
    broadcasts: chain.broadcasts,
    requests: wallets.map((wallet) =>
      wallet.adapter.requests.map((request) => ({
        inputPaths: request.inputPaths,
        broadcast: request.transaction.broadcast,
      })),
    ),
    encryptedEvents: relay.events.length,
  });
});
app.post('/__demo/pair', (request, response) => {
  const body = z
    .object({
      actor: z.number().int().min(0).max(2),
      uri: z.string().min(10).max(8_000),
    })
    .safeParse(request.body);
  if (!body.success) {
    response
      .status(400)
      .json({ error: 'Choose a test wallet and paste its pairing URI.' });
    return;
  }
  try {
    wallets[body.data.actor]!.manager.connect(body.data.uri);
    response.status(202).json({ status: 'pairing' });
  } catch {
    response
      .status(400)
      .json({ error: 'That pairing URI could not be opened.' });
  }
});
app.post('/__demo/reject-next', (request, response) => {
  const body = z
    .object({ actor: z.number().int().min(0).max(2) })
    .safeParse(request.body);
  if (!body.success) {
    response.sendStatus(400);
    return;
  }
  wallets[body.data.actor]!.adapter.rejectNext = true;
  response.json({ status: 'next request will be rejected' });
});
app.post('/__demo/confirm', (request, response) => {
  const body = z
    .object({
      txid: z.string().regex(/^[0-9a-f]{64}$/),
      confirmations: z.number().int().min(0).max(1_000),
    })
    .safeParse(request.body);
  if (!body.success || !chain.confirmations.has(body.data.txid)) {
    response.sendStatus(400);
    return;
  }
  chain.confirmations.set(body.data.txid, body.data.confirmations);
  response.json({ status: 'updated' });
});
app.post('/__demo/broadcast-mode', (request, response) => {
  const body = z
    .object({
      mode: z.enum([
        'ok',
        'timeout_before_acceptance',
        'timeout_after_acceptance',
      ]),
    })
    .safeParse(request.body);
  if (!body.success) {
    response.sendStatus(400);
    return;
  }
  chain.broadcastMode = body.data.mode;
  response.json({ status: 'updated' });
});
app.get('/demo', (_request, response) =>
  response.sendFile(resolve('e2e/demo.html')),
);
app.get('/__demo/client.js', (_request, response) =>
  response.sendFile(resolve('e2e/demo-client.js')),
);
app.use(express.static(resolve('dist/client')));
app.get('/{*path}', (_request, response) =>
  response.sendFile(resolve('dist/client/index.html')),
);

const server = app.listen(Number(process.env.PORT ?? 4317), '127.0.0.1', () => {
  const address = server.address();
  console.info(
    `SwapCircle local demo ready at http://127.0.0.1:${typeof address === 'object' && address ? address.port : 4317}`,
  );
  console.info(
    'Test wallets only. No real BCH, real token minting, or public network broadcast.',
  );
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      const timeout = setTimeout(() => process.exit(1), 8_000);
      timeout.unref();
      for (const wallet of wallets) wallet.manager.disconnectAll();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await relay.close();
      store.close();
      clearTimeout(timeout);
      process.exit(0);
    })();
  });
}
