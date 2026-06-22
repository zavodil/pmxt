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

export async function ensureClob(userId: string): Promise<ClobCreds> {
  let c = clobCache.get(userId);
  if (!c) {
    c = await deriveApiKey(userId);
    clobCache.set(userId, c);
  }
  return c;
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

// STEP 2 of the funding money-path: move the user's OutLayer intents USDC to the
// Polymarket bridge-in address; Polymarket swaps+wraps it into pUSD in the deposit
// wallet. `amountMinimal` is USDC in 6-dp minimal units (integer string). dryRun
// previews fee/feasibility without moving funds.
export async function fundTrading(userId: string, amountMinimal: string, dryRun = false): Promise<any> {
  return post('/outlayer/fund-trading', { credentials: creds(userId), amountMinimal, dryRun });
}

// STEP 1 funding target for the in-app NEAR deposit: the user's OutLayer custody
// NEAR account (credited by intents.near) + the native NEAR USDC token contract.
// The frontend signs `ft_transfer_call` to intents.near itself — no redirect.
export interface DepositTargetInfo {
  account: string;
  token: string;
}
export async function depositTarget(userId: string): Promise<DepositTargetInfo> {
  const d = await post('/outlayer/deposit-target', { credentials: creds(userId) });
  return { account: d.account, token: d.token };
}

export interface OrderInput {
  marketId: string;
  outcomeId: string;
  side: string;
  amount: number;
}
export async function placeOrder(userId: string, clob: ClobCreds, order: OrderInput): Promise<any> {
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
  if (!r.ok || (j && j.success === false)) {
    throw new Error(`createOrder -> ${r.status} ${JSON.stringify(j?.error ?? j).slice(0, 400)}`);
  }
  return j?.data ?? j;
}
