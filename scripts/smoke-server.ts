import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir(resolve('data'), { recursive: true });
const directory = await mkdtemp(resolve('data/smoke-'));
const child = spawn(process.execPath, ['dist/server/server/index.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '0',
    DATA_DIR: directory,
    PUBLIC_ORIGIN: '',
    VITE_PRIZE_ADDRESS: '',
    VITE_WIZARD_RELAYS: 'wss://relay.riften.net',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let rejectReady: (reason: Error) => void = () => undefined;
const closed = new Promise<number | null>((done) => {
  child.once('close', (code) => {
    rejectReady(
      new Error(`The production server exited before readiness: ${output}`),
    );
    done(code);
  });
});
const ready = new Promise<string>((done, fail) => {
  rejectReady = fail;
  child.once('error', fail);
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
    const url = output.match(
      /SwapCircle ready at (http:\/\/127\.0\.0\.1:\d+)/,
    )?.[1];
    if (url) done(url);
  });
});
child.stderr.on('data', (data: Buffer) => {
  output += data.toString();
});
const timeout = setTimeout(
  () => rejectReady(new Error('Production startup timed out.')),
  10_000,
);
try {
  const base = await ready;
  clearTimeout(timeout);
  const get = (path: string) =>
    fetch(base + path, { signal: AbortSignal.timeout(5_000) });
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { status: string }).status, 'ok');
  const csp = health.headers.get('content-security-policy') ?? '';
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("script-src 'self' 'wasm-unsafe-eval'"));
  assert.ok(!csp.includes("'unsafe-eval'"));
  const config = await get('/api/config');
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await config.json(), {
    relayUrls: ['wss://relay.riften.net'],
    prizeAddress: '',
    mode: 'live',
  });
  const home = await get('/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes('SwapCircle'));
  const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(
    script,
    'The built HTML must reference its generated application bundle.',
  );
  assert.equal((await get(script)).status, 200);
  const market = await get('/api/market?network=chipnet');
  assert.equal(market.status, 200);
  assert.match(market.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.deepEqual(await market.json(), {
    offers: [],
    cycles: [],
    circles: [],
  });
  const forbidden = await fetch(base + '/api/offers', {
    method: 'POST',
    headers: {
      origin: 'https://other.invalid',
      'content-type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(forbidden.status, 403);
  const missing = await get('/api/does-not-exist');
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
  const fixture = await get('/__demo/state');
  assert.match(fixture.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(!(await fixture.text()).includes('Fixture Alice'));
  console.info(
    'PASS: built server readiness, CSP, runtime config, assets, session cookie, origin rejection, and no demo API.',
  );
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 7_000);
  const code = await closed;
  clearTimeout(force);
  for (const suffix of ['', '-wal', '-shm'])
    await rm(resolve(directory, `swapcircle.sqlite${suffix}`), { force: true });
  await rmdir(directory);
  assert.equal(code, 0, `Production shutdown failed: ${output}`);
}
