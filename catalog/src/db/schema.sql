-- Catalog schema. `__EMBED_DIM__` is substituted by migrate.ts with config.EMBED_DIM.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- array_to_string() is only STABLE, so it can't be used directly in a generated
-- column; wrap it (safe for text[] joined by a constant).
CREATE OR REPLACE FUNCTION immutable_array_to_string(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, ' ') $$;

CREATE TABLE IF NOT EXISTS markets (
  id               bigserial PRIMARY KEY,
  venue            text NOT NULL,
  market_id        text NOT NULL,
  event_id         text,
  slug             text,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  category         text,
  tags             text[] NOT NULL DEFAULT '{}',
  outcomes         jsonb NOT NULL DEFAULT '[]',     -- [{outcomeId,label}] (NO prices)
  resolution_date  timestamptz,
  status           text NOT NULL DEFAULT 'active',  -- active | closed | archived
  condition_id     text,                            -- UnifiedMarket.contractAddress (for betting)
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
  embedding        vector(__EMBED_DIM__),
  needs_enrich     boolean NOT NULL DEFAULT true,
  enriched_at      timestamptz,
  -- FTS (generated)
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')),        'A') ||
    setweight(to_tsvector('english', coalesce(description, '')),  'B') ||
    setweight(to_tsvector('english', immutable_array_to_string(tags)), 'C')
  ) STORED,
  -- lifecycle
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue, market_id)
);

CREATE INDEX IF NOT EXISTS markets_tsv_idx     ON markets USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS markets_tags_idx    ON markets USING gin (tags);
CREATE INDEX IF NOT EXISTS markets_emb_idx     ON markets USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS markets_rank_idx    ON markets (venue, status, volume_24h DESC);
CREATE INDEX IF NOT EXISTS markets_res_idx     ON markets (resolution_date);
CREATE INDEX IF NOT EXISTS markets_enrich_idx  ON markets (needs_enrich) WHERE needs_enrich = true;
