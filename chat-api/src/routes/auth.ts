import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueJwt, verifyLogin } from '../auth';

const LoginBody = z.object({
  chain: z.string(),
  address: z.string(),
  message: z.string(),
  signature: z.string(),
  publicKey: z.string().optional(),
  nonce: z.string().optional(),
  recipient: z.string().optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req, reply) => {
    const b = LoginBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.flatten() });
    const userId = await verifyLogin(b.data);
    if (!userId) return reply.code(401).send({ error: 'signature verification failed' });
    const token = await issueJwt(userId);
    return { token, userId };
  });
}
