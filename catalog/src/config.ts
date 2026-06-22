import 'dotenv/config';
import { z } from 'zod';

const EnvZ = z.object({
  PORT: z.coerce.number().default(8080),
  CORS_ORIGINS: z.string().default('*'),
  RATE_LIMIT_MAX: z.coerce.number().default(120),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PMXT_BASE_URL: z.string().default('http://localhost:3847'),
  PMXT_ACCESS_TOKEN: z.string().optional(), // sent as x-pmxt-access-token if set

  VENUE_ALLOWLIST: z.string().default('polymarket'),
  INGEST_CRON: z.string().default('0 * * * *'),
  INGEST_MIN_VOLUME: z.coerce.number().default(0),
  INGEST_PAGE_LIMIT: z.coerce.number().default(100000),
  INGEST_ENABLED: z
    .string()
    .default('true')
    .transform((s) => s !== 'false'),

  EMBEDDINGS_PROVIDER: z.enum(['none', 'voyage', 'openai']).default('none'),
  EMBED_MODEL: z.string().default('voyage-3-lite'),
  EMBED_DIM: z.coerce.number().default(1024),
  EMBED_BASE_URL: z.string().default('https://api.openai.com/v1'), // OpenAI-compatible; swap for OpenRouter / local Ollama
  VOYAGE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // OpenAI-compatible LLM for discover rerank (POST {AI_BASE_URL}/chat/completions).
  // Works with the local-claude proxy, OpenAI, or any compatible endpoint.
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-4-5-20250929'),
  DISCOVER_RETRIEVE_K: z.coerce.number().default(40),
  DISCOVER_API_KEY: z.string().optional(), // inbound: gates /v1/markets/discover (NOT the LLM key)
  ADMIN_API_KEY: z.string().optional(),
});

const parsed = EnvZ.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const e = parsed.data;

export const config = {
  ...e,
  venues: e.VENUE_ALLOWLIST.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  corsOrigins: e.CORS_ORIGINS === '*' ? true : e.CORS_ORIGINS.split(',').map((s) => s.trim()),
};

export type Config = typeof config;
