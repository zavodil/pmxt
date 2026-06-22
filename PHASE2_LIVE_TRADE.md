# Phase 2 — Live gasless trade, end-to-end (record)

> **What this is.** A full, real-money, **gasless** OutLayer-custody → Polymarket V2 bet, executed
> end-to-end on Polygon mainnet on 2026-06-15. Every signature came from **OutLayer**; every gas
> fee was paid by the **Polymarket builder relayer**. No raw transaction, no POL on any wallet.
>
> **Outcome of the bet:** LOST (we bet BTC DOWN on a 5-min window; BTC went up). The money outcome is
> irrelevant — 5-min direction is a coin-flip with no edge. **The point was to validate the system,
> and the entire pipeline worked.** Cost of the live test: ~$1.91.
>
> Companion docs: [PHASE0_FINDINGS.md](PHASE0_FINDINGS.md) (research), [OUTLAYER_INTEGRATION_PLAN.md](OUTLAYER_INTEGRATION_PLAN.md) (plan).

> **Canonical procedure → [POLYMARKET_NATIVE_USDC_GUIDE.md](POLYMARKET_NATIVE_USDC_GUIDE.md).** This file
> is a dated **live-run record**, not the how-to. The first entry run used a self-contained
> **native↔USDC.e swap** (table steps 5–6); that swap path is now a **backup only** →
> [BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md). The **production flow is native USDC via the
> Polymarket bridge services** (no swap on our side) — see §5c / §5d.

---

## 1. The proven flow (each step gasless)

| # | Step | Mechanism | Gas paid by |
|---|------|-----------|-------------|
| 1 | Fund NEAR intents | user sends USDC to the wallet's intents balance (1Click `dest=intents`) | — |
| 2 | Bridge intents → Polygon | `POST /wallet/v1/intents/withdraw {chain:"polygon"}` (1Click) | 1Click solver |
| 3 | Deploy deposit-wallet | relayer `POST /submit {type:"WALLET-CREATE", from:EOA}` (no signature) | **builder relayer** |
| 4 | Consolidate USDC onto deposit-wallet | **EIP-3009** `transferWithAuthorization` (OutLayer signs) in a relayer deposit-wallet batch | **builder relayer** |
| 5 | Swap native USDC → USDC.e | Uniswap V3 `exactInputSingle` (fee-100 pool) in a relayer batch | **builder relayer** |
| 6 | Wrap USDC.e → pUSD | `CollateralOnramp.wrap()` in a relayer batch | **builder relayer** |
| 7 | Approvals (pUSD→Exchanges, CTF setApprovalForAll) | relayer batch | **builder relayer** |
| 8 | Place order | off-chain **EIP-712 order** (sigType 3 / ERC-7739, OutLayer signs) → `POST /order` (FOK) | none (off-chain); operator settles |

All signing = OutLayer (`sign-typed-data`). All on-chain execution = the builder relayer (`RelayClient.executeDepositWalletBatch` / `deployDepositWallet`) authenticated with **Builder HMAC** creds. The deposit-wallet executes batches only on its **owner's** EIP-712 signature (OutLayer), so the app can sponsor gas but **cannot move an agent's funds**.

### The actual live run
- Bet: `btc-updown-5m-1781544900` ("Bitcoin Up or Down — 1:35–1:40 PM ET"), market **BUY DOWN $1.91** → **FILLED 3.82 shares** (order id `0x1fff45098c72ebb5ac414778a6d9f16e37b1fe7f038231a7aff20d816a1702f2`).
- Resolution (on-chain CTF `payoutDenominator=1`, `Up=1 / Down=0`): **UP won → bet lost.** 3.82 DOWN shares → $0; ~0.011 pUSD dust remains on the deposit-wallet.

---

## 2. Addresses used (this run)

**Agent wallet (the per-user trading identity):**
- Funding wallet: OutLayer `wk_` wallet (registered via `POST /register`), NEAR account `7fdbc07b248012d36b06231ec6d5c909ed9a802be22123813c9bd2207eafab11`.
- Derived **EOA (owner / signer)**: `0x791c61B3c693dF9380e4eFe8Bc25Dd763D67d1Ef`
- **Deposit-wallet (funder, sigType 3)**: `0x56164B27FaA2E738747cE9D4951415cF69844550` (CREATE2 from the EOA; UUPS clone via factory).

**App-level identities (shared across all agents):**
- OutLayer app NEAR key: `fastjambo.near` (for the deterministic `Bearer near:` per-user model). Stored in `core/.env`.
- Polymarket **Builder "Outlayer"**: address `0xda68b3aed1c23bef43751e2d6413f3049d29db31`, code `0xfbfbc047be037f1638f96de48eac65f9b973fecd36bae53348bd1a318264b5a5`, HMAC creds in `core/.env`. **This is what sponsors gas + attributes builder fees for every agent.**
- Relayer: `https://relayer-v2.polymarket.com`. (NOTE: the personal **Relayer API key** `019ecbfd…`/owner `0x8EF0e73a…` was NOT usable — it forces `from == key-owner`; we use **Builder HMAC** instead, which sponsors arbitrary `from`.)

**Polygon contracts (chainId 137, all Polygonscan-verified):**
- CollateralOnramp (permissionless, USDC.e→pUSD): `0x93070a847efEf7F70739046A929D47a521F5B8ee` — ⚠️ **native USDC is `paused`; only USDC.e wraps here.**
- pUSD (collateral): `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- CTF Exchange V2 (standard): `0xE111180000d2663C0091e4f400237545B87B996B`
- Neg-Risk CTF Exchange V2: `0xe2222d279d744050d28e00520010520000310F59`
- Neg-Risk Adapter: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`
- ConditionalTokens (CTF, ERC-1155): `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
- Native Circle USDC: `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359`
- Bridged USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- Uniswap V3 SwapRouter02: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` (USDC/USDC.e **fee-100** pool, deep, ~1:1)
- Deposit-Wallet Factory: `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` (impl `0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB`)

(Also in code: `core/src/integrations/outlayer/polymarket-v2-contracts.ts`.)

---

## 3. Gotchas discovered live (the load-bearing ones)

1. **Bridge delivers NATIVE USDC; Polymarket's permissionless onramp wraps only USDC.e** (`CollateralOnramp` has native `paused`). **Resolution (production):** use Polymarket's **`/deposit` + `/withdraw` bridge services**, which accept/return **native USDC** and do the USDC.e swap + wrap/unwrap **internally** — no swap on our side (§5c/§5d). Doing the swap yourself on-chain is the **backup** path → [BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md).
2. **Builder HMAC auth sponsors arbitrary `from`** (the multi-tenant unlock — see §4). The personal *Relayer API key* does not (binds `from == owner`).
3. **`OutlayerClient` must serialize BigInt typed-data as decimal strings** — the relayer SDK builds EIP-712 with BigInt uint256; plain `JSON.stringify` throws. Fixed in `outlayer-client.ts` (`transformRequest`).
4. **Order needs balance ≥ amount + fee.** Observed taker fee estimate ≈ **3.5%** (`fee 69300` on `1980000`). Size the spend to `balance / ~1.04`.
5. **Approvals are required and gasless:** `pUSD.approve(CTFExchangeV2/NegRisk/Adapter)` + `ConditionalTokens.setApprovalForAll(...)` once per deposit-wallet, via a relayer batch.
6. **The clob-client-v2 sigType-3 L1-auth bug did NOT block us.** The order was accepted (failed only on balance/allowance, never on "signer ≠ API key"). The ERC-7739 sigType-3 order signature built by `clob-client-v2@1.0.5` + OutLayer signing works against the live CLOB.

---

## 4. Multi-agent architecture — YES, different agents get different addresses

**Question:** different AI agents deposit money and play themselves, each with its own address — can we do that? **Yes. That is exactly what this run proves.** We did NOT trade from "your personal Polymarket account" — we traded from an **independent, OutLayer-derived wallet** (`0x56164B27…`), gas-sponsored by the app's builder key.

The model:

```
            ┌──────────────────────── APP (shared, one set) ────────────────────────┐
            │  • OutLayer app NEAR key (fastjambo.near)   → derives per-agent wallets │
            │  • Polymarket Builder "Outlayer" HMAC creds → sponsors gas for ALL      │
            │    agents + collects builder fees (builder code)                        │
            └───────────────────────────────────────────────────────────────────────┘
                        │ per-agent seed (e.g. "predict:user:<agentId>")
        ┌───────────────┼───────────────┬───────────────────────────────┐
        ▼               ▼               ▼                               ▼
   Agent A          Agent B          Agent C        …            (N agents)
   own EOA          own EOA          own EOA                     distinct addresses
   own deposit-     own deposit-     own deposit-                (CREATE2 from each EOA)
   wallet + pUSD    wallet + pUSD    wallet + pUSD               funds isolated per agent
   own orders       own orders       own orders                  signed by each agent's OutLayer key
```

**How to give each agent a distinct address:** each agent = a distinct **OutLayer seed**. Two options
(both validated this session):
- **`Bearer near:` deterministic (preferred):** one app NEAR key (`fastjambo.near`), `seed =
  sha256("predict:user:<agentId>")`. Same seed → same EVM address forever; different seed → different
  address. (We validated `near:` auth + `GET /address?chain=polygon` live with this key.)
- **`wk_` per agent:** register a wallet (or sub-agent) per agent; each gets its own EVM address. (This
  run used a `wk_` funding wallet.)

**What's shared vs per-agent:**
- **Shared (app):** the OutLayer NEAR key (derivation root) and the **Builder HMAC creds** (gas sponsor + fee attribution). One builder key serves all agents — proven: the builder sponsored a deposit-wallet whose owner is *not* the builder address.
- **Per-agent (isolated):** EOA, deposit-wallet, pUSD balance, positions, CLOB API key, and the
  signatures (each agent's OutLayer key signs only its own orders/transfers).

**Trust / safety:** the app builder can **pay gas** for an agent but **cannot move the agent's funds** —
every deposit-wallet batch (transfer/wrap/withdraw) and every order requires the **owner's** EIP-712
signature, which only that agent's OutLayer key can produce. The relayer just submits + pays gas.

**What you do NOT need:** the personal Polymarket Relayer API key (the `0x8EF0e73a` one). That path is
single-user (binds `from == owner`). The multi-tenant path is the **Builder** path.

**Open considerations for scale:**
- The app's builder key pays gas for everyone → that POL cost is the app's (offset by builder fees on trades). Watch relayer rate limits.
- USDC variant: entry **and** exit use **native USDC via the bridge services** (no swap on our side, §5c/§5d); the on-chain swap is a backup only.
- Per-agent CLOB API key derivation runs once per agent (cache it).

---

## 4a. Per-user derivation chain (how N users get distinct, distinguishable addresses)

Every per-user address is a **deterministic function of `userId`** — nothing random, nothing that must
be stored beyond the `userId`→`seed` convention:

```
userId
  └─ seed = sha256("predict:user:<userId>")                         (our convention; hex, valid OutLayer seed)
       └─ EOA  = OutLayer derive (Bearer near: + account_id + seed)  (GET /wallet/v1/address?chain=polygon)
            └─ deposit-wallet = CREATE2 from the EOA via Polymarket factory:
                 walletId = bytes32(EOA)
                 salt     = keccak256(abi.encode(factory, walletId))
                 address  = CREATE2(factory, salt, ERC1967-clone-initcode(impl))
                   factory = 0x00000000000Fb5C9ADea0298D729A0CB3823Cc07
                   impl    = 0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB
                 (verify two ways: deriveDepositWallet(EOA,factory,impl) == RelayClient.deriveDepositWalletAddress())
                 └─ bridge-in = POST bridge.polymarket.com/deposit {address: deposit-wallet}
                                (deterministic + unique per address — confirmed: same address → same bridge-in;
                                 different users → different bridge-in. NOT one shared address.)
```

Different `userId` → different `seed` → different EOA → different deposit-wallet → different bridge-in.
Full isolation; nothing shared except the app-level roots (one OutLayer NEAR key + one builder key).

**Distinguishing deposits (both directions):**
- **Forward:** for a `userId`, derive its deposit-wallet / bridge-in → hand the user their funding address.
- **Reverse:** funds land on deposit-wallet X → X ⇒ EOA ⇒ seed ⇒ `userId` (keep a `deposit_wallet → userId`
  reverse index in the DB to recognise incoming deposits).

**Minimal DB (user-server):**

| field | why |
|---|---|
| `userId` (seed = `sha256("predict:user:"+userId)`) | derivation root; seed itself need not be stored |
| cache: `eoa`, `deposit_wallet`, `bridge_in` | avoid re-deriving / re-calling OutLayer every time |
| cache: Polymarket CLOB `apiKey/secret/passphrase` (per user) | derived once per user (L1 ClobAuth) |
| reverse index: `deposit_wallet → userId` | map incoming deposits back to the user |

App-level (shared, one set): the **OutLayer NEAR key** (EOA derivation root) + the **Polymarket builder
key** (gas sponsor + fee attribution). This run used a single `wk_` wallet for simplicity (→ EOA
`0x791c61b3…` → deposit-wallet `0x56164B27…`); production swaps that for `near:` + `seed=predict:user:<id>`
so every user derives from the one app key with no per-user registration.

## 5. How to reproduce (scripts in `core/scripts/`, run from `core/`)

1. `npx tsx scripts/outlayer-livecheck.ts` — validate the OutLayer EVM signing seam (address + EIP-712 + EIP-191, zero funds).
2. `npx tsx scripts/outlayer-fund-setup.ts` — register/load a wallet, derive its NEAR + Polygon addresses, print a fund link. (Idempotent.)
3. Fund it (~$3+ to clear the order min comfortably).
4. `npx tsx scripts/outlayer-fund-withdraw.ts --go` — bridge intents → Polygon.
5. The deploy / consolidate (EIP-3009) / swap / wrap / approvals / order steps were run as one-off scripts this session; the reusable logic belongs in `funding-adapter.ts` (currently a skeleton — productionizing it is the next chunk). `outlayer-deposit-wallet-deploy.ts` is kept as the deploy reference.

**Secrets** (gitignored, never commit): `core/.env` (OutLayer NEAR key, Builder HMAC creds, builder code) and `core/.secrets/outlayer-funding-wallet.json` (the run's `wk_` wallet).

---

## 5a. EXIT path — permissionless (corrected after web research)

> **✅ CONFIRMED LIVE (2026-06-15) via the withdraw service.** `POST https://bridge.polymarket.com/withdraw`
> `{address:<DW>, toChainId:"137", toTokenAddress:<NATIVE USDC 0x3c499c54…>, recipientAddr:<EOA>, amount}`
> returns a per-request **bridge-out** address. We sent **2.105 pUSD** from the deposit-wallet to it
> (gasless `pUSD.transfer` batch via the builder relayer) → ~25s later **2.107 native USDC landed on our
> EOA** (`0x791c61b3…`), **USDC.e = 0** (verified on-chain it's NATIVE — required because **OutLayer
> 1Click only accepts native USDC, not USDC.e**). 1:1, no loss. Then OutLayer 1Click bridges the native
> USDC EOA → NEAR intents to close the loop home (NEAR is not a Polymarket withdraw destination, so the
> service drops to our Polygon EOA and OutLayer does the NEAR leg).
>
> **Withdraw request fields (discovered live):** `address` (source = deposit-wallet), `toChainId` (string!),
> `toTokenAddress` (destination token — set to NATIVE USDC), `recipientAddr` (destination wallet = our EOA),
> `amount` (the actual bridged amount = the pUSD you send to the bridge-out). Same non-signable bridge-out
> hop as deposit (worked).

> **Correction.** An earlier draft guessed the exit was "witness-gated." **It is not.** Per Polymarket
> docs ([Withdraw](https://docs.polymarket.com/trading/bridge/withdraw),
> [How to Withdraw](https://docs.polymarket.com/polymarket-learn/deposits/how-to-withdraw),
> [Apr-28-2026 upgrade](https://help.polymarket.com/en/articles/14762452-polymarket-exchange-upgrade-april-28-2026)):
> **pUSD is backed 1:1 by native USDC, smart-contract-enforced — 1 pUSD ⇄ 1 USDC, no fee** — and the
> exit is **permissionless** via the Collateral Offramp + a Uniswap v3 pool.

**The documented withdraw flow:** send pUSD → it is **unwrapped to USDC via the Collateral Offramp and
swapped through the Uniswap v3 pool** (`0xd36ec33c8bed5a9f7b6630855f1533455b98a418` — the **same
USDC/USDC.e fee-100 pool we used on entry**) to **native USDC**. The UI does this via a service
`POST https://bridge.polymarket.com/withdraw` (auto unwrap + swap + bridge to the destination chain).
Two important caveats from the help docs:
- **The Uniswap pool can be exhausted** → withdraw fails; "break into smaller amounts or wait for the
  pool to rebalance." (This — plus our dust size — is the likely cause of our `unwrap` revert: the
  offramp's resting USDC.e balance was 0 at that moment.)
- **You can withdraw pUSD DIRECTLY** (it's a transferable ERC-20; our `transfer` simulated OK) — no
  Uniswap needed — but pUSD is a Polymarket-only token (not spendable dollars off-platform).

**⚠️ NEAR intents accepts only NATIVE USDC** (user-confirmed) — so the withdraw service's `toTokenAddress`
must be native USDC and the home leg stays native (§5d). A fully **self-contained** exit (offramp
`unwrap` + Uniswap swap, no Polymarket bridge service) exists as a **backup only** →
[BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md) (it's liquidity-dependent; our dust-size test reverted).

- The post-bet **$0.011 is stranded dust** (below the bridge/pool effective mins) — not worth recovering.

## 5b. ENTRY can be simplified — the deposit bridge service accepts NATIVE USDC

Web research (2026-06-15): there is a **symmetric deposit service**
`POST https://bridge.polymarket.com/deposit {"address":"0x…"}` ([docs](https://docs.polymarket.com/trading/bridge/deposit)).
Per the docs it **accepts either native USDC OR USDC.e** and *"the incoming USDC or USDC.e is wrapped
into pUSD via the Collateral Onramp"* — i.e. **the service handles the native→USDC.e swap + wrap for
you** (the mirror of the withdraw service). Each asset has a minimum (see `/supported-assets`).

**Entry = the Polymarket `/deposit` service (chosen, §5c):** 1Click delivers native USDC → send it to the
bridge-in address from `POST .../deposit` → the service swaps+wraps → pUSD in the deposit-wallet. Native
USDC in, **no swap on our side**. (A self-contained on-chain entry — swap native→USDC.e + `CollateralOnramp.wrap`
yourself — exists as a **backup only** → [BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md).)

## 5c. CHOSEN APPROACH: native USDC both ways via Polymarket bridge services (no manual swap)

Decision (user): **OutLayer delivering/accepting USDC.e is NOT possible** — so we work with **native USDC
on both ends** and let Polymarket's bridge services do the swap+wrap / unwrap+swap internally. No swap
code on our side.

> **✅ CONFIRMED LIVE (2026-06-15).** Deposited 2.1 USDC via the service: 1Click → 2.0939 **native** USDC
> to the per-wallet bridge-in (`0xC28c…` for our DW) → the service swap+wrapped → **+2.0939 pUSD credited
> directly to our deposit-wallet `0x56164B27`** (1:1, no swap on our side, no visible loss). pUSD lands in
> the wallet we sign for via OutLayer; the bridge-in is deterministic **per `{address}`** (per-agent, not
> shared). The only non-signable moment is the brief bridge-in hop — it worked.

**Deposit service** (`POST https://bridge.polymarket.com/deposit {"address":"0x…"}`), probed live:
- **Permissionless** — no auth (HTTP 201), returns a per-target bridge-in address set
  (`evm`/`svm`/`tron`/`btc`). Send the asset to the `evm` address → service swaps+wraps → pUSD.
- **Accepts Polygon NATIVE USDC** `0x3c499c542…`, **min $2** (also USDC.e, axlUSDC, USDT, etc. — all min $2;
  Ethereum-source min $5). So **send ≥ $2** (1.1 USDC is below the floor).
- Warns to include an **`X-Builder-Code`** header (our builder code) for attribution.
- Our deposit-wallet `0x56164B27…` bridge-in (evm): `0xC28c1f333b9C07Cd2eD28212E6a0a2012b349724` (per-request;
  re-fetch before sending). **To confirm live:** that pUSD lands in OUR tradeable deposit-wallet.

**Withdraw service** (`POST https://bridge.polymarket.com/withdraw`): mirror — send pUSD → unwrap + swap →
**native USDC** to a destination. Pool can be exhausted (break into smaller amounts).

**Full native round-trip (target design, no swap on our side):**
```
ENTRY: NEAR intents ─1Click(native USDC)─▶ Polymarket /deposit bridge-in addr ─▶ pUSD in deposit-wallet
EXIT:  pUSD ─Polymarket /withdraw─▶ native USDC ─1Click─▶ NEAR intents
```
Tradeoff vs. our self-contained on-chain path (§5a/§5b): the services are simpler and native-USDC-native,
but are **Polymarket-operated** (dependency; min $2; must confirm they target arbitrary OutLayer
deposit-wallets). The on-chain path stays as the independent fallback.

## 5d. FULL native round-trip — CONFIRMED LIVE end-to-end (2026-06-15)

Closed the entire loop with real money, **native USDC both ways, zero swap on our side, fully gasless**:
```
NEAR intents ─1Click─▶ native USDC ─/deposit svc─▶ pUSD ─(trade)─▶ /withdraw svc ─▶ native USDC (EOA) ─1Click─▶ NEAR intents
```
In ~2.1 USDC → out **2.1069 USDC** back in NEAR intents (≈no loss). Signatures = OutLayer; gas = builder
relayer + 1Click.

**The home leg (Polygon native USDC → NEAR intents), two gotchas solved:**
1. **deposit-intent form:** `source_asset: "nep245:…"` is **rejected** ("only NEP-141 supported"); use
   **`{chain:"polygon", token:"USDC", amount}`** instead — it resolves Polygon USDC fine. (Polygon USDC
   exists in OutLayer's catalog only as a `nep245` HOT-omni asset; no `nep141` Polygon USDC.)
2. **EOA has no POL** → can't send natively. Solved gaslessly: **EIP-3009 `transferWithAuthorization`**
   (EOA signs via OutLayer) submitted inside a **builder-relayer batch** (the deposit-wallet relays it) →
   moves native USDC EOA → 1Click deposit address with zero gas.

**✅ Production-clean exit (user-confirmed design):** skip the EOA hop entirely — set the withdraw's
**`recipientAddr` = the OutLayer 1Click deposit address** (from `deposit-intent {chain:"polygon",
token:"USDC"}`). Then `/withdraw` delivers native USDC **straight onto the bridge home**, and 1Click
credits NEAR intents — **one path, no EOA, no EIP-3009, no gas problem.** (This run used the
EOA→EIP-3009→1Click variant to prove each primitive; the `recipientAddr=1Click` variant is the cleaner
prod path and is viable now that deposit-intent works via chain+token.)

## 6. Status / next steps
- ✅ End-to-end gasless OutLayer→Polymarket trade proven live (real money).
- ✅ Multi-agent model (distinct address per agent, one app builder sponsor) proven.
- ⏭ Productionize the entry pipeline (deploy + approvals + `/deposit` service; home leg = `recipientAddr`=1Click, EIP-3009 only if landing on the EOA) into `funding-adapter.ts` / `broadcaster.ts` (currently scripts/skeletons).
- ✅ Decided: OutLayer USDC.e is impossible → use **native USDC both ways via Polymarket bridge services**
  (no swap on our side); see §5c. (The self-contained on-chain swap path is kept **only as a backup** →
  [BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md).)
- ✅ **Full native round-trip CONFIRMED live** (§5d): NEAR intents → pUSD → trade → native USDC → NEAR
  intents, ~no loss, fully gasless, native both ways. Entry via `/deposit` svc, exit via `/withdraw` svc,
  home via 1Click (`deposit-intent {chain,token}` + EIP-3009 relayer batch). Prod exit = withdraw
  `recipientAddr` = 1Click deposit address (one path, no EOA/EIP-3009).
- ⏭ Per-agent productionization: seed = `predict:user:<agentId>`, cache per-agent CLOB creds in the user-server DB.
