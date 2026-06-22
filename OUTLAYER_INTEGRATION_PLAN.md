# pmxt × OutLayer — Integration Plan

> **Goal.** Turn this fork into an **OutLayer/NEAR-compatible execution sidecar** for a
> prediction-betting product ("voulai, but for prediction markets"). Custody + funding go through
> OutLayer / NEAR intents; trade execution stays in (near-vanilla) pmxt so we keep pulling new venues
> from upstream `pmxt-dev/pmxt`.
>
> **Out of scope for this repo.** The product/user layer (accounts, deposits UX, chat agent, Postgres)
> is a **separate service** (a voulai-derived backend) that calls this sidecar over HTTP. Keeping it out
> of here keeps the upstream sync trivial.
>
> **STATUS (2026-06-15) — native-USDC path chosen + proven live.** The Phase-0 "USDC variant" questions
> below are **RESOLVED**: entry/exit use **native USDC via Polymarket's `/deposit` + `/withdraw` bridge
> services** (they swap+wrap / unwrap+swap internally — **no swap on our side**). Canonical how-to:
> [POLYMARKET_NATIVE_USDC_GUIDE.md](POLYMARKET_NATIVE_USDC_GUIDE.md); live record:
> [PHASE2_LIVE_TRADE.md](PHASE2_LIVE_TRADE.md). The self-contained on-chain **native↔USDC.e swap** is a
> **backup only** → [BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md). Treat swap / EIP-3009-exit
> notes below as superseded context.
>
> **Companion docs** (the signing contract lives there, not duplicated here):
> [OUTLAYER_EVM_SIGNING_REQUEST.md](OUTLAYER_EVM_SIGNING_REQUEST.md) (our ask),
> [OUTLAYER_EVM_SIGNING_RESPONSE.md](OUTLAYER_EVM_SIGNING_RESPONSE.md) (OutLayer's reply),
> [OUTLAYER_EVM_SIGNING_REPLY.md](OUTLAYER_EVM_SIGNING_REPLY.md) (our acceptance).

Status: planning, updated with the **agreed OutLayer v1 signing contract** + verified gas/security
findings. Last revised this pass.

> ✅ **Deployment status (2026-06-15):** OutLayer EVM signing v1 is **DEPLOYED and validated live
> end-to-end** on `https://api.outlayer.fastnear.com`. `outlayer-livecheck.ts` passes with the real app
> key (`fastjambo.near`, `Bearer near:`): `address?chain=polygon` → `0x62FcFCA0…`, EIP-712 + EIP-191
> sign → `ecrecover == address`, address stable — zero funds. One interop bug found & fixed (OutLayer
> needs `EIP712Domain` in `types`; `OutlayerSigner` now reconstructs it). See
> [PHASE0_FINDINGS.md](PHASE0_FINDINGS.md) §2.

---

## 0. Decisions locked

1. **Custody / signing — OutLayer v1 CONFIRMED.** OutLayer will expose EVM signing under the same
   `Bearer near:` + `seed` auth: **address derivation + EIP-712 + EIP-191**, off-chain (signatures
   only), single per-wallet `evm_sign` capability (default-on), signed **in-TEE** (sub-ms, *not* NEAR
   chain-signatures). Raw-EVM-tx signing is a **fast-follow** under `evm_sign.raw_tx` (default-off).
   **Broadcast and gas-sponsorship are declined — we broadcast and handle gas.** We build against a
   `LocalKeySigner` now and swap to the OutLayer signer with no redesign (§5).
2. **Repo role.** Execution + custody-adapter sidecar, **maximally upstream-syncable**: new code is
   additive and isolated; exactly one guarded hook in an upstream file (§9).
3. **Integration model = A (direct).** Self-hosted pmxt-core → the venue's **native** CLOB, OutLayer as
   the universal signer. PMXT-hosted PreFundedEscrow (model B) is **rejected** (puts PMXT in the loop,
   charges fees, isn't "vanilla library" sync, and isn't gasless either).
4. **Venue-agnostic by construction — no per-venue relayers** (§7). Gas/on-chain execution is solved
   once in the wallet/broadcaster layer; per-venue connectors stay declarative.
5. **Multi-tenant** via per-request credentials (§4): one sidecar, N users.
6. **First venue: Polymarket** (Polygon). Limitless / Opinion reuse the same seam later (§5).

---

## 1. What pmxt is (and is not)

- **ccxt for prediction markets.** TS monorepo, "sidecar" pattern: `core/` holds all venue logic;
  `sdks/*` are thin HTTP wrappers. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **Self-hosted core already trades Polymarket** from an EVM key — builds + EIP-712-signs CLOB orders
  via `viem` + `@polymarket/clob-client-v2`
  ([core/src/exchanges/polymarket/index.ts](core/src/exchanges/polymarket/index.ts),
  [auth.ts](core/src/exchanges/polymarket/auth.ts)).
- **It is a trading library, not an app.** No users, no DB, **no deposit/withdraw/approve execution**,
  **no relayer code** (verified: grep `relayer`/`gasless`/`sendTransaction`/`writeContract` = 0 in
  core+sdks excl. generated; the only on-chain touches are read-only ERC-20 `balanceOf` reads —
  Polymarket pUSD [index.ts:759-766](core/src/exchanges/polymarket/index.ts#L759-L766) plus
  Limitless/Probable balance reads — never a write/broadcast). pmxt assumes the wallet is
  already onboarded/funded — fine, because onboarding/exec becomes uniform sign+broadcast in our layer.
- **Every crypto venue is EVM** (Polymarket/Polygon, Limitless/Base+Polygon, Opinion/Polygon+BSC). No
  NEAR-native venue ⇒ an EVM signer is mandatory; OutLayer's NEAR-only custody can't be the signer by
  itself.

## 2. The custody gap — now closed by OutLayer v1

| Capability | Today | v1 (agreed) |
|---|---|---|
| Hold USDC in NEAR intents (public + confidential), gasless swaps | ✅ | ✅ |
| Cross-chain **withdraw** intents → Polygon EVM address | ✅ | ✅ |
| Derive an **EVM** address from a seed | ❌ (`address?chain=` near-only) | ✅ `GET /wallet/v1/address?chain=<evm>` |
| Sign **EIP-712 / EIP-191** for that address | ❌ | ✅ `POST /wallet/v1/evm/sign-typed-data` / `sign-message` |
| Sign **raw EVM tx** | ❌ | ⏳ fast-follow (`evm_sign.raw_tx`) |
| **Broadcast** tx / **sponsor gas** | ❌ | ❌ declined — **we** do it |

Signing is **in-TEE secp256k1 derivation + in-enclave ECDSA** (master secret delivered once via
Confidential Key Derivation; *not* a per-signature chain-signatures oracle) → sub-ms, no on-chain
round-trip per signature. Trust model identical to NEAR custody: **no raw key ever leaves the TEE.**

## 3. Target architecture

```
        ┌─────────────────────────┐         HTTP          ┌──────────────────────────┐
        │  User-server (SEPARATE) │ ───────────────────▶  │  pmxt sidecar (THIS repo)│ ──▶ venue CLOB
        │  voulai-derived:        │   per-user creds      │  near-vanilla core +     │     (Polygon)
        │  auth, DB, chat agent,  │ ◀───────────────────  │  outlayer integration +  │
        │  deposit/cashout UX     │                       │  generic broadcaster     │
        └───────────┬─────────────┘                       └───────┬──────────┬───────┘
                    │ OutLayer (Bearer near: + seed)              │ sign      │ broadcast
                    ▼                                             ▼ (evm_sign)▼ (our RPC)
        ┌──────────────────────────────────────┐      ┌──────────────────────────────┐
        │  OutLayer custody — NEAR intents +    │      │  Polygon: EOA float, venue    │
        │  intents→Polygon bridge + EVM signing │      │  contracts, 1Click bridge     │
        └──────────────────────────────────────┘      └──────────────────────────────┘
```

**Money path.** (1) **Deposit** → user funds NEAR intents under per-user seed (`predict:user:<id>`) via
OutLayer `deposit-intent` (1Click bridge). *(user-server)* (2) **Bet** → `intents/withdraw
{chain:"polygon", to:<seed's EVM addr>}` moves USDC onto Polygon (gasless on NEAR side). (3) **Trade**
→ pmxt builds the order; OutLayer signs the EIP-712; matched off-chain by the venue's operator. (4)
**Cash out** → sell positions → bridge Polygon → NEAR intents (gasless if EIP-3009 path holds, §7) →
user withdraws. Funds transit Polygon only while a position is open; **NEAR intents is the home
custody.**

## 4. Multi-tenancy

Already supported by the sidecar — we feed it per-user identity:
- No body credentials ⇒ cached singleton from env (single-user dev default)
  ([app.ts:245-264](core/src/server/app.ts#L245-L264)).
- Body has `credentials` ⇒ **fresh per-request instance** via `createExchange(name, credentials)`
  ([app.ts:397-402](core/src/server/app.ts#L397-L402)).

Plan: extend the credential shape **additively** to carry an OutLayer identity
(`{ outlayerAccountId, outlayerSeed }`) instead of `privateKey`; the outlayer-aware factory builds the
per-user signer. **Cache** per-seed `PolymarketAuth`/`ClobClient` (LRU) — per-request instances aren't
cached, so `deriveApiKey` + proxy discovery would otherwise run every call. Polymarket **API creds**
(key/secret/passphrase) are per-EOA: derive once per user, persist in the **user-server DB**, pass back
as credentials.

## 5. The signer seam (pmxt side)

Where the raw key enters today — the seam we displace:
```
core/src/exchanges/polymarket/auth.ts
  L40  if (!credentials.privateKey) throw ...
  L64  const account = privateKeyToAccount(hexKey);          // ← hard-coded EOA
  L66  this.signer = createWalletClient({ account, chain: polygon, transport: http() });
  L272 new ClobClient({ ..., signer: this.signer, ... })     // viem WalletClient handed to CLOB
```
`viem` supports **custom accounts** (`toAccount({ address, signTypedData, signMessage, signTransaction })`)
whose methods can be **async** and call out over HTTP. That's our injection mechanism.

Design (all additive, in `core/src/integrations/outlayer/**`):
1. **`SignerProvider` abstraction** — one interface, two impls:
   - `LocalKeySigner` — wraps a local secp256k1 key (dev / fallback / tests).
   - `OutlayerSigner` — calls OutLayer v1 by `seed`: `GET /address`, `POST /evm/sign-typed-data`,
     `POST /evm/sign-message`. **Holds no raw key.**
   Both expose `address()`, `signTypedData(td)`, `signMessage(msg)` (+ `signTransaction(tx)` once the
   raw-tx fast-follow lands).
2. **viem custom account** built from a `SignerProvider`, then a `WalletClient`.
3. **`PolymarketOutlayerAuth`** — subclass of `PolymarketAuth` (new file) that overrides the
   account/`WalletClient` construction to use the custom account; inherits proxy discovery,
   `getApiCredentials`, `getClobClient` unchanged.
4. **Factory hook** — `createExchange` selects the outlayer-backed exchange when an OutLayer identity /
   `OUTLAYER_ENABLED` is present (§9 — the single guarded edit).
5. Same pattern generalizes to **Limitless** / **Opinion** (also `@polymarket/clob-client-v2` / EIP-712).

Because the OutLayer signing contract is fixed (§2, companion docs), **swapping `LocalKeySigner` →
`OutlayerSigner` is an implementation change, not a redesign.** Load the OutLayer client via dynamic
`import()` (ESM) so it isn't bundled into core.

## 6. The generic broadcaster (our gas/on-chain executor)

OutLayer signs but won't broadcast — so this repo (or a tiny sibling service) runs **one generic
broadcaster**: takes an OutLayer-signed tx / EIP-3009 authorization, submits it via our Polygon RPC,
manages nonces, and pays gas. **It is not per-venue** — one component serves every EVM venue. This is
what lets connectors stay declarative and is why we never "write a relayer per market."

## 7. Funding, gas & exit — VERIFIED

Multi-agent investigation (pmxt code + Polymarket docs + adversarial verification) + the
`pmxt-builder-widgets` flow settled this. Confidence: **high** on the shape, **moderate** on V2
deposit-wallet specifics (Phase 0 confirms hands-on).

**Gas verdict.** Placing/cancelling an order is **gasless** (off-chain EIP-712 + HTTP POST; the venue's
operator settles on-chain). **Entry** (make bridged USDC tradeable) and **exit** (bridge back to NEAR
intents) each force ≥1 on-chain Polygon tx — so POL/MATIC is needed **at the boundaries, not per trade.**

| Step | On-chain? | Gas |
|---|---|---|
| Place / cancel a CLOB order | no | none on our side — operator settles |
| Entry: make bridged USDC tradeable | yes (≥1 tx) | mostly venue-relayer-sponsored (V2) |
| Exit: USDC → 1Click deposit addr → intents | yes (transfer) | gasless via EIP-3009 if native USDC; else POL |

**Design principle — venue-agnostic, no per-venue relayers.** Every EVM venue decomposes into two
uniform primitives: (a) **sign an EIP-712 order** (identical mechanic; only domain/types differ), and
(b) **sign + broadcast a few on-chain txs** (approve / wrap / exit transfer — only contract addresses +
calldata differ, *declarative data*). Per-venue connectors stay pure logic; **gas lives in the
wallet/broadcaster layer**. A venue's own gasless relayer (e.g. Polymarket's) is then an **optional**
gas-saver; worst case is a single HTTP call to *that venue's* relayer as one connector step — never
relayer infra we write/run.

**Polymarket V2 (post-2026-04-28) entry path.** Bare-EOA trading (`signatureType 0`) is **rejected for
new API users**; recommended funder is a **deposit-wallet (`POLY_1271`, sigType 3)**. ⚠️ pmxt's code
*comment* claims a POLY_1271 default, but the real fallback is **Gnosis Safe (sigType 2)** when discovery
fails ([auth.ts:254-258](core/src/exchanges/polymarket/auth.ts#L254-L258)) and **EOA (0)** in
`mapSignatureType`/`discoverProxy` — so we must set `signatureType` **explicitly**; we don't inherit the
deposit-wallet path. Collateral is **pUSD**:
bridged USDC must be **wrapped (Collateral Onramp, on-chain)** and **transferred into the
deposit-wallet**. **Deposit-wallet deploy + approvals are gas-sponsored by Polymarket's relayer**
(self-serve Builder API key, Unverified tier) — so entry is largely gasless; the wrap + funding
transfer are the steps that may still cost a little POL.

**Exit — prefer gasless.** 1Click is push-only — `deposit-intent` returns a single-use address you
`transfer` USDC TO ([types.rs:147-169](../ai-intents/api/crates/outlayer/src/types.rs)). Instead of a
plain ERC-20 `transfer` (EOA pays POL), the EOA signs an **EIP-3009 `transferWithAuthorization`** — an
**EIP-712 message already covered by OutLayer v1 `sign-typed-data`** — and **our broadcaster (§6)**
submits it and pays gas, so the EOA holds **zero POL**. **Conditional:** EIP-3009 works for **native
Circle USDC**, *not* bridged USDC.e. Which variant 1Click delivers / Polymarket settles is a **Phase-0**
question. Fallback if USDC.e: a tiny POL float (native-POL `withdraw-to-self` — OutLayer flagged this as
unverified; or raw-tx fast-follow). So we never require a manual per-wallet POL deposit unless the
gasless path is unavailable.

**Additive funding-adapter endpoints** (own router, non-colliding paths): `POST /outlayer/fund-polygon`,
`POST /outlayer/onramp-pusd`, `POST /outlayer/cashout`, `GET /outlayer/status/:id`. Plus reconciliation:
poll OutLayer + venue status, idempotency, partial fills, bridge delays.

## 8. Security model

**`evm_sign` is full fund-moving authority over the Polygon EOA float — not a bounded order signer**
(confirmed with OutLayer). Because EIP-3009 `transferWithAuthorization` (≈ transfer) and EIP-2612
`permit` (≈ approve) are typed-data, they ride the **always-on `evm_sign`**; `evm_sign.raw_tx` off is
therefore **not** a drain-containment boundary (it only gates arbitrary raw txs / native value /
non-EIP-3009 tokens). OutLayer can't fix this via a `to` allowlist (the exit recipient is a dynamic,
single-use address). So the real controls live on **our** side:
- **Minimize the EOA float** — just-in-time bridge + prompt sweep; idle balance ≈ 0. Drain blast-radius
  = funds mid-flight only; the NEAR-intents home balance is unreachable by any EVM signature.
- **Keep the `evm_sign` bearer in the trusted backend** — the NEAR key + `seed` never reach the chat
  agent; "compromised caller" = our backend, bounded further by the float.
- *Tradeoff:* tighter float = more bridge round-trips per bet (slower "bet now"). How much to pre-fund
  vs sweep is a **user-server** product decision.
- *Future hardening (non-blocking, OutLayer side):* a light **structural** typed-data filter
  (`primaryType ∈ {Order, TransferWithAuthorization, Permit}`, domain ∈ known venue/USDC contracts).

## 9. Upstream-sync strategy

- **New code only in new locations:** `core/src/integrations/outlayer/**` (signer, OutLayer client,
  viem custom account, `PolymarketOutlayerAuth`, funding adapter, broadcaster); `core/src/server/
  outlayer-routes.ts` (additive router); the companion + plan docs; `.env.example` additions.
- **Exactly one guarded hook in an upstream file** — a clearly-commented block in
  [exchange-factory.ts](core/src/server/exchange-factory.ts) `case "polymarket"`:
  ```ts
  // >>> outlayer-integration (keep additive; re-apply on upstream merge)
  if (isOutlayerEnabled(credentials)) return createOutlayerExchange(name, credentials);
  // <<< outlayer-integration
  ```
  The only merge-conflict point; optionally keep it as a tracked patch applied post-merge.
- **Never touch** `sdks/*/generated/**` or upstream venue files. Pin `viem`/`@polymarket/*` versions.
- **Process:** add `upstream` remote → periodic `git merge upstream/main` → smoke test (Phase-0 trade)
  → ship. Diff surface stays: 1 new dir, 1 new route file, 1 factory block.

## 10. Phased roadmap

- **Phase 0 — Spike (1–2 days, highest value, do first).** Self-host pmxt locally; with a throwaway
  local EVM key, run the **full** Polymarket flow on a tiny real amount: fund → (V2: wrap pUSD + deposit
  wallet) → place order → position → sell → exit to a 1Click address. Resolve §11's open questions —
  above all the **USDC variant** (native vs USDC.e → decides the gasless exit) and **signatureType**.
  Parallel on OutLayer's side: `sign_secp256k1` → recoverable (their first build item).
- **Phase 1 — Signer abstraction + multi-tenant.** `SignerProvider` + `LocalKeySigner`;
  `PolymarketOutlayerAuth`; factory hook; per-request per-user signer; per-seed cache. Trade as N users
  with per-user local keys.
- **Phase 2 — Funding adapter + broadcaster.** intents↔Polygon bridge, V2 onramp/deposit, the generic
  broadcaster (§6), gasless exit (EIP-3009) or POL-float fallback, status polling, idempotency. Full
  deposit→bet→cashout with local keys.
- **Phase 3 — Swap to OutLayer signing.** Implement `OutlayerSigner` against the **known v1 contract**
  (address + EIP-712 + EIP-191; raw-tx when it lands) and flip the provider. Minimal change.
- **Phase 4 — Generalize & harden.** Limitless + Opinion via the same seam; monitoring, reconciliation,
  rate limits, error mapping.
- **Parallel track (NOT this repo).** Build the user-server (fork voulai): users, deposits/cashout UX,
  the chat agent (conversation → bets), float policy (§8), per-user OutLayer seed mapping. It calls this
  sidecar with per-user credentials.

## 11. Open questions / risks (Phase 0 closes most)

> **Phase-0 resolution (2026-06-15) — see [PHASE0_FINDINGS.md](PHASE0_FINDINGS.md).** Resolved without
> funds: ✅ clob-client-v2 never broadcasts (HIGH); ✅ V2 contract addresses (HIGH, Polygonscan-verified,
> in `polymarket-v2-contracts.ts`); ✅ deposit-wallet factory is **permissionless + relayer-gas-sponsored**
> (HIGH); ✅ `signatureType` must be set to **3** explicitly (pmxt never auto-detects it). **Corrected:**
> the gasless exit is **not** EIP-3009 on the collateral — V2 collateral **pUSD is a wrapper over bridged
> USDC.e with EIP-2612 `permit` only, no EIP-3009**; the **Polymarket relayer** is the real gasless path
> (wrap/unwrap/transfer/deploy). EIP-3009 only applies at the 1Click bridge boundary on Circle USDC.
> **Still open (need the live spike / funds):** which USDC variant 1Click delivers; native-USDC EIP-3009
> support on Polygon (needs ABI read); the py-clob-client-v2 sigType-3 API-key-binding bug.
> ~~NEW BLOCKER: EVM v1 not deployed~~ → **RESOLVED 2026-06-15:** EVM v1 deployed; live signing check
> passes end-to-end (§0 status note).

- **USDC variant** — ✅ **RESOLVED:** 1Click delivers/accepts **native Circle USDC**; Polymarket settles
  **pUSD**. Production uses the **`/deposit` + `/withdraw` bridge services** (native USDC both ways,
  swap+wrap/unwrap handled internally); the on-chain native↔USDC.e swap is a **backup only**
  ([BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md)).
- **Which `signatureType`** — deposit-wallet (sigType 3, relayer-sponsored deploy/approvals) vs EOA
  (sigType 0, now rejected). Decides on-chain step count + gas; also whether the raw-tx fast-follow
  (REQUEST §4.4) is needed.
- **Polymarket relayer access** for a programmatic deposit-wallet (Unverified Builder tier, self-serve
  key) — confirm hands-on; and whether the deposit-wallet factory is permissionlessly callable.
- **Native-POL gas-float fallback** — OutLayer's cross-chain withdraw rejects a *native* source token
  and 1Click delivery of native POL is unverified; run `GET /wallet/v1/tokens` + `withdraw_dry_run`.
  Only matters if the gasless exit is unavailable.
- **Current V2 exchange/CTF contract addresses** — pull from the v2 migration guide; don't hardcode
  stale v1 approval targets.
- **`@polymarket/clob-client-v2` doesn't broadcast** under the hood — confirm against the actual lib
  (node_modules wasn't installed during analysis; moderate-confidence inference).
- **OutLayer confirms** `sign-typed-data` signs arbitrary EIP-712 incl. EIP-3009/EIP-2612 (asked in our
  REPLY; their RESPONSE §7 confirmed — verify on first live call) + accepts the security relabel
  (RESPONSE §7 / plan §8).
- **Per-user Polymarket API-key derivation** cost/caching at scale; **bridge latency/fees/minimums**
  (1Click) for "bet now" UX; **confidential vs public intents** for held collateral.
- **`evm_sign` = full fund authority** (see §8) — mitigated by float-sizing + server-side bearer, not by
  `raw_tx` off.
- **Legal/compliance + geofencing/ToS** for automated betting custody — flagged; out of scope here.

## Appendix — key file references

- Sidecar routing + per-request credentials: [core/src/server/app.ts](core/src/server/app.ts)
  (`L245-264`, `L369-402`, `L479-502`).
- Exchange construction / env fallbacks: [core/src/server/exchange-factory.ts](core/src/server/exchange-factory.ts).
- Polymarket signer + CLOB client + signature types:
  [core/src/exchanges/polymarket/auth.ts](core/src/exchanges/polymarket/auth.ts)
  (`L17-20` sig types, `L40/64/66/272` signer seam, `L211-282` getClobClient).
- Polymarket order build/submit + read-only balance:
  [core/src/exchanges/polymarket/index.ts](core/src/exchanges/polymarket/index.ts) (`L759-766`).
- OutLayer custody client (voulai, same auth model): `~/projects/ai-intents/api/crates/outlayer/`
  (`client.rs`, `signer.rs`, `types.rs`).
- Non-custodial trading-chain reference UX: `pmxt-dev/pmxt-builder-widgets`.
- Signing contract: companion REQUEST / RESPONSE / REPLY docs (top of this file).
