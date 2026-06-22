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
import { logger } from '../utils/logger';
import {
    resolveIdentity,
    buildSigner,
    buildFundingAdapter,
    buildFundLinkAuth,
    appendWalletBackup,
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
            // The order's funder/maker is the user's CREATE2 deposit-wallet (where pUSD
            // lives + which trades), resolved the same way as deposit-address/balance/
            // setup — NOT the proxy-discovery address getEffectiveFunderAddress() returns.
            // The L1 API key stays bound to the EOA / OutLayer signer
            // (POLYMARKET_NATIVE_USDC_GUIDE.md §12a; the proven PHASE2 setup).
            const rc = await relayClientFor(credentials, false);
            const depositWallet = await rc.deriveDepositWalletAddress();
            const auth = new PolymarketOutlayerAuth(credentials, signer);
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

    // POST /outlayer/deposit-target  { credentials } → { account, token }
    // STEP 1 funding target for the IN-APP NEAR deposit: the user's OutLayer custody
    // NEAR account (the `msg` that intents.near credits) + the native NEAR USDC token
    // contract. The frontend signs `ft_transfer_call` to intents.near itself — no
    // redirect/fund-link. No EVM/signer derivation; works for chain=near (the EVM
    // signer path throws a viem error on near).
    router.post('/deposit-target', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const credentials = getCredentials(req);

            const { client, auth } = buildFundLinkAuth(credentials);

            // The custody NEAR account for `to`. The client method is typed EvmChain;
            // the underlying GET just forwards `chain=near` and returns the near account.
            const addr = await client.address(auth, 'near' as never);
            const account = addr.address;
            if (!account) {
                throw new Error('OutLayer /wallet/v1/address?chain=near returned no account');
            }

            // Resolve native USDC on NEAR from the token catalog (exact defuse asset
            // id for chain `near`/`defuse`), else fall back to the known contract.
            const KNOWN_NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
            let token = KNOWN_NEAR_USDC;
            let tokenSource: 'catalog' | 'fallback' = 'fallback';
            try {
                const onNear = (chains: string[] | undefined): boolean =>
                    (chains ?? []).some((c) => {
                        const v = c.toLowerCase();
                        return v === 'near' || v === 'defuse' || v.includes('near');
                    });
                const stripNep141 = (id: string): string => (id.startsWith('nep141:') ? id.slice('nep141:'.length) : id);
                const list = (await client.tokens(auth)).tokens ?? [];
                const usdcNear = list.find(
                    (t) => t.symbol?.toUpperCase() === 'USDC' && onNear(t.chains),
                );
                if (usdcNear?.defuse_asset_id) {
                    token = stripNep141(usdcNear.defuse_asset_id);
                    tokenSource = 'catalog';
                }
            } catch (e) {
                logger.warn(`[outlayer] deposit-target token catalog lookup failed, using fallback USDC: ${(e as Error).message}`);
            }
            logger.info(`[outlayer] deposit-target NEAR USDC token resolved via ${tokenSource}: ${token}`);

            appendWalletBackup(credentials, 'near', account);
            res.json({ success: true, data: { account, token } });
        } catch (error) {
            next(error);
        }
    });

    // POST /outlayer/intents-balance  { credentials } → { usdc, raw, token }
    // The user's OutLayer NEAR-intents USDC balance — where an in-app deposit
    // lands, BEFORE it's moved (fund-trading) to the Polymarket pUSD wallet.
    router.post('/intents-balance', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { client, auth } = buildFundLinkAuth(getCredentials(req));
            const token = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
            const bal = await client.balance(auth, token, 'intents');
            const raw = bal.balance ?? '0';
            res.json({ success: true, data: { usdc: Number(raw) / 1e6, raw, token } });
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
            appendWalletBackup(getCredentials(req), 'polygon', depositWallet);
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

    // POST /outlayer/fund-trading  { credentials, amountMinimal, dryRun? }
    //   → { bridgeIn, amount, token, dryRun, result }
    // STEP 2 of the funding money-path (POLYMARKET_NATIVE_USDC_GUIDE.md §7): move the
    // user's OutLayer intents USDC to the Polymarket bridge-in address; Polymarket's
    // bridge service then swaps+wraps it into pUSD in the deposit-wallet (Step 3, no
    // code on our side). The bridge-in is resolved exactly like /deposit-address
    // (deposit-wallet → POST bridge.polymarket.com/deposit with X-Builder-Code).
    router.post('/fund-trading', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const credentials = getCredentials(req);
            const amountMinimal = String((req.body?.amountMinimal as unknown) ?? '');
            const dryRun = Boolean(req.body?.dryRun);
            // R4: API amounts are integer strings in the token's smallest unit (USDC = 6 dp).
            if (!/^\d+$/.test(amountMinimal) || amountMinimal === '0' || /^0+$/.test(amountMinimal)) {
                res.status(400).json({ success: false, error: 'fund-trading requires { amountMinimal } as a non-zero string of digits (USDC 6-dp minimal units)' });
                return;
            }

            // Resolve bridgeIn — same logic as /deposit-address (Step 1).
            const rc = await relayClientFor(credentials, false);
            const depositWallet = await rc.deriveDepositWalletAddress();
            const r = await fetch('https://bridge.polymarket.com/deposit', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'X-Builder-Code': process.env.POLYMARKET_BUILDER_CODE || '' },
                body: JSON.stringify({ address: depositWallet }),
            });
            const j = (await r.json()) as { address?: { evm?: string } };
            const bridgeIn = j?.address?.evm;
            if (!bridgeIn) {
                throw new Error('Polymarket bridge.polymarket.com/deposit returned no address.evm (bridgeIn)');
            }

            // OutLayer auth — same path as /deposit-target (seed-based, no EVM derivation).
            const { client, auth } = buildFundLinkAuth(credentials);

            // The withdraw token is the NEAR/defuse USDC defuse asset id, in `nep141:`
            // form (the guide's Step-2 body shape). Resolve from the catalog; fall back
            // to the known constant.
            const FALLBACK_TOKEN = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
            let token = FALLBACK_TOKEN;
            let tokenSource: 'catalog' | 'fallback' = 'fallback';
            try {
                const onNear = (chains: string[] | undefined): boolean =>
                    (chains ?? []).some((c) => {
                        const v = c.toLowerCase();
                        return v === 'near' || v === 'defuse' || v.includes('near');
                    });
                const withNep141 = (id: string): string => (id.startsWith('nep141:') ? id : `nep141:${id}`);
                const list = (await client.tokens(auth)).tokens ?? [];
                const usdcNear = list.find((t) => t.symbol?.toUpperCase() === 'USDC' && onNear(t.chains));
                if (usdcNear?.defuse_asset_id) {
                    token = withNep141(usdcNear.defuse_asset_id);
                    tokenSource = 'catalog';
                }
            } catch (e) {
                logger.warn(`[outlayer] fund-trading token catalog lookup failed, using fallback USDC: ${(e as Error).message}`);
            }
            logger.info(`[outlayer] fund-trading NEAR USDC withdraw token resolved via ${tokenSource}: ${token}`);

            const withdrawReq = { chain: 'polygon', to: bridgeIn, amount: amountMinimal, token };
            const result = dryRun
                ? await client.withdrawDryRun(auth, withdrawReq)
                : await client.withdraw(auth, withdrawReq);

            res.json({ success: true, data: { bridgeIn, amount: amountMinimal, token, dryRun, result } });
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
