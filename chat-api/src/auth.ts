import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import bs58 from 'bs58';
import { SignJWT, jwtVerify } from 'jose';
import { verifyMessage } from 'viem';
import { config } from './config';

const secret = new TextEncoder().encode(config.JWT_SECRET);

export const NEAR_LOGIN_RECIPIENT = 'prediction-copilot';
const NEAR_RPC_URL = 'https://rpc.mainnet.near.org';
const NEP413_TAG = 2147484061; // 2^31 + 413

export async function issueJwt(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

export async function verifyJwt(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export interface LoginInput {
  chain: string;
  address: string;
  message: string;
  signature: string;
  publicKey?: string;
  nonce?: string;
  recipient?: string;
}

/**
 * Verify a wallet-signature login and return the canonical userId, which becomes
 * the OutLayer derivation root (seed = sha256("predict:user:<userId>")) — so each
 * wallet gets its own per-user OutLayer wallet. Mirrors ai-intents.
 */
export async function verifyLogin(i: LoginInput): Promise<string | null> {
  const c = i.chain.trim().toLowerCase();

  if (c === 'evm' || c === 'ethereum' || c === 'eth' || c.startsWith('eip155:')) {
    try {
      const ok = await verifyMessage({
        address: i.address as `0x${string}`,
        message: i.message,
        signature: i.signature as `0x${string}`,
      });
      return ok ? `evm:${i.address.toLowerCase()}` : null;
    } catch {
      return null;
    }
  }

  if (c === 'near') {
    if (!i.publicKey || !i.nonce) return null;
    const recipient = i.recipient ?? NEAR_LOGIN_RECIPIENT;
    if (!verifyNep413(i.publicKey, i.message, i.signature, i.nonce, recipient, null)) return null;
    // Controlling the key ≠ owning the account — confirm it's an access key on-chain.
    const ok = await accountKeyExists(i.address.trim(), canonicalKey(i.publicKey));
    return ok ? `near:${i.address.trim()}` : null;
  }

  // TODO: 'solana' (ed25519 over raw message).
  return null;
}

/** Resolve the caller's userId: JWT bearer (authoritative) → x-user-id (dev) → 'guest'. */
export async function resolveUserId(req: FastifyRequest): Promise<string> {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const sub = await verifyJwt(auth.slice(7));
    if (sub) return sub;
  }
  const x = req.headers['x-user-id'];
  return typeof x === 'string' && x.trim() ? x : 'guest';
}

// ---- NEP-413 ----------------------------------------------------------------

function canonicalKey(publicKey: string): string {
  const b58 = publicKey.trim().replace(/^ed25519:/, '');
  return `ed25519:${b58}`;
}

function borshString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

function nep413Borsh(message: string, nonce: Buffer, recipient: string, callbackUrl: string | null): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG, 0);
  const cb =
    callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]);
  return Buffer.concat([tag, borshString(message), nonce, borshString(recipient), cb]);
}

function ed25519PubFromRaw(raw: Buffer) {
  // SPKI DER header for Ed25519 + the 32 raw key bytes.
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function verifyNep413(
  publicKey: string,
  message: string,
  signatureB64: string,
  nonceB64: string,
  recipient: string,
  callbackUrl: string | null,
): boolean {
  try {
    const raw = Buffer.from(bs58.decode(publicKey.trim().replace(/^ed25519:/, '')));
    if (raw.length !== 32) return false;
    const sig = Buffer.from(signatureB64, 'base64');
    if (sig.length !== 64) return false;
    const nonce = Buffer.from(nonceB64, 'base64');
    if (nonce.length !== 32) return false;
    const hash = createHash('sha256').update(nep413Borsh(message, nonce, recipient, callbackUrl)).digest();
    return edVerify(null, hash, ed25519PubFromRaw(raw), sig);
  } catch {
    return false;
  }
}

async function accountKeyExists(accountId: string, publicKey: string): Promise<boolean> {
  if (!accountId) return false;
  try {
    const r = await fetch(NEAR_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'query',
        params: {
          request_type: 'view_access_key',
          finality: 'final',
          account_id: accountId,
          public_key: publicKey,
        },
      }),
    });
    const j = (await r.json()) as { error?: unknown; result?: { error?: string; permission?: unknown } };
    // Present + no error → the key is an access key of the account.
    return Boolean(j.result && j.result.error === undefined && j.result.permission !== undefined);
  } catch {
    return false;
  }
}
