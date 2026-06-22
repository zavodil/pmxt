/** A row of the `markets` table as returned by pg. */
export interface MarketRow {
  id: number;
  venue: string;
  market_id: string;
  event_id: string | null;
  slug: string | null;
  title: string;
  description: string;
  category: string | null;
  tags: string[] | null;
  outcomes: { outcomeId: string; label: string }[] | null;
  resolution_date: Date | null;
  status: string;
  condition_id: string | null;
  url: string | null;
  image: string | null;
  volume: number | null;
  volume_24h: number | null;
  liquidity: number | null;
  metrics_as_of: Date | null;
}

/** Public DTO returned to the frontend — metadata only, NO live prices. */
export interface CatalogMarket {
  venue: string;
  marketId: string;
  eventId?: string;
  slug?: string;
  title: string;
  description: string;
  category?: string;
  tags: string[];
  outcomes: { outcomeId: string; label: string }[];
  resolutionDate?: Date;
  status: string;
  conditionId?: string;
  url?: string;
  image?: string;
  metrics: {
    volume24h?: number;
    liquidity?: number;
    volume?: number;
    asOf?: Date;
  };
}

export interface DiscoverMatch extends CatalogMarket {
  score: number | null;
  rationale: string | null;
  suggestedOutcome: { outcomeId: string; label: string } | null;
}
