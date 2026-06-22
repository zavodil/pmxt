import * as catalog from '../clients/catalog';
import { query } from '../db/client';
import { config } from '../config';
import { chat } from '../clients/llm';
import type { Emit, SidebarMarket } from './types';

export interface ToolCtx {
  conversationId: string;
  userId: string;
  venue: string;
  /** Tools this user's plan (tier) may call — others are refused. */
  allowedTools: string[];
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
  // Tier gate: never run a tool the user's plan doesn't include.
  if (!ctx.allowedTools.includes(action)) {
    return { error: `the "${action}" tool isn't available on your current plan` };
  }
  switch (action) {
    case 'discover_markets':
      return discoverTool(args, ctx, emit);
    case 'search_markets':
      return searchTool(args, ctx, emit);
    case 'present_markets':
      return presentTool(args, ctx, emit);
    case 'get_quote':
      return quoteTool(args, ctx, emit);
    case 'propose_bet':
      return proposeBetTool(args, ctx, emit);
    case 'web_research':
      return webResearchTool(args);
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
  if (!markets.length) return;
  const values: string[] = [];
  const params: unknown[] = [];
  for (const m of markets) {
    const i = params.length;
    values.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4})`);
    params.push(conversationId, m.venue, m.marketId, source);
  }
  await query(
    `INSERT INTO conversation_markets (conversation_id, venue, market_id, source)
     VALUES ${values.join(',')} ON CONFLICT (conversation_id, venue, market_id) DO NOTHING`,
    params,
  );
}

// compact view for the model (keep tokens low). venue is included so get_quote /
// propose_bet target the right source — markets span Polymarket + Limitless.
function compact(markets: SidebarMarket[]) {
  return markets.map((m) => ({
    venue: m.venue,
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

// Replace the sidebar with EXACTLY the markets the agent chose (by id, from prior
// results) — so the visible results match its answer after a filter/exclusion.
async function presentTool(args: Args, ctx: ToolCtx, emit: Emit) {
  const list = Array.isArray(args.marketIds)
    ? args.marketIds
    : Array.isArray(args.markets)
      ? args.markets
      : [];
  const ids = list
    .map((r) => (typeof r === 'string' ? r : String((r as { marketId?: string; id?: string })?.marketId ?? (r as { id?: string })?.id ?? '')))
    .filter(Boolean);
  if (!ids.length) return { error: 'marketIds (a list of market ids from prior results) is required' };
  // Resolve each id's venue from what was already shown in THIS conversation,
  // then re-fetch and emit a curated sidebar.
  const rows = await query<{ venue: string; market_id: string }>(
    `SELECT DISTINCT venue, market_id FROM conversation_markets
     WHERE conversation_id=$1 AND market_id = ANY($2)`,
    [ctx.conversationId, ids],
  );
  const fetched = await Promise.all(rows.map((r) => catalog.getMarket(r.venue, r.market_id).catch(() => null)));
  const sidebar = fetched.filter((m): m is catalog.CatalogMarket => !!m).map(toSidebar);
  emit({ type: 'sidebar', markets: sidebar });
  // Re-persist so the recent-markets context reflects the curated set as current.
  await persistMarkets(ctx.conversationId, sidebar, 'present');
  return { count: sidebar.length, shown: sidebar.map((m) => m.title) };
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

// Live web lookup via the search-enabled model (native WebSearch/WebFetch on the
// proxy, ai-intents style): a one-shot research call returning prose findings the
// agent can cite. For "what's the current value now" / latest-news questions that
// market data alone can't answer.
async function webResearchTool(args: Args): Promise<unknown> {
  const q = String(args.query ?? '').trim();
  if (!q) return { error: 'query is required' };
  if (!config.AI_SEARCH_MODEL) return { error: 'web research is not configured' };
  const messages = [
    {
      role: 'system' as const,
      content:
        'You are a web research assistant with live web tools (WebSearch + WebFetch). ' +
        'Search the web for the LATEST relevant information for the query, then report findings ' +
        'as concise PLAIN PROSE: the key facts, any current values/numbers, and the sources with ' +
        'their dates. Prefix any current figure with "as of <date>". Do NOT output JSON and do ' +
        'NOT make a recommendation — only report what the live web currently shows.',
    },
    { role: 'user' as const, content: q },
  ];
  try {
    const findings = (await chat(messages, 0.2, config.AI_SEARCH_MODEL)).trim();
    return { query: q, findings: findings ? findings.slice(0, 8000) : '(no web findings returned)' };
  } catch (err) {
    return { error: `web research failed: ${(err as Error).message}` };
  }
}
