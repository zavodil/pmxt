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

  // List this user's conversations for the history panel (title = first user
  // message, preview = last assistant reply), most-recently-active first.
  app.get('/v1/conversations', async (req) => {
    const rows = await query<{
      id: string;
      dial: number;
      created_at: string;
      title: string | null;
      preview: string | null;
      last_at: string | null;
    }>(
      `SELECT c.id, c.dial, c.created_at,
         (SELECT content FROM messages m WHERE m.conversation_id=c.id AND m.role='user'      ORDER BY m.id ASC  LIMIT 1) AS title,
         (SELECT content FROM messages m WHERE m.conversation_id=c.id AND m.role='assistant' ORDER BY m.id DESC LIMIT 1) AS preview,
         (SELECT created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_at
       FROM conversations c
       WHERE c.user_id=$1
       ORDER BY coalesce(
         (SELECT created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1), c.created_at
       ) DESC
       LIMIT 50`,
      [userId(req)],
    );
    return { conversations: rows.filter((r) => r.title) };
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
