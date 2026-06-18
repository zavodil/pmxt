import { config } from '../config';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function call(venue: string, method: string, body: unknown): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.PMXT_ACCESS_TOKEN) headers['x-pmxt-access-token'] = config.PMXT_ACCESS_TOKEN;
  const res = await fetch(`${config.PMXT_BASE_URL}/api/${venue}/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pmxt ${method} -> ${res.status}`);
  const json = (await res.json()) as { success?: boolean; data?: unknown; error?: unknown };
  if (json && typeof json === 'object' && 'success' in json) {
    if (!json.success) throw new Error(`pmxt ${method}: ${JSON.stringify(json.error).slice(0, 200)}`);
    return json.data;
  }
  return json;
}

/** OHLCV candles for an outcome token. Positional args → envelope form. */
export async function ohlcv(
  outcomeId: string,
  resolution = '1h',
  limit = 48,
  venue = config.DEFAULT_VENUE,
): Promise<Candle[]> {
  const data = await call(venue, 'fetchOHLCV', { args: [outcomeId, { resolution, limit }] });
  return Array.isArray(data) ? (data as Candle[]) : [];
}
