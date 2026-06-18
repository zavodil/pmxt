import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { discover } from '../search/discover';

const Body = z.object({
  prompt: z.string().min(1),
  filters: z.object({ venue: z.string().optional() }).optional(),
  limit: z.coerce.number().optional(),
  rerank: z.boolean().optional(),
});

async function requireDiscoverAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (config.DISCOVER_API_KEY && req.headers['x-api-key'] !== config.DISCOVER_API_KEY) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

export async function discoverRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/markets/discover',
    {
      preHandler: requireDiscoverAuth,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const { prompt, filters, limit, rerank } = parsed.data;
      const results = await discover(prompt, filters ?? {}, limit ?? 10, rerank ?? true);
      return { results };
    },
  );
}
