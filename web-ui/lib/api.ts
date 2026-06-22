import type { AgentEvent, Candle, MarketDetail } from './types';

const BASE = process.env.NEXT_PUBLIC_CHATAPI_URL || 'http://localhost:8090';

let authToken: string | null = null;
export function setAuthToken(t: string | null): void {
  authToken = t;
}

function headers(userId: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', 'x-user-id': userId };
  if (authToken) h.authorization = `Bearer ${authToken}`;
  return h;
}

export interface LoginBody {
  chain: string;
  address: string;
  message: string;
  signature: string;
  publicKey?: string;
  nonce?: string;
  recipient?: string;
}

export async function login(body: LoginBody): Promise<{ token: string; userId: string }> {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || `login ${r.status}`);
  return r.json();
}

export async function createConversation(userId: string, dial: number): Promise<{ id: string; dial: number }> {
  const r = await fetch(`${BASE}/v1/conversations`, {
    method: 'POST',
    headers: headers(userId),
    body: JSON.stringify({ dial }),
  });
  if (!r.ok) throw new Error(`createConversation ${r.status}`);
  return r.json();
}

export async function setDial(userId: string, convId: string, dial: number): Promise<void> {
  await fetch(`${BASE}/v1/conversations/${convId}`, {
    method: 'PATCH',
    headers: headers(userId),
    body: JSON.stringify({ dial }),
  });
}

export async function getDetail(venue: string, marketId: string): Promise<MarketDetail> {
  const r = await fetch(`${BASE}/v1/markets/${encodeURIComponent(venue)}/${encodeURIComponent(marketId)}/detail`);
  if (!r.ok) throw new Error(`getDetail ${r.status}`);
  return r.json();
}

export async function getOhlcv(
  venue: string,
  outcomeId: string,
  resolution = '1h',
  limit = 72,
): Promise<Candle[]> {
  const qs = new URLSearchParams({ resolution, limit: String(limit) });
  const r = await fetch(
    `${BASE}/v1/markets/${encodeURIComponent(venue)}/${encodeURIComponent(outcomeId)}/ohlcv?${qs}`,
  );
  if (!r.ok) return [];
  const data = (await r.json()) as { candles?: Candle[] };
  return data.candles ?? [];
}

export async function confirmBet(userId: string, betIntentId: string): Promise<unknown> {
  const r = await fetch(`${BASE}/v1/bets/confirm`, {
    method: 'POST',
    headers: headers(userId),
    body: JSON.stringify({ betIntentId }),
  });
  return r.json();
}

export interface PlaceBetBody {
  venue: string;
  marketId: string;
  marketTitle?: string;
  outcomeId: string;
  outcomeLabel?: string;
  amountUsdc: number;
  conversationId?: string;
}

export async function placeBet(
  userId: string,
  body: PlaceBetBody,
): Promise<{ id: string; status: string; executed?: boolean; note?: string }> {
  const r = await fetch(`${BASE}/v1/bets`, { method: 'POST', headers: headers(userId), body: JSON.stringify(body) });
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `placeBet ${r.status}`);
  return j as { id: string; status: string; executed?: boolean; note?: string };
}

export interface BetRow {
  id: string;
  venue: string;
  market_id: string;
  outcome_id: string;
  outcome_label: string | null;
  amount_usdc: number;
  status: string;
  created_at: string;
}

export async function listBets(userId: string): Promise<BetRow[]> {
  const r = await fetch(`${BASE}/v1/bets`, { headers: headers(userId) });
  if (!r.ok) throw new Error(`listBets ${r.status}`);
  const data = (await r.json()) as { bets?: BetRow[] };
  return data.bets ?? [];
}

export async function cancelBet(userId: string, id: string): Promise<unknown> {
  const r = await fetch(`${BASE}/v1/bets/${id}/cancel`, { method: 'POST', headers: headers(userId) });
  return r.json();
}

export interface WalletInfo {
  depositWallet: string;
  bridgeIn: { evm?: string; svm?: string; tron?: string; btc?: string } | null;
  minUsd: number;
  pusd: number;
  deployed: boolean;
}

export async function getWallet(userId: string): Promise<WalletInfo> {
  const r = await fetch(`${BASE}/v1/wallet`, { headers: headers(userId) });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || `getWallet ${r.status}`);
  return r.json();
}

export async function walletSetup(userId: string): Promise<unknown> {
  const r = await fetch(`${BASE}/v1/wallet/setup`, { method: 'POST', headers: headers(userId) });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || `walletSetup ${r.status}`);
  return r.json();
}

export async function streamMessage(opts: {
  userId: string;
  convId: string;
  text: string;
  selectedMarket?: {
    marketId: string;
    title?: string;
    venue?: string;
    conditionId?: string;
    status?: string;
    resolutionDate?: string;
    outcomes?: { label: string; price?: number | null }[];
  };
  onEvent: (e: AgentEvent) => void;
}): Promise<void> {
  const r = await fetch(`${BASE}/v1/conversations/${opts.convId}/messages`, {
    method: 'POST',
    headers: headers(opts.userId),
    body: JSON.stringify({ text: opts.text, selectedMarket: opts.selectedMarket }),
  });
  if (!r.ok || !r.body) throw new Error(`streamMessage ${r.status}`);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      try {
        opts.onEvent(JSON.parse(dataLine.slice(5).trim()) as AgentEvent);
      } catch {
        /* ignore malformed */
      }
    }
  }
}
