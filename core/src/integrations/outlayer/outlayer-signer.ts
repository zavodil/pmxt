/**
 * {@link OutlayerSigner} — the PRIMARY {@link SignerProvider}. Holds no raw key;
 * derives its address and produces every signature by calling the live OutLayer
 * v1 EVM signing API ({@link OutlayerClient}), authenticated by a {@link BearerAuth}
 * (either deterministic `Bearer near:` bound to a per-user seed, or a registered
 * `Bearer wk_` custody wallet — the signer is agnostic to which).
 *
 * Contract (see OUTLAYER_EVM_SIGNING_RESPONSE.md §2):
 *   GET  /wallet/v1/address?chain=polygon      → derived 0x EOA (stable forever)
 *   POST /wallet/v1/evm/sign-typed-data        → 65-byte 0x sig (EIP-712 v4)
 *   POST /wallet/v1/evm/sign-message           → 65-byte 0x sig (EIP-191)
 *   POST /wallet/v1/evm/sign-transaction       → raw signed tx (FAST-FOLLOW)
 */
import { getAddress } from 'viem';
import { OutlayerClient } from './outlayer-client';
import { SignerProvider, EvmTypedData, EvmChain, BearerAuth } from './types';

function normalizeSig(sig: string): `0x${string}` {
    const hex = sig.startsWith('0x') ? sig : `0x${sig}`;
    return hex as `0x${string}`;
}

/**
 * OutLayer's `sign-typed-data` computes the domain separator from an explicit
 * `EIP712Domain` entry in `types` (it errors `unknown struct type 'EIP712Domain'`
 * if absent). clob-client-v2 and viem both strip/omit it, so we reconstruct it
 * here — in canonical `eth_signTypedData_v4` field order — before sending.
 * No-op if already present. The resulting EIP-712 digest is identical, so
 * ecrecover against the original typed data still matches.
 */
export function withEip712Domain(td: EvmTypedData): EvmTypedData {
    if (td.types && td.types.EIP712Domain) return td;
    const domain = (td.domain ?? {}) as Record<string, unknown>;
    const fields: Array<{ name: string; type: string }> = [];
    if (domain.name !== undefined) fields.push({ name: 'name', type: 'string' });
    if (domain.version !== undefined) fields.push({ name: 'version', type: 'string' });
    if (domain.chainId !== undefined) fields.push({ name: 'chainId', type: 'uint256' });
    if (domain.verifyingContract !== undefined) fields.push({ name: 'verifyingContract', type: 'address' });
    if (domain.salt !== undefined) fields.push({ name: 'salt', type: 'bytes32' });
    return { ...td, types: { EIP712Domain: fields, ...td.types } };
}

export class OutlayerSigner implements SignerProvider {
    private cachedAddress?: `0x${string}`;

    constructor(
        private readonly client: OutlayerClient,
        private readonly auth: BearerAuth,
        private readonly chain: EvmChain = 'polygon',
    ) {}

    async address(): Promise<`0x${string}`> {
        if (!this.cachedAddress) {
            const res = await this.client.address(this.auth, this.chain);
            if (!res.address) {
                throw new Error('OutLayer /wallet/v1/address returned no address');
            }
            // Checksum so it matches viem-derived addresses byte-for-byte.
            this.cachedAddress = getAddress(res.address);
        }
        return this.cachedAddress;
    }

    async signTypedData(typedData: EvmTypedData): Promise<`0x${string}`> {
        const res = await this.client.signTypedData(this.auth, this.chain, withEip712Domain(typedData));
        return normalizeSig(res.signature);
    }

    async signMessage(message: `0x${string}` | string): Promise<`0x${string}`> {
        const res = await this.client.signMessage(this.auth, this.chain, message);
        return normalizeSig(res.signature);
    }

    async signTransaction(tx: Record<string, unknown>): Promise<`0x${string}`> {
        const res = await this.client.signTransaction(this.auth, this.chain, tx);
        return normalizeSig(res.raw_signed_tx);
    }
}
