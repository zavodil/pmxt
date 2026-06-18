# pmxt-catalog

"Skyscanner for prediction markets." A standalone web service that keeps a **searchable catalog of
markets** (metadata only — no live prices), lets a user write a prompt and an agent return matching
markets, then fetches **live prices on demand** when a market is picked.

- **Spec:** [`../CATALOG_SERVICE_SPEC.md`](../CATALOG_SERVICE_SPEC.md)
- **Upstream-clean:** this is a **separate package** (own `node_modules`, NOT in the pmxt workspaces). It
  consumes pmxt only over HTTP (`POST /api/:venue/fetchMarkets`) and never imports/edits pmxt core, so
  `git merge upstream` stays trivial.
- **No custody here.** Discovery only. Betting is the OutLayer flow
  ([`../POLYMARKET_NATIVE_USDC_GUIDE.md`](../POLYMARKET_NATIVE_USDC_GUIDE.md)); this service just returns
  the identifiers it needs (`venue`, `marketId`, `conditionId`, `outcomeId`).

## Quickstart

```bash
cd catalog
cp .env.example .env                 # set DATABASE_URL, PMXT_BASE_URL; keys optional for v1
docker compose up -d                 # local Postgres + pgvector
npm install
npm run migrate                      # apply schema (vector dim = EMBED_DIM)

# make sure the pmxt sidecar is running and reachable at PMXT_BASE_URL
#   (in repo root: npm run server)  -> http://localhost:3000

npm run ingest                       # one ingest cycle now (or rely on the in-process cron)
npm run dev                          # API on :PORT (default 8080)
```

Runs **keyword-only** out of the box (`EMBEDDINGS_PROVIDER=none`, no `AI_*`). Add a Voyage/OpenAI key for
semantic search, and set the **`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`** trio (any OpenAI-compatible
endpoint — e.g. the local-claude proxy, see `../../ai-intents/RUNNING.md`) for LLM rerank in
`/v1/markets/discover`. Without the trio, discover returns the hybrid-retrieval order.

## HTTP API (frontend-facing)

| method | path | purpose |
|---|---|---|
| GET  | `/health` | liveness |
| GET  | `/v1/venues` | configured venues + active/total counts |
| GET  | `/v1/markets/search?q=&venue=&category=&tags=&status=&limit=&offset=` | keyword/filter search |
| POST | `/v1/markets/discover` `{prompt, filters?, limit?}` | prompt → ranked markets (auth + rate-limited) |
| GET  | `/v1/markets/:venue/:marketId` | catalog detail (metadata) |
| GET  | `/v1/markets/:venue/:marketId/quote` | **live** prices on demand (proxies pmxt) |
| GET  | `/v1/categories` · `/v1/tags` | facets for filters |
| POST | `/v1/admin/ingest` | trigger an ingest cycle (admin) |

```bash
curl 'localhost:8080/v1/markets/search?q=bitcoin&limit=5'
curl -X POST localhost:8080/v1/markets/discover -H 'content-type: application/json' \
  -d '{"prompt":"the Fed cuts rates in July","limit":5}'
curl 'localhost:8080/v1/markets/polymarket/<marketId>/quote'
```

## Scripts

- `npm run dev` — API with watch
- `npm run start` — API
- `npm run migrate` — apply `src/db/schema.sql`
- `npm run ingest` — run one ingest+enrich cycle (CLI)
- `npm run typecheck` — `tsc --noEmit`

## How it works (see the spec for detail)

1. **Ingest** (`INGEST_CRON`): per venue in `VENUE_ALLOWLIST`, `fetchMarkets({status:"active"})` → upsert
   metadata by `(venue, market_id)`; diff via `content_hash` flags changed rows for re-enrichment; markets
   that vanish from the active set are swept to `closed`.
2. **Enrich**: embeds `needs_enrich` rows only (delta). LLM taxonomy/entities can be added later for
   cross-venue search.
3. **Search / Discover**: keyword (Postgres FTS) and semantic (pgvector) → fused (RRF) → optional Claude
   rerank that returns all relevant markets with a rationale + suggested side.
4. **Quote**: live prices fetched from pmxt on demand; never stored.

Adding a venue later = add it to `VENUE_ALLOWLIST` (no code change; `UnifiedMarket` is uniform).
