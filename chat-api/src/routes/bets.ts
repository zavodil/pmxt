import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { query } from '../db/client';
import { userId } from './conversations';
import * as exec from '../clients/outlayerExec';

interface BetRow {
  id: string;
  venue: string;
  market_id: string;
  outcome_id: string;
  outcome_label: string | null;
  amount_usdc: number;
  status: string;
}

interface PlaceArgs {
  id: string;
  userId: string;
  marketId: string;
  outcomeId: string;
  amount: number;
}

/**
 * Execute a drafted bet. Dry-run until BET_EXECUTION_ENABLED=true; then it places
 * a real gasless order through pmxt's OutLayer-backed createOrder (sigType 3).
 * Requires the user's deposit-wallet to be set up (deploy+approvals) and funded
 * (pUSD ≥ amount × ~1.04). On failure the intent is marked 'failed' and the error
 * (e.g. "not enough balance") propagates to the caller.
 */
async function placeBet(
  bet: PlaceArgs,
): Promise<{ status: string; executed: boolean; note?: string; orderRef?: string | null }> {
  if (!config.BET_EXECUTION_ENABLED) {
    await query(`UPDATE bet_intents SET status='placed' WHERE id=$1`, [bet.id]);
    return { status: 'placed', executed: false, note: 'Dry run (BET_EXECUTION_ENABLED=false).' };
  }
  try {
    const clob = await exec.ensureClob(bet.userId);
    const order = await exec.placeOrder(bet.userId, clob, {
      marketId: bet.marketId,
      outcomeId: bet.outcomeId,
      side: 'buy',
      amount: bet.amount,
    });
    const orderRef =
      order && typeof order === 'object' && 'id' in order ? String((order as { id: unknown }).id) : null;
    await query(`UPDATE bet_intents SET status='placed', order_ref=$2 WHERE id=$1`, [bet.id, orderRef]);
    return { status: 'placed', executed: true, orderRef };
  } catch (err) {
    await query(`UPDATE bet_intents SET status='failed' WHERE id=$1`, [bet.id]);
    throw err;
  }
}

export async function betsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/bets', async (req) => {
    const rows = await query(
      `SELECT id, venue, market_id, outcome_id, outcome_label, amount_usdc, status, order_ref, created_at
       FROM bet_intents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [userId(req)],
    );
    return { bets: rows };
  });

  // The signed-in user's open Polymarket positions (public read off the deposit wallet).
  app.get('/v1/positions', async (req, reply) => {
    try {
      const positions = await exec.fetchPositions(userId(req));
      return { positions };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Exit a position before resolution: a real market SELL. `shares` = share count
  // to sell (a market SELL amount is denominated in shares, not USDC).
  const SellBody = z.object({
    marketId: z.string().min(1),
    outcomeId: z.string().min(1),
    shares: z.coerce.number().positive(),
  });
  app.post('/v1/bets/sell', async (req, reply) => {
    const b = SellBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.flatten() });
    const { marketId, outcomeId, shares } = b.data;
    try {
      const order = await exec.sellOrder(userId(req), { marketId, outcomeId, shares });
      const orderRef =
        order && typeof order === 'object' && 'id' in order ? String((order as { id: unknown }).id) : null;
      return { status: 'placed', side: 'sell', marketId, outcomeId, shares, orderRef, order };
    } catch (err) {
      return reply.code(502).send({ status: 'failed', side: 'sell', error: (err as Error).message });
    }
  });

  // Direct place (UI "Proceed" — user already chose side + amount).
  const PlaceBody = z.object({
    venue: z.string().default('polymarket'),
    marketId: z.string(),
    marketTitle: z.string().optional(),
    outcomeId: z.string(),
    outcomeLabel: z.string().optional(),
    amountUsdc: z.coerce.number().positive(),
    conversationId: z.string().uuid().optional(),
  });
  app.post('/v1/bets', async (req, reply) => {
    const b = PlaceBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.flatten() });
    const d = b.data;
    if (d.venue !== 'polymarket') {
      return reply.code(400).send({ error: `betting is only supported on Polymarket right now (not ${d.venue})` });
    }
    const uid = userId(req);
    const rows = await query<{ id: string }>(
      `INSERT INTO bet_intents (conversation_id, user_id, venue, market_id, outcome_id, outcome_label, amount_usdc, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING id`,
      [d.conversationId ?? null, uid, d.venue, d.marketId, d.outcomeId, d.outcomeLabel ?? null, d.amountUsdc],
    );
    const id = rows[0]!.id;
    try {
      const result = await placeBet({ id, userId: uid, marketId: d.marketId, outcomeId: d.outcomeId, amount: d.amountUsdc });
      return { id, ...d, ...result };
    } catch (err) {
      return reply.code(502).send({ id, status: 'failed', error: (err as Error).message });
    }
  });

  // Confirm an agent-proposed draft.
  const ConfirmBody = z.object({ betIntentId: z.string().uuid() });
  app.post('/v1/bets/confirm', async (req, reply) => {
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const uid = userId(req);
    const rows = await query<BetRow>(
      `SELECT id, venue, market_id, outcome_id, outcome_label, amount_usdc, status
       FROM bet_intents WHERE id=$1 AND user_id=$2`,
      [parsed.data.betIntentId, uid],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'bet intent not found' });
    const r = rows[0]!;
    try {
      const result = await placeBet({
        id: r.id,
        userId: uid,
        marketId: r.market_id,
        outcomeId: r.outcome_id,
        amount: Number(r.amount_usdc),
      });
      return { ...r, ...result };
    } catch (err) {
      return reply.code(502).send({ ...r, status: 'failed', error: (err as Error).message });
    }
  });

  // Cancel / unwind. Dry-run marks cancelled. Real flow: cancel the open order if
  // unfilled, else sell the position and withdraw pUSD → native USDC → NEAR.
  app.post('/v1/bets/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await query<BetRow>(`SELECT id, status FROM bet_intents WHERE id=$1 AND user_id=$2`, [
      id,
      userId(req),
    ]);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    if (rows[0]!.status === 'cancelled') return { id, status: 'cancelled' };
    await query(`UPDATE bet_intents SET status='cancelled' WHERE id=$1`, [id]);
    return {
      id,
      status: 'cancelled',
      executed: false,
      note: 'Dry run. Real: cancel the open order, or sell the position and withdraw via the OutLayer USDC flow.',
    };
  });
}
