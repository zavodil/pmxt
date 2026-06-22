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
  // Active markets past their resolution date are stale — don't surface them.
  if (status === 'active') where.push(`(resolution_date IS NULL OR resolution_date > now())`);
  if (p.category) where.push(`category = ${bind(p.category)}`);
  if (p.tags && p.tags.length) where.push(`tags && ${bind(p.tags)}`);

  let order = `volume_24h DESC NULLS LAST`;
  if (p.q) {
    // Bind the query ONCE; the same $N placeholder is reused in WHERE and ORDER BY.
    // Don't call bind(p.q) a second time — it would push a duplicate, unused param.
    const qp = bind(p.q);
    where.push(`search_tsv @@ websearch_to_tsquery('english', ${qp})`);
    // Drop dead markets and blend volume into relevance, so a strong-but-dead
    // keyword match (e.g. a $0-volume market that merely shares a word) can't
    // outrank a live one.
    where.push(`(coalesce(volume_24h,0) > 0 OR coalesce(liquidity,0) > 0)`);
    order = `ts_rank(search_tsv, websearch_to_tsquery('english', ${qp})) * ln(coalesce(volume_24h,0) + coalesce(liquidity,0) + 2) DESC`;
  }

  const sql = `SELECT * FROM markets WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${bind(
    limit,
  )} OFFSET ${bind(offset)}`;

  const { rows } = await pool.query<MarketRow>(sql, params as never[]);
  return rows;
}
