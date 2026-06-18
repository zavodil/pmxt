import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { registerRoutes } from './routes/index';
import { scheduleIngest } from './ingest/cron';
import { pool } from './db/client';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.corsOrigins });
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  await registerRoutes(app);

  app.addHook('onClose', async () => {
    await pool.end();
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  if (config.INGEST_ENABLED) scheduleIngest();

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
