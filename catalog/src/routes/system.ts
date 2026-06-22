import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { pool } from '../db/client';
import { runIngestCycle } from '../ingest/cron';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.post(
    '/v1/admin/ingest',
    {
      preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (config.ADMIN_API_KEY && req.headers['x-admin-key'] !== config.ADMIN_API_KEY) {
          return reply.code(401).send({ error: 'unauthorized' });
        }
      },
    },
    async () => runIngestCycle(),
  );
}
