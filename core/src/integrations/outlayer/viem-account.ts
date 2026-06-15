/**
 * Build a viem custom account ({@link https://viem.sh/docs/accounts/local/toAccount | toAccount})
 * from a {@link SignerProvider}. This is the injection mechanism described in
 * OUTLAYER_INTEGRATION_PLAN.md §5: viem custom accounts expose async
 * `signMessage` / `signTypedData` / `signTransaction`, which we route over HTTP
 * to the signer (OutLayer or local key). The resulting account drops straight
 * into `createWalletClient`, which `@polymarket/clob-client-v2` consumes as a
 * `WalletClient` signer — no raw key in pmxt's `PolymarketAuth`.
 *
 * EIP-712 detail: clob-client-v2 calls
 * `signer.signTypedData({ account, domain, types, primaryType, message })` AFTER
 * `delete typedData.types.EIP712Domain` (verified in the compiled lib). This
 * generic account just forwards that to the provider unchanged — viem-backed
 * signers (LocalKeySigner) re-derive the domain locally. OutLayer's hasher needs
 * an explicit `EIP712Domain` entry in `types`; that quirk is handled inside
 * {@link OutlayerSigner} (the single point that talks to OutLayer), not baked
 * into this generic adapter.
 */
import { toAccount } from 'viem/accounts';
import { bytesToHex, type LocalAccount } from 'viem';
import { SignerProvider, EvmTypedData } from './types';

/**
 * Adapt a {@link SignerProvider} into a viem {@link LocalAccount}. Resolves the
 * provider's address up front (viem needs it synchronously on the account), then
 * delegates each signing call back to the provider.
 */
export async function toSignerAccount(provider: SignerProvider): Promise<LocalAccount> {
    const address = await provider.address();

    return toAccount({
        address,

        async signMessage({ message }): Promise<`0x${string}`> {
            // viem's message is `string` | { raw: Hex | ByteArray }.
            if (typeof message === 'string') {
                return provider.signMessage(message);
            }
            const raw = message.raw;
            const hex = typeof raw === 'string' ? raw : bytesToHex(raw);
            return provider.signMessage(hex);
        },

        async signTypedData(typedData): Promise<`0x${string}`> {
            return provider.signTypedData(typedData as unknown as EvmTypedData);
        },

        async signTransaction(transaction): Promise<`0x${string}`> {
            if (!provider.signTransaction) {
                throw new Error(
                    'Raw-tx signing is not available: the active signer does not implement ' +
                    'signTransaction (OutLayer evm_sign.raw_tx is a default-off fast-follow). ' +
                    'The gasless EIP-3009 exit uses signTypedData instead.',
                );
            }
            return provider.signTransaction(transaction as unknown as Record<string, unknown>);
        },
    });
}
