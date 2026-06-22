/**
 * The OutLayer factory: per-request identity resolution, signer construction,
 * and the per-seed LRU cache of exchange instances.
 *
 * This is what the single guarded hook in `exchange-factory.ts` calls. It keeps
 * ALL OutLayer-awareness out of upstream files:
 *   - {@link isOutlayerEnabled} decides whether a request is OutLayer-backed.
 *   - {@link createOutlayerExchange} builds (and caches) the venue exchange with
 *     its private-key signer replaced by an OutLayer/local {@link SignerProvider}.
 *
 * Multi-tenancy: one sidecar serves N users. The per-user identity rides in
 * credentials (`outlayerAccountId` + `outlayerSeed`/`outlayerUserId`); the NEAR
 * signing key NEVER does — it lives only in `OUTLAYER_NEAR_PRIVATE_KEY`
 * server-side. Per-(venue, identity) exchanges are LRU-cached so `deriveApiKey`
 * + proxy discovery don't re-run on every call.
 */
import { ExchangeCredentials } from '../../BaseExchange';
import { logger } from '../../utils/logger';
import { NearAuth } from './near-auth';
import { OutlayerClient } from './outlayer-client';
import { OutlayerSigner } from './outlayer-signer';
import { LocalKeySigner } from './local-key-signer';
import { SeedBearerAuth, WkBearerAuth } from './outlayer-auth';
import { FundingAdapter } from './funding-adapter';
import { PolymarketOutlayerExchange } from './polymarket-outlayer-exchange';
import { SignerProvider, OutlayerIdentity, EvmChain, BearerAuth } from './types';

const SEED_RE = /^[a-zA-Z0-9._-]{1,256}$/;
const USER_SEED_PREFIX = 'predict:user:';
const DEFAULT_CHAIN: EvmChain = 'polygon';
const CACHE_MAX = 500;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

// ---------------------------------------------------------------------------
// Tiny typed LRU (Map preserves insertion order). Avoids an untyped dep.
// ---------------------------------------------------------------------------
class TinyLru<V> {
    private readonly map = new Map<string, { value: V; at: number }>();
    constructor(private readonly max: number, private readonly ttlMs: number) {}

    get(key: string): V | undefined {
        const hit = this.map.get(key);
        if (!hit) return undefined;
        if (Date.now() - hit.at > this.ttlMs) {
            this.map.delete(key);
            return undefined;
        }
        // Refresh recency.
        this.map.delete(key);
        this.map.set(key, hit);
        return hit.value;
    }

    set(key: string, value: V): void {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, { value, at: Date.now() });
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.map.delete(oldest);
        }
    }
}

const exchangeCache = new TinyLru<unknown>(CACHE_MAX, CACHE_TTL_MS);

// One shared OutlayerClient + a small NearAuth cache (parsing the key is cheap
// but pointless to repeat per request).
let sharedClient: OutlayerClient | undefined;
function getClient(): OutlayerClient {
    if (!sharedClient) sharedClient = new OutlayerClient();
    return sharedClient;
}
const nearAuthCache = new Map<string, NearAuth>();

/** True when this request should be served by the OutLayer-backed exchange. */
export function isOutlayerEnabled(credentials?: ExchangeCredentials): boolean {
    if (credentials?.outlayerAccountId || credentials?.outlayerSeed || credentials?.outlayerUserId) {
        return true;
    }
    const flag = process.env.OUTLAYER_ENABLED;
    return flag === 'true' || flag === '1';
}

/** Whether the local-key test signer is selected (offline tests / CI). */
function isLocalSignerMode(): boolean {
    return (process.env.OUTLAYER_SIGNER || '').toLowerCase() === 'local';
}

/**
 * Whether the zero-NEAR-key `Bearer wk_` mode is selected (single-tenant/dev:
 * one registered custody wallet via OUTLAYER_WK_KEY). The multi-tenant per-user
 * path is `Bearer near:` + seed; prefer that for production.
 */
function isWkMode(): boolean {
    return !!process.env.OUTLAYER_WK_KEY;
}

/**
 * Resolve a full OutLayer identity from per-request credentials with env
 * fallbacks. The NEAR private key is resolved separately and only from env.
 */
export function resolveIdentity(credentials?: ExchangeCredentials): OutlayerIdentity {
    const accountId = credentials?.outlayerAccountId || process.env.OUTLAYER_ACCOUNT_ID || '';
    const vaultId = credentials?.outlayerVaultId || process.env.OUTLAYER_VAULT_ID || undefined;

    let seed = credentials?.outlayerSeed || '';
    if (!seed) {
        const userId = credentials?.outlayerUserId || process.env.OUTLAYER_USER_ID;
        if (userId) {
            seed = NearAuth.seedFor(`${USER_SEED_PREFIX}${userId}`);
        } else if (process.env.OUTLAYER_SEED) {
            seed = process.env.OUTLAYER_SEED;
        } else if (isWkMode()) {
            // wk_ mode fixes the wallet by key; seed is unused. Sentinel keeps
            // the rest of the code uniform without a real seed.
            seed = 'wk';
        }
    }
    if (!seed) {
        throw new Error(
            'OutLayer identity requires a seed: pass credentials.outlayerSeed or ' +
            'credentials.outlayerUserId (hashed as predict:user:<id>), or set ' +
            'OUTLAYER_SEED / OUTLAYER_USER_ID.',
        );
    }
    if (!SEED_RE.test(seed)) {
        throw new Error(
            `OutLayer seed "${seed}" is invalid: must match [a-zA-Z0-9._-]{1,256} (no ':' or ` +
            `whitespace). Use outlayerUserId to hash a product id into a valid hex seed.`,
        );
    }
    return { accountId, seed, vaultId };
}

function getNearAuth(identity: OutlayerIdentity): NearAuth {
    if (!identity.accountId) {
        throw new Error('OutLayer signing requires an account id (credentials.outlayerAccountId or OUTLAYER_ACCOUNT_ID).');
    }
    const nearPrivateKey = process.env.OUTLAYER_NEAR_PRIVATE_KEY;
    if (!nearPrivateKey) {
        throw new Error(
            'OUTLAYER_NEAR_PRIVATE_KEY is not set. The NEAR ed25519 key that authorizes ' +
            'evm_sign must live server-side (never in credentials). Set it in .env, or use ' +
            'OUTLAYER_SIGNER=local for offline tests.',
        );
    }
    const cacheKey = `${identity.accountId}|${identity.vaultId ?? ''}`;
    let auth = nearAuthCache.get(cacheKey);
    if (!auth) {
        auth = new NearAuth(identity.accountId, nearPrivateKey, identity.vaultId);
        nearAuthCache.set(cacheKey, auth);
    }
    return auth;
}

/** Build the {@link BearerAuth} for an identity: `wk_` if configured, else `near:`. */
function buildBearerAuth(identity: OutlayerIdentity): BearerAuth {
    if (isWkMode()) {
        return new WkBearerAuth(process.env.OUTLAYER_WK_KEY as string);
    }
    return new SeedBearerAuth(getNearAuth(identity), identity.seed);
}

/** Build the active {@link SignerProvider} for an identity. */
export function buildSigner(identity: OutlayerIdentity, chain: EvmChain = DEFAULT_CHAIN): SignerProvider {
    if (isLocalSignerMode()) {
        const pk = process.env.OUTLAYER_LOCAL_PRIVATE_KEY as `0x${string}` | undefined;
        logger.warn('[outlayer] OUTLAYER_SIGNER=local — using LocalKeySigner (offline test double, NOT OutLayer).');
        return pk ? new LocalKeySigner(pk) : LocalKeySigner.generate();
    }
    return new OutlayerSigner(getClient(), buildBearerAuth(identity), chain);
}

/** Build a {@link FundingAdapter} for the routes. */
export function buildFundingAdapter(credentials?: ExchangeCredentials): FundingAdapter {
    const identity = resolveIdentity(credentials);
    return new FundingAdapter(getClient(), buildBearerAuth(identity));
}

/**
 * Resolve the shared {@link OutlayerClient} + per-user {@link BearerAuth} for the
 * NEAR fund-link route — STEP 1 funding (USDC from the user's NEAR wallet into
 * their OutLayer custody intents balance). Same seed-based auth the signing/
 * funding paths use; no signer/EVM derivation, so it works for `chain=near`.
 */
export function buildFundLinkAuth(credentials?: ExchangeCredentials): { client: OutlayerClient; auth: BearerAuth } {
    const identity = resolveIdentity(credentials);
    return { client: getClient(), auth: buildBearerAuth(identity) };
}

/**
 * Build (or fetch from cache) the OutLayer-backed exchange for a venue.
 * Called by the single guarded hook in `exchange-factory.ts`.
 */
export function createOutlayerExchange(name: string, credentials?: ExchangeCredentials): unknown {
    const identity = resolveIdentity(credentials);
    const key = [
        name,
        identity.accountId,
        identity.vaultId ?? '',
        identity.seed,
        credentials?.funderAddress ?? '',
        String(credentials?.signatureType ?? ''),
        credentials?.apiKey ?? '',
        isLocalSignerMode() ? 'local' : 'outlayer',
    ].join('|');

    const cached = exchangeCache.get(key);
    if (cached) return cached;

    const provider = buildSigner(identity);
    let exchange: unknown;
    switch (name) {
        case 'polymarket':
            exchange = new PolymarketOutlayerExchange(credentials ?? {}, provider);
            break;
        // Limitless / Opinion reuse the same seam later (PLAN §5) — same
        // clob-client-v2 / EIP-712 mechanic, just a different subclass here.
        default:
            throw new Error(`OutLayer integration does not support venue '${name}' yet (Polymarket only).`);
    }

    exchangeCache.set(key, exchange);
    return exchange;
}
