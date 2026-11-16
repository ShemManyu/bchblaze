import { describe, expect, it } from 'vitest';
import { initiateDappRelay, type DappRelayResult } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import {
  buildSwap,
  mergeSignatures,
  validateProposal,
} from '../src/shared/transactions.js';
import { receiveAddress, scanPaths, signSwap } from '../src/web/wallet.js';
import { testActors } from './fixtures/actors.js';
import { FixtureChain } from './fixtures/chain.js';
import { fixtureRelay } from './fixtures/relay.js';
import { fixtureWalletHost, hdActors } from './fixtures/wallet.js';

describe('actual WizardConnect encrypted wallet protocol', () => {
  it('signs distinct HD inputs in three external wallet managers and settles a real VM-valid exchange', async () => {
    const relay = await fixtureRelay();
    const actors = hdActors();
    const ledger = new FixtureChain();
    ledger.addActors(actors);
    const hosts = actors.map(fixtureWalletHost);
    const managers = actors.map(
      () =>
        new DappConnectionManager('SwapCircle test', undefined, {
          session: false,
        }),
    );
    const relays: DappRelayResult[] = [];
    try {
      await Promise.all(
        managers.map(async (manager, index) => {
          const ready = new Promise<void>((resolve) =>
            manager.once('walletready', () => resolve()),
          );
          const connection = initiateDappRelay(
            (payload) =>
              manager.updateConnection(payload.client, payload.status),
            {
              explicitRelayUrls: [relay.url],
              reconnectInterval: 250,
              maxReconnectAttempts: 4,
            },
          );
          relays.push(connection);
          manager.attachRelay(connection);
          hosts[index]!.manager.connect(connection.uri);
          await ready;
        }),
      );
      for (const [index, manager] of managers.entries()) {
        expect(receiveAddress(manager, 'chipnet')).toBe(
          actors[index]!.offer.receiveAddress,
        );
        const paths = scanPaths(manager, 'chipnet');
        expect(
          paths.find((path) => path.path === 'receive' && path.index === 3)!
            .address,
        ).toBe(actors[index]!.nft.address);
        expect(
          paths.find((path) => path.path === 'change' && path.index === 2)!
            .address,
        ).toBe(actors[index]!.funding[0]!.address);
      }
      const proposal = buildSwap(actors);
      const signatures = await Promise.all(
        managers.map((manager, index) =>
          signSwap(
            manager,
            proposal,
            actors.map((actor) => actor.offer),
            actors[index]!.offer.id,
          ),
        ),
      );
      const finalHex = mergeSignatures(
        proposal,
        Object.fromEntries(
          actors.map((actor, index) => [actor.offer.id, signatures[index]!]),
        ),
      );
      await ledger.broadcast('chipnet', finalHex);
      expect(ledger.broadcasts).toHaveLength(1);
      expect(hosts.every((host) => host.adapter.requests.length === 1)).toBe(
        true,
      );
      expect(
        hosts.every(
          (host) => host.adapter.requests[0]!.transaction.broadcast === false,
        ),
      ).toBe(true);
      expect(relay.events.length).toBeGreaterThanOrEqual(6);
      expect(
        relay.events.every(
          (event) => !event.content.includes(proposal.unsignedTransaction),
        ),
      ).toBe(true);
      expect(
        relay.events.every(
          (event) => !event.content.includes(actors[0].nft.token!.category),
        ),
      ).toBe(true);
      hosts[0]!.adapter.rejectNext = true;
      await expect(
        signSwap(
          managers[0]!,
          proposal,
          actors.map((actor) => actor.offer),
          actors[0].offer.id,
        ),
      ).rejects.toMatchObject({ code: 'WALLET_REJECTED' });
      expect(hosts[0]!.adapter.requests).toHaveLength(2);

      const redirectedActors = actors.map((actor, index) => ({
        ...actor,
        offer: {
          ...actor.offer,
          ...(index === 0 && { receiveAddress: testActors()[0].nft.address }),
        },
      })) as typeof actors;
      const malicious = buildSwap(redirectedActors);
      expect(() => validateProposal(malicious)).not.toThrow();
      await expect(
        signSwap(
          managers[0]!,
          malicious,
          actors.map((actor) => actor.offer),
          actors[0].offer.id,
        ),
      ).rejects.toMatchObject({ code: 'OFFER_MISMATCH' });
      expect(hosts[0]!.adapter.requests).toHaveLength(2);
    } finally {
      for (const host of hosts) host.manager.disconnectAll();
      await relay.waitForClients(managers.length);
      for (const manager of managers) await manager.destroy();
      for (const connection of relays) connection.cleanup();
      await relay.waitForClients(0);
      await relay.close();
    }
  });
});
