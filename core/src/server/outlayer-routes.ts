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
import { createPublicClient, createWalletClient, http, encodeFunctionData, maxUint256 } from 'viem';
import { polygon } from 'viem/chains';
import { RelayClient } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { ExchangeCredentials } from '../BaseExchange';
import {
    resolveIdentity,
    buildSigner,
    buildFundingAdapter,
    PolymarketOutlayerAuth,
    OutlayerClient,
    toSignerAccount,
    POLYMARKET_V2_CONTRACTS,
} from '../integrations/outlayer';

function getCredentials(req: Request): ExchangeCredentials | undefined {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return body.credentials as ExchangeCredentials | undefined;
}

const RPC_URL = (): string => process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
const RELAYER_URL = (): string => process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com';

const ERC20_ABI = [
    { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const ERC1155_ABI = [
    { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
] as const;

function builderConfig(): BuilderConfig {
    return new BuilderConfig({
        localBuilderCreds: {
            key: process.env.POLYMARKET_BUILDER_API_KEY || '',
            secret: process.env.POLYMARKET_BUILDER_SECRET || '',
            passphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE || '',
        },
    });
}

/** A RelayClient bound to the identity's OutLayer-signed viem wallet. */
async function relayClientFor(credentials: ExchangeCredentials | undefined, withBuilder: boolean): Promise<RelayClient> {
    const identity = resolveIdentity(credentials);
    const signer = buildSigner(identity);
    const account = await toSignerAccount(signer);
    const walletClient = createWalletClient({ account, chain: polygon, transport: http(RPC_URL()) });
    return new RelayClient(RELAYER_URL(), 137, walletClient, withBuilder ? builderConfig() : undefined);
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
            // Resolve the user's sigType-3 deposit-wallet (CREATE2). For sigType 3,
            // clob-client-v2 sets the order's `signer` field to this funder address,
            // so the CLOB requires the L1 API key to be owned by it too (bug #65/#70).
            // Derive the key with signatureType 3 + funderAddress=depositWallet so the
            // key binds to the deposit-wallet — matching the proven §8 invocation in
            // POLYMARKET_NATIVE_USDC_GUIDE.md (PolymarketOutlayerExchange + funder).
            const rc = await relayClientFor(credentials, false);
            const depositWallet = await rc.deriveDepositWalletAddress();
            const auth = new PolymarketOutlayerAuth(
                { ...credentials, signatureType: 3, funderAddress: depositWallet },
                signer,
            );
            const [address, creds] = await Promise.all([
                signer.address(),
                auth.getApiCredentials(),
            ]);
            res.json({
                success: true,
                data: {
                    address,
                    funderAddress: depositWallet,
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

    // POST /outlayer/deposit-address  { credentials } → { depositWallet, bridgeIn, minUsd }
    // The user's sigType-3 deposit-wallet + the Polymarket native-USDC bridge-in to fund it.
    router.post('/deposit-address', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const rc = await relayClientFor(getCredentials(req), false);
            const depositWallet = await rc.deriveDepositWalletAddress();
            let bridgeIn: unknown = null;
            try {
                const r = await fetch('https://bridge.polymarket.com/deposit', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'X-Builder-Code': process.env.POLYMARKET_BUILDER_CODE || '' },
                    body: JSON.stringify({ address: depositWallet }),
                });
                const j = (await r.json()) as { address?: unknown };
                bridgeIn = j?.address ?? null;
            } catch {
                /* bridge-in is best-effort */
            }
            res.json({ success: true, data: { depositWallet, bridgeIn, minUsd: 2 } });
        } catch (error) {
            next(error);
        }
    });

    // POST /outlayer/balance  { credentials } → { depositWallet, pusd, pusdRaw, deployed }
    router.post('/balance', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const rc = await relayClientFor(getCredentials(req), false);
            const depositWallet = await rc.deriveDepositWalletAddress();
            const pc = createPublicClient({ chain: polygon, transport: http(RPC_URL()) });
            const [raw, code] = await Promise.all([
                pc.readContract({
                    address: POLYMARKET_V2_CONTRACTS.pUsd as `0x${string}`,
                    abi: ERC20_ABI,
                    functionName: 'balanceOf',
                    args: [depositWallet as `0x${string}`],
                }),
                pc.getBytecode({ address: depositWallet as `0x${string}` }),
            ]);
            const pusdRaw = raw as bigint;
            res.json({
                success: true,
                data: {
                    depositWallet,
                    pusd: Number(pusdRaw) / 1e6,
                    pusdRaw: pusdRaw.toString(),
                    deployed: Boolean(code && code !== '0x'),
                },
            });
        } catch (error) {
            next(error);
        }
    });

    // POST /outlayer/setup  { credentials } → deploy deposit-wallet (if needed) + token approvals.
    // One-time per user, gasless via the builder relayer. Idempotent.
    router.post('/setup', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const rc = await relayClientFor(getCredentials(req), true);
            const depositWallet = await rc.deriveDepositWalletAddress();
            const pc = createPublicClient({ chain: polygon, transport: http(RPC_URL()) });
            const code = await pc.getBytecode({ address: depositWallet as `0x${string}` });
            const wasDeployed = Boolean(code && code !== '0x');
            if (!wasDeployed) await rc.deployDepositWallet();

            const C = POLYMARKET_V2_CONTRACTS;
            const approve = (spender: string) =>
                encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender as `0x${string}`, maxUint256] });
            const setAll = (op: string) =>
                encodeFunctionData({ abi: ERC1155_ABI, functionName: 'setApprovalForAll', args: [op as `0x${string}`, true] });
            const calls = [
                { target: C.pUsd, value: '0', data: approve(C.ctfExchangeV2) },
                { target: C.pUsd, value: '0', data: approve(C.negRiskCtfExchangeV2) },
                { target: C.pUsd, value: '0', data: approve(C.negRiskAdapter) },
                { target: C.conditionalTokens, value: '0', data: setAll(C.ctfExchangeV2) },
                { target: C.conditionalTokens, value: '0', data: setAll(C.negRiskCtfExchangeV2) },
                { target: C.conditionalTokens, value: '0', data: setAll(C.negRiskAdapter) },
            ];
            const deadline = String(Math.floor(Date.now() / 1000) + 3600);
            await rc.executeDepositWalletBatch(calls, depositWallet, deadline);

            res.json({ success: true, data: { depositWallet, deployed: true, approvalsSet: true, wasAlreadyDeployed: wasDeployed } });
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
