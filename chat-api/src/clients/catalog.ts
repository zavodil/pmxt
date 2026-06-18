import { config } from '../config';

export interface CatalogMarket {
  venue: string;
  marketId: string;
  title: string;
  description?: string;
  category?: string;
  tags?: string[];
  outcomes: { outcomeId: string; label: string }[];
  resolutionDate?: string;
  status?: string;
  conditionId?: string;
  url?: string;
  image?: string;
  metrics?: { volume24h?: number; liquidity?: number; volume?: number; asOf?: string };
}

export interface DiscoverMatch extends CatalogMarket {
  score?: number | null;
  rationale?: string | null;
  suggestedOutcome?: { outcomeId: string; label: string } | null;
}

export interface Quote {
  venue: string;
  marketId: string;
  asOf: string;
  outcomes: { outcomeId: string; label: string; price: number | null }[];
  liquidity: number | null;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${config.CATALOG_BASE_URL}${path}`);
  if (!res.ok) throw new Error(`catalog GET ${path} -> ${res.status}`);
  return res.json();
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${config.CATALOG_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`catalog POST ${path} -> ${res.status}`);
  return res.json();
}

export async function discover(
  prompt: string,
  limit = 8,
  venue?: string,
  rerank = true,
): Promise<DiscoverMatch[]> {
  const body: Record<string, unknown> = { prompt, limit, rerank };
  if (venue) body.filters = { venue };
  const data = (await postJson('/v1/markets/discover', body)) as { results?: DiscoverMatch[] };
  return data.results ?? [];
}

export async function search(q: string, limit = 8, venue?: string): Promise<CatalogMarket[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  if (venue) qs.set('venue', venue);
  const data = (await getJson(`/v1/markets/search?${qs}`)) as { results?: CatalogMarket[] };
  return data.results ?? [];
}

export async function getMarket(venue: string, marketId: string): Promise<CatalogMarket | null> {
  try {
    return (await getJson(
      `/v1/markets/${encodeURIComponent(venue)}/${encodeURIComponent(marketId)}`,
    )) as CatalogMarket;
  } catch {
    return null;
  }
}

export async function getQuote(venue: string, marketId: string): Promise<Quote> {
  return (await getJson(
    `/v1/markets/${encodeURIComponent(venue)}/${encodeURIComponent(marketId)}/quote`,
  )) as Quote;
}
