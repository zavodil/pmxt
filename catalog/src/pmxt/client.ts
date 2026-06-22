import { z } from 'zod';
import { config } from '../config';

// --- boundary schema: validate pmxt JSON at runtime (C3) ---------------------
export const OutcomeZ = z
  .object({
    outcomeId: z.string(),
    label: z.string(),
    price: z.number().optional(),
  })
  .passthrough();

export const UnifiedMarketZ = z
  .object({
    marketId: z.string(),
    eventId: z.string().optional(),
    slug: z.string().optional(),
    title: z.string(),
    description: z.string().default(''),
    outcomes: z.array(OutcomeZ).default([]),
    resolutionDate: z.coerce.date().optional(),
    volume: z.number().optional(),
    volume24h: z.number().optional(),
    liquidity: z.number().optional(),
    url: z.string().optional(),
    image: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).default([]),
    status: z.string().optional(),
    contractAddress: z.string().optional(),
    sourceExchange: z.string().optional(),
    sourceMetadata: z.record(z.unknown()).optional(),
  })
  .passthrough(); // tolerate upstream additions → no silent drift breakage

export type UnifiedMarket = z.infer<typeof UnifiedMarketZ>;

// --- transport ---------------------------------------------------------------
async function call(venue: string, method: string, body: unknown): Promise<unknown> {
  const url = `${config.PMXT_BASE_URL}/api/${venue}/${method}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.PMXT_ACCESS_TOKEN) headers['x-pmxt-access-token'] = config.PMXT_ACCESS_TOKEN;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`pmxt ${venue}/${method} -> ${res.status} ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// The generic pmxt RPC may return the value directly or wrapped — be defensive.
function unwrapArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['result', 'data', 'markets', 'results'] as const) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  throw new Error('pmxt: expected an array of markets');
}

function unwrapObject(data: unknown): unknown {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    if (typeof o.marketId === 'string') return o;
    for (const k of ['result', 'data', 'market'] as const) {
      if (o[k] && typeof o[k] === 'object') return o[k];
    }
  }
  return data;
}

export async function fetchMarketsRaw(
  venue: string,
  params: Record<string, unknown>,
): Promise<unknown[]> {
  return unwrapArray(await call(venue, 'fetchMarkets', params));
}

export async function fetchMarketRaw(venue: string, marketId: string): Promise<unknown> {
  return unwrapObject(await call(venue, 'fetchMarket', { marketId }));
}
