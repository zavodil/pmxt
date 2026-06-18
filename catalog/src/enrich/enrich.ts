import { config } from '../config';
import { pool } from '../db/client';
import { embed, toVectorLiteral } from './embed';

interface EnrichRow {
  id: number;
  title: string;
  description: string | null;
  tags: string[] | null;
}

/** Embed up to `batchSize` rows flagged needs_enrich. Returns rows processed. */
export async function enrichBatch(batchSize = 64): Promise<number> {
  const { rows } = await pool.query<EnrichRow>(
    `SELECT id, title, description, tags FROM markets WHERE needs_enrich = true LIMIT $1`,
    [batchSize],
  );
  if (rows.length === 0) return 0;

  const texts = rows.map(
    (r) => `${r.title}\n${r.description ?? ''}\nTags: ${(r.tags ?? []).join(', ')}`,
  );
  const vecs = await embed(texts);

  for (let i = 0; i < rows.length; i++) {
    await pool.query(
      `UPDATE markets SET embedding=$1::vector, needs_enrich=false, enriched_at=now() WHERE id=$2`,
      [toVectorLiteral(vecs[i]!), rows[i]!.id],
    );
  }
  return rows.length;
}

/** Drain the needs_enrich queue. No-op when embeddings are disabled. */
export async function enrichAll(): Promise<number> {
  if (config.EMBEDDINGS_PROVIDER === 'none') {
    console.warn('[enrich] skipped (EMBEDDINGS_PROVIDER=none)');
    return 0;
  }
  let total = 0;
  for (;;) {
    const n = await enrichBatch();
    total += n;
    if (n === 0) break;
  }
  return total;
}
