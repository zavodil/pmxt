/**
 * Typed client for the OutLayer wallet API — a TS port of the subset of
 * `ai-intents/api/crates/outlayer/src/client.rs` this integration needs:
 * the EVM signing surface (v1, LIVE) plus the funding primitives the
 * funding-adapter uses (deposit-intent, withdraw, tokens, request status).
 *
 * No credential is stored on the client; pass a {@link NearAuth} + `seed` to
 * each method, which mints a fresh `Bearer near:` per request.
 */
import axios, { AxiosInstance, AxiosError } from 'axios';
import { EvmTypedData, EvmChain, BearerAuth } from './types';
import { logger } from '../../utils/logger';

export const OUTLAYER_API_BASE_ENV = 'OUTLAYER_API_BASE';
export const DEFAULT_OUTLAYER_API_BASE = 'https://api.outlayer.fastnear.com';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY = 4_096;

export interface AddressResponse {
    address: string;
    public_key?: string;
    chain?: string;
    wallet_id?: string;
}

export interface SignatureResponse {
    signature: string;
}

export interface SignTransactionResponse {
    raw_signed_tx: string;
    tx_hash?: string;
}

export interface DepositIntentRequest {
    source_asset?: string;
    chain?: string;
    token?: string;
    amount: string;
    destination_asset?: string;
    refund_address?: string;
}

export interface DepositIntentResponse {
    intent_id: string;
    deposit_address: string;
    amount: string;
    amount_out: string;
    min_amount_out: string;
    expires_at?: string;
    estimated_time_secs?: number;
    hint?: string;
}

export interface WithdrawRequest {
    chain: string;
    to?: string;
    amount: string;
    token?: string;
}

export interface WithdrawResponse {
    request_id: string;
    status: string;
    approval_id?: string;
    request_hash?: string;
}

export interface DryRunResponse {
    would_succeed: boolean;
    reason?: string;
    message?: string;
    estimated_fee?: string;
    fee_token?: string;
}

export interface RequestStatusResponse {
    request_id: string;
    type?: string;
    status: string;
    result?: unknown;
    created_at?: string;
    updated_at?: string;
}

export interface TokensResponse {
    tokens: Array<{
        id: string;
        symbol: string;
        chains: string[];
        decimals: number;
        defuse_asset_id: string;
    }>;
}

export interface RegisterResponse {
    api_key?: string;
    wallet_id?: string;
    near_account_id: string;
}

/** Terminal-success / terminal-failure markers (mirrors `RequestStatus::classify`). */
const TERMINAL_SUCCESS = new Set([
    'settled', 'completed', 'complete', 'success', 'succeeded', 'confirmed', 'done', 'finalized', 'finished',
]);
const TERMINAL_FAILURE = new Set([
    'failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'expired', 'timeout', 'timed_out', 'refunded', 'refund',
]);

export function isTerminalStatus(status: string): boolean {
    const s = status.trim().toLowerCase();
    return TERMINAL_SUCCESS.has(s) || TERMINAL_FAILURE.has(s);
}

export class OutlayerError extends Error {
    constructor(message: string, readonly status?: number, readonly body?: string) {
        super(message);
        this.name = 'OutlayerError';
    }
}

export class OutlayerClient {
    readonly baseUrl: string;
    private readonly http: AxiosInstance;

    constructor(baseUrl?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
        this.baseUrl = (baseUrl || process.env[OUTLAYER_API_BASE_ENV] || DEFAULT_OUTLAYER_API_BASE).replace(/\/+$/, '');
        this.http = axios.create({
            baseURL: this.baseUrl,
            timeout: timeoutMs,
            headers: { 'Content-Type': 'application/json' },
            // EIP-712 typed-data from tooling (e.g. the relayer SDK) carries BigInt
            // uint256 values, which plain JSON.stringify rejects. Serialize BigInt
            // as a decimal string — the canonical eth_signTypedData_v4 wire form.
            transformRequest: [(data) =>
                data === undefined || data === null
                    ? data
                    : JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
            ],
        });
    }

    // ---- Registration (no auth) -------------------------------------------

    /**
     * `POST /register` — mint a random custody wallet, returning a `wk_` api key
     * and the derived NEAR account. The zero-NEAR-key path: use the returned
     * `api_key` as `Bearer wk_…` (incl. for the EVM signing endpoints).
     */
    async register(): Promise<RegisterResponse> {
        try {
            const { data } = await this.http.post<RegisterResponse>('/register', {});
            return data;
        } catch (e) {
            throw this.mapError(e, '/register');
        }
    }

    // ---- EVM signing (v1, LIVE) -------------------------------------------

    /** `GET /wallet/v1/address?chain=<evm>` → the wallet's `0x` EOA on EVM chains. */
    async address(auth: BearerAuth, chain: EvmChain): Promise<AddressResponse> {
        return this.get('/wallet/v1/address', auth, { chain });
    }

    /** `POST /wallet/v1/evm/sign-typed-data` → 65-byte `0x` signature (EIP-712 v4). */
    async signTypedData(auth: BearerAuth, chain: EvmChain, typedData: EvmTypedData): Promise<SignatureResponse> {
        return this.post('/wallet/v1/evm/sign-typed-data', auth, { chain, typed_data: typedData });
    }

    /** `POST /wallet/v1/evm/sign-message` → 65-byte `0x` signature (EIP-191). */
    async signMessage(auth: BearerAuth, chain: EvmChain, message: string): Promise<SignatureResponse> {
        return this.post('/wallet/v1/evm/sign-message', auth, { chain, message });
    }

    /** `POST /wallet/v1/evm/sign-transaction` → raw signed tx (FAST-FOLLOW, may 404 until live). */
    async signTransaction(auth: BearerAuth, chain: EvmChain, tx: Record<string, unknown>): Promise<SignTransactionResponse> {
        return this.post('/wallet/v1/evm/sign-transaction', auth, { chain, tx });
    }

    // ---- Funding (intents bridge) -----------------------------------------

    /** `GET /wallet/v1/tokens` — the tradeable/withdrawable token catalog. */
    async tokens(auth: BearerAuth): Promise<TokensResponse> {
        return this.get('/wallet/v1/tokens', auth);
    }

    /**
     * `GET /wallet/v1/balance` — a token balance. `source: "intents"` reads the
     * NEAR-intents balance (what swaps/withdraws spend); omit for the on-chain
     * wallet balance. `token` is a defuse asset id (intents) or contract id.
     */
    async balance(auth: BearerAuth, token?: string, source: 'intents' | 'near' = 'intents'): Promise<{ balance: string; token?: string; account_id?: string }> {
        const params: Record<string, unknown> = source === 'intents' ? { source: 'intents' } : {};
        if (token) params.token = token;
        return this.get('/wallet/v1/balance', auth, params);
    }

    /** `POST /wallet/v1/deposit-intent` — a single-use 1Click bridge address. */
    async depositIntent(auth: BearerAuth, req: DepositIntentRequest): Promise<DepositIntentResponse> {
        return this.post('/wallet/v1/deposit-intent', auth, req);
    }

    /** `POST /wallet/v1/intents/withdraw` — bridge intents balance to a chain/address. */
    async withdraw(auth: BearerAuth, req: WithdrawRequest): Promise<WithdrawResponse> {
        return this.post('/wallet/v1/intents/withdraw', auth, req);
    }

    /** `POST /wallet/v1/intents/withdraw/dry-run` — fee/feasibility preview; moves nothing. */
    async withdrawDryRun(auth: BearerAuth, req: WithdrawRequest): Promise<DryRunResponse> {
        return this.post('/wallet/v1/intents/withdraw/dry-run', auth, req);
    }

    /** `GET /wallet/v1/requests/{id}` — status of an async op. */
    async requestStatus(auth: BearerAuth, requestId: string): Promise<RequestStatusResponse> {
        return this.get(`/wallet/v1/requests/${encodeURIComponent(requestId)}`, auth);
    }

    // ---- internals --------------------------------------------------------

    private async get<T>(path: string, auth: BearerAuth, params?: Record<string, unknown>): Promise<T> {
        try {
            const { data } = await this.http.get<T>(path, {
                params,
                headers: { Authorization: auth.header() },
            });
            return data;
        } catch (e) {
            throw this.mapError(e, path);
        }
    }

    private async post<T>(path: string, auth: BearerAuth, body: unknown): Promise<T> {
        try {
            const { data } = await this.http.post<T>(path, body, {
                headers: { Authorization: auth.header() },
            });
            return data;
        } catch (e) {
            throw this.mapError(e, path);
        }
    }

    private mapError(e: unknown, path: string): OutlayerError {
        const ax = e as AxiosError;
        const status = ax.response?.status;
        let body = '';
        if (ax.response?.data !== undefined) {
            body = typeof ax.response.data === 'string' ? ax.response.data : JSON.stringify(ax.response.data);
            if (body.length > MAX_ERROR_BODY) body = body.slice(0, MAX_ERROR_BODY);
        }
        const msg = `OutLayer ${path} failed${status ? ` (${status})` : ''}: ${body || ax.message}`;
        logger.warn(msg);
        return new OutlayerError(msg, status, body);
    }
}
