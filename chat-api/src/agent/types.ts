export interface SidebarMarket {
  venue: string;
  marketId: string;
  title: string;
  outcomes: { outcomeId: string; label: string }[];
  suggestedOutcome?: { outcomeId: string; label: string } | null;
  score?: number | null;
  rationale?: string | null;
  conditionId?: string;
  url?: string;
  metrics?: { volume24h?: number; liquidity?: number };
}

export interface BetIntentView {
  id: string;
  venue: string;
  marketId: string;
  marketTitle?: string;
  outcomeId: string;
  outcomeLabel?: string | null;
  amountUsdc: number;
  status: string;
}

export type AgentEvent =
  | { type: 'step'; tool: string; args: unknown }
  | { type: 'sidebar'; markets: SidebarMarket[] }
  | { type: 'quote'; quote: unknown }
  | { type: 'bet'; betIntent: BetIntentView }
  | { type: 'message'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type Emit = (e: AgentEvent) => void;
