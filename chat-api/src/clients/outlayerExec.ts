import { config } from '../config';

// chat-api → pmxt OutLayer surface. Per-user identity rides in `credentials.outlayerUserId`
// (pmxt hashes it to seed = sha256("predict:user:<userId>") — same scheme as ours, so the
// same userId hits the same per-user OutLayer wallet). The NEAR signing key stays in pmxt.

function pmxtHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (config.PMXT_ACCESS_TOKEN) h['x-pmxt-access-token'] = config.PMXT_ACCESS_TOKEN;
  return h;
}

function creds(userId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { outlayerUserId: userId, ...extra };
}

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${config.PMXT_BASE_URL}${path}`, {
    method: 'POST',
    headers: pmxtHeaders(),
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => null)) as { success?: boolean; data?: unknown; error?: unknown } | null;
  if (!r.ok || (j && j.success === false)) {
    throw new Error(`pmxt ${path} -> ${r.status} ${JSON.stringify(j?.error ?? j).slice(0, 300)}`);
  }
  return j?.data ?? j;
}

export interface ClobCreds {
  funderAddress: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

const clobCache = new Map<string, ClobCreds>();

export async function deriveApiKey(userId: string): Promise<ClobCreds> {
  const d = await post('/outlayer/derive-api-key', { credentials: creds(userId) });
  return { funderAddress: d.funderAddress, apiKey: d.apiKey, apiSecret: d.apiSecret, passphrase: d.passphrase };
}

export async function ensureClob(userId: string, forceRefresh = false): Promise<ClobCreds> {
  let c = forceRefresh ? undefined : clobCache.get(userId);
  if (!c) {
    c = await deriveApiKey(userId);
    clobCache.set(userId, c);
  }
  return c;
}

/** Drop cached CLOB creds for a user (e.g. after a signer/API-key mismatch). */
export function forgetClob(userId: string): void {
  clobCache.delete(userId);
}

export interface DepositInfo {
  depositWallet: string;
  bridgeIn: { evm?: string; svm?: string; tron?: string; btc?: string } | null;
  minUsd: number;
}
export async function depositAddress(userId: string): Promise<DepositInfo> {
  return post('/outlayer/deposit-address', { credentials: creds(userId) });
}

export interface BalanceInfo {
  depositWallet: string;
  pusd: number;
  pusdRaw: string;
  deployed: boolean;
}
export async function balance(userId: string): Promise<BalanceInfo> {
  return post('/outlayer/balance', { credentials: creds(userId) });
}

export async function setup(userId: string): Promise<unknown> {
  return post('/outlayer/setup', { credentials: creds(userId) });
}

export interface OrderInput {
  marketId: string;
  outcomeId: string;
  side: string;
  amount: number;
}
async function postCreateOrder(userId: string, clob: ClobCreds, order: OrderInput): Promise<{ ok: boolean; status: number; body: string; data: unknown }> {
  const body = {
    credentials: creds(userId, {
      funderAddress: clob.funderAddress,
      signatureType: 3,
      apiKey: clob.apiKey,
      apiSecret: clob.apiSecret,
      passphrase: clob.passphrase,
    }),
    args: [{ marketId: order.marketId, outcomeId: order.outcomeId, side: order.side, type: 'market', amount: order.amount }],
  };
  const r = await fetch(`${config.PMXT_BASE_URL}/api/polymarket/createOrder`, {
    method: 'POST',
    headers: pmxtHeaders(),
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => null)) as { success?: boolean; data?: unknown; error?: unknown } | null;
  const ok = r.ok && !(j && j.success === false);
  return { ok, status: r.status, body: JSON.stringify(j?.error ?? j).slice(0, 400), data: j?.data ?? j };
}

// CLOB error returned when the API-key owner != the order's signer. A stale
// (wrong-identity) cached/persisted key triggers this; drop it and re-derive.
const SIGNER_MISMATCH = /order signer address has to be the address of the API KEY/i;

export async function placeOrder(userId: string, clob: ClobCreds, order: OrderInput): Promise<any> {
  let res = await postCreateOrder(userId, clob, order);
  if (!res.ok && SIGNER_MISMATCH.test(res.body)) {
    // Stale/wrong-identity API key — forget it, re-derive (deposit-wallet-bound), retry once.
    forgetClob(userId);
    const fresh = await ensureClob(userId, true);
    res = await postCreateOrder(userId, fresh, order);
  }
  if (!res.ok) {
    throw new Error(`createOrder -> ${res.status} ${res.body}`);
  }
  return res.data;
}
