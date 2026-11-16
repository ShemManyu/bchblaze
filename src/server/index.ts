import express from 'express';
import { resolve } from 'node:path';

const app = express();
app.disable('x-powered-by');
app.get('/api/health', (_request, response) => {
  response.json({ name: 'SwapCircle', version: '0.1.0', status: 'ok' });
});

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
  process.once(signal, () => server.close(() => process.exit(0)));
}
