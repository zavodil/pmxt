import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client';
import { resolveUserId } from '../auth';
import { tierFor, toolsForTier } from '../agent/tiers';
import { conversationsRoutes } from './conversations';
import { messagesRoutes } from './messages';
import { betsRoutes } from './bets';
import { marketsRoutes } from './markets';
import { authRoutes } from './auth';
import { walletRoutes } from './wallet';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // Who am I + what plan/tools I have — the UI shows the tier; the agent enforces it.
  app.get('/v1/me', async (req) => {
    const userId = await resolveUserId(req);
    const tier = tierFor(userId);
    return { userId, tier, tools: toolsForTier(tier) };
  });
  await app.register(authRoutes);
  await app.register(conversationsRoutes);
  await app.register(messagesRoutes);
  await app.register(betsRoutes);
  await app.register(marketsRoutes);
  await app.register(walletRoutes);
}
