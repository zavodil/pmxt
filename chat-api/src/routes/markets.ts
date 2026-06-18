import type { FastifyInstance } from 'fastify';
import { getMarket, getQuote } from '../clients/catalog';
import * as pmxt from '../clients/pmxt';

const VALID_RES = new Set(['1m', '5m', '15m', '1h', '6h', '1d']);

export async function marketsRoutes(app: FastifyInstance): Promise<void> {
  // Enriched detail for the selected-market panel: catalog metadata + live quote.
  app.get('/v1/markets/:venue/:marketId/detail', async (req, reply) => {
    const { venue, marketId } = req.params as { venue: string; marketId: string };
    const market = await getMarket(venue, marketId);
    if (!market) return reply.code(404).send({ error: 'not found' });
    let quote: unknown = null;
    try {
      quote = await getQuote(venue, marketId);
    } catch {
      /* quote is best-effort */
    }
    return { market, quote };
  });

  // Price history (OHLCV) for one outcome token → the sparkline/chart.
  app.get('/v1/markets/:venue/:outcomeId/ohlcv', async (req, reply) => {
    const { venue, outcomeId } = req.params as { venue: string; outcomeId: string };
    const q = req.query as { resolution?: string; limit?: string };
    const resolution = q.resolution && VALID_RES.has(q.resolution) ? q.resolution : '1h';
    const limit = Math.min(Number(q.limit) || 48, 200);
    try {
      const candles = await pmxt.ohlcv(outcomeId, resolution, limit, venue);
      return { candles };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
