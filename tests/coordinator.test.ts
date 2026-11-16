import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { nftAsset } from '../src/shared/bitcoin.js';
import { outpointKey } from '../src/shared/cycles.js';
import type { Circle, CreateOffer } from '../src/shared/types.js';
import { Coordinator } from '../src/server/coordinator.js';
import { Store } from '../src/server/store.js';
import { signActor, testActors } from './fixtures/actors.js';
import { barrier, FixtureChain } from './fixtures/chain.js';

const stores = new Set<Store>();
const files: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const file of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(file + suffix, { force: true });
  }
});

async function fixture(extraNft = false, persistent = false) {
  const actors = testActors();
  const chain = new FixtureChain();
  chain.addActors(actors, extraNft);
  let now = Date.now();
  const path = persistent
    ? join(tmpdir(), `swapcircle-${randomUUID()}.sqlite`)
    : ':memory:';
  if (persistent) files.push(path);
  const store = new Store(path, () => now);
  stores.add(store);
  const coordinator = new Coordinator(store, chain);
  const sessions = ['collector-a', 'collector-b', 'collector-c'];
  const requests = actors.map((actor): CreateOffer => ({
    network: 'chipnet',
    receiveAddress: actor.offer.receiveAddress,
    addressPaths: [{ address: actor.nft.address, path: 'receive', index: 0 }],
    offered: { txid: actor.nft.txid, vout: actor.nft.vout },
    wanted: actor.offer.wanted,
    label: actor.offer.label,
  }));
  for (const [index, actor] of actors.entries()) {
    store.ensureSession(sessions[index]!);
    actor.offer = await coordinator.createOffer(
      sessions[index]!,
      requests[index]!,
    );
  }
  const prepare = () =>
    coordinator.prepare(
      actors.map((actor) => actor.offer.id),
      sessions[0]!,
    );
  const approve = (circle: Circle, index: number) =>
    coordinator.approve(
      circle.id,
      sessions[index]!,
      actors[index]!.offer.id,
      circle.proposal!.fingerprint,
      signActor(circle.proposal!, actors[index]!),
    );
  const ready = async () => {
    let circle = await prepare();
    for (let index = 0; index < 3; index += 1)
      circle = await approve(circle, index);
    return circle;
  };
  return {
    actors,
    chain,
    store,
    coordinator,
    sessions,
    requests,
    prepare,
    approve,
    ready,
    path,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    now: () => now,
  };
}

describe('persistent non-custodial coordinator', () => {
  it('moves actual ledger NFTs and BCH change only after all three signatures', async () => {
    const f = await fixture();
    let circle = await f.prepare();
    for (const index of [0, 1]) circle = await f.approve(circle, index);
    await expect(
      f.coordinator.settle(circle.id, f.sessions[0]!),
    ).rejects.toMatchObject({ code: 'MISSING_APPROVALS' });
    expect(f.chain.broadcasts).toHaveLength(0);
    circle = await f.approve(circle, 2);
    expect(circle.status).toBe('ready');
    const final = await f.coordinator.settle(circle.id, f.sessions[1]!);
    expect(final.status).toBe('broadcast');
    expect(final.confirmations).toBe(0);
    for (const [index, actor] of f.actors.entries()) {
      const holdings = await f.chain.getUtxos('chipnet', [
        { address: actor.nft.address, path: 'receive', index: 0 },
      ]);
      expect(
        holdings
          .filter((utxo) => utxo.token)
          .map(nftAsset)
          .map((asset) => asset.category),
      ).toEqual([f.actors[(index + 1) % 3]!.nft.token!.category]);
      expect(
        holdings.filter((utxo) => !utxo.token).map((utxo) => utxo.satoshis),
      ).toEqual(['9000']);
      expect(f.chain.utxos.has(outpointKey(actor.nft))).toBe(false);
    }
  });

  it('does not mistake an unsigned listing for exclusive ownership', async () => {
    const f = await fixture();
    const duplicate = await f.coordinator.createOffer(
      'another-browser',
      f.requests[0]!,
    );
    expect(duplicate.asset).toEqual(f.actors[0].offer.asset);
    const circle = await f.prepare();
    expect(circle.status).toBe('awaiting_signatures');
    expect(
      circle.participants.some(
        (participant) => participant.offerId === duplicate.id,
      ),
    ).toBe(false);
  });

  it('blocks outsider mutations and hides signing plans and transaction exports', async () => {
    const f = await fixture();
    const circle = await f.prepare();
    expect(
      f.coordinator.circle(circle.id, 'outsider').proposal,
    ).toBeUndefined();
    await expect(
      f.coordinator.approve(
        circle.id,
        'outsider',
        f.actors[0].offer.id,
        circle.proposal!.fingerprint,
        signActor(circle.proposal!, f.actors[0]),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(() => f.coordinator.cancelCircle(circle.id, 'outsider')).toThrow(
      'participant browser',
    );
    expect(() =>
      f.coordinator.signedTransaction(circle.id, 'outsider'),
    ).toThrow('participant browser');
    expect(() =>
      f.store.cancelOffer(f.actors[1].offer.id, f.sessions[0]!),
    ).toThrow('listing browser');
  });

  it('does not let a member approve a different member role', async () => {
    const f = await fixture();
    const circle = await f.prepare();
    await expect(
      f.coordinator.approve(
        circle.id,
        f.sessions[0]!,
        f.actors[1].offer.id,
        circle.proposal!.fingerprint,
        signActor(circle.proposal!, f.actors[1]),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.store.approvals(circle.id)).toHaveLength(0);
  });

  it('rejects overlapping room preparation without disturbing the first lease', async () => {
    const f = await fixture();
    const gate = barrier();
    f.chain.verifyBarrier = gate;
    const first = f.prepare();
    await gate.entered;
    await expect(f.prepare()).rejects.toMatchObject({ status: 409 });
    gate.release();
    const circle = await first;
    expect(circle.status).toBe('awaiting_signatures');
    expect(f.store.isReserved('chipnet', f.actors[0].funding[0]!)).toBe(true);
  });

  it('does not share fee inputs between two active circles, then uses newly created change', async () => {
    const f = await fixture(true);
    const first = await f.prepare();
    const extraOffers = [];
    for (const [index, actor] of f.actors.entries()) {
      extraOffers.push(
        await f.coordinator.createOffer(f.sessions[index]!, {
          ...f.requests[index]!,
          offered: { txid: actor.nft.txid, vout: 2 },
          wanted: {
            ...f.requests[index]!.wanted,
            outpoint: { txid: f.actors[(index + 1) % 3]!.nft.txid, vout: 2 },
          },
        }),
      );
    }
    await expect(
      f.coordinator.prepare(
        extraOffers.map((offer) => offer.id),
        f.sessions[0]!,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    for (let index = 0; index < 3; index += 1) await f.approve(first, index);
    await f.coordinator.settle(first.id, f.sessions[0]!);
    const next = await f.coordinator.prepare(
      extraOffers.map((offer) => offer.id),
      f.sessions[0]!,
    );
    const oldFunding = new Set(
      f.actors.map((actor) => outpointKey(actor.funding[0]!)),
    );
    expect(
      f.store
        .getCircle(next.id)
        .sourceUtxos!.filter((utxo) => !utxo.token)
        .every((utxo) => !oldFunding.has(outpointKey(utxo))),
    ).toBe(true);
  });

  it('cannot resurrect a room cancelled during asynchronous preparation', async () => {
    const f = await fixture();
    const gate = barrier();
    f.chain.verifyBarrier = gate;
    const pending = f.prepare();
    await gate.entered;
    const circle = f.coordinator.market('chipnet', f.sessions[0]!).circles[0]!;
    f.coordinator.cancelCircle(circle.id, f.sessions[0]!);
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'CIRCLE_CLOSED' });
    expect(f.store.getCircle(circle.id).status).toBe('cancelled');
    expect(f.store.isReserved('chipnet', f.actors[0].nft)).toBe(false);
    expect(f.coordinator.market('chipnet', f.sessions[0]!).cycles).toHaveLength(
      1,
    );
  });

  it('rejects a late signature after expiration and releases only pending leases', async () => {
    const f = await fixture();
    const circle = await f.prepare();
    await f.approve(circle, 0);
    await f.approve(circle, 1);
    const gate = barrier();
    f.chain.verifyBarrier = gate;
    const pending = f.approve(circle, 2);
    await gate.entered;
    f.advance(10 * 60_000 + 1);
    f.coordinator.market('chipnet', f.sessions[0]!);
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'CIRCLE_CLOSED' });
    expect(f.store.getCircle(circle.id).status).toBe('expired');
    expect(f.store.getCircle(circle.id).signedTransaction).toBeUndefined();
    expect(f.store.isReserved('chipnet', f.actors[0].funding[0]!)).toBe(false);
    expect(
      f.store
        .approvals(circle.id)
        .every((approval) => !approval.signedTransaction),
    ).toBe(true);
  });

  it('does not record an approval arriving after the coordination window', async () => {
    const f = await fixture();
    const circle = await f.prepare();
    const gate = barrier();
    f.chain.verifyBarrier = gate;
    const pending = f.approve(circle, 0);
    await gate.entered;
    f.advance(10 * 60_000 + 1);
    f.coordinator.market('chipnet', f.sessions[0]!);
    gate.release();
    await expect(pending).rejects.toMatchObject({ code: 'CIRCLE_CLOSED' });
    expect(f.store.approvals(circle.id)).toHaveLength(0);
  });

  it('removes a spent NFT offer and fails preparation without leaving other inputs leased', async () => {
    const f = await fixture();
    f.chain.utxos.delete(outpointKey(f.actors[1].nft));
    await expect(f.prepare()).rejects.toMatchObject({ code: 'ASSET_SPENT' });
    expect(f.store.getOffer(f.actors[1].offer.id).offer.status).toBe('invalid');
    expect(f.store.getOffer(f.actors[0].offer.id).offer.status).toBe('open');
    expect(f.store.isReserved('chipnet', f.actors[0].nft)).toBe(false);
  });

  it('fails a pending circle when an input is spent before its next approval', async () => {
    const f = await fixture();
    const circle = await f.prepare();
    await f.approve(circle, 0);
    f.chain.utxos.delete(outpointKey(f.actors[2].nft));
    await expect(f.approve(circle, 1)).rejects.toMatchObject({
      code: 'INPUT_SPENT',
    });
    expect(f.store.getCircle(circle.id).status).toBe('failed');
    expect(f.store.getOffer(f.actors[2].offer.id).offer.status).toBe('invalid');
    expect(f.store.isReserved('chipnet', f.actors[0].funding[0]!)).toBe(false);
  });

  it('keeps a fully signed transaction valid and reserved beyond the off-chain window', async () => {
    const f = await fixture();
    const circle = await f.ready();
    const raw = f.coordinator.signedTransaction(
      circle.id,
      f.sessions[0]!,
    ).signedTransaction;
    f.advance(11 * 60_000);
    f.coordinator.market('chipnet', f.sessions[0]!);
    expect(f.store.getCircle(circle.id).status).toBe('ready');
    expect(() => f.coordinator.cancelCircle(circle.id, f.sessions[0]!)).toThrow(
      'cannot revoke',
    );
    expect(
      f.coordinator.signedTransaction(circle.id, f.sessions[1]!)
        .signedTransaction,
    ).toBe(raw);
    expect(f.store.isReserved('chipnet', f.actors[0].nft)).toBe(true);
  });

  it('retries the exact signed bytes after an inconclusive unaccepted broadcast', async () => {
    const f = await fixture();
    const circle = await f.ready();
    f.chain.broadcastMode = 'timeout_before_acceptance';
    const unknown = await f.coordinator.settle(circle.id, f.sessions[0]!);
    expect(unknown.status).toBe('broadcast_unknown');
    expect(unknown.error).not.toContain('DO_NOT_LEAK');
    expect(f.store.isReserved('chipnet', f.actors[0].funding[0]!)).toBe(true);
    f.chain.broadcastMode = 'ok';
    const retried = await f.coordinator.settle(circle.id, f.sessions[0]!);
    expect(retried.status).toBe('broadcast');
    expect(f.chain.broadcasts).toHaveLength(2);
    expect(f.chain.broadcasts[0]).toBe(f.chain.broadcasts[1]);
    expect(retried.txid).toBe(unknown.txid);
  });

  it('discovers acceptance after a timed-out reply without broadcasting twice', async () => {
    const f = await fixture();
    const circle = await f.ready();
    f.chain.broadcastMode = 'timeout_after_acceptance';
    expect((await f.coordinator.settle(circle.id, f.sessions[0]!)).status).toBe(
      'broadcast_unknown',
    );
    f.chain.broadcastMode = 'ok';
    expect((await f.coordinator.settle(circle.id, f.sessions[0]!)).status).toBe(
      'broadcast',
    );
    expect(f.chain.broadcasts).toHaveLength(1);
  });

  it.each(['success', 'timeout'])(
    'does not let a late broadcast result erase a newer confirmation (%s)',
    async (outcome) => {
      const f = await fixture();
      const circle = await f.ready();
      const gate = barrier();
      f.chain.broadcastBarrier = gate;
      const pending = f.coordinator.settle(circle.id, f.sessions[0]!);
      await gate.entered;
      f.chain.confirmations.set(circle.txid!, 1);
      expect(
        (await f.coordinator.refresh(circle.id, f.sessions[1]!)).status,
      ).toBe('confirmed');
      if (outcome === 'success') gate.release();
      else gate.fail(new Error('A late transport failure.'));
      const final = await pending;
      expect(final.status).toBe('confirmed');
      expect(final.confirmations).toBe(1);
    },
  );

  it('downgrades real reorg observations without releasing old spend authority', async () => {
    const f = await fixture();
    const circle = await f.ready();
    await f.coordinator.settle(circle.id, f.sessions[0]!);
    f.chain.confirmations.set(circle.txid!, 2);
    expect(
      (await f.coordinator.refresh(circle.id, f.sessions[0]!)).confirmations,
    ).toBe(2);
    f.chain.confirmations.delete(circle.txid!);
    const reorg = await f.coordinator.refresh(circle.id, f.sessions[0]!);
    expect(reorg.status).toBe('broadcast_unknown');
    expect(reorg.confirmations).toBe(0);
    expect(f.store.isReserved('chipnet', f.actors[0].nft)).toBe(true);
  });

  it('persists sessions, immutable proposals, and partial approvals across restart', async () => {
    const f = await fixture(false, true);
    const circle = await f.prepare();
    await f.approve(circle, 0);
    f.store.close();
    stores.delete(f.store);
    const reopened = new Store(f.path, f.now);
    stores.add(reopened);
    const coordinator = new Coordinator(reopened, f.chain);
    const restored = coordinator.circle(circle.id, f.sessions[0]!);
    expect(reopened.hasSession(f.sessions[0]!)).toBe(true);
    expect(restored.proposal!.fingerprint).toBe(circle.proposal!.fingerprint);
    expect(
      restored.participants.filter((participant) => participant.signed),
    ).toHaveLength(1);
    for (const index of [1, 2]) {
      await coordinator.approve(
        circle.id,
        f.sessions[index]!,
        f.actors[index]!.offer.id,
        circle.proposal!.fingerprint,
        signActor(circle.proposal!, f.actors[index]!),
      );
    }
    expect((await coordinator.settle(circle.id, f.sessions[0]!)).status).toBe(
      'broadcast',
    );
  });

  it('recovers an interrupted broadcast as unknown and preserves its identical transaction', async () => {
    const f = await fixture(false, true);
    const circle = await f.ready();
    const original = f.store.getCircle(circle.id).signedTransaction!;
    f.store.beginBroadcast(circle.id);
    f.store.close();
    stores.delete(f.store);
    const reopened = new Store(f.path, f.now);
    stores.add(reopened);
    const coordinator = new Coordinator(reopened, f.chain);
    expect(coordinator.circle(circle.id, f.sessions[0]!).status).toBe(
      'broadcast_unknown',
    );
    expect(reopened.getCircle(circle.id).signedTransaction).toBe(original);
    await coordinator.settle(circle.id, f.sessions[0]!);
    expect(f.chain.broadcasts).toEqual([original]);
  });
});
