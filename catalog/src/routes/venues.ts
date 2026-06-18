import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { pool } from '../db/client';

export async function venuesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/venues', async () => {
    const { rows } = await pool.query<{ venue: string; active: number; total: number }>(
      `SELECT venue,
              count(*) FILTER (WHERE status='active')::int AS active,
              count(*)::int AS total
       FROM markets GROUP BY venue`,
    );
    const byVenue = new Map(rows.map((r) => [r.venue, r]));
    return {
      venues: config.venues.map((v) => ({
        venue: v,
        active: byVenue.get(v)?.active ?? 0,
        total: byVenue.get(v)?.total ?? 0,
      })),
    };
  });
}
