import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import { registerRoutes } from './routes/index';
import { resolveUserId } from './auth';
import { pool } from './db/client';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: config.corsOrigins });

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
