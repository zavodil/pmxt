# Feature request to OutLayer: EVM (secp256k1) signing under the existing wallet API

> _RU note for the OutLayer dev (Vadim's team): нам нужно, чтобы OutLayer-кошелёк умел
> подписывать EVM (Polygon) — деривировать адрес и подписывать EIP-712 / personal_sign / транзакции —
> за тем же `Bearer near:` + `seed` интерфейсом, что и NEAR. Ниже — точная спека и контекст._

**TL;DR.** Please add **EVM secp256k1 signing** to the agent-custody wallet API, exposed exactly
like the existing NEAR custody: same `Authorization: Bearer near:<…>` auth, same `seed`-derived
sub-wallet model, **server-side MPC signing with no raw key ever leaving the TEE**. We need: (1) EVM
address derivation per seed, (2) EIP-712 typed-data signing, (3) EIP-191 `personal_sign`, and
(4) raw EVM transaction signing/broadcast. This unblocks programmatic trading on Polymarket and other
EVM prediction-market venues while keeping the OutLayer trust model intact.

---

## 1. Context — what we're building and why we need this

We're building a "voulai for prediction markets": a chat agent that places bets on prediction
markets (Polymarket first). Custody and funding go through OutLayer / NEAR intents, exactly like
voulai today (per-user `seed`, hold USDC in intents, gasless swaps, cross-chain withdraw).

The execution layer is a fork of **pmxt** ("ccxt for prediction markets"). Every crypto venue pmxt
supports (Polymarket on Polygon, Limitless on Base/Polygon, Opinion on Polygon/BSC) settles on EVM
chains and authenticates orders with an **EVM key**:
- Trades are **off-chain EIP-712 signed orders** posted to the venue's CLOB API (the venue's operator
  does on-chain settlement — the trader does not pay per-trade gas).
- Getting a CLOB API key requires an **EIP-191 `personal_sign`** (L1 auth → derive/create API creds).
- Funding-in and cash-out (bridging USDC on/off the Polygon address) may require **on-chain EVM
  transactions** signed by the wallet.

Today OutLayer can hold the USDC in NEAR intents and **withdraw it cross-chain to a Polygon
address** — but it **cannot derive that Polygon address from a seed, nor sign anything EVM**
(`GET /wallet/v1/address?chain=` is NEAR-only; custody signing is ed25519-only). So we currently
have no way to control the Polygon side under OutLayer custody. This request closes that gap.

We do **not** want to hold raw EVM private keys ourselves — that would regress the whole OutLayer
value proposition (TEE / MPC, no app-held keys). We want EVM signing to work **the same way NEAR
signing does**: we hold one NEAR key, derive sub-wallets by seed, and the coordinator signs
server-side.

## 2. Baseline — what exists today (so the delta is clear)

Auth is stateless NEAR-signature (`crates/outlayer/src/signer.rs`):

```
Authorization: Bearer near:<base64url(JSON)>

JSON = {
  "account_id": "<app NEAR account>",
  "seed":       "<hex(sha256(app-identifier))>",   // selects the deterministic sub-wallet
  "pubkey":     "ed25519:<base58>",
  "timestamp":  <unix seconds>,
  "vault_id":   "<vault account>",                  // present only with a sovereign vault
  "signature":  "<base58 ed25519 sig>"
}
```
Signed message: `auth:{seed}:{ts}` — or `auth:{seed}:{ts}:{vault_id}` when a vault is bound (the
`vault_id` must be part of the signed bytes). The sub-wallet auto-creates on first authenticated
call. With a vault, sub-wallets derive under the **vault's MPC master**.

Existing endpoints we already use: `GET /wallet/v1/balance`, `GET /wallet/v1/address?chain=near`,
`GET /wallet/v1/tokens`, `POST /wallet/v1/intents/swap(+/quote)`, `POST /wallet/v1/intents/withdraw`
(supports `chain:"polygon"`), `POST /wallet/v1/deposit-intent`, `/confidential/*`,
`GET /wallet/v1/requests/{id}`.

## 3. What we need — the model

Add EVM signing **under the same auth, same seed-derivation**. The EVM key for a given
`(account_id [+ vault], seed)` is derived and signed **entirely inside the TEE** (in-enclave secp256k1
derivation from the wallet's master secret; in-enclave ECDSA), so:
- Same `seed` ⇒ same EVM address, forever (deterministic).
- The secp256k1 key **never leaves the TEE / is never returned to us**.
- Auth header is byte-for-byte the same `Bearer near:<…>` we already build.
- Signing is a **sub-ms local enclave op — no on-chain round-trip per signature** (fine for the order
  path).

_(Corrected per OutLayer's reply: this is **not** NEAR chain-signatures. The NEAR MPC network is used
once, via Confidential Key Derivation, to deliver the master secret into the enclave — not as a
per-signature oracle. The recoverable-signature path (keccak prehash, `r‖s‖v`, low-s) is genuinely new
work for OutLayer, not a flag-flip.)_

## 4. Proposed API (mirrors `wallet/v1` conventions)

All endpoints take the existing `Bearer near:` auth and the `seed` is taken from it (same as every
other wallet method). `chain` ∈ {`polygon`, `ethereum`, `base`, `arbitrum`, `bsc`, `optimism`,
`avalanche`} (EVM). Amounts/data follow existing conventions (hex `0x…` for EVM bytes).

### 4.1 EVM address derivation — extend `GET /wallet/v1/address`
```
GET /wallet/v1/address?chain=polygon
→ 200 { "address": "0xabc…", "public_key": "0x04…", "chain": "polygon", "wallet_id": "…" }
```
Just allow EVM `chain` values (today non-`near` returns `UnsupportedChain`). For EVM, `address` is the
0x EOA derived from the seed's secp256k1 key; `public_key` is the uncompressed/compressed secp256k1
pubkey. (Same address across all EVM chains is fine and expected.)

### 4.2 EIP-712 typed-data signing — `POST /wallet/v1/evm/sign-typed-data`
The core trading primitive (signs CLOB orders).
```
POST /wallet/v1/evm/sign-typed-data
{
  "chain": "polygon",
  "typed_data": {                 // standard EIP-712 v4 object (as eth_signTypedData_v4)
    "domain":      { "name": "...", "version": "...", "chainId": 137, "verifyingContract": "0x..." },
    "types":       { "EIP712Domain": [...], "Order": [...] },
    "primaryType": "Order",
    "message":     { ... }
  }
}
→ 200 { "signature": "0x<r||s||v, 65 bytes>" }
```
Semantics: identical to MetaMask/viem `signTypedData` (EIP-712 v4). `v ∈ {27,28}` (or 0/1 — please
document which; we normalize). `ecrecover` over the EIP-712 digest MUST return the §4.1 address.

### 4.3 EIP-191 `personal_sign` — `POST /wallet/v1/evm/sign-message`
**Likely optional / fallback.** Polymarket's L1 auth (derive/create CLOB API key) signs a structured
**EIP-712 `ClobAuth` struct**, not a raw `personal_sign` — so §4.2 already covers it. Provide
`sign-message` anyway as a cheap fallback in case some venue/SDK path needs raw EIP-191; defer if a
spike shows nothing requires it.
```
POST /wallet/v1/evm/sign-message
{ "chain": "polygon", "message": "0x<bytes>"  }   // or a UTF-8 string; please support hex bytes
→ 200 { "signature": "0x<65 bytes>" }
```
Semantics: EIP-191 `personal_sign` — i.e. sign `keccak256("\x19Ethereum Signed Message:\n" + len + msg)`.

### 4.4 Raw EVM transaction signing — `POST /wallet/v1/evm/sign-transaction`
Needed for funding/cash-out on-chain steps (USDC `approve`, bridge-back ERC-20 transfer, possible
proxy setup). Whether the MVP trading path needs this is being confirmed in a hands-on spike — but
the **cash-out path (Polygon → NEAR intents) almost certainly needs at least one on-chain transfer**,
so please plan for it.
```
POST /wallet/v1/evm/sign-transaction
{
  "chain": "polygon",
  "tx": {                          // EIP-1559 fields; you fill nonce/gas if omitted, or we provide
    "to": "0x...", "data": "0x...", "value": "0x0",
    "nonce": 12, "chainId": 137,
    "maxFeePerGas": "0x...", "maxPriorityFeePerGas": "0x...", "gas": "0x..."
  }
}
→ 200 { "raw_signed_tx": "0x...", "tx_hash": "0x..." }
```

### 4.5 (Optional but very helpful) broadcast — `POST /wallet/v1/evm/send-transaction`
Same body as 4.4 but you broadcast via your Polygon RPC and return the hash (async like withdraws,
with `request_id` polling). Saves us running an RPC + nonce manager.
```
→ 200 { "request_id": "...", "status": "submitted", "tx_hash": "0x..." }
```
### 4.6 Gas management — pay gas in USDC, **no manual POL deposit step** (first-class requirement)

**Hard requirement: the caller must never have to pre-fund each EVM wallet with native POL.** That
per-wallet "deposit POL for gas" step is operationally unacceptable at scale. We're fine with gas being
*paid* (e.g. out of withdrawal proceeds) — we just don't want POL as a separate asset we manage. So gas
must be **paid in USDC / sponsored**, debited from the wallet's own balance. Please support one of:
- **(a) OutLayer fronts gas (preferred, EOA-compatible):** when a tx needs broadcasting, OutLayer pays
  the POL from its own pool and debits the USDC equivalent from the wallet's intents balance. From our
  side there is **no POL step at all** — only USDC is spent.
- **(b) ERC-4337 smart-account + USDC paymaster:** the wallet pays gas in USDC from its own balance.
  Cleaner, but it's a smart-account (not a bare EOA) — more work on your side.
- **(c) least-preferred fallback:** expose native-POL `withdraw-to-self` so we pre-fund a float
  ourselves. This is the step we're explicitly trying to avoid; offer it only if (a)/(b) aren't feasible.

Notes that make this cheaper than it sounds: on the **entry** side for Polymarket V2, the venue's own
relayer already sponsors deploy + approvals (no POL needed there); gas is really only unavoidable on the
**exit** transfer — which comes out of proceeds anyway. With gas solved at the wallet layer this way, the
same OutLayer EVM wallet serves Polymarket, Limitless, Opinion, and any future EVM venue with **no
per-venue relayer code on our side**.

## 5. Auth — unchanged

No change to the bearer construction. The same `Bearer near:<…>` (with `seed`, optional `vault_id`)
authorizes these EVM endpoints. The `seed` selects which EVM sub-wallet signs — identical to how it
selects the NEAR sub-wallet today.

## 6. Acceptance criteria (how we'll validate)

1. `GET /wallet/v1/address?chain=polygon` returns a stable 0x address for a fixed seed across calls.
2. Sign a known **EIP-712 Polymarket CLOB order**; `ecrecover` over its digest == that address;
   Polymarket's CLOB accepts the order.
3. Sign an **EIP-191** message; `personal_ecRecover` == that address; Polymarket `deriveApiKey`
   succeeds.
4. Sign + broadcast a **USDC ERC-20 `approve`** (or transfer) from that EOA on Polygon; it lands
   on-chain.
5. Two different seeds ⇒ two different EVM addresses; same seed ⇒ same address every time.

## 7. Priority / scope for our MVP (refined after a code + docs investigation)

- **P0 — unblock placing orders:** §4.1 EVM address derivation + §4.2 EIP-712 typed-data signing.
  Polymarket order placement **and** L1 auth are both EIP-712; placing an order is otherwise
  gasless/off-chain.
- **P0 — unblock the round trip:** §4.4 raw EVM tx **sign + broadcast** (and ideally §4.5). The EXIT
  (push USDC into the 1Click deposit address) is an on-chain ERC-20 transfer the custodied key must
  sign+send; the V2 deposit-wallet path also needs a pUSD wrap + a funding transfer. Without raw-tx
  signing there is no self-contained cash-out. **This is the biggest gap** — pmxt only ever uses the
  key as a message signer, never broadcasts.
- **P0 — gas float:** native **POL/MATIC withdraw-to-self** on Polygon (or OutLayer gas sponsorship).
  The EOA needs ~0.02 POL to pay for the exit/wrap/funding txs. Verified: per-trade is gasless, but the
  fund→trade→exit lifecycle needs POL at the boundaries.
- **Optional / defer:** §4.3 EIP-191 personal_sign (fallback only); EIP-3009 (not needed —
  bridged USDC.e isn't EIP-3009-compatible).

## 8. Open questions for OutLayer

1. Can the same seed derive **both** the NEAR custody sub-wallet **and** an EVM sub-wallet, or do you
   want a chain-scoped seed/derivation path? (We'd prefer same seed, `chain` param selects.)
2. `v` convention in returned signatures (27/28 vs 0/1) and EIP-712 vs EIP-155 normalization.
3. Native-gas (MATIC/POL) handling for `send-transaction`: sponsor vs we pre-fund via
   `intents/withdraw chain=polygon token=native`.
4. Any per-wallet approval policy (like the NEAR `pending_approval` flow in `WithdrawResponse`) you'd
   apply to EVM txs?
5. Rate limits / latency target for `sign-typed-data` (it's on the user-facing order path).

---

_Contact: voulai/ai-intents team. This request lives in the pmxt fork repo alongside
`OUTLAYER_INTEGRATION_PLAN.md`._
