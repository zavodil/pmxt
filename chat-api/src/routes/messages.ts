import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { query } from '../db/client';
import { runAgentTurn } from '../agent/loop';
import { quickSearch } from '../agent/tools';
import { commentOnMarkets } from '../agent/comment';
import type { AgentEvent, Emit } from '../agent/types';
import type { ChatMessage } from '../clients/llm';
import { userId } from './conversations';

const Body = z.object({
  text: z.string().min(1),
  selectedMarket: z
    .object({
      marketId: z.string(),
      title: z.string().optional(),
      venue: z.string().optional(),
      conditionId: z.string().optional(),
      status: z.string().optional(),
      resolutionDate: z.string().optional(),
      // prices already loaded on the client — pass them so the agent need not re-fetch
      outcomes: z
        .array(z.object({ label: z.string(), price: z.number().nullable().optional() }))
        .optional(),
    })
    .optional(),
});

export async function messagesRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const conv = await query<{ id: string; dial: number }>(
      `SELECT id, dial FROM conversations WHERE id=$1 AND user_id=$2`,
      [id, userId(req)],
    );
    if (conv.length === 0) return reply.code(404).send({ error: 'not found' });
    const dial = conv[0]!.dial;

    // prior turns for context (user/assistant only)
    const prior = await query<{ role: string; content: string }>(
      `SELECT role, content FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 20`,
      [id],
    );
    const history: ChatMessage[] = prior
      .reverse()
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const sel = parsed.data.selectedMarket;
    let userText = parsed.data.text;
    if (sel) {
      const parts = [
        `[Context: the user is viewing the market "${sel.title ?? ''}" (marketId=${sel.marketId}` +
          `${sel.conditionId ? `, conditionId=${sel.conditionId}` : ''}${sel.venue ? `, source=${sel.venue}` : ''}).`,
      ];
      if (sel.outcomes?.length) {
        parts.push(
          `Current live prices (already on the user's screen): ${sel.outcomes
            .map((o) => `${o.label} ${o.price != null ? `${(o.price * 100).toFixed(1)}%` : '—'}`)
            .join(', ')}.`,
        );
      }
      if (sel.status) parts.push(`Status: ${sel.status}.`);
      if (sel.resolutionDate) parts.push(`Resolves: ${sel.resolutionDate}.`);
      parts.push('Use these prices directly — do NOT call get_quote unless you need a fresher number.]');
      userText = `${parts.join(' ')}\n${parsed.data.text}`;
    }

    // persist the user message
    await query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)`, [
      id,
      parsed.data.text,
    ]);

    // start SSE
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    const send = (event: string, data: unknown) =>
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const emit: Emit = (e: AgentEvent) => send(e.type, e);

    let finalText = '';
    try {
      if (sel) {
        // DISCUSSION: a market is in focus → full agent (live quote, evidence, propose_bet).
        finalText = await runAgentTurn({
          conversationId: id,
          userId: userId(req),
          dial,
          history,
          userText,
          venue: config.DEFAULT_VENUE,
          emit,
        });
      } else {
        // DISCOVERY: fast keyword search → show markets INSTANTLY → then a single AI comment.
        const shown = await quickSearch(parsed.data.text, id, emit);
        finalText = await commentOnMarkets(parsed.data.text, shown, dial);
        if (finalText) emit({ type: 'message', text: finalText });
      }
    } catch (err) {
      send('error', { message: (err as Error).message });
    }

    if (finalText) {
      await query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1,'assistant',$2)`, [
        id,
        finalText,
      ]);
    }
    send('done', {});
    raw.end();
  });
}
