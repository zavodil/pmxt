import { config } from '../config';
import { pool } from '../db/client';
import type { MarketRow } from '../types';

export interface SearchParams {
  q?: string;
  venue?: string;
  category?: string;
  tags?: string[];
  status?: string;
  limit?: number;
  offset?: number;
}

/** Keyword + filter search over the catalog (cheap, cacheable). */
export async function searchMarkets(p: SearchParams): Promise<MarketRow[]> {
  const venues = p.venue ? [p.venue] : config.venues;
  const status = p.status ?? 'active';
  const limit = Math.min(p.limit ?? 20, 100);
  const offset = Math.max(p.offset ?? 0, 0);

  const params: unknown[] = [];
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  const where: string[] = [`status = ${bind(status)}`, `venue = ANY(${bind(venues)})`];
  if (p.category) where.push(`category = ${bind(p.category)}`);
  if (p.tags && p.tags.length) where.push(`tags && ${bind(p.tags)}`);

  let order = `volume_24h DESC NULLS LAST`;
  if (p.q) {
    const qp = bind(p.q);
    where.push(`search_tsv @@ websearch_to_tsquery('english', ${qp})`);
    order = `ts_rank(search_tsv, websearch_to_tsquery('english', ${qp})) DESC`;
  }

  const sql = `SELECT * FROM markets WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${bind(
    limit,
  )} OFFSET ${bind(offset)}`;

  const { rows } = await pool.query<MarketRow>(sql, params as never[]);
  return rows;
}
