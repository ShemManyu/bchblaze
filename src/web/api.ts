import { DomainError } from '../shared/errors.js';
import type { NftAsset, Offer } from '../shared/types.js';
import { outpointKey } from '../shared/cycles.js';

export async function api<T>(
  path: string,
  options: {
    body?: unknown;
    method?: string;
    mainnet?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: {
      ...(options.body !== undefined
        ? { 'content-type': 'application/json' }
        : {}),
      ...(options.mainnet ? { 'x-swapcircle-mainnet': 'approved' } : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
    signal: options.signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      { error?: { code?: string; message?: string } } | undefined;
    throw new DomainError(
      body?.error?.code ?? 'REQUEST_FAILED',
      body?.error?.message ??
        'The coordinator could not complete that request.',
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const originalOffersKey = 'swapcircle-original-offers-v1';

export function originalOffer(id: string): Offer | undefined {
  try {
    const offers = JSON.parse(
      localStorage.getItem(originalOffersKey) ?? '{}',
    ) as Record<string, Offer>;
    const offer = offers[id];
    return offer?.id === id && offer.asset && offer.wanted ? offer : undefined;
  } catch {
    return undefined;
  }
}

export function saveOriginalOffer(offer: Offer): void {
  let offers: Record<string, Offer> = {};
  try {
    offers = JSON.parse(
      localStorage.getItem(originalOffersKey) ?? '{}',
    ) as Record<string, Offer>;
  } catch {
    // A corrupted local cache must not become a trusted signing plan.
  }
  const entries = Object.values({ ...offers, [offer.id]: offer })
    .filter((item) => item && typeof item.createdAt === 'number')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
  localStorage.setItem(
    originalOffersKey,
    JSON.stringify(Object.fromEntries(entries.map((item) => [item.id, item]))),
  );
}

export function sameAsset(a: NftAsset, b: NftAsset): boolean {
  return (
    outpointKey(a) === outpointKey(b) &&
    a.category === b.category &&
    a.commitment === b.commitment
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'Wallet request cancelled. A wallet may already have signed, but no new approval was submitted by this request.';
  return 'The operation could not be completed. Check your wallet or node connection and try again.';
}
