import type { FastifyInstance } from 'fastify';
import { userId } from './conversations';
import * as exec from '../clients/outlayerExec';

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  // The user's OutLayer deposit-wallet: address to fund (native USDC, min $2),
  // current pUSD balance, and whether it's deployed/ready.
  app.get('/v1/wallet', async (req, reply) => {
    try {
      const uid = userId(req);
      const [dep, bal] = await Promise.all([exec.depositAddress(uid), exec.balance(uid)]);
      return {
        depositWallet: bal.depositWallet,
        bridgeIn: dep.bridgeIn,
        minUsd: dep.minUsd,
        pusd: bal.pusd,
        deployed: bal.deployed,
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // One-time: deploy the deposit-wallet + set token approvals (gasless via builder relayer).
  app.post('/v1/wallet/setup', async (req, reply) => {
    try {
      return await exec.setup(userId(req));
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
