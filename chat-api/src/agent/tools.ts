import * as catalog from '../clients/catalog';
import { query } from '../db/client';
import type { Emit, SidebarMarket } from './types';

export interface ToolCtx {
  conversationId: string;
  userId: string;
  venue: string;
}

type Args = Record<string, unknown>;

type Outcome = { outcomeId: string; label: string };

/** Resolve a model-supplied outcome ref to a real outcome: by exact id, exact label, side hint, or substring. */
function resolveOutcome(outcomes: Outcome[], ref: string): Outcome | undefined {
  const needle = ref.trim().toLowerCase();
  const byId = outcomes.find((o) => o.outcomeId === ref);
  if (byId) return byId;
  const byLabel = outcomes.find((o) => o.label.toLowerCase() === needle);
  if (byLabel) return byLabel;
  if (needle === 'no' || needle === 'not' || needle === 'нет') {
    const neg = outcomes.find((o) => /^(no|not)\b/i.test(o.label));
    if (neg) return neg;
  }
  if (needle === 'yes' || needle === 'да') {
    const pos = outcomes.find((o) => /^yes\b/i.test(o.label));
    if (pos) return pos;
  }
  return outcomes.find(
    (o) => o.label.toLowerCase().includes(needle) || needle.includes(o.label.toLowerCase()),
  );
}

export async function executeTool(
  action: string,
  args: Args,
  ctx: ToolCtx,
  emit: Emit,
): Promise<unknown> {
  switch (action) {
    case 'discover_markets':
      return discoverTool(args, ctx, emit);
    case 'search_markets':
      return searchTool(args, ctx, emit);
    case 'get_quote':
      return quoteTool(args, ctx, emit);
    case 'propose_bet':
      return proposeBetTool(args, ctx, emit);
    default:
      return { error: `unknown tool: ${action}` };
  }
}

function toSidebar(m: catalog.DiscoverMatch | catalog.CatalogMarket): SidebarMarket {
  const dm = m as catalog.DiscoverMatch;
  return {
    venue: m.venue,
    marketId: m.marketId,
    title: m.title,
    outcomes: (m.outcomes ?? []).map((o) => ({ outcomeId: o.outcomeId, label: o.label })),
    suggestedOutcome: dm.suggestedOutcome ?? null,
    score: dm.score ?? null,
    rationale: dm.rationale ?? null,
    conditionId: m.conditionId,
    url: m.url,
    metrics: { volume24h: m.metrics?.volume24h, liquidity: m.metrics?.liquidity },
  };
}

async function persistMarkets(conversationId: string, markets: SidebarMarket[], source: string) {
  for (const m of markets) {
    await query(
      `INSERT INTO conversation_markets (conversation_id, venue, market_id, source)
       VALUES ($1,$2,$3,$4) ON CONFLICT (conversation_id, venue, market_id) DO NOTHING`,
      [conversationId, m.venue, m.marketId, source],
    );
  }
}

// compact view for the model (keep tokens low)
function compact(markets: SidebarMarket[]) {
  return markets.map((m) => ({
    marketId: m.marketId,
    title: m.title,
    outcomes: m.outcomes,
    suggestedOutcome: m.suggestedOutcome ?? undefined,
    score: m.score ?? undefined,
  }));
}

/** Fast, LLM-free market search for the instant sidebar (used before any AI commentary). */
export async function quickSearch(query: string, conversationId: string, emit: Emit): Promise<SidebarMarket[]> {
  const matches = await catalog.discover(query, 12, undefined, false);
  const sidebar = matches.map(toSidebar);
  emit({ type: 'sidebar', markets: sidebar });
  await persistMarkets(conversationId, sidebar, 'search');
  return sidebar;
}

async function discoverTool(args: Args, ctx: ToolCtx, emit: Emit) {
  const queryStr = String(args.query ?? '').trim();
  if (!queryStr) return { error: 'query is required' };
  const limit = Math.min(Number(args.limit) || 8, 20);
  const matches = await catalog.discover(queryStr, limit, undefined, false); // fast: no LLM rerank
  const sidebar = matches.map(toSidebar);
  emit({ type: 'sidebar', markets: sidebar });
  await persistMarkets(ctx.conversationId, sidebar, 'discover');
  return { count: sidebar.length, markets: compact(sidebar) };
}

async function searchTool(args: Args, ctx: ToolCtx, emit: Emit) {
  const q = String(args.q ?? '').trim();
  if (!q) return { error: 'q is required' };
  const limit = Math.min(Number(args.limit) || 8, 20);
  const results = await catalog.search(q, limit); // all configured venues
  const sidebar = results.map(toSidebar);
  emit({ type: 'sidebar', markets: sidebar });
  await persistMarkets(ctx.conversationId, sidebar, 'search');
  return { count: sidebar.length, markets: compact(sidebar) };
}

async function quoteTool(args: Args, ctx: ToolCtx, emit: Emit) {
  const marketId = String(args.marketId ?? '').trim();
  if (!marketId) return { error: 'marketId is required' };
  const venue = String(args.venue ?? ctx.venue);
  const quote = await catalog.getQuote(venue, marketId);
  emit({ type: 'quote', quote });
  return quote;
}

async function proposeBetTool(args: Args, ctx: ToolCtx, emit: Emit) {
  const marketId = String(args.marketId ?? '').trim();
  const outcomeId = String(args.outcomeId ?? '').trim();
  const amountUsdc = Number(args.amountUsdc);
  if (!marketId || !outcomeId || !(amountUsdc > 0)) {
    return { error: 'marketId, outcomeId and amountUsdc>0 are required' };
  }
  const venue = String(args.venue ?? ctx.venue);
  if (venue !== 'polymarket') {
    return { error: `betting is only supported on Polymarket right now (not ${venue})` };
  }
  const market = await catalog.getMarket(venue, marketId);
  const outcomes = market?.outcomes ?? [];
  const outcome = resolveOutcome(outcomes, outcomeId);
  if (!outcome) {
    return {
      error: 'outcomeId not recognised',
      validOutcomes: outcomes.map((o) => ({ outcomeId: o.outcomeId, label: o.label })),
    };
  }

  const rows = await query<{ id: string }>(
    `INSERT INTO bet_intents (conversation_id, user_id, venue, market_id, outcome_id, outcome_label, amount_usdc, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING id`,
    [ctx.conversationId, ctx.userId, venue, marketId, outcome.outcomeId, outcome.label, amountUsdc],
  );
  const betIntent = {
    id: rows[0]!.id,
    venue,
    marketId,
    marketTitle: market?.title,
    outcomeId: outcome.outcomeId,
    outcomeLabel: outcome.label,
    amountUsdc,
    status: 'draft',
  };
  emit({ type: 'bet', betIntent });
  return betIntent;
}
