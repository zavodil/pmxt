/**
 * {@link LocalKeySigner} — a {@link SignerProvider} backed by a local secp256k1
 * key, via viem's `privateKeyToAccount`.
 *
 * This is the OFFLINE TEST DOUBLE only: unit tests / CI that must sign without
 * reaching OutLayer. The PRIMARY production path is {@link OutlayerSigner}.
 * Because both implement the same interface, swapping between them is a config
 * change (`OUTLAYER_SIGNER=local`), never a redesign.
 */
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from 'viem/accounts';
import { SignerProvider, EvmTypedData } from './types';

export class LocalKeySigner implements SignerProvider {
    private readonly account: PrivateKeyAccount;

    constructor(privateKey: `0x${string}`) {
        this.account = privateKeyToAccount(privateKey);
    }

    /** Mint a throwaway key (tests). */
    static generate(): LocalKeySigner {
        return new LocalKeySigner(generatePrivateKey());
    }

    async address(): Promise<`0x${string}`> {
        return this.account.address;
    }

    async signTypedData(typedData: EvmTypedData): Promise<`0x${string}`> {
        // viem re-derives EIP712Domain from `domain`, so an EIP712Domain entry
        // in `types` (if present) is harmless. Cast away the strict generic.
        return this.account.signTypedData(typedData as never);
    }

    async signMessage(message: `0x${string}` | string): Promise<`0x${string}`> {
        // A `0x`-prefixed value is signed as raw bytes (EIP-191 over the bytes);
        // any other string is signed as a UTF-8 personal_sign message.
        if (typeof message === 'string' && message.startsWith('0x')) {
            return this.account.signMessage({ message: { raw: message as `0x${string}` } });
        }
        return this.account.signMessage({ message });
    }

    async signTransaction(tx: Record<string, unknown>): Promise<`0x${string}`> {
        return this.account.signTransaction(tx as never);
    }
}
