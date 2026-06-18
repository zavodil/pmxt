import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/client';
import { searchMarkets } from '../search/search';
import { toCatalogMarket } from '../dto';
import type { MarketRow } from '../types';

const SearchQ = z.object({
  q: z.string().optional(),
  venue: z.string().optional(),
  category: z.string().optional(),
  tags: z.string().optional(), // comma-separated
  status: z.string().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

export async function marketsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/markets/search', async (req, reply) => {
    const parsed = SearchQ.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const p = parsed.data;
    const rows = await searchMarkets({
      ...p,
      tags: p.tags ? p.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
    return { results: rows.map(toCatalogMarket) };
  });

  app.get('/v1/markets/:venue/:marketId', async (req, reply) => {
    const { venue, marketId } = req.params as { venue: string; marketId: string };
    const { rows } = await pool.query<MarketRow>(
      `SELECT * FROM markets WHERE venue=$1 AND market_id=$2`,
      [venue, marketId],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return toCatalogMarket(rows[0]!);
  });

  app.get('/v1/categories', async () => {
    const { rows } = await pool.query<{ category: string; count: number }>(
      `SELECT category, count(*)::int AS count FROM markets
       WHERE status='active' AND category IS NOT NULL
       GROUP BY category ORDER BY count DESC`,
    );
    return { categories: rows };
  });

  app.get('/v1/tags', async () => {
    const { rows } = await pool.query<{ tag: string; count: number }>(
      `SELECT unnest(tags) AS tag, count(*)::int AS count FROM markets
       WHERE status='active'
       GROUP BY tag ORDER BY count DESC LIMIT 200`,
    );
    return { tags: rows };
  });
}
