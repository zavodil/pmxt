// User plans and the agent tools each plan may use.
//
// The toolset is gated per tier so we can monetise later. For now the *base*
// user is Premium (everything, incl. live web research); Free is defined but
// gets no tools yet — it's scaffolding, not an active downgrade.

export type Tier = 'premium' | 'free';

/** Tools each tier may call. Order here is also the order shown to the model. */
export const TIER_TOOLS: Record<Tier, string[]> = {
  premium: ['discover_markets', 'search_markets', 'present_markets', 'get_quote', 'propose_bet', 'web_research'],
  free: [],
};

/**
 * The plan for a user. Everyone is Premium for now (the base user) — swap this
 * for a real per-user lookup (DB column / billing) when plans go live.
 */
export function tierFor(_userId: string): Tier {
  return 'premium';
}

export function toolsForTier(tier: Tier): string[] {
  return TIER_TOOLS[tier] ?? [];
}

/** Human-readable capability names — used to tell the user what an upgrade unlocks. */
export const TOOL_CAPABILITY: Record<string, string> = {
  discover_markets: 'market discovery',
  search_markets: 'keyword market search',
  present_markets: 'curating the results list',
  get_quote: 'live odds / quotes',
  propose_bet: 'drafting a bet',
  web_research: 'live web search (current prices, news, real-world facts)',
};

/** Tools a higher tier has that this tier can't use (premium is the superset). */
export function lockedToolsForTier(tier: Tier): string[] {
  const have = new Set(toolsForTier(tier));
  return TIER_TOOLS.premium.filter((t) => !have.has(t));
}
