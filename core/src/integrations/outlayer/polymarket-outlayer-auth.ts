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
import { createL1Headers } from '@polymarket/clob-client-v2';
import type { ApiKeyCreds } from '@polymarket/clob-client-v2';
import axios from 'axios';
import { PolymarketAuth } from '../../exchanges/polymarket/auth';
import { ExchangeCredentials } from '../../BaseExchange';
import { POLYMARKET_CHAIN_ID } from '../../exchanges/polymarket/config';
import { logger } from '../../utils/logger';
import { SignerProvider } from './types';
import { toSignerAccount } from './viem-account';

// Valid-format hex key used ONLY to clear the base constructor's format check.
// Never used to sign — overwritten by the OutLayer-backed account below.
const DUMMY_PRIVATE_KEY = `0x${'1'.repeat(64)}` as const;

const SIG_TYPE_POLY_1271 = 3; // deposit-wallet (ERC-1271 / ERC-7739)

export class PolymarketOutlayerAuth extends PolymarketAuth {
    private readonly provider: SignerProvider;
    private readonly outlayerCredentials: ExchangeCredentials;
    private signerReady?: Promise<void>;
    private funderApiCreds?: ApiKeyCreds;

    constructor(credentials: ExchangeCredentials, provider: SignerProvider) {
        // Preserve any apiKey/secret/passphrase/funderAddress/signatureType; only
        // inject the throwaway privateKey so the base constructor doesn't throw.
        super({ ...credentials, privateKey: DUMMY_PRIVATE_KEY });
        this.provider = provider;
        this.outlayerCredentials = credentials;
    }

    /**
     * Returns true when this identity trades as a sigType-3 deposit wallet, i.e.
     * the CLOB order's `signer` field is set by clob-client-v2 to `funderAddress`
     * (the deposit-wallet), NOT the EOA — see createMarketOrder/createOrder in the
     * SDK: `signerForOrder = signatureType === 3 ? maker : eoaSignerAddress`.
     */
    private depositWalletFunder(): string | undefined {
        const sigType = this.outlayerCredentials.signatureType;
        const isPoly1271 =
            sigType === SIG_TYPE_POLY_1271 ||
            (typeof sigType === 'string' &&
                ['3', '1271', 'poly1271', 'depositwallet'].includes(
                    sigType.toLowerCase().replace(/[^a-z0-9]/g, ''),
                ));
        if (!isPoly1271) return undefined;
        return this.outlayerCredentials.funderAddress || undefined;
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

        // If explicit CLOB creds were supplied (e.g. cached + passed back by the
        // user-server on a trading call), defer to the base, which returns them
        // verbatim. We trust the caller already derived them with the right owner.
        if (
            this.outlayerCredentials.apiKey &&
            this.outlayerCredentials.apiSecret &&
            this.outlayerCredentials.passphrase
        ) {
            return super.getApiCredentials();
        }

        // sigType-3 fix (clob-client-v2 #65/#70): the order's `signer` is the
        // deposit-wallet (funderAddress), but the SDK's deriveApiKey/createApiKey
        // bind the L1 API key to the EOA (they never pass the `address` override to
        // createL1Headers). That mismatch makes the CLOB reject orders with
        // "the order signer address has to be the address of the API KEY".
        //
        // Fix: derive/create the L1 key against the deposit-wallet address using
        // createL1Headers(..., address=funderAddress) so POLY_ADDRESS (the API-key
        // owner) == order.signer == depositWallet. The EOA OutLayer signer still
        // produces the ClobAuth signature; the CLOB verifies it against the
        // deposit-wallet via ERC-1271 (the same wallet that ERC-1271-verifies the
        // order itself). Requires the deposit-wallet to be deployed (run SETUP
        // first). For sigTypes 0/1/2 (order.signer == EOA) we keep the base path.
        const funder = this.depositWalletFunder();
        if (!funder) {
            return super.getApiCredentials();
        }

        if (this.funderApiCreds) {
            return this.funderApiCreds;
        }

        const creds = await this.deriveApiCredsForAddress(funder);
        this.funderApiCreds = creds;
        return creds;
    }

    /**
     * Derive (then, on failure, create) a Polymarket CLOB L1 API key bound to
     * `address` instead of the signer's EOA. Mirrors clob-client-v2's
     * ClobClient.deriveApiKey()/createApiKey() exactly — same endpoints, same
     * createL1Headers builder, same response shape — but passes the `address`
     * override so POLY_ADDRESS == the deposit-wallet.
     */
    private async deriveApiCredsForAddress(address: string): Promise<ApiKeyCreds> {
        const signer = (this as unknown as { signer: unknown }).signer;
        if (!signer) {
            throw new Error('[polymarket-outlayer] signer not initialized before L1 derivation');
        }
        const host = this.host.endsWith('/') ? this.host.slice(0, -1) : this.host;

        const reqHeaders = (h: Record<string, string>) => ({
            ...h,
            'User-Agent': '@polymarket/clob-client',
            Accept: '*/*',
            Connection: 'keep-alive',
            'Content-Type': 'application/json',
        });
        const toCreds = (raw: { apiKey?: string; secret?: string; passphrase?: string }): ApiKeyCreds => ({
            key: raw.apiKey ?? '',
            secret: raw.secret ?? '',
            passphrase: raw.passphrase ?? '',
        });
        const complete = (c: ApiKeyCreds) => Boolean(c.key && c.secret && c.passphrase);

        // 1) DERIVE existing key (GET /auth/derive-api-key), POLY_ADDRESS=address.
        try {
            const headers = await createL1Headers(
                signer as any,
                POLYMARKET_CHAIN_ID as any,
                undefined,
                undefined,
                address,
            );
            const resp = await axios.get(`${host}/auth/derive-api-key`, {
                headers: reqHeaders({ ...(headers as Record<string, string>), 'Accept-Encoding': 'gzip' }),
            });
            const creds = toCreds(resp.data ?? {});
            if (complete(creds)) return creds;
            throw new Error('derived deposit-wallet credentials are incomplete/empty');
        } catch (deriveError: any) {
            logger.info('Deposit-wallet API key derivation failed, creating new key', {
                error: deriveError?.message || String(deriveError),
            });
        }

        // 2) CREATE a new key (POST /auth/api-key), POLY_ADDRESS=address.
        const headers = await createL1Headers(
            signer as any,
            POLYMARKET_CHAIN_ID as any,
            undefined,
            undefined,
            address,
        );
        const resp = await axios.post(`${host}/auth/api-key`, undefined, {
            headers: reqHeaders(headers as Record<string, string>),
        });
        const creds = toCreds(resp.data ?? {});
        if (!complete(creds)) {
            throw new Error('Authentication failed: deposit-wallet credentials are incomplete after create.');
        }
        return creds;
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
