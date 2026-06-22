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

  // STEP 1 deposit target for the in-app NEAR deposit: the OutLayer custody NEAR
  // account (credited by intents.near) + the native NEAR USDC token contract. The
  // frontend signs `ft_transfer_call` to intents.near itself — no redirect.
  app.get('/v1/wallet/deposit-target', async (req, reply) => {
    try {
      return await exec.depositTarget(userId(req));
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // The user's OutLayer NEAR-intents USDC balance — where an in-app NEAR deposit
  // lands before it's moved (fund-trading) into the pUSD trading wallet. This is
  // the value that proves a NEAR deposit arrived.
  app.get('/v1/wallet/intents-balance', async (req, reply) => {
    try {
      const b = await exec.intentsBalance(userId(req));
      return { usdc: b.usdc, raw: b.raw };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // STEP 2: move the user's OutLayer intents USDC to the Polymarket bridge-in
  // address (which swaps+wraps it into pUSD in the deposit-wallet). Body:
  // { amountMinimal: string (USDC 6-dp minimal units), dryRun?: boolean }.
  app.post('/v1/wallet/fund-trading', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { amountMinimal?: string; dryRun?: boolean };
      return await exec.fundTrading(userId(req), String(body.amountMinimal ?? ''), Boolean(body.dryRun));
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
