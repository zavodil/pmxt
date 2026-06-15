/**
 * Shared types for the OutLayer integration.
 *
 * This whole directory is ADDITIVE: it never modifies upstream pmxt files. The
 * one cross-cutting concern — extending `ExchangeCredentials` to carry an
 * OutLayer identity instead of a raw `privateKey` — is done via TypeScript
 * declaration merging at the bottom of this file, so `BaseExchange.ts` stays
 * byte-for-byte vanilla and upstream-syncable.
 */

/**
 * A standard EIP-712 v4 typed-data object, as passed to `eth_signTypedData_v4`.
 *
 * `types` MAY include an `EIP712Domain` entry; consumers that talk to OutLayer
 * reconstruct it from `domain` when absent (see {@link withEip712Domain}).
 */
export interface EvmTypedData {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
}

/**
 * The signer seam. Two implementations sit behind it:
 *  - {@link LocalKeySigner} — wraps a throwaway local secp256k1 key (offline
 *    unit tests / CI without network).
 *  - {@link OutlayerSigner} — calls the live OutLayer v1 EVM signing API by
 *    `seed`; holds NO raw key.
 *
 * Swapping one for the other is an implementation change, not a redesign — both
 * are constructed by {@link buildSigner} and consumed identically by the viem
 * custom account ({@link toSignerAccount}).
 */
export interface SignerProvider {
    /**
     * The `0x` EOA this signer controls. One address across all EVM chains for a
     * given identity; stable forever. May perform a one-time network lookup
     * (OutLayer) but is cached thereafter.
     */
    address(): Promise<`0x${string}`>;

    /** Sign an EIP-712 typed-data payload (EIP-712 v4). Returns 65-byte `0x` r‖s‖v (v ∈ {27,28}). */
    signTypedData(typedData: EvmTypedData): Promise<`0x${string}`>;

    /**
     * Sign an EIP-191 `personal_sign` message. Accepts a hex `0x..` byte string
     * or a UTF-8 string. Returns 65-byte `0x` r‖s‖v.
     */
    signMessage(message: `0x${string}` | string): Promise<`0x${string}`>;

    /**
     * Sign a raw EVM transaction. OPTIONAL — this is the OutLayer
     * `evm_sign.raw_tx` fast-follow (default-off), not part of v1. The generic
     * broadcaster only needs it for the POL-float fallback exit; the primary
     * gasless exit rides {@link signTypedData} (EIP-3009). Throws if the live
     * signer does not yet expose it.
     */
    signTransaction?(tx: Record<string, unknown>): Promise<`0x${string}`>;
}

/**
 * Auth-mode abstraction for the OutLayer wallet API. Implementations mint the
 * full `Authorization` header value per call:
 *  - `Bearer near:<…>` (deterministic, seed-bound) — the PREFERRED product path,
 *    matching the agreed EVM-signing contract; one instance per (key, seed).
 *  - `Bearer wk_<…>` (a registered custody-wallet key) — the zero-NEAR-key
 *    alternative; the wallet is fixed by the key, so `seed` plays no role.
 * Built fresh per request for `near:` (it embeds a timestamp + signature).
 */
export interface BearerAuth {
    /** Full `Authorization` header value, e.g. `Bearer near:<…>` or `Bearer wk_<…>`. */
    header(): string;
}

/**
 * A fully-resolved OutLayer identity: enough to mint a `Bearer near:` token and
 * select the per-user sub-wallet. Assembled by {@link resolveIdentity} from
 * per-request credentials with env fallbacks. The NEAR private key is resolved
 * separately and ONLY from server-side env — it never travels in credentials.
 */
export interface OutlayerIdentity {
    /** NEAR account id that authenticates the bearer. */
    accountId: string;
    /** The seed (verbatim, as sent in the bearer) selecting the sub-wallet. */
    seed: string;
    /** Optional sovereign vault id (bound into the signed auth message). */
    vaultId?: string;
}

/** EVM chain selector used in OutLayer wallet API calls. One EOA across all of them. */
export type EvmChain =
    | 'polygon'
    | 'ethereum'
    | 'base'
    | 'arbitrum'
    | 'bsc'
    | 'optimism'
    | 'avalanche';

// ---------------------------------------------------------------------------
// Declaration merging: extend ExchangeCredentials with the OutLayer identity.
// This keeps core/src/BaseExchange.ts vanilla (no upstream edit) while letting
// the factory hook and routes read `credentials.outlayer*` with full typing.
// ---------------------------------------------------------------------------
declare module '../../BaseExchange' {
    interface ExchangeCredentials {
        /**
         * OutLayer NEAR account id authorizing `evm_sign`. Falls back to
         * `OUTLAYER_ACCOUNT_ID` (single-tenant dev). The NEAR signing key is
         * NEVER carried here — it lives in `OUTLAYER_NEAR_PRIVATE_KEY` server-side.
         */
        outlayerAccountId?: string;
        /**
         * Pre-computed seed (verbatim) selecting the user's sub-wallet. Takes
         * precedence over {@link outlayerUserId}.
         */
        outlayerSeed?: string;
        /**
         * Convenience: the product user id. The seed is derived as
         * `seedFor("predict:user:<id>")`. Used when `outlayerSeed` is absent.
         */
        outlayerUserId?: string;
        /** Optional sovereign vault id; falls back to `OUTLAYER_VAULT_ID`. */
        outlayerVaultId?: string;
    }
}
