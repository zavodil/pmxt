import { createHash } from 'node:crypto';
import type { UnifiedMarket } from '../pmxt/client';

/** Hash of the STABLE metadata only — changing it flags a row for re-enrichment. */
export function contentHash(m: UnifiedMarket): string {
  const stable = JSON.stringify({
    title: m.title,
    description: m.description ?? '',
    category: m.category ?? null,
    tags: [...(m.tags ?? [])].sort(),
    resolutionDate: m.resolutionDate ? new Date(m.resolutionDate).toISOString() : null,
    outcomes: (m.outcomes ?? []).map((o) => o.label).sort(),
  });
  return createHash('sha256').update(stable).digest('hex');
}
