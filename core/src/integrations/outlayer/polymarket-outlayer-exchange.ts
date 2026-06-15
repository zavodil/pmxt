/**
 * {@link PolymarketOutlayerExchange} — the vanilla {@link PolymarketExchange}
 * with its private-key auth replaced by {@link PolymarketOutlayerAuth}.
 *
 * The base constructor only builds `this.auth` when `credentials.privateKey` is
 * present; we deliberately pass NO private key, leaving `auth` unset, then
 * install the OutLayer-backed auth. (`auth` is `private` upstream; bracket-access
 * keeps `polymarket/index.ts` vanilla.) Every trading method funnels through
 * `ensureAuth()` → `this.auth`, so this single swap routes all order/L1-auth
 * signing through the custom-account seam. apiKey/secret/passphrase, if supplied,
 * are still picked up by the base constructor for the implicit private API.
 */
import { PolymarketExchange } from '../../exchanges/polymarket';
import { ExchangeCredentials } from '../../BaseExchange';
import { SignerProvider } from './types';
import { PolymarketOutlayerAuth } from './polymarket-outlayer-auth';

export class PolymarketOutlayerExchange extends PolymarketExchange {
    constructor(credentials: ExchangeCredentials, provider: SignerProvider) {
        super(credentials);
        (this as unknown as { auth: PolymarketOutlayerAuth }).auth = new PolymarketOutlayerAuth(credentials, provider);
    }
}
