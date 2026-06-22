-- chat-api tables (live alongside the catalog's `markets` table in the same DB).

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  dial        smallint NOT NULL DEFAULT 3,   -- 1 devil's advocate .. 5 supportive
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,             -- user | assistant
  content         text NOT NULL,
  meta            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS conversation_markets (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  venue           text NOT NULL,
  market_id       text NOT NULL,
  source          text,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, venue, market_id)
);

CREATE TABLE IF NOT EXISTS bet_intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  user_id         text NOT NULL,
  venue           text NOT NULL,
  market_id       text NOT NULL,
  outcome_id      text NOT NULL,
  outcome_label   text,
  amount_usdc     numeric NOT NULL,
  status          text NOT NULL DEFAULT 'draft',  -- draft | confirmed | placed | failed
  order_ref       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
