/**
 * Polymarket V2 contract addresses on Polygon (chainId 137).
 *
 * Resolved in Phase-0 via multi-agent web research + adversarial verification
 * (Polygonscan public name-tags, docs.polymarket.com, ctf-exchange-v2 repo).
 * Confidence: HIGH on the addresses (each cross-checked on Polygonscan).
 * Re-verify on-chain before using any of these to MOVE funds in Phase 2.
 *
 * See PHASE0_FINDINGS.md §4 for sources and the full reasoning, including the
 * key correction: Polymarket V2 collateral is **pUSD**, a Polymarket-issued
 * ERC-20 wrapper over **bridged USDC.e** (via CollateralOnramp.wrap()). pUSD
 * implements **EIP-2612 `permit`** but **NOT EIP-3009** — so the gasless exit
 * cannot use EIP-3009 on pUSD; the Polymarket relayer (gasless wrap/unwrap/
 * transfer/approve/deploy) is the primary gas-saver, and EIP-3009 only applies
 * to the underlying Circle USDC at the NEAR-intents bridge boundary.
 */
export const POLYGON_CHAIN_ID = 137;

export const POLYMARKET_V2_CONTRACTS = {
    /** V2 CLOB exchange (standard markets). Replaced V1 0x4bFb41d5…8982E. */
    ctfExchangeV2: '0xE111180000d2663C0091e4f400237545B87B996B',
    /** V2 CLOB exchange (neg-risk / mutually-exclusive multi-outcome markets). */
    negRiskCtfExchangeV2: '0xe2222d279d744050d28e00520010520000310F59',
    /** Neg-risk adapter (carried from V1). */
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
    /** Conditional Tokens Framework (Gnosis CTF, ERC-1155). Shared V1/V2. */
    conditionalTokens: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    /** V2 collateral token pUSD (ERC-20, 6 decimals). impl 0x6bBCef9f…925f. */
    pUsd: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
    /** Permissionless Collateral Onramp: wrap(USDC.e|USDC) -> pUSD. */
    collateralOnramp: '0x93070a847efEf7F70739046A929D47a521F5B8ee',
    /** Collateral Offramp: unwrap(pUSD) -> USDC.e. */
    collateralOfframp: '0x2957922Eb93258b93368531d39fAcCA3B4dC5854',
    /**
     * Deposit-wallet (POLY_1271 / sigType 3) factory. CREATE2 ERC-1967 clone.
     * Has a view `predictWalletAddress(address _implementation, bytes32 _id)` —
     * use that (or the SDK's deriveDepositWalletAddress) rather than hardcoding,
     * since both UUPS and BeaconProxy clone shapes exist.
     */
    depositWalletFactory: '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',
    /**
     * ⚠️ UNVERIFIED — Phase-2 verifiers disagree: one found NO on-chain code at
     * this "beacon", and names 0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB as the
     * DepositWalletImplementation. Do NOT rely on this constant; derive the
     * address on-chain via predictWalletAddress(impl, id). See PHASE0_FINDINGS §4c.
     */
    depositWalletBeacon: '0x7A18EDfe055488A3128f01F563e5B479D92ffc3a',
    /** Candidate deposit-wallet implementation (has code on-chain per verifier). */
    depositWalletImplementation: '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB',
    /** Legacy V1 CLOB exchange (order books wiped 2026-04-28; contract still live). */
    ctfExchangeV1Legacy: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
} as const;

/** USDC token variants on Polygon (the EIP-3009 question lives here, not on pUSD). */
export const POLYGON_USDC = {
    /** Native Circle USDC (FiatTokenV2). EIP-3009 support on Polygon = TO VERIFY by ABI/bytecode. */
    native: '0x3c499c542cEF5E3811e1192ce70d8cc03d5c3359',
    /** Bridged USDC.e (PoS). No EIP-3009. What pUSD is wrapped from. */
    bridged: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
} as const;

/**
 * EIP-712 domain for V2 CLOB order signing. `verifyingContract` is the exchange
 * the order routes to (standard vs neg-risk, per market). V1 used version '1';
 * V2 bumped to '2'. The L1 ClobAuth domain stays version '1'.
 */
export const POLYMARKET_V2_ORDER_DOMAIN = {
    name: 'Polymarket CTF Exchange',
    version: '2',
    chainId: POLYGON_CHAIN_ID,
} as const;

/**
 * Polymarket signatureType. pmxt's discovery can only ever return 1 or 2 — it
 * NEVER auto-detects a V2 deposit wallet — so sigType 3 MUST be set explicitly
 * in credentials. (pmxt's runtime fallback is Gnosis Safe (2), despite a stale
 * code comment claiming POLY_1271.)
 */
export const SIGNATURE_TYPE = {
    EOA: 0,
    POLY_PROXY: 1,
    GNOSIS_SAFE: 2,
    POLY_1271_DEPOSIT_WALLET: 3, // V2 standard for new API users (ERC-7739-wrapped ERC-1271)
} as const;
