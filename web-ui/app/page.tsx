'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  cancelBet,
  confirmBet,
  createConversation,
  getDetail,
  getOhlcv,
  getWallet,
  listBets,
  login,
  placeBet,
  setAuthToken,
  setDial as apiSetDial,
  streamMessage,
  walletSetup,
  type BetRow,
  type WalletInfo,
} from '../lib/api';
import { loginWithNear } from '../lib/near';
import type { BetIntent, Candle, ChatMsg, MarketDetail, Quote, SidebarMarket } from '../lib/types';

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

function shortId(uid: string): string {
  const addr = uid.includes(':') ? uid.split(':')[1]! : uid;
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function venueLabel(v: string): string {
  if (v === 'polymarket') return 'Polymarket';
  if (v === 'limitless') return 'Limitless';
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/** Attach a non-passive wheel listener that steps the chart timeframe (debounced). */
function useWheelZoom(onZoom: (d: number) => void, redep: number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now - last < 160) return;
      last = now;
      onZoom(e.deltaY < 0 ? -1 : 1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [redep, onZoom]);
  return ref;
}

const DIAL_LABELS: Record<number, string> = {
  1: "Devil's advocate",
  2: 'Skeptic',
  3: 'Neutral',
  4: 'Constructive',
  5: 'Supportive',
};

const SUGGESTIONS = [
  'BTC up or down today', // shows both sources (Polymarket + Limitless)
  'Fed interest rate cut by July',
  'Bitcoin above $150k in 2026',
  'Who will win the Premier League',
];

const QUICK_AMOUNTS = [1, 10, 100];

// Chart timeframes — scroll the chart to move between them (loads more/finer data).
const RANGES = [
  { label: '24h', resolution: '15m', limit: 96 },
  { label: '3d', resolution: '1h', limit: 72 },
  { label: '1w', resolution: '1h', limit: 168 },
  { label: '1mo', resolution: '6h', limit: 120 },
  { label: '3mo', resolution: '1d', limit: 90 },
];
const DEFAULT_RANGE = 1;

export default function Page() {
  const [userId, setUserId] = useState('guest');
  const [dial, setDial] = useState(3);
  const [convId, setConvId] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sidebar, setSidebar] = useState<SidebarMarket[]>([]);
  const [selected, setSelected] = useState<SidebarMarket | null>(null);
  const [attached, setAttached] = useState<SidebarMarket | null>(null);
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selOutcomeId, setSelOutcomeId] = useState<string | null>(null);
  const [rangeIdx, setRangeIdx] = useState(DEFAULT_RANGE);
  const [loadedRangeIdx, setLoadedRangeIdx] = useState(DEFAULT_RANGE);

  const [agentBet, setAgentBet] = useState<BetIntent | null>(null);
  const [betAmount, setBetAmount] = useState(10);
  const [placing, setPlacing] = useState(false);

  const [showBets, setShowBets] = useState(false);
  const [bets, setBets] = useState<BetRow[]>([]);

  const [showWallet, setShowWallet] = useState(false);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [showChart, setShowChart] = useState(false);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);

  const cacheRef = useRef<Map<string, MarketDetail>>(new Map());
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, step, agentBet]);

  // Restore a prior wallet session.
  useEffect(() => {
    const t = localStorage.getItem('pc_token');
    const u = localStorage.getItem('pc_user');
    if (t && u) {
      setAuthToken(t);
      setUserId(u);
    }
  }, []);

  async function connectWallet() {
    const eth = window.ethereum;
    if (!eth) {
      alert('No EVM wallet found. Install MetaMask (NEAR/Solana login coming next).');
      return;
    }
    try {
      const accts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      const addr = accts[0];
      if (!addr) return;
      const message = `Sign in to Prediction Copilot\nAddress: ${addr}\nTime: ${new Date().toISOString()}`;
      const signature = (await eth.request({ method: 'personal_sign', params: [message, addr] })) as string;
      applySession(await login({ chain: 'evm', address: addr, message, signature }));
    } catch (err) {
      alert(`Wallet login failed: ${(err as Error).message}`);
    }
  }

  function applySession(res: { token: string; userId: string }) {
    setAuthToken(res.token);
    setUserId(res.userId);
    localStorage.setItem('pc_token', res.token);
    localStorage.setItem('pc_user', res.userId);
  }

  async function connectNear() {
    try {
      applySession(await loginWithNear());
    } catch (err) {
      alert(`NEAR login failed: ${(err as Error).message}`);
    }
  }

  function disconnect() {
    setAuthToken(null);
    setUserId('guest');
    localStorage.removeItem('pc_token');
    localStorage.removeItem('pc_user');
  }

  // Market detail (metadata + quote) — cached per market.
  useEffect(() => {
    setCandles([]); // clear the previous market's chart on selection change
    if (!selected) {
      setDetail(null);
      setSelOutcomeId(null);
      setDetailLoading(false);
      return;
    }
    setSelOutcomeId(selected.suggestedOutcome?.outcomeId ?? selected.outcomes[0]?.outcomeId ?? null);
    setRangeIdx(DEFAULT_RANGE);
    setLoadedRangeIdx(DEFAULT_RANGE);
    const key = `${selected.venue}:${selected.marketId}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setDetail(cached);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    getDetail(selected.venue, selected.marketId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setDetailLoading(false);
        cacheRef.current.set(key, d);
      })
      .catch(() => !cancelled && setDetailLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Price history — refetches when the market or the chart timeframe (scroll) changes.
  useEffect(() => {
    if (!selected) {
      setCandles([]);
      return;
    }
    const primary = selected.suggestedOutcome?.outcomeId ?? selected.outcomes[0]?.outcomeId;
    if (!primary) {
      setCandles([]);
      return;
    }
    let cancelled = false;
    const r = RANGES[rangeIdx]!;
    getOhlcv(selected.venue, primary, r.resolution, r.limit)
      .then((c) => {
        if (cancelled) return;
        // Keep the last good chart if a longer range has no data (market too young).
        if (c.length >= 2) {
          setCandles(c);
          setLoadedRangeIdx(rangeIdx);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected, rangeIdx]);

  const onZoom = (delta: number) =>
    setRangeIdx((i) => Math.min(RANGES.length - 1, Math.max(0, i + delta)));

  async function ensureConv(): Promise<string> {
    if (convId) return convId;
    const c = await createConversation(userId, dial);
    setConvId(c.id);
    return c.id;
  }

  async function onDial(v: number) {
    setDial(v);
    if (convId) await apiSetDial(userId, convId, v);
  }

  async function send(textArg?: string) {
    const text = (textArg ?? input).trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    setStep('thinking…');
    try {
      const cid = await ensureConv();
      await streamMessage({
        userId,
        convId: cid,
        text,
        selectedMarket: attached
          ? (() => {
              const d = detail && detail.market.marketId === attached.marketId ? detail : null;
              const outcomes = d?.quote?.outcomes
                ? d.quote.outcomes.map((o) => ({ label: o.label, price: o.price }))
                : attached.outcomes.map((o) => ({ label: o.label }));
              return {
                marketId: attached.marketId,
                title: attached.title,
                venue: attached.venue,
                conditionId: d?.market.conditionId,
                status: d?.market.status,
                resolutionDate: d?.market.resolutionDate,
                outcomes,
              };
            })()
          : undefined,
        onEvent: (e) => {
          if (e.type === 'step') setStep(`${labelStep(e.tool)}…`);
          else if (e.type === 'sidebar') setSidebar(e.markets);
          else if (e.type === 'quote') {
            setDetail((d) =>
              d && d.market.marketId === (e.quote as Quote).marketId ? { ...d, quote: e.quote } : d,
            );
          } else if (e.type === 'bet') setAgentBet(e.betIntent);
          else if (e.type === 'message') setMessages((m) => [...m, { role: 'assistant', text: e.text }]);
          else if (e.type === 'error')
            setMessages((m) => [...m, { role: 'assistant', text: `⚠️ ${e.message}` }]);
        },
      });
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', text: `⚠️ ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  const priceById = new Map<string, number | null>(
    (detail?.quote?.outcomes ?? []).map((o) => [o.outcomeId, o.price]),
  );

  async function proceed() {
    if (!selected || !selOutcomeId || placing) return;
    const o = selected.outcomes.find((x) => x.outcomeId === selOutcomeId);
    const price = priceById.get(selOutcomeId);
    const toWin = price && price > 0 ? betAmount / price : null;
    setPlacing(true);
    try {
      const res = await placeBet(userId, {
        venue: selected.venue,
        marketId: selected.marketId,
        marketTitle: selected.title,
        outcomeId: selOutcomeId,
        outcomeLabel: o?.label,
        amountUsdc: betAmount,
        conversationId: convId ?? undefined,
      });
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: `✅ Placed $${betAmount} on "${o?.label}"${toWin != null ? ` — to win **$${toWin.toFixed(2)}**` : ''} _(status: ${res.status}${res.executed === false ? ', dry-run' : ''})_. See **My bets**.`,
        },
      ]);
    } catch (err) {
      const raw = (err as Error).message;
      let msg: string;
      if (userId === 'guest') {
        msg = '⚠️ Connect a wallet first (top-right), then open **Wallet** → Set up + deposit (min $2).';
      } else if (/signer address has to be|API ?KEY/i.test(raw)) {
        msg = `⚠️ Live order blocked by a known Polymarket SDK issue (sigType-3: order signer ↔ API key). This is **not** your wallet or funds.\n\n_${raw}_`;
      } else {
        msg = `⚠️ Couldn't place the bet: ${raw}\n\nTip: open **Wallet** → Set up wallet → deposit native USDC (min $2), then retry.`;
      }
      setMessages((m) => [...m, { role: 'assistant', text: msg }]);
    } finally {
      setPlacing(false);
    }
  }

  async function onConfirmAgentBet() {
    if (!agentBet) return;
    const res = (await confirmBet(userId, agentBet.id)) as { status?: string; note?: string };
    setMessages((m) => [
      ...m,
      {
        role: 'assistant',
        text: `✅ Bet ${agentBet.amountUsdc} USDC on "${agentBet.outcomeLabel ?? agentBet.outcomeId}" — status: ${res.status ?? '?'}.`,
      },
    ]);
    setAgentBet(null);
  }

  async function openBets() {
    setShowBets(true);
    try {
      setBets(await listBets(userId));
    } catch {
      setBets([]);
    }
  }
  async function onCancelBet(id: string) {
    await cancelBet(userId, id);
    setBets(await listBets(userId));
  }

  async function openWallet() {
    setShowWallet(true);
    setWallet(null);
    setWalletBusy(true);
    try {
      setWallet(await getWallet(userId));
    } catch (err) {
      alert(`Wallet error: ${(err as Error).message}`);
    } finally {
      setWalletBusy(false);
    }
  }
  async function onSetupWallet() {
    setWalletBusy(true);
    try {
      await walletSetup(userId);
      setWallet(await getWallet(userId));
    } catch (err) {
      alert(`Setup failed: ${(err as Error).message}`);
    } finally {
      setWalletBusy(false);
    }
  }

  const composer = (
    <div className="composer">
      {selected && (
        <BetBar
          selected={selected}
          detail={detail}
          loading={detailLoading}
          candles={candles}
          priceById={priceById}
          selOutcomeId={selOutcomeId}
          setSelOutcomeId={setSelOutcomeId}
          betAmount={betAmount}
          setBetAmount={setBetAmount}
          placing={placing}
          primaryLabel={selected.suggestedOutcome?.label ?? selected.outcomes[0]?.label ?? ''}
          rangeLabel={RANGES[loadedRangeIdx]!.label}
          onZoom={onZoom}
          onOpenChart={() => setShowChart(true)}
          onProceed={proceed}
          onClose={() => {
            setSelected(null);
            setAttached(null);
          }}
        />
      )}
      {attached && (
        <div className="attachChip">
          <span className="clip">📎</span>
          <span className="atxt">
            Replying about: <b>{attached.title}</b>
          </span>
          <div className="spacer" style={{ flex: 1 }} />
          <button className="atrm" onClick={() => setAttached(null)} title="detach from message">
            remove
          </button>
        </div>
      )}
      <div className="row">
        <textarea
          value={input}
          placeholder={attached ? 'Your thesis on the attached market…' : 'Ask anything, or search markets…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button onClick={() => void send()} disabled={busy}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
      <div className="dial">
        <span>Tone</span>
        <input type="range" min={1} max={5} value={dial} onChange={(e) => onDial(Number(e.target.value))} />
        <b>
          {dial} · {DIAL_LABELS[dial]}
        </b>
      </div>
    </div>
  );

  return (
    <div className="app">
      <header className="header">
        <h1>🎯 Prediction Copilot</h1>
        <div className="spacer" />
        <button className="ghost" onClick={openBets}>
          My bets
        </button>
        {userId !== 'guest' ? (
          <>
            <button className="ghost" onClick={openWallet}>
              Wallet
            </button>
            <span className="wallet" title={userId}>
              {shortId(userId)}
              <span className="x" onClick={disconnect} title="disconnect">
                ✕
              </span>
            </span>
          </>
        ) : (
          <>
            <button className="ghost" onClick={connectNear}>
              Connect NEAR
            </button>
            <button className="ghost" onClick={connectWallet}>
              EVM
            </button>
          </>
        )}
      </header>

      {messages.length === 0 ? (
        <div className="hero">
          <div className="heroBox">
            <h2 className="heroTitle">What do you want to bet on?</h2>
            <p className="heroSub">
              Describe a topic, interest, or thesis — I&apos;ll find prediction markets on Polymarket.
            </p>
            <div className="heroInput">
              <textarea
                value={input}
                placeholder="e.g. Fed rate cut this summer…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button onClick={() => void send()} disabled={busy}>
                {busy ? '…' : 'Send'}
              </button>
            </div>
            <div className="heroDial">
              <div className="dial">
                <span>Tone</span>
                <input type="range" min={1} max={5} value={dial} onChange={(e) => onDial(Number(e.target.value))} />
                <b>
                  {dial} · {DIAL_LABELS[dial]}
                </b>
              </div>
            </div>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => void send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="main">
          <div className="chatCol">
            <div className="messages">
              {messages.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  {m.role === 'assistant' ? (
                    <div className="md">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{ a: ({ node, ...p }) => <a {...p} target="_blank" rel="noreferrer" /> }}
                      >
                        {m.text}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    m.text
                  )}
                </div>
              ))}
              {step && <div className="steps">🔎 {step}</div>}
              {agentBet && (
                <div className="betCard">
                  <div>
                    <b>Draft bet</b> — {agentBet.marketTitle ?? agentBet.marketId}
                  </div>
                  <div className="quote">
                    Outcome: <b>{agentBet.outcomeLabel ?? agentBet.outcomeId}</b> · ${agentBet.amountUsdc}
                  </div>
                  <div className="row">
                    <button onClick={onConfirmAgentBet}>Confirm (dry-run)</button>
                    <span className="quote" onClick={() => setAgentBet(null)} style={{ cursor: 'pointer' }}>
                      dismiss
                    </span>
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
            {composer}
          </div>

          <aside className="sidebar">
            <h2>Markets {sidebar.length ? `(${sidebar.length})` : ''}</h2>
            {sidebar.length === 0 && <div className="empty">Found markets will appear here.</div>}
            {sidebar.map((m) => (
              <div
                key={m.venue + m.marketId}
                className={`card ${selected?.marketId === m.marketId ? 'selected' : ''}`}
                onClick={() => {
                  setSelected(m);
                  setAttached(m);
                }}
              >
                <div className="title">{m.title}</div>
                <div className="meta">
                  <span className={`src ${m.venue}`}>{venueLabel(m.venue)}</span>
                  {m.suggestedOutcome && <span className="pill">→ {m.suggestedOutcome.label}</span>}
                  {typeof m.metrics?.volume24h === 'number' && (
                    <span>vol24h ${Math.round(m.metrics.volume24h).toLocaleString()}</span>
                  )}
                  {typeof m.metrics?.liquidity === 'number' && (
                    <span>liq ${Math.round(m.metrics.liquidity).toLocaleString()}</span>
                  )}
                </div>
                {m.rationale && <div className="why">{m.rationale}</div>}
              </div>
            ))}
          </aside>
        </div>
      )}

      {showBets && <MyBets bets={bets} onCancel={onCancelBet} onClose={() => setShowBets(false)} />}
      {showWallet && (
        <WalletModal
          wallet={wallet}
          busy={walletBusy}
          onSetup={onSetupWallet}
          onRefresh={openWallet}
          onClose={() => setShowWallet(false)}
        />
      )}
      {showChart && selected && candles.length > 1 && (
        <ChartModal
          candles={candles}
          title={`${selected.suggestedOutcome?.label ?? selected.outcomes[0]?.label ?? ''} · ${selected.title}`}
          rangeLabel={RANGES[loadedRangeIdx]!.label}
          onZoom={onZoom}
          onClose={() => setShowChart(false)}
        />
      )}
    </div>
  );
}

function WalletModal({
  wallet,
  busy,
  onSetup,
  onRefresh,
  onClose,
}: {
  wallet: WalletInfo | null;
  busy: boolean;
  onSetup: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const bridgeIn = wallet?.bridgeIn?.evm;
  return (
    <div className="modalBg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHead">
          <b>Wallet</b>
          <div className="spacer" style={{ flex: 1 }} />
          <span className="x" onClick={onClose}>
            ✕
          </span>
        </div>

        {busy && !wallet && (
          <div className="loading">
            <span className="spinner" /> loading…
          </div>
        )}

        {wallet && (
          <>
            <div className="wrow">
              <span className="wlabel">Balance</span>
              <b>${wallet.pusd.toFixed(2)} pUSD</b>
            </div>
            <div className="wrow">
              <span className="wlabel">Status</span>
              {wallet.deployed ? (
                <span className="st placed">ready</span>
              ) : (
                <button className="ghost" onClick={onSetup} disabled={busy}>
                  {busy ? '…' : 'Set up wallet (one-time)'}
                </button>
              )}
            </div>
            <div className="wdep">
              <div className="wlabel">Deposit — send native USDC on Polygon (min ${wallet.minUsd}) to:</div>
              <code className="waddr">{bridgeIn ?? '— (unavailable, retry)'}</code>
            </div>
            <div className="wrow">
              <span className="wlabel">Deposit-wallet</span>
              <code className="waddr small">{wallet.depositWallet}</code>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="ghost" onClick={onRefresh} disabled={busy}>
                Refresh
              </button>
            </div>
            <div className="quote" style={{ marginTop: 8 }}>
              Funds you send are converted to pUSD on your deposit-wallet and used to place bets. Withdraw back to
              NEAR from My bets (sell + bridge).
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BetBar(props: {
  selected: SidebarMarket;
  detail: MarketDetail | null;
  loading: boolean;
  candles: Candle[];
  priceById: Map<string, number | null>;
  selOutcomeId: string | null;
  setSelOutcomeId: (id: string) => void;
  betAmount: number;
  setBetAmount: (n: number) => void;
  placing: boolean;
  primaryLabel: string;
  rangeLabel: string;
  onZoom: (delta: number) => void;
  onOpenChart: () => void;
  onProceed: () => void;
  onClose: () => void;
}) {
  const { selected, detail, loading, candles, priceById, selOutcomeId, betAmount } = props;
  const selLabel = selected.outcomes.find((o) => o.outcomeId === selOutcomeId)?.label ?? '';
  const chartRef = useWheelZoom(props.onZoom, candles.length);
  const [showInfo, setShowInfo] = useState(false);
  return (
    <div className="betbar">
      <div className="betbarHead">
        <span className="clip">📎</span>
        <span className={`src ${selected.venue}`}>{venueLabel(selected.venue)}</span>
        <b className="bt" title={selected.title}>
          {selected.title}
        </b>
        {detail?.market.url && (
          <a href={detail.market.url} target="_blank" rel="noreferrer" title="Open on Polymarket">
            ↗
          </a>
        )}
        <div className="spacer" style={{ flex: 1 }} />
        <span className="x" onClick={props.onClose}>
          ✕
        </span>
      </div>

      {loading ? (
        <div className="loading">
          <span className="spinner" /> loading market…
        </div>
      ) : (
        <>
          {detail?.market && (
            <div className="metaChips">
              {detail.market.status && <span className="mchip">{detail.market.status}</span>}
              {detail.market.category && <span className="mchip">{detail.market.category}</span>}
              {detail.market.resolutionDate && (
                <span className="mchip">ends {new Date(detail.market.resolutionDate).toLocaleDateString()}</span>
              )}
              {typeof detail.market.metrics?.volume24h === 'number' && (
                <span className="mchip">24h ${Math.round(detail.market.metrics.volume24h).toLocaleString()}</span>
              )}
              {typeof detail.market.metrics?.liquidity === 'number' && (
                <span className="mchip">liq ${Math.round(detail.market.metrics.liquidity).toLocaleString()}</span>
              )}
            </div>
          )}

          <div className="betGrid">
            {candles.length > 1 && (
              <div className="betCol chartCol">
                <div className="chartWrap" ref={chartRef}>
                  <div className="chartTitle">
                    <span>
                      {props.primaryLabel ? `${props.primaryLabel} · ` : ''}
                      {props.rangeLabel} ·{' '}
                      <b style={{ color: candles[candles.length - 1]!.close >= candles[0]!.close ? 'var(--green)' : 'var(--red)' }}>
                        {changeLabel(candles)}
                      </b>
                    </span>
                    <span className="enlarge" onClick={props.onOpenChart}>
                      scroll · ⤢
                    </span>
                  </div>
                  <PriceChart candles={candles} height={150} onClick={props.onOpenChart} />
                </div>
              </div>
            )}

            <div className="betCol actionCol">
              <div className="odds">
                {selected.outcomes.map((o) => {
                  const p = priceById.get(o.outcomeId);
                  const on = selOutcomeId === o.outcomeId;
                  return (
                    <div className="oc" key={o.outcomeId}>
                      <button className={`oddsBtn ${on ? 'on' : ''}`} onClick={() => props.setSelOutcomeId(o.outcomeId)}>
                        {p != null ? `${(p * 100).toFixed(0)}%` : '—'}
                      </button>
                      <span className={`ocL ${on ? 'on' : ''}`} title={o.label}>
                        {o.label}
                      </span>
                    </div>
                  );
                })}
              </div>

              {(() => {
                const p = selOutcomeId ? priceById.get(selOutcomeId) : null;
                const win = p != null && p > 0 ? betAmount / p : null;
                return win != null ? (
                  <div className="winline">
                    If <b>{selLabel}</b> wins → <b style={{ color: 'var(--green)' }}>${win.toFixed(2)}</b>
                    <span className="muted">&nbsp; (stake ${betAmount})</span>
                  </div>
                ) : null;
              })()}

              {selected.venue === 'polymarket' ? (
                <div className="betForm">
                  <div className="formDiv">
                    <span>place a bet</span>
                    <button className="info" onClick={() => setShowInfo(true)} title="how betting works">
                      ⓘ
                    </button>
                  </div>
                  <div className="amtRow">
                    <div className="amt">
                      <span>$</span>
                      <input
                        type="number"
                        min={1}
                        value={betAmount}
                        onChange={(e) => props.setBetAmount(Math.max(1, Number(e.target.value)))}
                      />
                    </div>
                    <div className="amtChips">
                      {QUICK_AMOUNTS.map((a) => (
                        <button key={a} className={betAmount === a ? 'on' : ''} onClick={() => props.setBetAmount(a)}>
                          ${a}
                        </button>
                      ))}
                    </div>
                    <button className="proceed" disabled={!selOutcomeId || props.placing} onClick={props.onProceed}>
                      {props.placing ? '…' : `Bid $${betAmount}${selLabel ? ` · ${selLabel}` : ''}`}
                    </button>
                  </div>
                  <div className="hint">Real order needs a funded wallet (min deposit $2, order ≥ $1).</div>
                </div>
              ) : (
                <div className="hint">
                  Betting on {venueLabel(selected.venue)} is coming soon — Polymarket only for now. You can still
                  discuss it in chat.
                </div>
              )}
            </div>
          </div>
          {detail?.market.description && (
            <details className="desc">
              <summary>Details</summary>
              <div>{detail.market.description}</div>
            </details>
          )}
        </>
      )}
      {showInfo && <BetInfoModal onClose={() => setShowInfo(false)} />}
    </div>
  );
}

function BetInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modalBg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <div className="modalHead">
          <b>How your bid is placed</b>
          <div className="spacer" style={{ flex: 1 }} />
          <span className="x" onClick={onClose}>
            ✕
          </span>
        </div>
        <div className="md" style={{ fontSize: 13, lineHeight: 1.6 }}>
          <ul>
            <li>
              <b>Gasless.</b> Your bid is signed by your OutLayer wallet; the Polymarket relayer pays the gas — you
              pay nothing extra.
            </li>
            <li>
              <b>Funds.</b> It buys shares of your chosen outcome using your <b>pUSD</b> balance. Deposit native USDC
              (≥ $2) and it converts to pUSD on your deposit-wallet.
            </li>
            <li>
              <b>Order.</b> Market buy, ~3.5% taker fee, order min ~$1. Your stake buys{' '}
              <i>stake ÷ price</i> shares.
            </li>
            <li>
              <b>Payout.</b> If the outcome wins, each share pays $1 (the “win” amount shown). If it loses, the shares
              are worth $0.
            </li>
            <li>
              <b>After.</b> It appears in <b>My bets</b>; you can withdraw later (sell + bridge back to NEAR).
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function MyBets({
  bets,
  onCancel,
  onClose,
}: {
  bets: BetRow[];
  onCancel: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="modalBg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHead">
          <b>My bets</b>
          <div className="spacer" style={{ flex: 1 }} />
          <span className="x" onClick={onClose}>
            ✕
          </span>
        </div>
        {bets.length === 0 && <div className="empty">No bets yet.</div>}
        {bets.map((b) => (
          <div key={b.id} className="betRowItem">
            <div className="bi">
              <div className="biTitle">{b.outcome_label ?? b.outcome_id.slice(0, 10)}</div>
              <div className="quote">
                ${Number(b.amount_usdc)} · {b.venue} · {b.market_id} · <span className={`st ${b.status}`}>{b.status}</span>
              </div>
            </div>
            {b.status !== 'cancelled' && (
              <button className="ghost" onClick={() => onCancel(b.id)}>
                Cancel
              </button>
            )}
          </div>
        ))}
        <div className="quote" style={{ marginTop: 10 }}>
          Cancel is a dry run. Real flow cancels the open order, or sells the position and withdraws back to NEAR via the
          OutLayer USDC flow.
        </div>
      </div>
    </div>
  );
}

function PriceChart({
  candles,
  height = 150,
  onClick,
}: {
  candles: Candle[];
  height?: number;
  onClick?: () => void;
}) {
  const w = 600;
  const h = height;
  const padL = 8;
  const padR = 34;
  const padT = 14;
  const padB = 16;
  const n = candles.length;
  const xs = candles.map((c) => c.close);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const span = max - min || 0.01;
  const x = (i: number) => padL + (i / (n - 1)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - (v - min) / span) * (h - padT - padB);
  const line = candles.map((c, i) => `${x(i).toFixed(1)},${y(c.close).toFixed(1)}`).join(' ');
  const area = `${x(0).toFixed(1)},${h - padB} ${line} ${x(n - 1).toFixed(1)},${h - padB}`;
  const last = xs[n - 1]!;
  const up = last >= xs[0]!;
  const col = up ? 'var(--green)' : 'var(--red)';
  const gid = `cg-${up ? 'u' : 'd'}`;
  const ly = Math.min(Math.max(y(last) + 3, padT + 8), h - padB - 1);

  const spanMs = candles[n - 1]!.timestamp - candles[0]!.timestamp;
  const useTime = spanMs <= 2 * 86_400_000;
  const fmt = (ts: number) => {
    const d = new Date(ts);
    return useTime
      ? `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const xticks = [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${w} ${h}`}
      onClick={onClick}
      style={{ cursor: onClick ? 'zoom-in' : 'default' }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.22" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* y-axis label */}
      <text x={padL} y={padT - 4} className="cax">probability %</text>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline
        points={line}
        fill="none"
        stroke={col}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={x(n - 1)} cy={y(last)} r={3} fill={col} />
      {/* y scale */}
      <text x={w - padR + 5} y={padT + 4} className="cax">{(max * 100).toFixed(0)}%</text>
      <text x={w - padR + 5} y={h - padB} className="cax">{(min * 100).toFixed(0)}%</text>
      <text x={w - padR + 5} y={ly} className="caxc" fill={col}>{(last * 100).toFixed(0)}%</text>
      {/* x dates */}
      {xticks.map((i, k) => (
        <text
          key={k}
          x={x(i)}
          y={h - 3}
          className="cax"
          textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}
        >
          {fmt(candles[i]!.timestamp)}
        </text>
      ))}
    </svg>
  );
}

function ChartModal({
  candles,
  title,
  rangeLabel,
  onZoom,
  onClose,
}: {
  candles: Candle[];
  title: string;
  rangeLabel: string;
  onZoom: (delta: number) => void;
  onClose: () => void;
}) {
  const chartRef = useWheelZoom(onZoom, candles.length);
  return (
    <div className="modalBg" onClick={onClose}>
      <div className="modal chartModal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHead">
          <b>{title}</b>
          <div className="spacer" style={{ flex: 1 }} />
          <span className="x" onClick={onClose}>
            ✕
          </span>
        </div>
        <div className="quote" style={{ marginBottom: 8 }}>
          Implied probability (%) of this outcome · {rangeLabel} · {changeLabel(candles)} · scroll to zoom
        </div>
        <div ref={chartRef}>
          <PriceChart candles={candles} height={320} />
        </div>
      </div>
    </div>
  );
}

function changeLabel(candles: Candle[]): string {
  const first = candles[0]!.close;
  const last = candles[candles.length - 1]!.close;
  const pct = first ? ((last - first) / first) * 100 : 0;
  const sign = pct >= 0 ? '+' : '';
  return `${(last * 100).toFixed(1)}% (${sign}${pct.toFixed(1)}%)`;
}

function labelStep(tool: string): string {
  switch (tool) {
    case 'discover_markets':
      return 'finding markets';
    case 'search_markets':
      return 'keyword search';
    case 'get_quote':
      return 'checking the price';
    case 'propose_bet':
      return 'preparing the bet';
    default:
      return tool;
  }
}
