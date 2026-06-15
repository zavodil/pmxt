# Phase-0 Findings

Hands-on resolution of the open questions in `OUTLAYER_INTEGRATION_PLAN.md` §11 that don't need funds.
Each finding is marked **high / moderate / low**. Items still needing funds or a live OutLayer EVM
deployment are called out explicitly — none are faked.

Last updated: 2026-06-15.

> **STATUS:** the "native USDC vs USDC.e" blocker (§7b) is **resolved in production** by Polymarket's
> **`/deposit` + `/withdraw` bridge services** — native USDC both ways, swap+wrap/unwrap done by the
> service (**no swap on our side**). Canonical how-to: [POLYMARKET_NATIVE_USDC_GUIDE.md](POLYMARKET_NATIVE_USDC_GUIDE.md);
> the self-contained on-chain **native↔USDC.e swap** is a **backup only** →
> [BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md). The swap/wrap analysis below is research context.

---

## 1. `@polymarket/clob-client-v2` never broadcasts — **HIGH**

The plan's one moderate-confidence assumption (§11) is now **confirmed against the installed library**
(`node_modules/@polymarket/clob-client-v2@1.0.5`, analyzed in `dist/index.js`).

- **Zero on-chain write primitives.** No `sendTransaction`, `sendRawTransaction`, `writeContract`,
  `eth_sendTransaction`, `broadcast`, `populateTransaction`, `.deploy(` anywhere in the compiled lib.
- **The signer is used as a pure message signer.** `ClobSigner = EthersSigner | WalletClient`. Order
  and L1-auth signing route through one helper:
  ```js
  signTypedDataWithSigner = ({ signer, domain, types, value, primaryType }) => {
    if (isEthersTypedDataSigner(signer)) return signer._signTypedData(domain, types, value);     // ethers
    if (isWalletClientSigner(signer))   return signer.signTypedData({ account, domain, types, primaryType, message: value }); // viem
  }
  ```
- **Order submission is HTTP** `POST /order` via axios. The venue operator settles on-chain; the trader
  never pays per-trade gas.
- `getContract` references are only `getContractConfig(chainId)` — a pure address-lookup switch
  (`case 137: return MATIC_CONTRACTS`), **not** viem on-chain calls.

**Implication:** placing/cancelling an order through pmxt is gasless and off-chain; the OutLayer custom
account only ever needs to *sign* (EIP-712 + EIP-191). On-chain gas appears only at the funding
boundaries (entry/exit), exactly as the plan predicts.

**Consequence for our seam (verified):** clob deletes `typedData.types.EIP712Domain` before calling
`signer.signTypedData(...)`. viem re-derives it locally, but OutLayer's `sign-typed-data` expects a full
`eth_signTypedData_v4` object — so the viem custom account reconstructs `EIP712Domain` from `domain`
before forwarding (`withEip712Domain`, covered by a unit test).

---

## 2. OutLayer EVM signing v1 — **DEPLOYED + validated live end-to-end** — **HIGH**

> History: this was initially found NOT deployed on prod (the EVM routes 404'd, `chain=polygon` →
> `unsupported_chain`). OutLayer then completed the deploy; the live check below now **passes**.

`core/scripts/outlayer-livecheck.ts` against `https://api.outlayer.fastnear.com` with the real app key
(`fastjambo.near`, `Bearer near:`, `seed = sha256("predict:user:livecheck")`) — **all green, zero funds**:

| Check | Result |
|---|---|
| `GET /wallet/v1/address?chain=polygon` | **PASS** → `0x62FcFCA00C88Fc7804Bb9e6d235E678270fC4Ce7` |
| `POST /wallet/v1/evm/sign-typed-data` (Order) → `ecrecover == address` | **PASS** |
| `POST /wallet/v1/evm/sign-message` (EIP-191) → `personal_ecRecover == address` | **PASS** |
| address stable across calls | **PASS** |

This validates the entire seam against the live server: `NearAuth` (ported from `signer.rs`),
`SeedBearerAuth`, `seedFor`, `OutlayerClient`, `OutlayerSigner`, and the recover logic.

**Interop bug found & fixed (HIGH):** OutLayer's `sign-typed-data` computes the domain separator from an
**explicit `EIP712Domain` entry in `types`** and errors `unknown struct type 'EIP712Domain'` when it's
absent. But `clob-client-v2` deletes it and viem omits it. Fix: `OutlayerSigner.signTypedData`
reconstructs `EIP712Domain` (canonical field order) before sending — centralized so every caller is
covered; the generic viem custom account stays clean. Regression-tested
(`test/outlayer/outlayer-signer.test.ts`). The resulting EIP-712 digest is identical, so `ecrecover`
against the original typed data matches (verified live).

**Auth notes (still true):** the coordinator does an on-chain access-key check on the `account_id` in a
`Bearer near:` token — a freshly-generated, unfunded implicit account 401s (`not an access key`). A
**real NEAR account whose ed25519 key is an access key** is required (we use `fastjambo.near`). The
zero-key alternative is `POST /register` → `Bearer wk_` (also validated live). Seed is `[a-zA-Z0-9._-]`
(no `:`), so `predict:user:<id>` is hashed via `seedFor`.

**Full onboarding path validated live (zero funds) — HIGH.** Beyond raw signing, the complete
`PolymarketOutlayerAuth` path was exercised against **both** live OutLayer **and** live Polymarket:
OutLayer signed the Polymarket **L1 ClobAuth EIP-712**, and the Polymarket CLOB **accepted it and issued
real API credentials** (`createApiKey`) for the OutLayer-derived EOA `0x62FcFCA0…`. This proves the
OutLayer↔Polymarket signature interop end-to-end. The only remaining piece for a full order is
collateral + market tick size (needs funds) — the live entry→trade→exit spike (§6).

---

## 3. Auth model + seed format — **HIGH** (from the agent-custody skill + live probe)

- `Bearer near:` signs `auth:<seed>:<ts>` as **raw ed25519 → base58 (no prefix)**; pubkey carries the
  `ed25519:` prefix; **±30s** timestamp window. Sub-wallet auto-creates on first authenticated call.
  (Matches `signer.rs` and our `NearAuth`; verified the server parses our tokens.)
- **Seed format is `[a-zA-Z0-9._-]{1,256}` — no `:`.** So the product's `predict:user:<id>` must be
  **hashed** into the seed: `seed = hex(sha256("predict:user:<id>"))`. Our `seedFor()` /
  `outlayerUserId` does exactly this; `resolveIdentity` rejects a raw colon-bearing seed.
- Two auth modes both work and sit behind one `BearerAuth` interface in our code: `SeedBearerAuth`
  (deterministic, multi-tenant per seed — **preferred**) and `WkBearerAuth` (registered `wk_`,
  single-tenant/dev, zero NEAR key).

---

## 4. Polymarket V2 — USDC variant / contracts / deposit-wallet / onboarding

Researched via a multi-agent web workflow (`phase0-polymarket-research`, 8 agents) with **adversarial
verification** (each claim independently re-checked on Polygonscan + docs.polymarket.com). Addresses
captured in code: [`polymarket-v2-contracts.ts`](core/src/integrations/outlayer/polymarket-v2-contracts.ts).

### 4a. USDC variant + gasless exit — **the big correction** — **MODERATE→HIGH**

> **LIVE RESULT (2026-06-15, real $1):** bridged 1 USDC NEAR-intents → Polygon via
> `intents/withdraw {chain:"polygon"}` (gasless, ~0.59% 1Click fee → 0.994094 delivered). On-chain
> `balanceOf` on the EOA confirms **1Click delivered NATIVE Circle USDC** (`0x3c499c54…`) — **0.994094**;
> USDC.e and pUSD = 0; POL = **0**. So at the bridge boundary the EOA holds **native USDC (EIP-3009-capable)**,
> not USDC.e — the gasless EIP-3009 exit boundary is viable in principle (still verify the deployed
> native-USDC ABI). The trading-layer collateral is still pUSD (permit/relayer), per below.

The plan's "gasless exit via EIP-3009 if native USDC" framing was **partly wrong about where EIP-3009
applies**:

- **V2 collateral is pUSD** (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`, 6 decimals) — a
  **Polymarket-issued ERC-20 wrapper over bridged USDC.e**, minted via `CollateralOnramp.wrap()`. It is
  **NOT** native Circle USDC. (Polygonscan "Polymarket: pUSD Token"; docs.polymarket.com/concepts/pusd.)
- **pUSD does NOT implement EIP-3009** — its verified implementation (`0x6bBCef9f…925f`) exposes
  **EIP-2612 `permit`** but no `transferWithAuthorization`/`receiveWithAuthorization`. **HIGH.**
  ⇒ The gasless exit **cannot** ride EIP-3009 on the venue collateral.
- **The real gasless mechanism is Polymarket's own relayer**, which sponsors wallet deploy, token
  approvals, CTF ops, transfers, and **wrap/unwrap** (Builder/Relayer API key, Unverified tier). So
  entry AND most of exit (unwrap pUSD → USDC.e) are gasless via that relayer — **not** via a broadcaster
  we run. **HIGH.**
- **EIP-3009 only matters at the NEAR-intents bridge boundary**, on the *underlying Circle USDC* that
  1Click delivers/collects — and (i) whether 1Click delivers native USDC (`0x3c499c54…`) vs USDC.e
  (`0x2791Bca1…`) is **still unspecified**, and (ii) whether native Circle USDC on Polygon actually
  supports EIP-3009 **needs on-chain ABI/bytecode verification** (web sources conflict). **Both remain
  open — but they only affect the bridge hop, not the trading layer.** Code updated accordingly
  (`broadcaster.ts`, `funding-adapter.ts`).

**Net:** the float can hold USDC.e (or native USDC) at the bridge boundary; Polymarket's relayer handles
the gasless on-venue steps. Our generic broadcaster is needed only for the residual on-chain bits not
covered by the relayer (e.g. the pUSD-into-deposit-wallet transfer if not relayer-covered, or a raw-EOA
fallback) — POL is needed only there.

### 4b. V2 contract addresses (Polygon, chainId 137) — **HIGH** (each Polygonscan-verified)

| Contract | Address |
|---|---|
| CTF Exchange V2 (standard) | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Neg-Risk CTF Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` |
| NegRiskAdapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |
| Conditional Tokens (CTF, ERC-1155) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| pUSD collateral (impl `0x6bBCef9f…925f`) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| Collateral Onramp (permissionless, `wrap`) | `0x93070a847efEf7F70739046A929D47a521F5B8ee` |
| Collateral Offramp (`unwrap`) | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` |
| Deposit-Wallet Factory | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` |
| Deposit-Wallet Beacon | `0x7A18EDfe055488A3128f01F563e5B479D92ffc3a` |
| Native Circle USDC | `0x3c499c542cEF5E3811e1192ce70d8cc03d5c3359` |
| Bridged USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| Legacy V1 Exchange (order books wiped 2026-04-28) | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |

**EIP-712 V2 order domain:** `name="Polymarket CTF Exchange"`, `version="2"` (V1 was `"1"`),
`chainId=137`, `verifyingContract` = the exchange the market routes to (standard vs neg-risk). The L1
**ClobAuth** domain stays `version="1"`. **HIGH.** (clob-client-v2 builds these internally; we don't
hand-roll them, but they're recorded for verification.)

### 4c. Deposit-wallet (sigType 3 / POLY_1271) — **HIGH**

- **Deployment is permissionless and gas-sponsored** by the Polymarket relayer (a `WALLET-CREATE` op;
  the EOA signs **nothing** to deploy). Deterministic **CREATE2 ERC-1967 BeaconProxy**, `walletId =
  bytes32(owner)`, `salt = keccak256(args)`.
- The EOA only ever signs **L1 ClobAuth** + **L2 EIP-712 Order** (ERC-7739-wrapped ERC-1271 for sigType
  3). That's exactly what our custom-account seam provides.
- ⚠️ **Known SDK bug** (py-clob-client-v2 #64/#70/#71): for sigType 3, L1 auth can wrongly bind the API
  key to the **EOA** instead of the **deposit wallet** — an integration hazard to watch in the live
  spike (may affect `deriveApiKey`/`funderAddress` wiring).

### 4d. signatureType — **HIGH (confirms the plan's warning)**

pmxt's `discoverProxy()` can only ever return sigType **1 or 2** — it has **no branch that returns 3** —
and its runtime fallback is **Gnosis Safe (2)** (the `POLY_1271` "default" is only a stale code comment).
⇒ **We MUST set `signatureType: 3` explicitly** in credentials for the V2 deposit-wallet path. Done:
`SIGNATURE_TYPE.POLY_1271_DEPOSIT_WALLET` in `polymarket-v2-contracts.ts`; pass `signatureType: 3`.

### 4e. V2 onboarding step list (deposit-wallet path) — **MODERATE**

1. Bridge USDC onto the EOA (NEAR intents → Polygon via 1Click). *(funding adapter `fundPolygon`)*
2. `CollateralOnramp.wrap(USDC.e|USDC, pUSD)` — on-chain, **relayer-sponsorable**.
3. Deploy deposit-wallet (sigType 3) — **relayer-sponsored**, no EOA signature.
4. Transfer pUSD into the deposit-wallet — a plain transfer; **the one step that may cost POL** if done
   as a raw EOA tx (not documented as relayer-covered).
5. Derive CLOB API key (L1 EIP-712 ClobAuth) — off-chain signature (our seam). *(watch bug §4c)*
6. Place order (L2 EIP-712 Order) — off-chain; operator settles. **Gasless.**

Steps 2–5 are largely relayer-sponsored (Builder/Relayer API key). Residual POL risk is step 4 only.
**Final confirmation needs the live spike** (a funded wallet + a Builder/Relayer key).

---

## 5. Offline seam validation — **HIGH** (what IS proven today)

Even with OutLayer EVM v1 absent, the entire signing seam is validated offline via `LocalKeySigner`
(same `SignerProvider` interface as `OutlayerSigner`):

- 18/18 unit tests pass (`core/test/outlayer/`), including the **order-signing seam**: a Polymarket-shaped
  EIP-712 Order signed through `LocalKeySigner → toSignerAccount → viem WalletClient` (exactly what
  clob-client-v2 calls) **recovers back to the signer address**; same for EIP-191.
- Full pmxt suite green (30 suites / 670 tests), so the additive integration causes **zero regressions**.
- Server boots; `/outlayer/*` routes mount; the `exchange-factory` hook routes OutLayer-identity requests
  through `PolymarketOutlayerExchange`.

---

## 6. Needs funds / human (not blocking the above)

1. **A live OutLayer EVM deployment** (base URL serving `/wallet/v1/evm/*`) — blocks the live signing
   check and everything downstream.
2. **A persistent OutLayer app identity** for the deterministic per-user model: a real NEAR account +
   `ed25519:` access key (reuse existing or register fresh).
3. **A funded Polygon wallet** (tiny USDC + a little POL) + a **Polymarket Builder/Relayer API key**
   (Unverified tier) + a **tiny real test amount** — for the live entry→trade→exit spike (Phase 0 §10).

---

## 7. Relayer auth binding — **architectural blocker for OutLayer-gasless** — **HIGH (empirical)**

Live test (2026-06-15) deploying a deposit-wallet via `POST https://relayer-v2.polymarket.com/submit`
`{type:'WALLET-CREATE', from:<OutLayer EOA 0x791c61b3…>, to:<factory>}` with the user's **Relayer API
key** headers (`RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS=0x8EF0e73a…`) returned:

> `400 {"error":"from 0x791c61B3… does not match auth 0x8EF0e73a…"}`

**The Relayer API key enforces `from == key-owner address`.** A relayer key created at
`polymarket.com/settings?tab=api-keys` (Gamma-auth, tied to the creator's wallet) can therefore only
gaslessly operate **its own owner's** deposit-wallet — **not** an OutLayer-custodied EOA. You can't mint
a relayer key for an OutLayer-derived address (no Polymarket login as a custodied address).

**Consequence for the architecture (plan §6–7):** the multi-tenant "app sponsors each user's
OutLayer wallet" model needs the **Builder program / Builder HMAC credentials** (key/secret/passphrase),
NOT a personal relayer API key. Whether Builder HMAC permits an arbitrary `from` (sponsoring many user
wallets) is **undocumented** (docs silent on the `from`-vs-auth rule) — must be confirmed empirically
with real Builder creds, or with Polymarket. **Open + on the critical path for gasless OutLayer trading.**

Everything UP TO this point is proven live: custody, bridge (real $1, native USDC), OutLayer EVM signing,
OutLayer↔Polymarket L1 ClobAuth, deposit-wallet address derivation
(`0x56164B27FaA2E738747cE9D4951415cF69844550` for EOA `0x791c61b3…`, UUPS, cross-checked).

### 7a. PROVEN LIVE (gasless, builder-sponsored)
- **Builder HMAC auth sponsors arbitrary `from`.** With Builder API creds (key/secret/passphrase) +
  `BuilderConfig`, `RelayClient.deployDepositWallet()` **deployed the OutLayer deposit-wallet**
  `0x56164B27…` (from = OutLayer EOA, relayer paid gas, no EOA signature). This is the multi-tenant
  model: one app builder key sponsors every user's OutLayer wallet. **HIGH.**
- **Gasless EIP-3009 consolidation works.** OutLayer signed an EIP-3009 `transferWithAuthorization`
  (domain verified == on-chain `DOMAIN_SEPARATOR`); a `RelayClient.executeDepositWalletBatch` ran it
  → moved 0.994 USDC EOA→deposit-wallet, gasless. (Also requires `OutlayerClient` to serialize BigInt
  typed-data as strings — fixed.) **HIGH.**

### 7b. BLOCKER: native USDC vs USDC.e at the wrap — **HIGH (on-chain + contract source)**
- `CollateralOnramp` (`0x93070a847…`, permissionless `wrap(_asset,_to,_amount)`):
  **`paused(native USDC 0x3c49)=true`, `paused(USDC.e 0x2791)=false`** — it wraps **USDC.e only**. The
  contract has ONLY `wrap()` (no swap/native path). So our 1Click-delivered **native** USDC reverts
  (`batch would revert: execution reverted`).
- The deposit FORM accepts native USDC at 1:1 (no slippage) via the **`PermissionedRamp`**
  (`0xebC2459…`): `wrap/deposit(_asset,_to,_amount,_nonce,_deadline,_signature)` — a **witness signature
  from Polymarket's backend** authorizes the 1:1. **No public/builder API for that witness sig is
  documented.** So the clean native path is Polymarket-gated; we can't self-produce it.
- **Net:** for a programmatic gasless flow with our native USDC, the options are: (a) get OutLayer/1Click
  to deliver **USDC.e** (then permissionless `wrap`, no swap, no witness) — cleanest, but the 1Click
  catalog currently offers only native USDC for Polygon; (b) obtain Polymarket's witness/deposit API
  (ask Polymarket/OutLayer); (c) DEX-swap native→USDC.e (cents of slippage on a tight pool). Order min
  is ~$1; the form's "$3 Min" is the deposit-UX floor, separate.
