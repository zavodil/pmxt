/**
 * NEAR-signature auth for the OutLayer wallet API — a faithful TS port of
 * `ai-intents/api/crates/outlayer/src/signer.rs`.
 *
 * Every request carries `Authorization: Bearer near:<base64url(JSON)>`, where
 * the JSON is `{ account_id, seed, pubkey, timestamp, [vault_id], signature }`
 * and `signature` is the base58 ed25519 signature over the message
 * `auth:<seed>:<ts>` (or `auth:<seed>:<ts>:<vault_id>` when a vault is bound —
 * the vault id MUST be part of the signed bytes, not merely present in the JSON).
 *
 * The `seed` selects a deterministic sub-wallet; build it from an application
 * identifier with {@link NearAuth.seedFor} (`hex(sha256(input))`). The bearer
 * embeds a fresh timestamp + signature, so mint one per request — never cache it.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { base58, base64urlnopad } from '@scure/base';

const ED25519_PREFIX = 'ed25519:';

export class NearAuth {
    private readonly accountId: string;
    private readonly vaultId?: string;
    /** 32-byte ed25519 seed (the secret scalar source). Never logged or returned. */
    private readonly secret: Uint8Array;
    private readonly pubkeyStr: string;

    /**
     * @param accountId        NEAR account id this signer authenticates as.
     * @param nearPrivateKey   `ed25519:<base58>` secret key (NEAR standard
     *                         encoding; 32-byte seed or 64-byte expanded keypair).
     * @param vaultId          Optional sovereign vault id.
     */
    constructor(accountId: string, nearPrivateKey: string, vaultId?: string) {
        if (!nearPrivateKey.startsWith(ED25519_PREFIX)) {
            throw new Error('NEAR private key must start with `ed25519:`');
        }
        const b58 = nearPrivateKey.slice(ED25519_PREFIX.length);
        let keyBytes: Uint8Array;
        try {
            keyBytes = base58.decode(b58);
        } catch (e) {
            throw new Error(`invalid base58 in NEAR private key: ${e instanceof Error ? e.message : String(e)}`);
        }
        // 64-byte form is the expanded keypair; the first 32 bytes are the seed.
        if (keyBytes.length === 64) {
            this.secret = keyBytes.slice(0, 32);
        } else if (keyBytes.length === 32) {
            this.secret = keyBytes;
        } else {
            throw new Error(`unexpected NEAR key length: ${keyBytes.length} bytes (expected 32 or 64)`);
        }
        this.accountId = accountId;
        this.vaultId = vaultId;
        this.pubkeyStr = `${ED25519_PREFIX}${base58.encode(ed25519.getPublicKey(this.secret))}`;
    }

    /** The NEAR account id this signer authenticates as. */
    getAccountId(): string {
        return this.accountId;
    }

    /** The signer's public key, `ed25519:<base58>`. */
    getPublicKey(): string {
        return this.pubkeyStr;
    }

    /**
     * Canonical seed for an application identifier: `hex(sha256(input))`.
     * Deterministic — same input always yields the same sub-wallet.
     */
    static seedFor(input: string): string {
        return bytesToHex(sha256(new TextEncoder().encode(input)));
    }

    /**
     * Build a `near:<base64url>` bearer credential for `seed`, stamped with the
     * current wall clock (or an explicit `ts` for deterministic tests).
     */
    makeBearer(seed: string, ts: number = Math.floor(Date.now() / 1000)): string {
        const payload: Record<string, unknown> = {
            account_id: this.accountId,
            seed,
            pubkey: this.pubkeyStr,
            timestamp: ts,
        };

        // With a vault, the vault id MUST be part of the signed message bytes —
        // not just the JSON — or the coordinator rejects the signature.
        let message: string;
        if (this.vaultId) {
            payload.vault_id = this.vaultId;
            message = `auth:${seed}:${ts}:${this.vaultId}`;
        } else {
            message = `auth:${seed}:${ts}`;
        }

        const signature = ed25519.sign(new TextEncoder().encode(message), this.secret);
        payload.signature = base58.encode(signature);

        const encoded = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)));
        return `near:${encoded}`;
    }

    /** The full `Authorization` header value: `Bearer near:<…>`. */
    authHeader(seed: string, ts?: number): string {
        return `Bearer ${this.makeBearer(seed, ts)}`;
    }
}
