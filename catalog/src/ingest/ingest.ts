import type { PoolClient } from 'pg';
import { config } from '../config';
import { pool } from '../db/client';
import { fetchMarketsRaw, UnifiedMarketZ, type UnifiedMarket } from '../pmxt/client';
import { contentHash } from './diff';

export interface IngestVenueResult {
  venue: string;
  upserted: number;
  closed: number;
  invalid: number;
}

export async function ingestVenue(venue: string): Promise<IngestVenueResult> {
  const runStart = new Date();

  // pmxt returns the full active set in ONE call (it does not honor limit/offset
  // pagination); a high limit + single fetch avoids hammering the upstream.
  const raw = await fetchMarketsRaw(venue, { status: 'active', limit: config.INGEST_PAGE_LIMIT });
  if (raw.length >= config.INGEST_PAGE_LIMIT) {
    console.warn(
      `[ingest] ${venue}: received ${raw.length} >= INGEST_PAGE_LIMIT (${config.INGEST_PAGE_LIMIT}); may be truncated — raise it.`,
    );
  }

  let upserted = 0;
  let invalid = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of raw) {
      const parsed = UnifiedMarketZ.safeParse(r);
      if (!parsed.success) {
        invalid++;
        continue;
      }
      const m = parsed.data;
      if ((m.volume24h ?? 0) < config.INGEST_MIN_VOLUME) continue;
      await upsertMarket(client, venue, m, runStart);
      upserted++;
    }
    // Sweep: markets that were active but did not appear this run → closed.
    const closed = await client.query(
      `UPDATE markets SET status='closed', updated_at=now()
       WHERE venue=$1 AND status='active' AND last_seen_at < $2`,
      [venue, runStart],
    );
    await client.query('COMMIT');
    return { venue, upserted, closed: closed.rowCount ?? 0, invalid };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function upsertMarket(
  client: PoolClient,
  venue: string,
  m: UnifiedMarket,
  seenAt: Date,
): Promise<void> {
  const hash = contentHash(m);
  const outcomes = JSON.stringify(
    (m.outcomes ?? []).map((o) => ({ outcomeId: o.outcomeId, label: o.label })),
  );
  const sourceMetadata = m.sourceMetadata ? JSON.stringify(m.sourceMetadata) : null;

  await client.query(
    `INSERT INTO markets
       (venue, market_id, event_id, slug, title, description, category, tags, outcomes,
        resolution_date, status, condition_id, url, image,
        volume, volume_24h, liquidity, metrics_as_of, source_metadata, content_hash, last_seen_at)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
        $10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19::jsonb,$20,$21)
     ON CONFLICT (venue, market_id) DO UPDATE SET
        event_id=EXCLUDED.event_id, slug=EXCLUDED.slug,
        volume=EXCLUDED.volume, volume_24h=EXCLUDED.volume_24h, liquidity=EXCLUDED.liquidity,
        metrics_as_of=EXCLUDED.metrics_as_of, status=EXCLUDED.status, last_seen_at=EXCLUDED.last_seen_at,
        title=EXCLUDED.title, description=EXCLUDED.description, tags=EXCLUDED.tags, category=EXCLUDED.category,
        outcomes=EXCLUDED.outcomes, resolution_date=EXCLUDED.resolution_date, condition_id=EXCLUDED.condition_id,
        url=EXCLUDED.url, image=EXCLUDED.image, source_metadata=EXCLUDED.source_metadata,
        content_hash=EXCLUDED.content_hash,
        needs_enrich = (markets.content_hash IS DISTINCT FROM EXCLUDED.content_hash) OR markets.needs_enrich,
        updated_at = CASE WHEN markets.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                          THEN now() ELSE markets.updated_at END`,
    [
      venue,
      m.marketId,
      m.eventId ?? null,
      m.slug ?? null,
      m.title,
      m.description ?? '',
      m.category ?? null,
      m.tags ?? [],
      outcomes,
      m.resolutionDate ?? null,
      m.status ?? 'active',
      m.contractAddress ?? null,
      m.url ?? null,
      m.image ?? null,
      m.volume ?? null,
      m.volume24h ?? null,
      m.liquidity ?? null,
      seenAt,
      sourceMetadata,
      hash,
      seenAt,
    ],
  );
}

export async function ingestAll(): Promise<IngestVenueResult[]> {
  const out: IngestVenueResult[] = [];
  for (const venue of config.venues) {
    try {
      out.push(await ingestVenue(venue));
    } catch (err) {
      console.error(`[ingest] venue ${venue} failed:`, (err as Error).message);
    }
  }
  return out;
}
