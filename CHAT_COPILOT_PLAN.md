# Prediction-market chat copilot — product + build plan

> "Vibecoding, but for prediction markets." The user chats; an AI **finds markets** and surfaces
> **evidence (data, links, charts)**; the **human decides** and places the bet (USDC, already built).
> Polymarket-first; aggregator-ready. Modeled on the chat-driven shape of `../ai-intents` (RUNNING.md),
> but for *picking a market to bet on* rather than authoring a trading strategy.

**Status:** plan for review. Recommended defaults are marked **[REC]**; open decisions in §10.
**Reuses (already built, unchanged):** `catalog/` (market discovery), pmxt sidecar (market data/quotes/charts),
the OutLayer USDC betting flow ([POLYMARKET_NATIVE_USDC_GUIDE.md](POLYMARKET_NATIVE_USDC_GUIDE.md)).
**New:** a `chat-api` service + a `web-ui`.

---

## 1. Core principle (non-negotiable)

The AI is a **research copilot, not an oracle**. It finds candidates and lays out evidence for and against;
**the human makes the call and clicks bet.** Even in "supportive" mode the agent must surface material
disconfirming facts and never fabricate — money is at stake. (The dial in §5 controls *emphasis/tone*, not
*truthfulness*.)

---

## 2. Interaction model (the conversation)

A loose, tool-driven state machine. The UI is **3 panes**: chat (center), **market sidebar** (right),
**discussion panel** (opens on market select: chart + evidence + bet button). The dial control sits in the header.

1. **EXPLORE** — agent opens: *"В чём ты разбираешься / что тебя интересует?"* User: *"нефтедобыча."*
2. **DISCOVER** — agent calls `discover_markets("нефтедобыча")` → **top-N markets render in the sidebar** →
   *"Вот что нашёл — какой обсудим?"*
   - **No matches** → agent stays in chat, asks a clarifying question / broadens the query, loops. (Never a dead end.)
3. **DISCUSS** — user clicks a market card **and** states a thesis: *"думаю Рынок 1 будет ДА, потому что…"*.
   Agent opens the discussion panel and:
   - pulls the **live quote** + **price-history chart**,
   - gathers **evidence for and against** (web search → links/snippets; market internals),
   - responds **according to the dial** (§5), always citing sources.
4. **DECIDE / BET** — user decides → clicks **Bet** → confirm card (outcome, amount USDC, est. fee) →
   executes via the OutLayer flow. **Human-in-the-loop**: the agent never auto-bets.
5. Loop freely: refine the search, switch markets, ask follow-ups, check positions.

The agent decides *when* to discover vs discuss (tool use); the UI just reflects tool results.

---

## 3. Architecture (reuse the built pieces; add two)

Components (▶ = new):

- **web-ui** ▶ — Next.js. Chat (SSE), market sidebar, discussion panel (chart + evidence + bet), dial,
  wallet login. **[REC]** adapt `../ai-intents/web-ui` (already has wallet login + chat shell).
- **chat-api** ▶ — TypeScript service. The brains: auth, conversation state, the **agent loop + tools**,
  and orchestration of everything below. **[REC]** TS (reuses catalog + the OutLayer betting TS; richest
  LLM-tool ecosystem).
- **catalog** — discovery (`/v1/markets/discover`, `/search`, `/quote`). Built. :8080.
- **pmxt sidecar** — market data: `fetchOHLCV` (charts), `fetchOrderBook`, `fetchTrades`,
  `fetchPositions/fetchBalance`. Built. :3847 (token auth).
- **OutLayer betting** — per-user custody + gasless USDC order placement. Built (pmxt `core/src/integrations/outlayer`).
- **LLM** — OpenAI-compatible; local-claude proxy in dev (:8317). Built/available.
- **web-search** ▶ — evidence provider (news/data for-and-against). **[REC]** Tavily (LLM-friendly); pluggable.
- **Postgres** ▶ — chat-api's store (conversations, messages, bet intents). Separate DB from catalog's.

Data flow (as a list):
- Browser ⇄ **web-ui**
- web-ui ⇄ **chat-api** (SSE chat stream; REST for auth/history/bet-confirm)
- chat-api ⇄ **catalog** (:8080) · **pmxt** (:3847) · **LLM** (:8317) · **web-search** · **OutLayer betting**

Nothing in pmxt core or catalog changes → still upstream-clean.

---

## 4. The agent (LLM loop + tools)

One streaming LLM loop per turn, with tools. Tool → service mapping:

| tool | does | backed by |
|---|---|---|
| `discover_markets(prompt, limit)` | prompt → ranked markets (renders sidebar) | catalog `/v1/markets/discover` |
| `search_markets(q, filters)` | keyword/category/tag search | catalog `/v1/markets/search` |
| `get_market(venue,id)` | catalog detail | catalog `/v1/markets/:venue/:id` |
| `get_quote(venue,id)` | live prices | catalog `/quote` → pmxt |
| `get_price_history(venue,outcomeId,range)` | OHLCV for the chart | pmxt `fetchOHLCV` |
| `get_orderbook(venue,outcomeId)` | depth/spread (sizing) | pmxt `fetchOrderBook` |
| `web_search(query)` | evidence + links for/against | web-search provider |
| `propose_bet(venue,id,outcomeId,amountUSDC)` | build a **bet intent** (NOT execute) → confirm card | chat-api |

- **Streaming (SSE).** Assistant tokens stream; tool calls emit **UI events**: `sidebar.markets`,
  `panel.chart`, `panel.evidence`, `bet.intent`. The frontend renders these into the right panes.
- **Grounding.** The agent must cite (market data + web links) and label confidence. No fabricated numbers.
- **Execution is gated.** `propose_bet` only drafts; the actual order goes through `POST /bets/confirm`
  after a human click (§5 betting).

---

## 5. The critical ↔ supportive dial (1–5)

A per-conversation integer (default **3**), set in the UI, injected into the agent's system prompt:

- **1 — Devil's advocate:** lead with the strongest counterarguments; actively hunt disconfirming
  evidence; stress-test the thesis; quantify downside.
- **2 — Skeptical:** balanced but probes weak points first.
- **3 — Neutral analyst:** even-handed evidence both sides, no lean.
- **4 — Constructive:** helps build the case, still flags key risks.
- **5 — Supportive:** marshals the strongest *honest* case for the user's thesis; finds confirming data and
  framing — **but still surfaces any material risk that could lose money.**

**Hard guardrail at every level:** never hide or fabricate disconfirming facts; the dial changes *emphasis
and ordering*, not the truth. (Product analog of "accuracy over approval.") Show the current setting in the
UI (e.g. "Адвокат дьявола ◄──●──► Болельщик").

---

## 6. Data model (chat-api Postgres)

- `users` (id, wallet_address, chain, created_at) — id doubles as the OutLayer `userId` (→ per-user wallet).
- `conversations` (id, user_id, dial smallint default 3, created_at)
- `messages` (id, conversation_id, role[user|assistant|tool], content, tool_name, tool_payload jsonb, created_at)
- `conversation_markets` (conversation_id, venue, market_id, source[discover|search], added_at) — the sidebar set
- `selected_market` (conversation_id, venue, market_id, thesis text) — current focus + the user's stated view
- `bet_intents` (id, conversation_id, user_id, venue, market_id, outcome_id, amount_usdc, status[draft|confirmed|placed|failed], order_ref, created_at) — audit trail of every bet

---

## 7. API surface (chat-api → web-ui)

- `POST /auth/login` — wallet signature → JWT (reuse ai-intents pattern)
- `POST /conversations` → new; `GET /conversations/:id` → history + sidebar + selected
- `PATCH /conversations/:id` `{dial}` — set 1–5
- `POST /conversations/:id/messages` (**SSE**) `{text}` → agent turn; streams tokens + tool/UI events
- `POST /conversations/:id/select-market` `{venue, marketId, thesis?}`
- `GET /markets/:venue/:outcomeId/chart?range=` — OHLCV passthrough (chart)
- `POST /bets/confirm` `{betIntentId}` — **human-gated** execution via OutLayer USDC flow
- `GET /positions` — user's open positions / balance (pmxt fetchPositions/fetchBalance or OutLayer)

---

## 8. Betting handoff (reuse, human-gated)

`propose_bet` → a `bet_intent` (draft) → confirm card in the discussion panel (outcome, amount, est. fee,
current price). On user click → `POST /bets/confirm` → chat-api calls the OutLayer module with the user's
`userId`: derive wallet → ensure deposit-wallet/approvals → `createOrder({marketId:conditionId, outcomeId,
side, amount})` sigType 3. Funding/withdraw via the native-USDC bridge flow. **The agent never executes a bet
on its own.**

---

## 9. Phasing

- **Phase 1 — MVP (Polymarket-only):** auth; conversation; `discover_markets` → sidebar; select + thesis;
  discuss with live quote + `web_search` evidence + the dial; **bet via USDC (confirm)**. Minimal/no chart.
- **Phase 2 — richer copilot:** `get_price_history` charts; multi-source evidence; conversation
  summary/memory; **positions/P&L** view (fetchPositions/fetchBalance); deposit/withdraw UX in-app.
- **Phase 3 — aggregator:** flip `VENUE_ALLOWLIST` (catalog is venue-uniform); cross-venue same-question
  clustering + **best-price comparison** (pmxt `fetchRelatedMarkets/fetchMatchedPrices/fetchArbitrage`);
  notifications.

---

## 10. Open decisions (need your call — defaults marked [REC])

1. **Frontend base** — **[REC]** fork/adapt `ai-intents/web-ui` (wallet login + chat shell exist) vs new Next.js.
2. **web-search provider** — **[REC]** Tavily; alt: Brave / SerpAPI / Bing / an MCP search tool.
3. **chat-api language** — **[REC]** TypeScript (reuses catalog + OutLayer betting). (Rust possible but would
   reimplement the betting stack — see the earlier discussion.)
4. **Auth/custody** — **[REC]** wallet-login → per-user OutLayer wallet (the USDC flow we built). Confirm
   this is the identity model (vs reusing an ai-intents account).
5. **One app vs two** — keep `chat-api` separate from `catalog`/pmxt (recommended; clean boundaries), or merge
   chat into catalog. **[REC]** separate.

---

## 12. pmxt features to enable for UX (all Polymarket-supported, verified)

Beyond discovery, pmxt already implements these — turn them on as agent tools / UI affordances:

**Must-have (Phase 1–2, cheap, high UX):**
- **Live price streaming** — `watchOrderBook` / `watchTrades` over pmxt `/ws` (websocket.ts). Ticking prices
  in the sidebar + discussion panel; "price moved since you opened" cues. No polling.
- **Price chart** — `fetchOHLCV(outcomeId, {resolution})`. The discussion-panel chart.
- **Order-book depth + spread** — `fetchOrderBook(s)`. Show liquidity + estimated slippage **for the chosen
  bet size** ("$50 moves the price to 0.42").
- **Order preview before betting** — `buildOrder` (signs without submitting). The confirm card shows the
  **exact price, fee, and expected fill** before the human clicks — accuracy at the decision point.
- **Portfolio & P&L** — `fetchPositions` + `fetchBalance` (+ `fetchMyTrades` / `fetchOpenOrders` /
  `fetchClosedOrders`). A "My bets" view: open positions, realized/unrealized P&L, order history.
- **Recent-trades tape** — `fetchTrades` / `watchTrades`. Activity/momentum signal in the discussion panel.

**Strong nice-to-have:**
- **Event / series grouping** — `fetchEvents` / `fetchSeries`. Group sub-markets under an event in the
  sidebar ("2026 election" → all candidates/dates); recurring series (weekly/daily).
- **Rich search & facets** — `fetchMarkets` supports `query` + `searchIn[title|description|category|tags|
  outcomes]` + `tags` + `category` + `sort`. Tag/category quick-filter chips ("Crypto", "Politics",
  "Fed Rates", "Trump") and a "trending by volume" sort / hot-markets tab before the user even types.
- **Related markets / implied / hedge** — `fetchRelatedMarkets` (subset/superset with live prices):
  "markets related to this thesis" + hedge ideas. Partial within Polymarket; shines cross-venue.

**Aggregator (Phase 3, when multi-venue):**
- **Best-price-across-venues** — `compareMarketPrices` (same market, side-by-side best bid/ask → "cheaper on X").
- **Arbitrage / hedge scanner** — `fetchArbitrage` / `fetchHedges` / `fetchEventMatches` (power-user tab).
- **Trending/analytics leaderboards** — `/v0/sql` ClickHouse passthrough (needs a ClickHouse instance).

**New agent tools to add (extends §4):** `get_ohlcv`, `get_orderbook`, `get_trades`, `preview_order`
(buildOrder), `get_positions`; later `get_related_markets`, `compare_prices`, `find_arbitrage`.

---

## 11. First implementation slice (once §10 is settled)

1. `chat-api` skeleton (TS, Fastify): auth + conversations + SSE `/messages` with the agent loop and tools
   `discover_markets`, `get_quote`, `web_search`, `propose_bet`; dial in the system prompt.
2. `web-ui`: chat pane + sidebar (renders `sidebar.markets`) + discussion panel (quote + evidence +
   bet-confirm) + dial control + wallet login.
3. Wire `propose_bet`/`/bets/confirm` to the OutLayer betting module (testnet-sized real bet).
4. Add charts (`get_price_history`) + positions.
