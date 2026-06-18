import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client';

export function userId(req: FastifyRequest): string {
  const u = (req as unknown as { userId?: string }).userId;
  return u && u.trim() ? u : 'guest';
}

const CreateBody = z.object({ dial: z.coerce.number().min(1).max(5).optional() });
const PatchBody = z.object({ dial: z.coerce.number().min(1).max(5) });

export async function conversationsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/conversations', async (req, reply) => {
    const body = CreateBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const rows = await query<{ id: string; dial: number }>(
      `INSERT INTO conversations (user_id, dial) VALUES ($1,$2) RETURNING id, dial`,
      [userId(req), body.data.dial ?? 3],
    );
    return rows[0];
  });

  app.get('/v1/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = await query<{ id: string; dial: number }>(
      `SELECT id, dial FROM conversations WHERE id=$1 AND user_id=$2`,
      [id, userId(req)],
    );
    if (conv.length === 0) return reply.code(404).send({ error: 'not found' });
    const messages = await query(
      `SELECT role, content, created_at FROM messages WHERE conversation_id=$1 ORDER BY id`,
      [id],
    );
    const markets = await query(
      `SELECT venue, market_id, source, added_at FROM conversation_markets WHERE conversation_id=$1 ORDER BY added_at DESC`,
      [id],
    );
    return { ...conv[0], messages, markets };
  });

  app.patch('/v1/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PatchBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const rows = await query<{ id: string; dial: number }>(
      `UPDATE conversations SET dial=$1 WHERE id=$2 AND user_id=$3 RETURNING id, dial`,
      [body.data.dial, id, userId(req)],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });
}
