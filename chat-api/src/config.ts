import 'dotenv/config';
import { z } from 'zod';

const EnvZ = z.object({
  PORT: z.coerce.number().default(8090),
  CORS_ORIGINS: z.string().default('*'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CATALOG_BASE_URL: z.string().default('http://localhost:8080'),
  CATALOG_API_KEY: z.string().optional(),
  PMXT_BASE_URL: z.string().default('http://localhost:3847'),
  PMXT_ACCESS_TOKEN: z.string().optional(),
  DEFAULT_VENUE: z.string().default('polymarket'),

  AI_BASE_URL: z.string().min(1, 'AI_BASE_URL is required'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-4-6'),
  // Web-enabled model for the `web_research` tool. The local-claude proxy turns
  // on Anthropic's native WebSearch/WebFetch for model ids ending in `-search`
  // (same scheme ai-intents uses). Override per environment if needed.
  AI_SEARCH_MODEL: z.string().default('claude-opus-4-5-search'),
  AGENT_MAX_STEPS: z.coerce.number().default(6),
  AGENT_TEMPERATURE: z.coerce.number().default(0.3),

  BET_EXECUTION_ENABLED: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),

  JWT_SECRET: z.string().default('dev-insecure-jwt-secret-change-me-please-32+'),
});

const parsed = EnvZ.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const e = parsed.data;

export const config = {
  ...e,
  corsOrigins: e.CORS_ORIGINS === '*' ? true : e.CORS_ORIGINS.split(',').map((s) => s.trim()),
};
export type Config = typeof config;
