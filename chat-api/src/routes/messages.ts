import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { query } from '../db/client';
import { runAgentTurn } from '../agent/loop';
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
    const allHistory: ChatMessage[] = prior
      .reverse()
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    // Cap history by characters (not just the 20-row count) to bound prompt cost
    // on long chats — keep the most recent turns that fit the budget.
    const HISTORY_CHAR_BUDGET = 24000;
    let histUsed = 0;
    const history: ChatMessage[] = [];
    for (let i = allHistory.length - 1; i >= 0; i--) {
      histUsed += allHistory[i]!.content.length;
      if (histUsed > HISTORY_CHAR_BUDGET && history.length) break;
      history.unshift(allHistory[i]!);
    }

    // Markets already shown this conversation → context so the agent can resolve
    // "the second one" / "hide those" without blindly re-searching (chat-api shares
    // the catalog DB, so we can join conversation_markets to markets for titles).
    const shownRows = await query<{ venue: string; market_id: string; title: string }>(
      `SELECT cm.venue, cm.market_id, m.title
         FROM conversation_markets cm
         JOIN markets m ON m.venue = cm.venue AND m.market_id = cm.market_id
        WHERE cm.conversation_id = $1
        ORDER BY cm.added_at DESC
        LIMIT 15`,
      [id],
    );
    const recentMarkets = shownRows.length
      ? "Markets currently in the user's results panel (most recent first). Resolve references like " +
        '"the second one" or "hide those" against THIS list without re-searching, and pass the exact ' +
        'marketIds to present_markets when filtering:\n' +
        shownRows.map((r, i) => `${i + 1}. "${r.title}" (venue=${r.venue}, marketId=${r.market_id})`).join('\n')
      : undefined;

    const sel = parsed.data.selectedMarket;
    let userText = parsed.data.text;
    if (sel) {
      // Client-supplied strings are untrusted — strip framing chars + cap length so a
      // crafted title can't break out of the [Context: …] block and inject instructions.
      const safe = (s: string | undefined, max = 200) => (s ?? '').replace(/[[\]\n\r]/g, ' ').slice(0, max);
      const parts = [
        `[Context: the user is viewing the market "${safe(sel.title)}" (marketId=${safe(sel.marketId, 80)}` +
          `${sel.conditionId ? `, conditionId=${safe(sel.conditionId, 80)}` : ''}${sel.venue ? `, source=${safe(sel.venue, 30)}` : ''}).`,
      ];
      if (sel.outcomes?.length) {
        parts.push(
          `Current live prices (already on the user's screen): ${sel.outcomes
            .map((o) => `${safe(o.label, 60)} ${o.price != null ? `${(o.price * 100).toFixed(1)}%` : '—'}`)
            .join(', ')}.`,
        );
      }
      if (sel.status) parts.push(`Status: ${safe(sel.status, 30)}.`);
      if (sel.resolutionDate) parts.push(`Resolves: ${safe(sel.resolutionDate, 40)}.`);
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
      // Every turn goes through the context-aware ReAct agent (with the recent-
      // markets note) so first-turn discovery and follow-up refinements behave
      // consistently, and the agent can curate results via present_markets.
      finalText = await runAgentTurn({
        conversationId: id,
        userId: userId(req),
        dial,
        history,
        userText,
        venue: config.DEFAULT_VENUE,
        emit,
        recentMarkets,
      });
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
