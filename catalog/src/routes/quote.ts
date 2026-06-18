import type { FastifyInstance } from 'fastify';
import { fetchMarketRaw, UnifiedMarketZ } from '../pmxt/client';

/** Live prices on demand — proxies pmxt, never persisted (C2). */
export async function quoteRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/markets/:venue/:marketId/quote',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { venue, marketId } = req.params as { venue: string; marketId: string };
      let raw: unknown;
      try {
        raw = await fetchMarketRaw(venue, marketId);
      } catch (err) {
        return reply.code(502).send({ error: 'pmxt upstream error', detail: (err as Error).message });
      }
      const parsed = UnifiedMarketZ.safeParse(raw);
      if (!parsed.success) {
        return reply.code(502).send({ error: 'bad upstream shape', detail: parsed.error.message });
      }
      const m = parsed.data;
      return {
        venue,
        marketId,
        asOf: new Date().toISOString(),
        outcomes: (m.outcomes ?? []).map((o) => ({
          outcomeId: o.outcomeId,
          label: o.label,
          price: o.price ?? null,
        })),
        liquidity: m.liquidity ?? null,
      };
    },
  );
}
