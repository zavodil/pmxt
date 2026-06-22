import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { config } from '../config';
import { ingestAll, type IngestVenueResult } from './ingest';
import { enrichAll } from '../enrich/enrich';
import { pool } from '../db/client';

export interface IngestCycleResult {
  ingested: IngestVenueResult[];
  enriched: number;
  ms: number;
}

export async function runIngestCycle(): Promise<IngestCycleResult> {
  const t0 = Date.now();
  const ingested = await ingestAll();
  let enriched = 0;
  try {
    enriched = await enrichAll();
  } catch (err) {
    console.error('[ingest] enrich failed:', (err as Error).message);
  }
  const ms = Date.now() - t0;
  console.log(`[ingest] ${JSON.stringify(ingested)} enriched=${enriched} in ${ms}ms`);
  return { ingested, enriched, ms };
}

export function scheduleIngest(): void {
  if (!cron.validate(config.INGEST_CRON)) {
    throw new Error(`invalid INGEST_CRON: ${config.INGEST_CRON}`);
  }
  cron.schedule(config.INGEST_CRON, () => {
    runIngestCycle().catch((err) => console.error('[ingest] cron run failed:', err));
  });
  console.log(`[ingest] scheduled: "${config.INGEST_CRON}" venues=${config.venues.join(',')}`);
}

// Standalone CLI: `npm run ingest`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runIngestCycle()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
