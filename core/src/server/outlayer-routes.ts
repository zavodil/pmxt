/**
 * Additive Express router for the OutLayer custody/funding surface
 * (OUTLAYER_INTEGRATION_PLAN.md §7). Mounts under `/outlayer`, mirroring how
 * `createFeedRouter` / `createSqlRouter` are mounted in `app.ts`.
 *
 * Trading still flows through the vanilla `/api/polymarket/*` dispatcher (the
 * exchange-factory hook swaps in the OutLayer-backed exchange). These routes
 * cover the things that sit OUTSIDE a venue method: address derivation,
 * one-time API-key onboarding, and the funding money-path.
 *
 * Every mutating route carries the per-user identity in `body.credentials`
 * ({ outlayerAccountId, outlayerSeed | outlayerUserId, … }); the NEAR signing
 * key is read from env, never the body. Status is a POST (not the plan's
 * `GET /status/:id`) precisely because per-user identity can't ride safely in a
 * GET query string.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { ExchangeCredentials } from '../BaseExchange';
import {
    resolveIdentity,
    buildSigner,
    buildFundingAdapter,
    PolymarketOutlayerAuth,
    OutlayerClient,
} from '../integrations/outlayer';

function getCredentials(req: Request): ExchangeCredentials | undefined {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return body.credentials as ExchangeCredentials | undefined;
}

export function createOutlayerRouter(): Router {
    const router = Router();

    // Liveness / config probe (no auth, no funds).
    router.get('/health', (_req: Request, res: Response) => {
        res.json({
            success: true,
            data: {
                signer: (process.env.OUTLAYER_SIGNER || 'outlayer').toLowerCase(),
                apiBase: new OutlayerClient().baseUrl,
                enabled: process.env.OUTLAYER_ENABLED === 'true' || process.env.OUTLAYER_ENABLED === '1',
            },
        });
    });

    // POST /outlayer/address  { credentials, chain? } → { address }
    // Derives (auto-creating) the EVM EOA for the identity. Zero funds.
    router.post('/address', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const credentials = getCredentials(req);
            const chain = ((req.body?.chain as string) || 'polygon') as never;
            const identity = resolveIdentity(credentials);
            const signer = buildSigner(identity, chain);
            const address = await signer.address();
            res.json({ success: true, data: { address, chain: chain ?? 'polygon' } });
        } catch (error) {
            next(error);
        }
    });

    // POST /outlayer/derive-api-key  { credentials } → { address, funderAddress, apiKey, apiSecret, passphrase }
    // One-time onboarding: signs Polymarket L1 auth via OutLayer to derive/create
    // CLOB API creds. The user-server persists these and passes them back as
    // credentials on subsequent trading calls. No funds required.
    router.post('/derive-api-key', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const credentials = getCredentials(req) ?? {};
            const identity = resolveIdentity(credentials);
            const signer = buildSigner(identity);
            const auth = new PolymarketOutlayerAuth(credentials, signer);
            const [address, creds, funderAddress] = await Promise.all([
                signer.address(),
                auth.getApiCredentials(),
                auth.getEffectiveFunderAddress(),
            ]);
            res.json({
                success: true,
                data: {
                    address,
                    funderAddress,
                    apiKey: creds.key,
                    apiSecret: creds.secret,
                    passphrase: creds.passphrase,
                },
            });
        } catch (error) {
            next(error);
        }
    });

    // POST /outlayer/tokens  { credentials } → OutLayer token catalog
    // Useful for resolving the right Polygon USDC variant (Phase-0).
    router.post('/tokens', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const adapter = buildFundingAdapter(getCredentials(req));
            res.json({ success: true, data: await adapter.tokens() });
        } catch (error) {
            next(error);
        }
    });

    // POST /outlayer/fund-polygon  { credentials, to, amount, token, dryRun? }
    // Bridge USDC from NEAR intents onto the Polygon EOA (gasless on NEAR side).
    router.post('/fund-polygon', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { to, amount, token, dryRun } = (req.body ?? {}) as Record<string, unknown>;
            if (!to || !amount || !token) {
                res.status(400).json({ success: false, error: 'fund-polygon requires { to, amount, token }' });
                return;
            }
            const adapter = buildFundingAdapter(getCredentials(req));
            const data = await adapter.fundPolygon({
                to: String(to),
                amount: String(amount),
                token: String(token),
                dryRun: Boolean(dryRun),
            });
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    });

    // POST /outlayer/status  { credentials, requestId } → async op status
    router.post('/status', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const requestId = (req.body?.requestId as string) || '';
            if (!requestId) {
                res.status(400).json({ success: false, error: 'status requires { requestId }' });
                return;
            }
            const adapter = buildFundingAdapter(getCredentials(req));
            res.json({ success: true, data: await adapter.status(requestId) });
        } catch (error) {
            next(error);
        }
    });

    // Stubs — blocked on Phase-0; respond 501 with the reason, never fake success.
    router.post('/onramp-pusd', async (req: Request, res: Response, next: NextFunction) => {
        try {
            await buildFundingAdapter(getCredentials(req)).onrampPusd();
        } catch (error) {
            res.status(501).json({ success: false, error: (error as Error).message });
        }
    });

    router.post('/cashout', async (req: Request, res: Response, next: NextFunction) => {
        try {
            await buildFundingAdapter(getCredentials(req)).cashout();
        } catch (error) {
            res.status(501).json({ success: false, error: (error as Error).message });
        }
    });

    return router;
}
