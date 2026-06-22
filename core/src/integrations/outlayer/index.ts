/**
 * OutLayer integration — additive, upstream-syncable surface.
 *
 * Everything here lives outside upstream pmxt files. The only upstream touch
 * points are (1) the guarded hook in `server/exchange-factory.ts` and (2) the
 * one router-mount line in `server/app.ts` (mirroring createFeedRouter /
 * createSqlRouter). See OUTLAYER_INTEGRATION_PLAN.md §9.
 */
export * from './types';
export { NearAuth } from './near-auth';
export { SeedBearerAuth, WkBearerAuth } from './outlayer-auth';
export {
    OutlayerClient,
    OutlayerError,
    DEFAULT_OUTLAYER_API_BASE,
    OUTLAYER_API_BASE_ENV,
    isTerminalStatus,
} from './outlayer-client';
export { LocalKeySigner } from './local-key-signer';
export { OutlayerSigner, withEip712Domain } from './outlayer-signer';
export { toSignerAccount } from './viem-account';
export { PolymarketOutlayerAuth } from './polymarket-outlayer-auth';
export { PolymarketOutlayerExchange } from './polymarket-outlayer-exchange';
export { appendWalletBackup } from './wallet-backup';
export { GenericBroadcaster } from './broadcaster';
export { FundingAdapter } from './funding-adapter';
export {
    POLYMARKET_V2_CONTRACTS,
    POLYGON_USDC,
    POLYMARKET_V2_ORDER_DOMAIN,
    SIGNATURE_TYPE,
    POLYGON_CHAIN_ID,
} from './polymarket-v2-contracts';
export {
    isOutlayerEnabled,
    createOutlayerExchange,
    resolveIdentity,
    buildSigner,
    buildFundingAdapter,
    buildFundLinkAuth,
} from './factory';
