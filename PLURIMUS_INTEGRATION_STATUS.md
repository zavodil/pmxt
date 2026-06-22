# Plurimus × pmxt — integration status / handoff

Status of wiring the **Plurimus** SPA (`~/Developer/plurimus`, repo `zavodil/plurimus`,
branch `main`) onto **our backend** (`pmxt`: `core` + `catalog` + `chat-api`, branch
`feat/agent-web-research-tiers`). Continue from this doc.

Last updated: 2026-06-22.

---

## 0. Architecture (how it fits together)

```
Plurimus SPA (Vite :5173)
  ├─ catalog  :8081  — market browse / search / discover / detail metadata
  └─ chat-api :8090  — streaming agent (SSE), auth/JWT, wallet, bets, positions
                         └─ core (pmxt sidecar) :3847 — OutLayer custody + Polymarket CLOB
                              catalog DB (pgvector) :5455
```

- **Login**: NEAR (NEP-413) or EVM (`personal_sign`) → `chat-api /auth/login` → JWT. `userId` =
  `near:<acct>` / `evm:0x…`, the OutLayer derivation root.
- **Custody**: per-user OutLayer wallet, deterministic from `userId` + the app NEAR key
  (`OUTLAYER_ACCOUNT_ID`/`OUTLAYER_NEAR_PRIVATE_KEY`). EOA → CREATE2 sigType-3 **deposit-wallet**
  (holds pUSD, trades on Polymarket). Addresses are re-derived, never stored. See
  `POLYMARKET_NATIVE_USDC_GUIDE.md`.
- **Money path** (all proven this session): deposit (NEAR `ft_transfer_call` → OutLayer intents)
  → move (intents → bridgeIn → Polymarket → pUSD) → buy order → position → sell.

We **standardized on Plurimus** as the frontend; our old `web-ui` is retired (kept as reference).

---

## 1. Screens / flows DONE ✅

### Auth & shell
- **EVM login** added (NEAR already existed); shared session (`setSession`/`restoreSession`/`clearSession`).
- **TopBar**: balance pill (trading pUSD + internal USDC), **plan control shows the real tier**
  ("Premium"); removed the duplicate tier badge. **Left NavRail**: added **Wallet** + **Bets** buttons.
  A TopBar was added to the pre-chat home so balance/wallet are reachable before chatting.
- **Order gating**: live order buttons require sign-in + a deployed deposit-wallet, else route to
  Sign-in / Set-up.

### Funding (FundModal)
- **NEAR-aware**: in-app **`ft_transfer_call` deposit** (port of ai-intents `depositFtToIntents`:
  `storage_deposit` if needed → `ft_transfer_call(intents.near, msg=custody)`) — no OutLayer redirect.
- **One internal balance + per-venue trading balances**, modular venue registry
  (`src/lib/venues.ts`, only Polymarket wired; Kalshi etc. plug in by adding an array entry).
- **Move to Polymarket**: amount capped at balance + Max; **Move** button; cross-chain withdraw
  tolerates the slow bridge (`status:processing`, 150s timeout). **Refresh** button.
- De-branded copy: "Balance" / "USDC" (not "OutLayer …").

### Trading
- Orders route through **`chat-api /v1/bets`** (sigType-3, EOA-bound apiKey — the proven PHASE2
  path); dropped Plurimus's separate `:3010` trading-core. Graceful error messages.
- **Bets tab rewritten** for our model: shows the signed-in user's **real positions** (from
  `/v1/positions`, enriched with market title/url) with **Sell** (market exit before resolution),
  PnL, entry→now price. Old "paste a Polymarket wallet" flow removed. Moved to the **left nav**.
- **Market detail**: inline **"Your position"** card + **Sell** + **Refresh**; **deep-links**
  (`#/market/<venue:id>`) now open a market directly on load.

### Chat / discovery
- **Attach market to chat** (📎) on cards/detail → agent receives `selectedMarket`.
- Right-rail UX: order **markets → chat → input**, attach chip + toasts to top, **results modal**
  for the full market list, **persistent collapsible** markets panel.
- Agent **broadens discovery** on ≤3 results (semantic search is off — see §4).

### Backend features added (chat-api / core)
- `web_research` agent tool (native WebSearch via a `-search` model) + **per-tier toolsets**
  (`agent/tiers.ts`; everyone Premium for now); plan-aware system prompt; `GET /v1/me`.
- `GET /v1/positions`, `POST /v1/bets/sell`, `GET /v1/wallet/intents-balance`,
  `POST /v1/wallet/deposit-target`, `POST /v1/wallet/fund-trading`.
- **Wallet-recovery backup** (`BACKUP_WALLETS=true`): append-only JSONL index of `userId`/seed/
  addresses (gitignored). Empty-JSON-body tolerance on bodyless POSTs.
- Pulled upstream fixes (PR #1: Gamma 422, search ranking, agent robustness) + Limitless fee fix.

### Build
- **Buffer/global polyfill** for Vite (`@near-js/transactions` needs `Buffer`; Next.js polyfills it,
  Vite doesn't).

---

## 2. Plurimus screens / areas TO DO ⬜

Ordered roughly by importance.

1. **Withdraw / cash-out home** (pUSD → NEAR). The exit leg of the money path
   (`POLYMARKET_NATIVE_USDC_GUIDE.md §10`) is **not wired**: a user can deposit, move, buy, and
   **sell** back to pUSD, but cannot withdraw pUSD → native USDC → NEAR intents. `core` has the
   primitives (`client.withdraw`, the bridge `/withdraw`); needs a `chat-api` endpoint + UI.
2. **SettingsTab** — still mostly the original Plurimus (theme + notification prefs; shows the real
   plan now). Needs: sign-out, account/wallet info (deposit-wallet address, NEAR account), and to
   drop any "paste a Polymarket wallet" remnants.
3. **UpgradeModal / tiers** — the upgrade control opens a generic modal. Either implement real plan
   management/billing or make it a "you're on Premium" info panel. `tierFor()` in `agent/tiers.ts`
   is hardcoded to `premium` — wire a real per-user tier source (DB/billing) when plans go live.
4. **WatchlistTab** — verify it uses live catalog data (not mock `data/markets.ts`); the watchlist
   is local-only (`watchedIds`), no persistence.
5. **History / P&L view** — no closed-positions / realized-P&L history. Positions show only *open*
   holdings. (`/v1/bets` still records attempts but the UI dropped that list as noisy.)
6. **More venues** — `venues.ts` + the agent are Polymarket-only for trading. **Limitless** is
   discovered by the agent but betting is Polymarket-only; **Kalshi** etc. are placeholders. Each
   needs its own backend (balance/move/order/positions) + a `venues.ts` entry.
7. **SearchModal / CommandPalette / OnboardingFlow / Landing / NotificationsPanel** — audit for
   mock data / stale "Voulai"-style copy and old `:3010` assumptions.
8. **Dead `:3010` code cleanup** — `lib/api.ts` still has `postCoreJson`/`fundAccount`/`deriveAccount`/
   `cashoutPosition` hitting the abandoned Next trading-core (harmless ECONNREFUSED). Prune once the
   wallet/positions flows fully replace them.
9. **`.env.local` / config** — Plurimus needs `VITE_CATALOG_URL=:8081`, `VITE_CHATAPI_URL=:8090`
   (documented; not committed). Catalog ports moved 8080→8081, DB 5432→5455 (PR #1) — keep local
   `.env`s aligned.

---

## 3. Backend endpoints (reference)

chat-api (`:8090`):
`POST /auth/login` · `GET /v1/me` · `POST /v1/conversations` (+ SSE messages) ·
`GET /v1/wallet` · `POST /v1/wallet/setup` · `POST /v1/wallet/deposit-target` ·
`POST /v1/wallet/fund-trading` · `GET /v1/wallet/intents-balance` ·
`POST /v1/bets` · `GET /v1/bets` · `POST /v1/bets/sell` · `GET /v1/positions`

core (`:3847`, OutLayer surface): `/outlayer/{address,derive-api-key,deposit-target,deposit-address,
balance,intents-balance,setup,fund-trading,fund-link(removed)}` + the `/api/polymarket/*` dispatcher
(`createOrder`, `fetchPositions`, …).

---

## 4. Caveats / pending validation ⚠️

- **Live order path WORKS** — a real $2 buy was placed (status `placed`, real `order_ref`), funds
  moved, and it became an on-chain position. The earlier sigType-3 "signer ↔ API key" was misdiagnosed;
  fix A was **reverted** — the apiKey stays **EOA-bound** (matches PHASE2). The kept change: the
  derive path returns the real CREATE2 deposit-wallet as funder.
- **Sell not yet executed live** — endpoint + UI are wired; SELL `amount` = **share count** (guide §9).
  Confirm against a real exit.
- **"wallet not registered"** on setup was a **transient** Polymarket-relayer state during first
  deploy; the wallet is deployed and setup is idempotent now.
- **Semantic search is OFF** (`EMBEDDINGS_PROVIDER=none`, 0/94k embedded) — discovery is keyword-only;
  niche single words under-match. Real lever: configure an embedding provider + backfill ~94k markets.
- **Custody root backup** — `OUTLAYER_NEAR_PRIVATE_KEY` + `OUTLAYER_ACCOUNT_ID` (`fastjambo.near`) is
  the "lose it = lose funds" secret; back up offline. `BACKUP_WALLETS=true` writes the per-user index.
- **Everyone is Premium** (`tierFor` hardcoded). **web_research** model = `claude-opus-4-5-search`
  (configurable via `AI_SEARCH_MODEL`).

---

## 5. Where things live

- **pmxt** (backend): branch `feat/agent-web-research-tiers` (pushed to `origin`/`zavodil/pmxt`).
  Money-path + agent + positions work is here. `main` = stable (PR #1 merged).
- **plurimus** (frontend): branch `main` (pushed to `zavodil/plurimus`).
- Local stack: `core :3847`, `catalog :8081` (DB `:5455`, docker), `chat-api :8090`, SPA `:5173`.
