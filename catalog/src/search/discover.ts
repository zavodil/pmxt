import { z } from 'zod';
import { config } from '../config';
import { pool } from '../db/client';
import { embedQuery, toVectorLiteral } from '../enrich/embed';
import { toCatalogMarket } from '../dto';
import type { DiscoverMatch, MarketRow } from '../types';

export interface DiscoverFilters {
  venue?: string;
}

const RerankZ = z.object({
  results: z.array(
    z.object({
      marketId: z.string(),
      score: z.number(),
      rationale: z.string(),
      suggestedOutcomeId: z.string().optional(),
      suggestedOutcomeLabel: z.string().optional(),
    }),
  ),
});
type RerankResult = z.infer<typeof RerankZ>['results'][number];

const llmEnabled = (): boolean => Boolean(config.AI_BASE_URL && config.AI_API_KEY && config.AI_MODEL);

/** prompt -> ranked markets: hybrid retrieval (FTS + vector) fused by RRF, then optional LLM rerank. */
export async function discover(
  prompt: string,
  filters: DiscoverFilters = {},
  limit = 10,
  useRerank = true,
): Promise<DiscoverMatch[]> {
  const venues = filters.venue ? [filters.venue] : config.venues;
  const k = config.DISCOVER_RETRIEVE_K;

  const lists: number[][] = [];
  if (config.EMBEDDINGS_PROVIDER !== 'none') {
    try {
      lists.push(await semanticTopK(prompt, venues, k));
    } catch (err) {
      console.error('[discover] semantic retrieval failed:', (err as Error).message);
    }
  }
  lists.push(await keywordTopK(prompt, venues, k));

  const fusedIds = rrf(lists).slice(0, k);
  if (fusedIds.length === 0) return [];

  const { rows } = await pool.query<MarketRow>(`SELECT * FROM markets WHERE id = ANY($1)`, [
    fusedIds,
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = fusedIds.map((id) => byId.get(id)).filter((r): r is MarketRow => Boolean(r));

  const retrievalOrder = (): DiscoverMatch[] =>
    ordered.slice(0, limit).map((r) => ({
      ...toCatalogMarket(r),
      score: null,
      rationale: null,
      suggestedOutcome: null,
    }));

  // Fast path (useRerank=false) or no LLM → return retrieval order, no LLM call.
  if (!useRerank || !llmEnabled()) return retrievalOrder();

  let ranked: RerankResult[];
  try {
    ranked = await rerank(prompt, ordered);
  } catch (err) {
    console.error('[discover] rerank failed, falling back to retrieval order:', (err as Error).message);
    return retrievalOrder();
  }

  const rankByMarketId = new Map(ranked.map((r) => [r.marketId, r]));
  return ordered
    .map((r): DiscoverMatch | null => {
      const rk = rankByMarketId.get(r.market_id);
      if (!rk) return null; // LLM judged it irrelevant
      return {
        ...toCatalogMarket(r),
        score: rk.score,
        rationale: rk.rationale,
        suggestedOutcome: rk.suggestedOutcomeId
          ? { outcomeId: rk.suggestedOutcomeId, label: rk.suggestedOutcomeLabel ?? '' }
          : null,
      };
    })
    .filter((m): m is DiscoverMatch => m !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}

async function semanticTopK(prompt: string, venues: string[], k: number): Promise<number[]> {
  const qvec = toVectorLiteral(await embedQuery(prompt));
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM markets
     WHERE status='active' AND venue = ANY($1) AND embedding IS NOT NULL
       AND (resolution_date IS NULL OR resolution_date > now())
     ORDER BY embedding <=> $2::vector LIMIT $3`,
    [venues, qvec, k],
  );
  return rows.map((r) => r.id);
}

// Discovery wants OR semantics (match ANY salient term), unlike the search box
// which ANDs. Build a sanitized `term | term | ...` tsquery from the prompt.
const STOPWORDS = new Set([
  'will', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'by', 'is', 'are', 'be',
  'with', 'at', 'as', 'vs', 'from', 'this', 'that', 'it', 'its', 'into', 'over', 'under', 'than',
  'then', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'should', 'would', 'may',
  'might', 'must', 'not', 'no', 'i', 'we', 'you', 'they', 'what', 'which', 'who', 'how', 'when',
  'where', 'why', 'about', 'going', 'get',
]);

function orTsQuery(prompt: string): string | null {
  const terms = [
    ...new Set(
      (prompt.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
        (w) => w.length >= 2 && !STOPWORDS.has(w),
      ),
    ),
  ];
  return terms.length ? terms.join(' | ') : null;
}

async function keywordTopK(prompt: string, venues: string[], k: number): Promise<number[]> {
  const query = orTsQuery(prompt);
  if (!query) return [];
  try {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM markets
       WHERE status='active' AND venue = ANY($1)
         AND search_tsv @@ to_tsquery('english', $2)
         AND (coalesce(volume_24h,0) > 0 OR coalesce(liquidity,0) > 0)
         AND (resolution_date IS NULL OR resolution_date > now())
       ORDER BY ts_rank(search_tsv, to_tsquery('english', $2))
                * ln(coalesce(volume_24h,0) + coalesce(liquidity,0) + 2) DESC
       LIMIT $3`,
      [venues, query, k],
    );
    return rows.map((r) => r.id);
  } catch (err) {
    console.error('[discover] keyword retrieval failed:', (err as Error).message);
    return [];
  }
}

/** Reciprocal Rank Fusion over multiple ranked id lists. */
function rrf(lists: number[][], kConst = 60): number[] {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, idx) => score.set(id, (score.get(id) ?? 0) + 1 / (kConst + idx + 1)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const SYSTEM =
  'You match a user intent to prediction markets. Given the user prompt and candidate markets, return ' +
  'ONLY the markets genuinely relevant to the intent. For each, give a 0..1 relevance score, a one-line ' +
  'rationale, and the outcome (outcomeId + label) the user\'s view implies. Drop irrelevant candidates. ' +
  'Respond with ONLY a JSON object, no prose, no markdown.';

/** OpenAI-compatible chat-completions rerank (works with local-claude / OpenAI / any compatible endpoint). */
async function rerank(prompt: string, cands: MarketRow[]): Promise<RerankResult[]> {
  const candidates = cands.map((c) => ({
    marketId: c.market_id,
    title: c.title,
    description: (c.description ?? '').slice(0, 500),
    resolutionDate: c.resolution_date,
    outcomes: c.outcomes ?? [],
  }));

  const user =
    `User prompt:\n${prompt}\n\nCandidate markets (JSON):\n${JSON.stringify(candidates)}\n\n` +
    'Return ONLY this JSON shape: ' +
    '{"results":[{"marketId":string,"score":number(0..1),"rationale":string,' +
    '"suggestedOutcomeId":string,"suggestedOutcomeLabel":string}]}. ' +
    'Include only relevant markets; omit the suggested* fields if unsure.';

  const res = await fetch(`${config.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.AI_MODEL,
      temperature: 0,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content ?? '';
  const obj = extractJson(content);
  const parsed = RerankZ.safeParse(obj);
  if (!parsed.success) {
    throw new Error(`rerank returned malformed JSON: ${parsed.error.message}`);
  }
  return parsed.data.results;
}

/** Extract the first balanced top-level JSON object from an LLM response (tolerates fences/prose). */
function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
