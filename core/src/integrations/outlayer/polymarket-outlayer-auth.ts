/**
 * {@link PolymarketOutlayerAuth} — a subclass of the vanilla
 * {@link PolymarketAuth} that replaces the EOA private-key signer with a viem
 * custom account backed by a {@link SignerProvider} (OutLayer or local key).
 *
 * Everything else — API-credential derivation, proxy/signatureType discovery,
 * the L2 `ClobClient` construction — is INHERITED unchanged. The base reads its
 * signer/address from the private `signer` / `signerAddress` fields and builds
 * every `ClobClient` from `this.signer`; we simply swap those out before any
 * signing happens. The OutLayer address is resolved asynchronously, so the swap
 * is deferred to {@link ensureSigner} (memoized) and awaited at the top of each
 * public async method.
 *
 * The base constructor requires a hex `privateKey` (format-checked), so we pass
 * a fixed THROWAWAY key purely to satisfy it. That key never signs anything: the
 * dummy `signer` it produces is overwritten in `ensureSigner` before first use.
 */
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { PolymarketAuth } from '../../exchanges/polymarket/auth';
import { ExchangeCredentials } from '../../BaseExchange';
import { SignerProvider } from './types';
import { toSignerAccount } from './viem-account';

// Valid-format hex key used ONLY to clear the base constructor's format check.
// Never used to sign — overwritten by the OutLayer-backed account below.
const DUMMY_PRIVATE_KEY = `0x${'1'.repeat(64)}` as const;

export class PolymarketOutlayerAuth extends PolymarketAuth {
    private readonly provider: SignerProvider;
    private signerReady?: Promise<void>;

    constructor(credentials: ExchangeCredentials, provider: SignerProvider) {
        // Preserve any apiKey/secret/passphrase/funderAddress/signatureType; only
        // inject the throwaway privateKey so the base constructor doesn't throw.
        super({ ...credentials, privateKey: DUMMY_PRIVATE_KEY });
        this.provider = provider;
    }

    /**
     * Build the OutLayer-backed viem wallet client once and install it over the
     * base's dummy `signer` / `signerAddress`. Those fields are `private` in the
     * upstream `auth.ts`; bracket-access keeps that file byte-for-byte vanilla.
     */
    private async ensureSigner(): Promise<void> {
        if (!this.signerReady) {
            this.signerReady = (async () => {
                const account = await toSignerAccount(this.provider);
                const walletClient = createWalletClient({
                    account,
                    chain: polygon,
                    transport: http(),
                });
                (this as unknown as { signer: unknown }).signer = walletClient;
                (this as unknown as { signerAddress: string }).signerAddress = account.address;
            })();
        }
        return this.signerReady;
    }

    override async getApiCredentials() {
        await this.ensureSigner();
        return super.getApiCredentials();
    }

    override async getClobClient() {
        await this.ensureSigner();
        return super.getClobClient();
    }

    override async discoverProxy() {
        await this.ensureSigner();
        return super.discoverProxy();
    }

    override async getEffectiveFunderAddress() {
        await this.ensureSigner();
        return super.getEffectiveFunderAddress();
    }
}
