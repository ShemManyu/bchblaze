import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication, type AppOptions } from '../src/server/app.js';
import { Coordinator } from '../src/server/coordinator.js';
import { Store } from '../src/server/store.js';
import { signActor, testActors } from './fixtures/actors.js';
import { FixtureChain } from './fixtures/chain.js';
import type {
  Circle,
  CreateOffer,
  Network,
  Offer,
} from '../src/shared/types.js';

const servers: Server[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
});

async function fixture(
  options: AppOptions = {},
  networks: readonly Network[] = ['chipnet', 'mainnet'],
) {
  const actors = testActors();
  const chain = new FixtureChain();
  chain.addActors(actors);
  const store = new Store();
  stores.push(store);
  const app = createApplication(
    new Coordinator(store, chain, networks),
    options,
  );
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No test server address.');
  const base = `http://127.0.0.1:${address.port}`;
  const clients = [0, 1, 2, 3].map(() => {
    let cookie = '';
    return {
      request: async (
        path: string,
        body?: unknown,
        headers: Record<string, string> = {},
        method?: string,
      ) => {
        const response = await fetch(base + path, {
          method: method ?? (body !== undefined ? 'POST' : 'GET'),
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(body !== undefined
              ? { 'content-type': 'application/json' }
              : {}),
            ...headers,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const nextCookie = response.headers.get('set-cookie');
        if (nextCookie) cookie = nextCookie.split(';')[0]!;
        return response;
      },
    };
  });
  const requests = actors.map((actor): CreateOffer => ({
    network: 'chipnet',
    receiveAddress: actor.nft.address,
    addressPaths: [{ address: actor.nft.address, path: 'receive', index: 0 }],
    offered: { txid: actor.nft.txid, vout: actor.nft.vout },
    wanted: actor.offer.wanted,
    label: actor.offer.label,
  }));
  return { actors, chain, store, clients, requests, base };
}

describe('trading HTTP API', () => {
  it('executes a real three-browser trading flow with private plans and VM-validated settlement', async () => {
    const f = await fixture();
    for (const [index, actor] of f.actors.entries()) {
      const response = await f.clients[index]!.request(
        '/api/offers',
        f.requests[index],
      );
      expect(response.status).toBe(201);
      actor.offer = (await response.json()) as Offer;
    }
    const creation = await f.clients[0]!.request('/api/circles', {
      offerIds: f.actors.map((actor) => actor.offer.id),
    });
    expect(creation.status).toBe(201);
    let circle = (await creation.json()) as Circle;
    const publicCircle = (await (
      await f.clients[3]!.request(`/api/circles/${circle.id}`)
    ).json()) as Circle;
    expect(publicCircle.proposal).toBeUndefined();
    expect(
      (await f.clients[3]!.request(`/api/circles/${circle.id}/transaction`))
        .status,
    ).toBe(403);
    for (const [index, actor] of f.actors.entries()) {
      const response = await f.clients[index]!.request(
        `/api/circles/${circle.id}/approve`,
        {
          offerId: actor.offer.id,
          fingerprint: circle.proposal!.fingerprint,
          signedTransaction: signActor(circle.proposal!, actor),
        },
      );
      expect(response.status).toBe(200);
      circle = (await response.json()) as Circle;
    }
    const exported = await f.clients[1]!.request(
      `/api/circles/${circle.id}/transaction`,
    );
    expect(exported.status).toBe(200);
    const final = await f.clients[0]!.request(
      `/api/circles/${circle.id}/settle`,
      {},
    );
    expect(final.status).toBe(200);
    expect(((await final.json()) as Circle).status).toBe('broadcast');
    expect(f.chain.broadcasts).toHaveLength(1);
  });

  it('rejects cross-origin writes, malformed fields, and oversized bodies without leaking input data', async () => {
    const f = await fixture();
    expect(
      (
        await f.clients[0]!.request('/api/offers', f.requests[0], {
          origin: 'https://other.invalid',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.clients[0]!.request('/api/offers', {
          ...f.requests[0],
          privateKey: 'DO_NOT_LEAK',
        })
      ).status,
    ).toBe(400);
    const oversized = await f.clients[0]!.request('/api/offers', {
      ...f.requests[0],
      label: 'x'.repeat(70_000),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).not.toContain('DO_NOT_LEAK');
    expect(f.store.listOffers('chipnet')).toHaveLength(0);
  });

  it('issues a private session cookie and requires explicit Mainnet acknowledgement', async () => {
    const f = await fixture();
    const market = await f.clients[0]!.request('/api/market');
    const cookie = market.headers.get('set-cookie')!;
    expect(cookie.includes('HttpOnly')).toBe(true);
    expect(cookie.includes('SameSite=Strict')).toBe(true);
    const response = await f.clients[0]!.request('/api/offers', {
      ...f.requests[0],
      network: 'mainnet',
    });
    expect(response.status).toBe(409);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe('MAINNET_CONFIRMATION_REQUIRED');
    expect(f.store.listOffers('mainnet')).toHaveLength(0);
  });

  it('cannot enable Mainnet with a forged acknowledgement when the server is Chipnet-only', async () => {
    const f = await fixture({}, ['chipnet']);
    const config = await f.clients[0]!.request('/api/config');
    expect(
      ((await config.json()) as { enabledNetworks: Network[] }).enabledNetworks,
    ).toEqual(['chipnet']);
    const response = await f.clients[0]!.request(
      '/api/offers',
      {
        ...f.requests[0],
        network: 'mainnet',
      },
      { 'x-swapcircle-mainnet': 'approved' },
    );
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe('NETWORK_DISABLED');
    expect(f.store.listOffers('mainnet')).toHaveLength(0);
  });

  it.each([0, 1])(
    'trusts forwarded client addresses only with an explicit proxy-hop configuration (%i)',
    async (hops) => {
      for (const address of ['198.51.100.1', '[2001:db8::1]']) {
        const f = await fixture({ trustProxyHops: hops });
        for (let index = 0; index < 240; index += 1) {
          const response = await f.clients[0]!.request(
            '/api/market',
            undefined,
            {
              'x-forwarded-for': `${address}:${10000 + index}`,
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        }
        const sameClient = await f.clients[0]!.request(
          '/api/market',
          undefined,
          {
            'x-forwarded-for': `${address}:30000`,
          },
        );
        expect(sameClient.status).toBe(429);
        const differentClient = await f.clients[0]!.request(
          '/api/market',
          undefined,
          {
            'x-forwarded-for': '198.51.100.2:40000',
          },
        );
        expect(differentClient.status).toBe(hops ? 200 : 429);
      }
    },
  );
});
