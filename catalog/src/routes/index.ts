import type { FastifyInstance } from 'fastify';
import { systemRoutes } from './system';
import { venuesRoutes } from './venues';
import { marketsRoutes } from './markets';
import { discoverRoutes } from './discover';
import { quoteRoutes } from './quote';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(systemRoutes);
  await app.register(venuesRoutes);
  await app.register(marketsRoutes);
  await app.register(discoverRoutes);
  await app.register(quoteRoutes);
}
