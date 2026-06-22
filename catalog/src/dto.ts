import type { CatalogMarket, MarketRow } from './types';

export function toCatalogMarket(row: MarketRow): CatalogMarket {
  return {
    venue: row.venue,
    marketId: row.market_id,
    eventId: row.event_id ?? undefined,
    slug: row.slug ?? undefined,
    title: row.title,
    description: row.description,
    category: row.category ?? undefined,
    tags: row.tags ?? [],
    outcomes: row.outcomes ?? [],
    resolutionDate: row.resolution_date ?? undefined,
    status: row.status,
    conditionId: row.condition_id ?? undefined,
    url: row.url ?? undefined,
    image: row.image ?? undefined,
    metrics: {
      volume24h: row.volume_24h ?? undefined,
      liquidity: row.liquidity ?? undefined,
      volume: row.volume ?? undefined,
      asOf: row.metrics_as_of ?? undefined,
    },
  };
}
