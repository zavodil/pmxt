export interface Outcome {
  outcomeId: string;
  label: string;
}

export interface SidebarMarket {
  venue: string;
  marketId: string;
  title: string;
  outcomes: Outcome[];
  suggestedOutcome?: Outcome | null;
  score?: number | null;
  rationale?: string | null;
  conditionId?: string;
  url?: string;
  description?: string;
  category?: string;
  tags?: string[];
  resolutionDate?: string;
  status?: string;
  metrics?: { volume24h?: number; liquidity?: number; volume?: number };
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketDetail {
  market: SidebarMarket;
  quote: Quote | null;
}

export interface Quote {
  venue: string;
  marketId: string;
  asOf: string;
  outcomes: { outcomeId: string; label: string; price: number | null }[];
  liquidity: number | null;
}

export interface BetIntent {
  id: string;
  venue: string;
  marketId: string;
  marketTitle?: string;
  outcomeId: string;
  outcomeLabel?: string | null;
  amountUsdc: number;
  status: string;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
}

export type AgentEvent =
  | { type: 'step'; tool: string; args: unknown }
  | { type: 'sidebar'; markets: SidebarMarket[] }
  | { type: 'quote'; quote: Quote }
  | { type: 'bet'; betIntent: BetIntent }
  | { type: 'message'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };
