# Polymarket × OutLayer backend spec (native USDC) — for an implementing AI agent

**Audience:** an AI agent building the backend service. This is an implementation contract, not a tutorial.
**What you are building:** a multi-tenant service where each user/agent gets an isolated, OutLayer-custodied
wallet that trades on Polymarket V2 (Polygon), funded/withdrawn in **native USDC**, **fully gasless**.
**Custody model:** OutLayer holds keys and *signs*; the Polymarket builder relayer + 1Click *pay gas*.
Every step below was executed live with real money on 2026-06-15 (record: [PHASE2_LIVE_TRADE.md](PHASE2_LIVE_TRADE.md)).

---

## 0. GOLDEN RULES (violating any of these breaks the system — enforce in code)

- **R1** Funds move ONLY via the user's OutLayer signature. The builder key pays gas; it CANNOT move funds.
- **R2** Use **native Circle USDC** everywhere (`0x3c499c54…`). NEAR intents / OutLayer 1Click reject USDC.e.
- **R3** Set Polymarket `signatureType = 3` **explicitly** + `funderAddress = depositWallet`. Nothing auto-detects it.
- **R4** All amounts in API bodies are **integer strings in the token's smallest unit** (USDC/pUSD = 6 dp →
  `2.106871 USDC` = `"2106871"`). Never send floats/decimals to the APIs.
- **R5** Mint a fresh `Bearer near:` token **per request** (validity ≈ ±30 s). Cache derived *addresses*, never tokens.
- **R6** Never send a native (gas-paying) transaction from a user EOA — it holds no POL. All on-chain writes
  go through the builder relayer (deposit-wallet batches) or 1Click.
- **R7** `toChainId` in `/withdraw` is a **string** (`"137"`).
- **R8** `deposit-intent` for Polygon uses `{chain:"polygon", token:"USDC"}` — NOT `source_asset:"nep245:…"`.
- **R9** The OutLayer NEAR private key is server-side only. The user supplies only `userId`; you sign for them.
- **R10** Do not implement the on-chain USDC↔USDC.e swap. That is a backup path only
  ([BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md)); the bridge services handle conversion internally.

---

## 1. IDENTIFIERS (data model — derive, don't store secrets)

Per user, everything is a deterministic function of `userId`:

- `userId` — YOUR app's identifier for the user/agent (DB id, NEAR name, anything). The only thing you persist.
- `seed` = `sha256("predict:user:<userId>")` — hex; the OutLayer wallet selector. Charset `[a-zA-Z0-9._-]` (no `:`).
- `eoa` — the user's Polygon EOA (owner/signer). From OutLayer `GET /wallet/v1/address?chain=polygon`.
- `depositWallet` — Polymarket sigType-3 smart wallet, CREATE2 from `eoa`. Holds pUSD + positions; trades.
- `bridgeIn` — per-`depositWallet` deposit address from `POST bridge.polymarket.com/deposit` (deposits land here).
- `bridgeOut` — per-request withdraw address from `POST bridge.polymarket.com/withdraw` (send pUSD here to exit).
- `clobCreds` — Polymarket CLOB API key/secret/passphrase, derived once per user (L1 ClobAuth, OutLayer-signed).

App-level singletons (shared across ALL users): one OutLayer NEAR account+key (derivation root) and one
Polymarket builder HMAC cred set (gas sponsor + fee attribution).

---

## 2. CONFIG CONTRACT (env)

```bash
OUTLAYER_API_BASE=https://api.outlayer.fastnear.com        # fixed
POLYMARKET_RELAYER_URL=https://relayer-v2.polymarket.com   # fixed
POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com     # any Polygon RPC

# OutLayer auth — Model A (multi-tenant, REQUIRED for per-user isolation):
OUTLAYER_ACCOUNT_ID=<any>.near            # any real on-chain NEAR account you control
OUTLAYER_NEAR_PRIVATE_KEY=ed25519:<...>   # its full-access key; SERVER-SIDE ONLY
# OutLayer auth — Model B (single wallet, no derivation): OUTLAYER_API_KEY=wk_...  (mutually exclusive)

# Polymarket builder (sponsors gas for all users + fee attribution):
POLYMARKET_BUILDER_API_KEY=<uuid>
POLYMARKET_BUILDER_SECRET=<base64>
POLYMARKET_BUILDER_PASSPHRASE=<hex>
POLYMARKET_BUILDER_CODE=0x...             # bytes32 builder code
```

**Obtaining builder creds** (human, one-time): polymarket.com/settings?tab=builder → connect the builder
wallet → register (mints `POLYMARKET_BUILDER_CODE`) → Builder Keys → "+ Create New" reveals key/secret/passphrase
once. HMAC creds let the relayer sponsor gas for ANY `from` → one set serves all users.
`OUTLAYER_ACCOUNT_ID`+key: any existing NEAR account + its full-access key. **Model A vs B:** A derives a
distinct wallet per `seed` (use for multi-tenant); B is one fixed `wk_` wallet, no derivation.

npm deps (in `core`): `@polymarket/clob-client-v2`, `@polymarket/builder-relayer-client`,
`@polymarket/builder-signing-sdk`, `viem`. Integration code: `core/src/integrations/outlayer/`.

---

## 3. LIFECYCLE (the flow as a list — replaces the diagram)

Per user, in order. Steps marked **[once]** run a single time per user; **[each]** run per operation.

1. **AUTH [each]** — mint a seed-scoped `Bearer near:` token for `userId` (§4).
2. **DERIVE [once, then cache]** — `eoa` ← OutLayer; `depositWallet` ← CREATE2(`eoa`) (§5).
3. **SETUP [once]** — deploy `depositWallet` + set token approvals, gasless via builder relayer (§6).
4. **DEPOSIT [each]** — native USDC: NEAR intents → 1Click → `bridgeIn` → service swaps+wraps → pUSD in `depositWallet` (§7).
5. **BID [each]** — derive/load `clobCreds`; place CLOB order (sigType 3), off-chain, OutLayer-signed (§8).
6. **EXIT MARKET [each]** — sell, or redeem after resolution → pUSD back in `depositWallet` (§9).
7. **WITHDRAW HOME [each]** — pUSD → `/withdraw` service → native USDC → 1Click → NEAR intents (§10).
8. **PAYOUT [each]** — intents transfer USDC to any NEAR account (§11).

Money path proven live: in ~2.1 USDC → bet → out ~2.1069 USDC back in NEAR intents → paid out. ≈ no loss, zero gas on user wallets.

---

## 4. PROCEDURE: AUTH — mint a per-user token

- **Goal:** an `Authorization` header scoped to `userId`'s wallet.
- **Inputs:** `userId`, app NEAR account+key.
- **Token structure** (rebuild every request):
  1. `seed = sha256("predict:user:<userId>")`
  2. `timestamp = now_ms`; `message = "auth:<seed>:<timestamp>"`
  3. `signature = ed25519_sign(message, OUTLAYER_NEAR_PRIVATE_KEY)`
  4. `token = base64url(JSON{ account_id, seed, pubkey, timestamp, signature })`
  5. header = `Authorization: Bearer near:<token>`
- **Implementation:**
  ```ts
  import { NearAuth, SeedBearerAuth } from 'core/src/integrations/outlayer';
  const near = new NearAuth(process.env.OUTLAYER_ACCOUNT_ID!, process.env.OUTLAYER_NEAR_PRIVATE_KEY!);
  const auth = (userId: string) =>
    new SeedBearerAuth(near, NearAuth.seedFor(`predict:user:${userId}`)); // auth.header() → { Authorization }
  ```
- **Isolation invariant:** OutLayer verifies `signature` against `account_id` then scopes the call to `seed`.
  A token minted for user A can only touch A's wallet.
- **Model B:** skip all of the above; header = `Authorization: Bearer wk_<key>` (single wallet, no `userId`).
- **Errors:** `401 not an access key` → `account_id` is not a real on-chain NEAR account, or key mismatch.
  Expired-window errors → clock skew; resync, mint fresh.

---

## 5. PROCEDURE: DERIVE addresses [once per user, cache]

- **Step 1 — EOA:** `GET {OUTLAYER_API_BASE}/wallet/v1/address?chain=polygon`, headers: AUTH (§4).
  Response `{address}` → `eoa`. (First call auto-creates the sub-wallet.)
- **Step 2 — deposit-wallet (CREATE2, no network):**
  ```ts
  import { deriveDepositWallet, RelayClient } from '@polymarket/builder-relayer-client';
  const depositWallet = deriveDepositWallet(eoa, FACTORY, IMPL); // === RelayClient.deriveDepositWalletAddress()
  ```
  - `walletId = bytes32(eoa)`; `salt = keccak256(abi.encode(FACTORY, walletId))`;
    `address = CREATE2(FACTORY, salt, ERC1967-clone-initcode(IMPL))`.
  - `FACTORY = 0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`, `IMPL = 0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB`.
- **Postcondition:** persist `eoa`, `depositWallet`, and a reverse index `depositWallet → userId`.
- **Idempotent:** pure function of `seed`. Same `userId` → same addresses forever.

---

## 6. PROCEDURE: SETUP — deploy deposit-wallet + approvals [once per user]

- **Precondition:** `eoa`, `depositWallet` known. **Who pays gas:** builder relayer (gasless for user).
- **Steps:**
  ```ts
  import { RelayClient } from '@polymarket/builder-relayer-client';
  import { BuilderConfig } from '@polymarket/builder-signing-sdk';
  import { toSignerAccount, OutlayerSigner } from 'core/src/integrations/outlayer';
  import { createWalletClient, http, encodeFunctionData, maxUint256 } from 'viem';

  const wallet = createWalletClient({ account: await toSignerAccount(signer), chain: polygon, transport: http(RPC) });
  const rc = new RelayClient(POLYMARKET_RELAYER_URL, 137, wallet,
              new BuilderConfig({ localBuilderCreds: { key, secret, passphrase } }));

  await rc.deployDepositWallet();                 // 1) deploy (WALLET-CREATE; no signature)
  await rc.executeDepositWalletBatch([            // 2) approvals (one batch)
    { target: PUSD, value:'0', data: approve(CTF_EXCHANGE_V2, maxUint256) },
    { target: PUSD, value:'0', data: approve(NEG_RISK_EXCHANGE, maxUint256) },
    { target: PUSD, value:'0', data: approve(NEG_RISK_ADAPTER, maxUint256) },
    { target: CTF,  value:'0', data: setApprovalForAll(CTF_EXCHANGE_V2, true) },
    { target: CTF,  value:'0', data: setApprovalForAll(NEG_RISK_EXCHANGE, true) },
    { target: CTF,  value:'0', data: setApprovalForAll(NEG_RISK_ADAPTER, true) },
  ], depositWallet, String(deadline));
  ```
  (`approve`/`setApprovalForAll` via `viem.encodeFunctionData`. `signer` = `OutlayerSigner` from §4 auth.)
- **Idempotent:** safe to re-run; deploy no-ops if already deployed, approvals re-set idempotently. Persist a
  `setupDone` flag to skip.

---

## 7. PROCEDURE: DEPOSIT — native USDC → pUSD in deposit-wallet [each]

- **Precondition:** user has USDC in their OutLayer intents balance (fund step is your product's concern:
  user deposits via OutLayer fund link or cross-chain `deposit-intent`).
- **Step 1 — get bridge-in** (per `depositWallet`, deterministic):
  `POST https://bridge.polymarket.com/deposit`, headers `Content-Type: application/json`,
  `X-Builder-Code: <POLYMARKET_BUILDER_CODE>`, body `{"address":"<depositWallet>"}`.
  Response `{address:{evm,svm,tron,btc}}` → `bridgeIn = address.evm`. **Min deposit $2.**
- **Step 2 — move native USDC intents → bridgeIn** (1Click; gas: 1Click solver):
  `POST {OUTLAYER_API_BASE}/wallet/v1/intents/withdraw`, headers AUTH,
  body `{"chain":"polygon","to":"<bridgeIn>","amount":"<usdc_6dp>","token":"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}`.
- **Step 3 — service swaps+wraps** internally → pUSD credited to `depositWallet`.
- **Verify (poll):** on-chain `pUSD.balanceOf(depositWallet)` increases above baseline (pUSD `0xC011a7E1…`).
  Check INCREASE vs a captured baseline, not absolute > 0 (avoids matching pre-existing dust).
- **Shortcut:** if the user already holds native USDC on Polygon, skip steps 1–2 of funding and send straight to `bridgeIn`.
- **Errors:** below $2 → silently not credited (enforce min). USDC.e sent → not accepted home later (R2).

---

## 8. PROCEDURE: BID — place a CLOB order [each]

- **Precondition:** pUSD balance ≥ `amount * 1.04` (taker fee ≈ 3.5%); `amount ≥ ~$1` (order min).
- **Steps:**
  ```ts
  import { PolymarketOutlayerExchange } from 'core/src/integrations/outlayer';
  const ex = new PolymarketOutlayerExchange(
    { signatureType: 3, funderAddress: depositWallet },   // R3 — explicit
    signer);                                               // OutLayer-backed
  await ex.initAuth();                                     // L1 ClobAuth (OutLayer-signed) → clobCreds; CACHE per user
  const order = await ex.createOrder({
    marketId: '<conditionId>', outcomeId: '<CLOB token id>',
    side: 'buy', type: 'market', amount: 1.9,             // market BUY: amount = USDC to spend
  });                                                      // → off-chain EIP-712 (ERC-7739), POST /order; gasless
  ```
- **Order forms:** market BUY `amount` = USDC; SELL `amount` = share count; `type:'limit'` adds `price` (0..1).
- **Discovery:** `PolymarketExchange.fetchMarkets(...)` → `market.yes/no.outcomeId`. 5-min BTC slug:
  `btc-updown-5m-<unix_5min_boundary>`.
- **Cancel:** `ex.cancelOrder(orderId)`. **Positions:** ERC-1155 held by `depositWallet`.
- **Errors:** `not enough balance`/fee → shrink `amount`. `allowance is not enough` → SETUP (§6) not done.

---

## 9. PROCEDURE: EXIT MARKET → pUSD [each]

- **Before resolution:** `ex.createOrder({ side:'sell', type:'market'|'limit', outcomeId, amount:<shares> })`
  (gasless; proceeds → pUSD in `depositWallet`).
- **After resolution (won):** redeem winning ERC-1155 via Conditional Tokens `redeemPositions` in a gasless
  builder-relayer batch from `depositWallet`. Losing shares = $0.
- **Postcondition:** pUSD in `depositWallet`, ready to withdraw.

---

## 10. PROCEDURE: WITHDRAW HOME — pUSD → native USDC → NEAR intents [each]

Production-clean: withdraw straight to the 1Click bridge (no EOA hop, no EIP-3009).

- **Step 1 — 1Click deposit address** (native USDC → user's NEAR intents):
  `POST {OUTLAYER_API_BASE}/wallet/v1/deposit-intent`, headers AUTH,
  body `{"chain":"polygon","token":"USDC","amount":"<usdc_6dp>"}` (R8). Response `{deposit_address}` → `oneClickAddr`.
- **Step 2 — request withdraw** (native USDC straight to `oneClickAddr`):
  `POST https://bridge.polymarket.com/withdraw`, headers `Content-Type: application/json`,
  `X-Builder-Code: <POLYMARKET_BUILDER_CODE>`,
  body `{"address":"<depositWallet>","toChainId":"137","toTokenAddress":"0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359","recipientAddr":"<oneClickAddr>","amount":"<pusd_6dp>"}`
  (R7: `toChainId` string). Response `{address:{evm}}` → `bridgeOut = address.evm`.
- **Step 3 — send pUSD to bridge-out** (gasless relayer batch):
  ```ts
  await rc.executeDepositWalletBatch(
    [{ target: PUSD, value:'0', data: transfer('<bridgeOut>', pusdAmount) }],
    depositWallet, String(deadline));
  ```
- **Step 4 — service** unwraps+swaps → native USDC → `oneClickAddr` → 1Click → user's NEAR intents.
- **Verify:** `GET {OUTLAYER_API_BASE}/wallet/v1/balance?source=intents&token=nep141:17208628…` increases.
- **Why this shape:** native USDC required for NEAR (R2); NEAR isn't a Polymarket withdraw chain, so land native
  USDC on the 1Click address and let OutLayer do the NEAR leg; `recipientAddr=oneClickAddr` avoids the gasless
  EOA (R6). *(Alt: withdraw to the EOA then move EOA→oneClickAddr via an EIP-3009 `transferWithAuthorization`
  in a relayer batch — see PHASE2 §5d. Not needed for the clean path.)*
- **Caveats:** withdraw min applies; very small amounts may strand as dust.

---

## 11. PROCEDURE: PAYOUT — intents transfer to a NEAR account [each]

- `POST {OUTLAYER_API_BASE}/wallet/v1/intents/transfer`, headers AUTH,
  body `{"to":"<near_account>","amount":"<usdc_6dp>","token":"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}`.
  Response `{request_id,status}`. Gasless; recipient credited in their intents balance.
- For an on-chain payout (plain wallet/exchange), use `/wallet/v1/intents/withdraw` with target `chain`+`to`.

---

## 12. PERSISTENCE (minimal backend schema)

Per-user row (all cacheable, all derivable from `userId`):

- `userId` (PK) — derivation root; `seed = sha256("predict:user:"+userId)` (do not store the seed/key).
- `eoa`, `depositWallet`, `bridgeIn` — cache to avoid re-derivation.
- `clobApiKey`, `clobSecret`, `clobPassphrase` — derived once (§8 `initAuth`); cache.
- `setupDone` (bool) — §6 completed.
- Reverse index `depositWallet → userId` — to attribute incoming deposits.

App-level singletons: OutLayer NEAR key, builder HMAC creds + builder code. NEVER per-user.

---

## 13. CONTRACTS / ENDPOINTS (Polygon, chainId 137)

| name | value |
|---|---|
| pUSD (collateral) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| native Circle USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| USDC.e (do not use) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| CTF Exchange V2 | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Neg-Risk Exchange V2 | `0xe2222d279d744050d28e00520010520000310F59` |
| Neg-Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |
| Conditional Tokens (ERC-1155) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| Deposit-Wallet Factory | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` |
| Deposit-Wallet impl | `0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB` |
| NEAR intents USDC (token id) | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| OutLayer API | `https://api.outlayer.fastnear.com` |
| Polymarket deposit svc | `POST https://bridge.polymarket.com/deposit` |
| Polymarket withdraw svc | `POST https://bridge.polymarket.com/withdraw` |
| Builder relayer | `https://relayer-v2.polymarket.com` |

---

## 14. ERROR / EDGE CATALOG (all observed live)

- `401 not an access key` → `OUTLAYER_ACCOUNT_ID` not a real NEAR account / wrong key. (§4)
- `unknown struct type 'EIP712Domain'` (OutLayer sign-typed-data) → OutLayer REQUIRES `EIP712Domain` in
  `types`; the `OutlayerSigner` already reconstructs it. Don't strip it.
- `Do not know how to serialize a BigInt` → typed-data uint256 must serialize as decimal strings; handled in
  `OutlayerClient` (`transformRequest`). Reuse that client.
- relayer `from ... does not match auth ...` → you used the personal Relayer API key (binds `from==owner`).
  Use **builder HMAC** creds instead (sponsor arbitrary `from`).
- `batch would revert` on wrap → native USDC is paused on the onramp. Don't wrap yourself; use the deposit
  service (R10).
- order `not enough balance` / fee → `amount + ~3.5% fee` must be ≤ pUSD balance; min order ≈ $1.
- order `allowance is not enough` → run SETUP approvals (§6).
- deposit-intent `Only NEP-141 supported` → you sent `source_asset:"nep245:…"`; use `{chain,token}` (R8).
- false-positive "credited" → compare pUSD/intents balance against a captured baseline, not absolute.
- `clob-client-v2` sigType-3 L1-auth bug (#65/#70): may bind the API key to the EOA not the deposit-wallet.
  Did NOT block orders in our live run — but validate per environment.
- Non-signable hop: deposit/withdraw bridge-in/out are Polymarket-operated (per-user, not shared); funds are
  in Polymarket custody only during that brief hop. Self-custodial alternative = backup
  ([BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md)).

---

## 15. CODE MAP (existing modules + reference scripts)

- `core/src/integrations/outlayer/` — `NearAuth`, `SeedBearerAuth`/`WkBearerAuth`, `OutlayerClient`,
  `OutlayerSigner`, `toSignerAccount`, `PolymarketOutlayerAuth`/`PolymarketOutlayerExchange`,
  `polymarket-v2-contracts.ts` (addresses), barrel `index.ts`.
- `core/src/server/outlayer-routes.ts` — additive HTTP router (extend for your backend endpoints).
- Scripts (`core/scripts/`, run from `core/`): `outlayer-livecheck.ts` (signing seam, zero funds),
  `outlayer-fund-setup.ts`, `outlayer-fund-withdraw.ts`, `outlayer-deposit-wallet-deploy.ts`.
- Companion docs: [PHASE2_LIVE_TRADE.md](PHASE2_LIVE_TRADE.md) (live run + addresses),
  [OUTLAYER_INTEGRATION_PLAN.md](OUTLAYER_INTEGRATION_PLAN.md), [PHASE0_FINDINGS.md](PHASE0_FINDINGS.md),
  [BACKUP_USDCE_SWAP_PATH.md](BACKUP_USDCE_SWAP_PATH.md) (fallback only).
