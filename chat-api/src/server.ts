import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import { registerRoutes } from './routes/index';
import { resolveUserId } from './auth';
import { pool } from './db/client';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: config.corsOrigins });

  // Allow bodyless POSTs that still send `content-type: application/json`
  // (e.g. /v1/wallet/setup, /v1/bets/:id/cancel) — treat an empty body as {}
  // instead of throwing FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = (body as string).trim();
    if (!s) return done(null, {});
    try {
      done(null, JSON.parse(s));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // Resolve the caller once per request: JWT bearer → x-user-id (dev) → 'guest'.
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (req) => {
    (req as unknown as { userId: string }).userId = await resolveUserId(req);
  });

  await registerRoutes(app);

  app.addHook('onClose', async () => {
    await pool.end();
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      app.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
