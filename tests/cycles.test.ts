import { describe, expect, it } from 'vitest';
import { findCycles } from '../src/shared/cycles.js';
import type { Offer } from '../src/shared/types.js';

export function cycleOffers(): [Offer, Offer, Offer] {
  const categories = ['a', 'b', 'c'].map((letter) => letter.repeat(64));
  return ['alice', 'bob', 'carol'].map((owner, index) => ({
    id: owner,
    network: 'chipnet',
    receiveAddress: owner,
    label: owner,
    asset: {
      txid: categories[index]!,
      vout: 0,
      category: categories[index]!,
      commitment: '01',
    },
    wanted: {
      category: categories[(index + 1) % 3]!,
      commitment: '01',
    },
    createdAt: 0,
    expiresAt: 20_000,
    status: 'open',
  })) as [Offer, Offer, Offer];
}

describe('three-party cycle matching', () => {
  it('closes a cycle when none of the bilateral swaps can close', () => {
    const offers = cycleOffers();
    expect(findCycles(offers.slice(0, 2), 1)).toEqual([]);
    const cycles = findCycles(offers, 1);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.offers.map((offer) => offer.id)).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
    expect(findCycles(offers.toReversed(), 1)).toEqual(cycles);
  });

  it('does not match the same receiving wallet as two participants', () => {
    const offers = cycleOffers();
    offers[2].receiveAddress = offers[0].receiveAddress;
    expect(findCycles(offers, 1)).toEqual([]);
  });

  it('does not mix networks, expired offers, or reserved assets', () => {
    const offers = cycleOffers();
    expect(findCycles(offers, 20_000)).toEqual([]);
    offers[1].network = 'mainnet';
    expect(findCycles(offers, 1)).toEqual([]);
    offers[1].network = 'chipnet';
    offers[1].status = 'reserved';
    expect(findCycles(offers, 1)).toEqual([]);
  });

  it('honors an exact wanted outpoint rather than interchangeable NFT metadata', () => {
    const offers = cycleOffers();
    offers[0].wanted.outpoint = { txid: 'd'.repeat(64), vout: 2 };
    expect(findCycles(offers, 1)).toEqual([]);
    offers[0].wanted.outpoint = {
      txid: offers[1].asset.txid,
      vout: offers[1].asset.vout,
    };
    expect(findCycles(offers, 1)).toHaveLength(1);
  });
});
