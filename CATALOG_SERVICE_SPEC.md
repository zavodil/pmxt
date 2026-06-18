# Prediction-market catalog service — backend spec (TypeScript) for an implementing AI agent

**Audience:** an AI agent building this service. Implementation contract, not a tutorial.
**What you are building:** a standalone **web server** ("Skyscanner for prediction markets"). It keeps a
searchable **catalog of markets** (metadata only, no live prices), lets a user write a natural-language
prompt and have an agent return matching markets, and — once the user picks one — fetches **live prices on
demand** and hands off to the existing betting flow. **The frontend calls this server directly over HTTP.**
**v1 scope:** Polymarket only (venue set is config; uniform across venues by design).
**Relation to pmxt:** this is a **separate service** that consumes pmxt's public HTTP API
(`POST /api/:venue/fetchMarkets`). It does **not** import or modify pmxt code → the pmxt repo stays
upstream-clean. Betting is **not** in this service (see §12 handoff → [POLYMARKET_NATIVE_USDC_GUIDE.md](POLYMARKET_NATIVE_USDC_GUIDE.md)).

---

## 0. GOLDEN RULES (enforce in code)

- **C1** Never modify pmxt core. Consume markets ONLY via pmxt HTTP (`/api/:venue/fetchMarkets`). Live in a
  separate repo/package — NOT under pmxt `core/`. (Keeps `git merge upstream` trivial.)
- **C2** The catalog stores **metadata only — no live prices.** `volume/liquidity` are stored as a
  **snapshot ranking signal** (stamped `metrics_as_of`), never treated as authoritative. Prices are fetched
  on demand (§11).
- **C3** Validate **all external JSON at the boundary with `zod`** — pmxt responses, LLM output, and
  frontend input. Parse, don't trust. (This is where runtime type-safety comes from.)
- **C4** The working venue set is a **config allowlist**. v1 = `["polymarket"]`. Adding a venue later is
  **config only** — `UnifiedMarket` is uniform across all pmxt venues.
- **C5** Enrich (embeddings / LLM) only the **delta** (`needs_enrich = true`), never the whole catalog per
  run. Bounds cost to ~new+changed markets.
- **C6** **Discover (LLM) costs money + latency** → require auth, rate-limit, and cache. **Search (keyword)**
  is cheap → public + cacheable.
- **C7** Ingest is **idempotent**: upsert by `(venue, market_id)`; `content_hash` gates re-enrichment.
- **C8** No custody/keys/betting here. This service is **read-only discovery**. Betting is the OutLayer TS
  flow; this service only returns the identifiers it needs (§12).

---

## 1. DATA MODEL (identifiers)

- `venue` — pmxt venue id (`"polymarket"`, later `"kalshi"`, …).
- `marketId` — venue-native market id (pmxt `UnifiedMarket.marketId`). PK with `venue`.
- `conditionId` — on-chain market id (`UnifiedMarket.contractAddress`); needed for betting.
- `outcomeId` — per-outcome id (Polymarket = CLOB token id); needed for betting.
- `contentHash` — `sha256` of the stable metadata (gates re-enrichment, §7).
- `embedding` — vector of `title+description+tags` for semantic search (§8).

---

## 2. CONFIG (env)

```bash
PORT=8080
DATABASE_URL=postgres://…/catalog
PMXT_BASE_URL=http://localhost:3000        # the pmxt sidecar's HTTP base

VENUE_ALLOWLIST=polymarket                 # comma-separated; v1 = polymarket only
INGEST_CRON=0 * * * *                       # hourly metadata refresh
INGEST_MIN_VOLUME=0                          # drop dust markets below this (optional)

EMBEDDINGS_PROVIDER=voyage                   # voyage | openai
EMBED_MODEL=voyage-3-lite                     # or text-embedding-3-small
EMBED_DIM=1024                                # voyage-3-lite=1024; openai 3-small=1536 — MUST match vector(N)
VOYAGE_API_KEY=…                              # or OPENAI_API_KEY

ANTHROPIC_API_KEY=…
DISCOVER_MODEL=claude-opus-4-8                # prompt→market reranker
DISCOVER_RETRIEVE_K=40                         # candidates fed to the LLM

CORS_ORIGINS=https://app.example.com          # frontend origin(s)
DISCOVER_API_KEY=…                            # gate the LLM endpoint (or JWT from your user backend)
```

Stack: **Fastify** (or Express) + **Postgres + pgvector** + **zod**. Optionally import `UnifiedMarket`
type from pmxt for free types — but still zod-validate at runtime (C3).

---

## 3. ARCHITECTURE (the Skyscanner flow, as a list)

1. **INGEST [cron]** — per venue in allowlist: `fetchMarkets({status:"active"})` from pmxt → upsert metadata
   (no prices) → mark new/changed rows `needs_enrich` → sweep vanished markets to `closed` (§7).
2. **ENRICH [worker]** — embed `needs_enrich` rows (later: LLM tags/entities) → clear the flag (§8).
3. **SEARCH [http]** — keyword + filter over the catalog; cheap, cacheable (§9).
4. **DISCOVER [http]** — user prompt → hybrid retrieve (FTS + vector) → LLM rerank → ranked candidates with
   rationale + suggested side; returns **all suitable** (user chooses) (§10).
5. **QUOTE [http]** — user picked a market → fetch **live prices on demand** via pmxt; not persisted (§11).
6. **BET [handoff]** — frontend takes the identifiers and calls the OutLayer betting backend (§12).

---

## 4. PROJECT LAYOUT (separate package/repo)

```
catalog/                          # NOT under pmxt core/
  src/
    server.ts                     # Fastify app, CORS, routes, error handler
    config.ts                     # env parse + zod
    db/{schema.sql, client.ts}    # pg pool (+ kysely/drizzle optional)
    pmxt/client.ts                # HTTP client to pmxt + zod UnifiedMarket schema
    ingest/{ingest.ts, diff.ts, cron.ts}
    enrich/embed.ts               # embeddings provider adapter
    search/{search.ts, discover.ts}
    routes/{markets.ts, discover.ts, quote.ts, venues.ts, health.ts}
  package.json  tsconfig.json  Dockerfile
```

Deploy: Docker, runs alongside the pmxt sidecar; frontend → this service (CORS-allowed).

---

## 5. DATA SOURCE — pmxt HTTP contract

- **Call:** `POST {PMXT_BASE_URL}/api/{venue}/fetchMarkets`, body (see `MarketFetchParams` in
  `core/src/BaseExchange.ts`): `{ status?: "active"|"closed"|"all", limit?, offset?, query?, category?, sort? }`.
  Returns `UnifiedMarket[]`.
- **Single market:** `POST /api/{venue}/fetchMarket { marketId }` → one `UnifiedMarket` (used by §11 quote).
- **Fields used** (validate with zod; `UnifiedMarket` in `core/src/types.ts`): `marketId, eventId, slug,
  title, description, outcomes[{outcomeId,label,price}], resolutionDate, volume, volume24h, liquidity,
  url, image, category, tags[], status, contractAddress, sourceExchange, sourceMetadata`.
- **zod (boundary):**
  ```ts
  const Outcome = z.object({ outcomeId: z.string(), label: z.string(), price: z.number().optional() });
  const UnifiedMarketZ = z.object({
    marketId: z.string(), eventId: z.string().optional(), slug: z.string().optional(),
    title: z.string(), description: z.string().default(''),
    outcomes: z.array(Outcome).default([]),
    resolutionDate: z.coerce.date().optional(),
    volume: z.number().optional(), volume24h: z.number().optional(), liquidity: z.number().optional(),
    url: z.string().optional(), image: z.string().optional(),
    category: z.string().optional(), tags: z.array(z.string()).default([]),
    status: z.string().optional(), contractAddress: z.string().optional(),
    sourceExchange: z.string().optional(), sourceMetadata: z.record(z.unknown()).optional(),
  }).passthrough();      // tolerate upstream additions → no silent drift breakage
  ```
- **Pagination:** Polymarket can return the full active set in one large `limit`; otherwise page by `offset`
  until short page. Polygon/Gamma has Cloudflare bot checks — pmxt handles UA; you just call pmxt.

---

## 6. DB SCHEMA (Postgres + pgvector)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE markets (
  id               bigserial PRIMARY KEY,
  venue            text NOT NULL,
  market_id        text NOT NULL,
  event_id         text,
  slug             text,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  category         text,
  tags             text[] NOT NULL DEFAULT '{}',
  outcomes         jsonb NOT NULL DEFAULT '[]',     -- [{outcomeId,label}]  (NO prices — C2)
  resolution_date  timestamptz,
  status           text NOT NULL DEFAULT 'active',  -- active | closed | archived
  condition_id     text,                             -- UnifiedMarket.contractAddress (for betting)
  url              text,
  image            text,
  -- snapshot ranking metrics (NOT live; stamped)
  volume           numeric,
  volume_24h       numeric,
  liquidity        numeric,
  metrics_as_of    timestamptz,
  -- source + diff
  source_metadata  jsonb,
  content_hash     text NOT NULL,
  -- enrichment
  embedding        vector(1024),                     -- = EMBED_DIM; MUST match provider
  needs_enrich     boolean NOT NULL DEFAULT true,
  enriched_at      timestamptz,
  -- FTS (generated)
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')),                'A') ||
    setweight(to_tsvector('english', coalesce(description,'')),          'B') ||
    setweight(to_tsvector('english', array_to_string(tags,' ')),         'C')
  ) STORED,
  -- lifecycle
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue, market_id)
);

CREATE INDEX markets_tsv_idx   ON markets USING gin (search_tsv);
CREATE INDEX markets_tags_idx  ON markets USING gin (tags);
CREATE INDEX markets_emb_idx   ON markets USING hnsw (embedding vector_cosine_ops);
CREATE INDEX markets_rank_idx  ON markets (venue, status, volume_24h DESC);
CREATE INDEX markets_res_idx   ON markets (resolution_date);
```

---

## 7. PROCEDURE: INGEST [cron, idempotent]

- **Trigger:** `INGEST_CRON`. **Per venue** in `VENUE_ALLOWLIST`:
  1. `runStart = now()`.
  2. Page `POST /api/{venue}/fetchMarkets {status:"active", limit}`; zod-validate each (drop invalid, log).
  3. For each market: `hash = sha256(title | description | tags.sorted | resolutionDate | outcomes.label.sorted)`.
  4. **Upsert** by `(venue, market_id)`:
     ```sql
     INSERT INTO markets (venue, market_id, event_id, slug, title, description, category, tags,
       outcomes, resolution_date, status, condition_id, url, image,
       volume, volume_24h, liquidity, metrics_as_of, source_metadata, content_hash, last_seen_at)
     VALUES (...)
     ON CONFLICT (venue, market_id) DO UPDATE SET
       -- always refresh snapshot metrics + lifecycle:
       volume=EXCLUDED.volume, volume_24h=EXCLUDED.volume_24h, liquidity=EXCLUDED.liquidity,
       metrics_as_of=EXCLUDED.metrics_as_of, status=EXCLUDED.status, last_seen_at=EXCLUDED.last_seen_at,
       -- refresh content + flag re-enrich ONLY when stable metadata changed:
       title=EXCLUDED.title, description=EXCLUDED.description, tags=EXCLUDED.tags,
       category=EXCLUDED.category, outcomes=EXCLUDED.outcomes, resolution_date=EXCLUDED.resolution_date,
       condition_id=EXCLUDED.condition_id, url=EXCLUDED.url, image=EXCLUDED.image,
       source_metadata=EXCLUDED.source_metadata,
       content_hash=EXCLUDED.content_hash,
       needs_enrich = (markets.content_hash IS DISTINCT FROM EXCLUDED.content_hash) OR markets.needs_enrich,
       updated_at = CASE WHEN markets.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                         THEN now() ELSE markets.updated_at END;
     ```
     (Insert path: `needs_enrich` defaults true.)
  5. **Sweep vanished:** markets of this venue that were `active` but not seen this run →
     `UPDATE markets SET status='closed' WHERE venue=$1 AND status='active' AND last_seen_at < runStart;`
     (Optionally `archived` after N consecutive misses. Never delete — keep history for resolved-market lookups.)
- **Optional filter:** skip markets with `volume24h < INGEST_MIN_VOLUME` (dust) at insert.
- **Cadence rationale (C2):** metadata is stable → re-enrich only on `content_hash` change; metrics refresh
  every run cheaply; prices are never here.

---

## 8. PROCEDURE: ENRICH [worker, delta only]

- Runs after ingest (or on its own interval). Batch over `WHERE needs_enrich = true LIMIT N`:
  ```ts
  const text = `${m.title}\n${m.description}\nTags: ${m.tags.join(', ')}`;
  const vec  = await embed(text);                  // Voyage/OpenAI; batch the API call
  // UPDATE markets SET embedding=$vec, needs_enrich=false, enriched_at=now() WHERE id=$id
  ```
- **v1 stops here** — Polymarket already provides `tags`+`category`, and embeddings cover prompt→market.
- **Later (cross-venue):** an LLM pass to assign a **unified taxonomy** + extract **entities** (people,
  teams, tickers, event type, region, time window) into `tags`/a new `entities jsonb` — the real value once
  multiple venues with different taxonomies are ingested. Still delta-only.

---

## 9. PROCEDURE: SEARCH [http, cheap] — keyword + filter

- `GET /v1/markets/search?q=&venue=&category=&tags=&status=active&sort=volume&limit=20&cursor=`
- SQL:
  ```sql
  SELECT … FROM markets
  WHERE status = $status
    AND venue = ANY($venues)               -- default = allowlist
    AND ($category IS NULL OR category = $category)
    AND ($tags IS NULL OR tags && $tags)
    AND ($q   IS NULL OR search_tsv @@ websearch_to_tsquery('english', $q))
  ORDER BY (CASE WHEN $q IS NULL THEN volume_24h END) DESC NULLS LAST,
           (CASE WHEN $q IS NOT NULL THEN ts_rank(search_tsv, websearch_to_tsquery('english',$q)) END) DESC
  LIMIT $limit;                            -- keyset pagination by (sort_key, id) via cursor
  ```
- Returns `CatalogMarket[]` (§13 DTO). Cache by query string (short TTL).

---

## 10. PROCEDURE: DISCOVER [http, LLM] — prompt → markets

- `POST /v1/markets/discover  { prompt, filters?, limit? }`  (authed + rate-limited — C6).
- **Steps:**
  1. `qvec = embed(prompt)`.
  2. **Hybrid retrieve** (`status='active'` + filters):
     - semantic: `ORDER BY embedding <=> qvec LIMIT 50`
     - keyword: `WHERE search_tsv @@ websearch_to_tsquery('english', prompt) ORDER BY ts_rank LIMIT 50`
     - **fuse** with Reciprocal Rank Fusion → top `DISCOVER_RETRIEVE_K`.
  3. **LLM rerank** (Claude `DISCOVER_MODEL`): pass the user `prompt` + each candidate's
     `{marketId, title, description, resolutionDate, outcomes[].label}`. Force structured output:
     ```json
     [{ "marketId": "...", "score": 0.0-1.0, "rationale": "one line",
        "suggestedOutcomeId": "...", "suggestedOutcomeLabel": "Yes" }]
     ```
     Prompt the model to return **all genuinely relevant** markets (not just one), drop irrelevant ones, and
     pick the side the user's view implies.
  4. Join back to `CatalogMarket`, attach `score`/`rationale`/`suggestedOutcome`, sort by score, apply `limit`.
- **Output:** `DiscoverResult[]` (§13). User picks one → §11.
- **Guards:** validate LLM JSON with zod (C3); cap candidates; cache (prompt-hash → results, short TTL).

---

## 11. PROCEDURE: QUOTE [http, live, not persisted]

- `GET /v1/markets/:venue/:marketId/quote`
- Proxy to pmxt: `POST /api/{venue}/fetchMarket { marketId }` (or an order-book method) → read current
  `outcomes[].price` (+ liquidity/spread if available).
- Return `{ venue, marketId, asOf: now, outcomes:[{outcomeId,label,price}], liquidity }`. **Do not write to DB.**
- This is the "user selected → load prices" step. Optionally a tiny in-memory TTL cache (1–5 s) to absorb bursts.

---

## 12. BET HANDOFF (→ OutLayer flow, not in this service)

This service returns exactly the identifiers the betting backend needs; the **frontend** then calls the
OutLayer betting backend (separate; [POLYMARKET_NATIVE_USDC_GUIDE.md](POLYMARKET_NATIVE_USDC_GUIDE.md)).

- From discover/detail/quote the frontend has: `venue`, `marketId`, `conditionId`, the chosen
  `outcomeId`+label, and the live price.
- Bet call (existing flow) maps to:
  `PolymarketOutlayerExchange.createOrder({ marketId: conditionId, outcomeId, side, type, amount })`
  with `{ signatureType: 3, funderAddress: depositWallet }` and the user's OutLayer auth.
- **This service never sees keys, funds, or signatures** (C8).

---

## 13. HTTP API (what the frontend calls)

| method | path | purpose | cost/auth |
|---|---|---|---|
| GET | `/health` | liveness | public |
| GET | `/v1/venues` | configured venues + active counts | public |
| GET | `/v1/markets/search` | keyword/filter catalog search (§9) | public, cacheable |
| POST | `/v1/markets/discover` | prompt → ranked markets (§10) | **authed + rate-limited** |
| GET | `/v1/markets/:venue/:marketId` | catalog detail (metadata) | public |
| GET | `/v1/markets/:venue/:marketId/quote` | live prices on demand (§11) | public, rate-limited |
| GET | `/v1/categories` · `/v1/tags` | facets for frontend filters | public |
| POST | `/v1/admin/ingest` | trigger ingest manually | **admin only** |

**`CatalogMarket` DTO** (no live prices):
```json
{ "venue":"polymarket", "marketId":"...", "eventId":"...", "slug":"...",
  "title":"...", "description":"...", "category":"Crypto", "tags":["Bitcoin","2026"],
  "outcomes":[{"outcomeId":"...","label":"Yes"},{"outcomeId":"...","label":"No"}],
  "resolutionDate":"2026-07-01T00:00:00Z", "status":"active", "conditionId":"0x...",
  "url":"https://polymarket.com/...", "image":"https://...",
  "metrics":{"volume24h":12345,"liquidity":6789,"volume":99999,"asOf":"2026-06-16T10:00:00Z"} }
```
**`DiscoverResult`** = `CatalogMarket` + `{ "score":0.87, "rationale":"...", "suggestedOutcome":{"outcomeId":"...","label":"Yes"} }`.
**Quote DTO** = `{ "venue","marketId","asOf", "outcomes":[{"outcomeId","label","price"}], "liquidity" }`.

CORS to `CORS_ORIGINS`; rate-limit `discover`/`quote`; gate `discover` with `DISCOVER_API_KEY`/JWT from your user backend.

---

## 14. ERROR / EDGE CATALOG

- pmxt unreachable / 5xx during ingest → keep last good catalog; log + retry next cron. Never wipe on a failed run.
- pmxt market fails zod → drop that one market, log; don't fail the whole batch.
- Market disappears from `active` set → sweep to `closed` (§7), don't delete (resolved-market lookups).
- Embedding dim ≠ `vector(N)` → insert error; `EMBED_DIM` must equal the column and the provider model.
- LLM returns malformed/empty JSON in discover → zod-reject → fall back to the hybrid-retrieve order (no rerank).
- Discover abuse / cost spike → enforce auth + rate-limit + cache (C6).
- Stale prices: never serve catalog `volume/liquidity` as live; always fetch via §11 for trading decisions (C2).
- Schema drift: `UnifiedMarketZ.passthrough()` tolerates new fields; a contract test against a live pmxt
  response catches removed/renamed fields early.

---

## 15. FUTURE (out of v1 scope, designed-for)

- **More venues:** add to `VENUE_ALLOWLIST` — zero code change (uniform `UnifiedMarket`). Then turn on the
  §8 LLM taxonomy/entity pass so search is consistent across heterogeneous venue tags.
- **Cross-venue dedup/clustering:** group markets that ask the same real-world question (by entities) →
  enables price comparison across venues for the same outcome (the true Skyscanner moment). v1 returns all
  matches; user chooses.
- **Auth/identity:** put the end-user auth in your user backend; this service trusts a signed token/API key.
- **Resolved-market history & analytics:** the `closed`/`archived` rows + ClickHouse (`/v0/sql` in pmxt) for
  backtesting agent picks.
```
