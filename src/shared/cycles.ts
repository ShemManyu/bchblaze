import type {
  NftAsset,
  Offer,
  Outpoint,
  TradeCycle,
  WantedAsset,
} from './types.js';

export function outpointKey(outpoint: Outpoint): string {
  return `${outpoint.txid}:${outpoint.vout}`;
}

export function matchesWanted(wanted: WantedAsset, offered: NftAsset): boolean {
  return (
    wanted.category === offered.category &&
    wanted.commitment === offered.commitment &&
    (!wanted.outpoint || outpointKey(wanted.outpoint) === outpointKey(offered))
  );
}

export function findCycles(
  offers: readonly Offer[],
  now: number,
  limit = 30,
): TradeCycle[] {
  if (limit <= 0) return [];
  const open = offers
    .filter((offer) => offer.status === 'open' && offer.expiresAt > now)
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const result: TradeCycle[] = [];
  for (const a of open) {
    for (const b of open) {
      if (
        a.id >= b.id ||
        a.network !== b.network ||
        a.receiveAddress === b.receiveAddress ||
        !matchesWanted(a.wanted, b.asset) ||
        outpointKey(a.asset) === outpointKey(b.asset)
      ) {
        continue;
      }
      for (const c of open) {
        if (
          a.id >= c.id ||
          b.id === c.id ||
          a.network !== c.network ||
          a.receiveAddress === c.receiveAddress ||
          b.receiveAddress === c.receiveAddress ||
          outpointKey(a.asset) === outpointKey(c.asset) ||
          outpointKey(b.asset) === outpointKey(c.asset) ||
          !matchesWanted(b.wanted, c.asset) ||
          !matchesWanted(c.wanted, a.asset)
        ) {
          continue;
        }
        result.push({ id: `${a.id}.${b.id}.${c.id}`, offers: [a, b, c] });
        if (result.length >= limit) return result;
      }
    }
  }
  return result;
}
