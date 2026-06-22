/**
 * Funding adapter (OUTLAYER_INTEGRATION_PLAN.md §7) — the money path between
 * NEAR-intents custody and the Polygon trading EOA.
 *
 *   deposit  : user funds NEAR intents (1Click bridge)        [user-server]
 *   fund     : intents → Polygon EOA  (withdraw chain=polygon, gasless on NEAR side)
 *   onramp   : make bridged USDC tradeable on the venue (V2: wrap pUSD + deposit-wallet)
 *   cashout  : sell → bridge Polygon → NEAR intents (gasless EIP-3009 if native USDC)
 *
 * STATUS: skeleton. `fundPolygon` (intents→Polygon withdraw), `status`, and
 * `tokens` are real (direct OutLayer client calls). `onrampPusd` and `cashout`
 * are stubbed — their on-chain step list depends on Phase-0 (USDC variant,
 * V2 deposit-wallet, exact contracts). Each throws a clear, actionable error
 * rather than pretending to run.
 */
import { OutlayerClient, WithdrawResponse, RequestStatusResponse, TokensResponse, DryRunResponse } from './outlayer-client';
import { BearerAuth } from './types';
import { GenericBroadcaster } from './broadcaster';
import { logger } from '../../utils/logger';

/** Polygon USDC defuse asset id — set after Phase-0 confirms the variant. */
export const POLYGON_USDC_DEFUSE_ASSET_PLACEHOLDER = 'nep141:<polygon-usdc>.omft.near';

export interface FundPolygonParams {
    /** EVM address to deliver USDC to (the user's OutLayer-derived Polygon EOA). */
    to: string;
    /** Amount in USDC minimal units (6 decimals). */
    amount: string;
    /** Defuse asset id of the intents-held USDC to bridge out. */
    token: string;
    /** Preview only — no funds move. */
    dryRun?: boolean;
}

export class FundingAdapter {
    constructor(
        private readonly client: OutlayerClient,
        private readonly auth: BearerAuth,
        // Broadcaster is held for the cashout/EIP-3009 path (Phase 2).
        private readonly broadcaster: GenericBroadcaster = new GenericBroadcaster(),
    ) {}

    /** The tradeable/withdrawable token catalog (used to resolve the right USDC variant). */
    async tokens(): Promise<TokensResponse> {
        return this.client.tokens(this.auth);
    }

    /**
     * Bridge USDC from NEAR intents onto the Polygon EOA (gasless on the NEAR
     * side; 1Click delivers on Polygon). This is the entry primitive.
     */
    async fundPolygon(params: FundPolygonParams): Promise<WithdrawResponse | DryRunResponse> {
        const req = { chain: 'polygon', to: params.to, amount: params.amount, token: params.token };
        if (params.dryRun) {
            return this.client.withdrawDryRun(this.auth, req);
        }
        logger.info('[funding] intents → polygon withdraw', { to: params.to, amount: params.amount });
        return this.client.withdraw(this.auth, req);
    }

    /** Poll an async OutLayer op (withdraw/swap) to its terminal state. */
    async status(requestId: string): Promise<RequestStatusResponse> {
        return this.client.requestStatus(this.auth, requestId);
    }

    /**
     * Make bridged USDC tradeable on Polymarket V2 (Phase-0 RESOLVED the shape —
     * see PHASE0_FINDINGS.md §4 + polymarket-v2-contracts.ts):
     *   1. CollateralOnramp.wrap(USDC.e|USDC) -> pUSD   (on-chain; relayer-sponsorable)
     *   2. deploy deposit-wallet (sigType 3)            (relayer-sponsored; no EOA signature)
     *   3. transfer pUSD into the deposit-wallet         (the one step that may cost POL as a raw EOA tx)
     * Deploy + approvals + wrap are gas-sponsored by Polymarket's relayer
     * (Builder/Relayer API key, Unverified tier). sigType 3 MUST be set
     * explicitly (pmxt never auto-detects it).
     *
     * STILL A STUB — implementing it needs the Builder/Relayer API key and a
     * funded wallet (live spike); the addresses + flow are now known.
     */
    async onrampPusd(): Promise<never> {
        throw new Error(
            '[funding] onrampPusd not implemented yet — addresses/flow known ' +
            '(see PHASE0_FINDINGS.md §4); needs a Polymarket Builder/Relayer API key + funded wallet.',
        );
    }

    /**
     * Exit: sell positions, then bridge Polygon → NEAR intents. Phase-0
     * correction: the venue collateral pUSD has NO EIP-3009 — gasless pUSD
     * movement uses the Polymarket relayer (unwrap pUSD -> USDC.e) or EIP-2612
     * permit. EIP-3009 only applies to the underlying Circle USDC at the 1Click
     * bridge boundary (and only if 1Click delivers native USDC — still open).
     *
     * STUB — needs the live spike: relayer key + the 1Click USDC-variant answer.
     */
    async cashout(): Promise<never> {
        void this.broadcaster;
        throw new Error(
            '[funding] cashout not implemented yet — pUSD uses relayer/permit (not EIP-3009); ' +
            'EIP-3009 only at the 1Click bridge boundary on Circle USDC. See PHASE0_FINDINGS.md §4.',
        );
    }
}
