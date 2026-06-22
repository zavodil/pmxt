# OutLayer response — EVM (secp256k1) signing

> Reply to `OUTLAYER_EVM_SIGNING_REQUEST.md` and `OUTLAYER_INTEGRATION_PLAN.md` §6–7, §10.
> Status: **v1 accepted (your reply).** This revision adds **§7** — confirming arbitrary EIP-712
> signing + a security caveat the gasless-exit design surfaces. Author: OutLayer dev.

## TL;DR

We'll ship your **P0** — §4.1 address derivation, §4.2 EIP-712, §4.3 EIP-191 — as a thin
**off-chain signing surface**: we return signatures only. **No broadcast, no gas, no nonce, no RPC
on our side**, gated by a single per-wallet on/off permission. Raw EVM tx signing (§4.4) is a
**fast-follow** under the **same** on/off permission (no per-tx allowlist — see §3); broadcast (§4.5)
we **decline** — you broadcast. One correction to the trust-model wording below; it changes nothing
you build, but please fix the doc so expectations are right.

This matches your stated priorities: §4.1–4.3 = P0; §4.4 = "after the spike"; §4.5 = nice-to-have.

---

## 1. Correction: it is **not** chain-signatures (and that's better for you)

Your §2/§6 state the underlying primitive is *"NEAR chain-signatures MPC, already
secp256k1-capable, so it's an API-surface addition, not new cryptography."* That is **not how our
custody works**, and the distinction matters for your latency/security expectations:

- We do **not** route custody signing through NEAR chain-signatures. The sub-wallet's secp256k1 key
  is **derived and signed entirely inside the TEE** (`HMAC-SHA256(master, seed)` → secp256k1 scalar;
  ECDSA in-enclave). The NEAR MPC network is used **once**, via Confidential Key Derivation (CKD), to
  deliver the 32-byte master secret into the enclave — it is not a per-signature signing oracle.
- **Your trust-model framing is correct** ("no raw key ever leaves the TEE"). Only the *mechanism*
  label is wrong.
- **Why this is good for you:** in-enclave signing is a sub-millisecond local op — **no on-chain
  round-trip per signature**. If it really were chain-signatures, every CLOB order signature would be
  a multi-second on-chain MPC call, which is unusable on a user-facing order path. The as-built
  design is the one you want; just drop the "chain-signatures" wording.

Practical implication for §4.2/§4.3: producing an EVM signature is **not** "already done" on our side.
The secp256k1 key derivation and EVM address derivation exist, but the recoverable-signature path
(keccak prehash + `r‖s‖v` + low-s) is new work for us. It's bounded and we own it — flagging so the
timeline is realistic, not "flip a flag."

---

## 2. What we'll ship — v1

Auth is **unchanged**: the same `Authorization: Bearer near:<base64url(JSON)>` with `seed`
(+ optional `vault_id`) you already build. `seed` selects the EVM sub-wallet exactly as it selects the
NEAR one.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/wallet/v1/address?chain=<evm>` | — | `{ address: "0x..", public_key: "secp256k1:..", chain }` |
| POST | `/wallet/v1/evm/sign-typed-data` | `{ chain, typed_data: {domain,types,primaryType,message} }` | `{ signature: "0x..(65 bytes)" }` |
| POST | `/wallet/v1/evm/sign-message` | `{ chain, message }` (hex `0x..` or utf-8) | `{ signature: "0x..(65 bytes)" }` |

Contract details:

- **One EVM address across all EVM chains.** We canonicalize derivation so `polygon`, `ethereum`,
  `base`, `arbitrum`, … for a given `(account_id[+vault], seed)` all resolve to the **same** `0x` EOA,
  deterministic forever. (Confirm this is what you want — it's the standard EVM mental model and what
  we'll implement.)
- **sign-typed-data:** send the standard EIP-712 v4 `typed_data` object (as `eth_signTypedData_v4`).
  We compute the EIP-712 digest **server-side** (domain separator + `hashStruct`) and ECDSA-sign it.
  `ecrecover` over that digest **== the derived address** (the one from `GET /address`).
- **sign-message:** EIP-191 `personal_sign` — we prefix `"\x19Ethereum Signed Message:\n"+len`, keccak,
  sign. Hex `0x..` bytes **and** UTF-8 strings supported.
- **Signature format:** 65-byte `0x` `r‖s‖v`, **`v ∈ {27,28}`**, low-s normalized (EIP-2). Documented
  per endpoint.
- **Permission model:** EVM signing is gated by a single per-wallet capability (`evm_sign`,
  allow/deny, optional chain list). **Default agent wallets (no restrictive on-chain policy) sign out
  of the box** — same as raw ed25519 signing today; only wallets that have a restrictive policy must
  opt in. **No per-order approval flow** (it would kill order latency). **No contract change** — the
  capability rides inside the existing encrypted policy blob.

That's it for v1. Off-chain, no funds infra on our side.

**You can build against this contract now.** Code your `SignerProvider` / `OutlayerSigner` against the
shapes above with your `LocalKeySigner` stand-in (your plan §5 / §9 Phase 1). The contract is stable;
swapping the local key for live OutLayer signing is an implementation change, not a redesign.

---

## 3. What we defer / decline

- **§4.4 `sign-transaction` (raw EVM tx) — fast-follow after v1, not a security gate.** It lands after
  §4.1–4.3 purely on engineering sequencing: it needs EIP-1559 tx encoding (RLP + sighash) on our side
  and you don't need it for the off-chain order path (your own priority puts it "after the spike").
  **Permission model is the same single `evm_sign` capability** — we sign the tx you send, no per-call
  inspection. We are **not** building a `to`/selector allowlist, and on reflection one wouldn't help:
  the legitimate exit recipient is a **single-use, per-withdraw 1Click deposit address** that can't be
  statically allowlisted, and filtering the recipient *inside* calldata would be exactly the policy
  engine we're avoiding. The residual risk is explicit: a compromised caller can drain the EOA float
  via a raw `transfer` — but it can already bleed that float via crafted orders, and your **home
  balance in NEAR intents is never exposed to any EVM signature**. The real boundary is the capability
  toggle + how much float you park (§4), not per-tx checks.
  - *Sub-flag (you chose this):* raw-tx sits behind its **own** `evm_sign.raw_tx` (default-off),
    separate from order/message signing. **Caveat (see §7):** this isolates *arbitrary raw
    transactions* (contract calls, native value), but it does **not** contain USDC drains — those are
    expressible as EIP-3009/2612 **typed-data** and ride the always-on `evm_sign`.
- **§4.5 `send-transaction` (broadcast) — declined.** We return `raw_signed_tx`; you broadcast via your
  own Polygon RPC + nonce manager. You already run that infra; we don't, and adding it buys little.

---

## 4. The funding boundary, and one concrete gotcha

The off-chain model is safe precisely **because the Polygon EOA only ever holds what you deliberately
bridge there** — the blast radius of EVM signing is bounded to that float, not the user's home
balance in NEAR intents. **Float-sizing is your (voulai's) call**, not ours: don't park more on
Polygon than a session needs.

**Gotcha on the POL gas float (your §7 / §10).** You plan to source POL via
`intents/withdraw {chain:"polygon", token:native-POL, to:<EOA>}`. Two problems from our side:

1. Our cross-chain withdraw **rejects a native source token** — you must specify a `nep141` source
   asset (e.g. `nep141:wrap.near` or a USDC nep141), not "native".
2. Whether 1Click **delivers native POL** to the EOA as the destination asset is a **1Click-catalog**
   question we can't answer from our code. **Verify with a withdraw dry-run before depending on it.**

If 1Click won't deliver native POL, gas-float needs a path we **don't have today** (we do not sponsor
gas). Resolve this in Phase 0 — it's on the critical path for both entry (pUSD wrap) and exit.

---

## 5. Answers to your open questions (request §8 / plan §10)

1. **Same seed for NEAR and EVM?** Yes — the same user `seed`; internally we use a distinct
   curve-domain suffix per chain class, so NEAR and EVM keys differ (correct domain separation) while
   both stay deterministic. `chain` selects.
2. **`v` convention?** `r‖s‖v`, `v ∈ {27,28}`, low-s. (EIP-155 doesn't apply to EIP-712/EIP-191; for
   the future EIP-1559 tx path it's yParity 0/1 inside the typed envelope.)
3. **Native-gas handling?** Pre-fund — see §4 gotcha. We will **not** sponsor gas in v1.
4. **Per-wallet approval policy on EVM?** A single `evm_sign` allow/deny capability, no per-order
   approval. **This is deliberately weaker than the NEAR withdraw path** (amount limits, multisig) —
   acceptable only because the risk is bounded by the Polygon float. Make float-sizing explicit on
   your side.
5. **Rate limit / latency for sign-typed-data?** In-enclave ECDSA is sub-ms; the round-trip is one
   coordinator→keystore HTTP hop. Fine for the order path. (Again: no on-chain round-trip, because
   it's not chain-signatures.) We'll add idempotency keys on the mutating endpoints.
6. **Can OutLayer sign AND broadcast raw Polygon tx?** Sign: yes, as a fast-follow under the same
   `evm_sign` capability (no allowlist — see §3). Broadcast: no — you broadcast.

---

## 6. What we need from you to finalize

1. **A vs B decision** (direct pmxt-core vs PMXT PreFundedEscrow). This determines whether §4.4 is ever
   needed: **Model B needs only v1 signing**; Model A also needs the raw-tx path + POL float.
2. **Confirm "one EVM address across all chains"** is the behavior you want (it's what we'll build).
3. **One toggle or two** — single `evm_sign`, or split raw-tx into its own `evm_sign.raw_tx` sub-flag
   (§3).
4. **Phase-0 spike output:** the chosen `signatureType` (deposit-wallet sigType 3 vs EOA) and the
   exact on-chain step list — so we know whether raw-tx (§4.4) is even needed and can document the flow.
5. **Native-POL withdraw dry-run result** (§4) — confirms or kills the gas-float plan.

---

## 7. Confirmation — re: your reply §1 (arbitrary EIP-712), and a security note

**Confirmed: `sign-typed-data` signs arbitrary EIP-712.** No struct / domain / `primaryType` allowlist
in v1 — we hash whatever `typed_data` you send (domain + types + message) server-side and sign.
**EIP-3009 `TransferWithAuthorization` and EIP-2612 `Permit` work** exactly like a Polymarket order
struct. Your gasless-exit-via-EIP-3009 path is unblocked by v1 alone — no raw-tx, no native-POL, no
gas sponsorship. Agreed.

**One consequence you should accept explicitly (not a blocker — a relabel):** because typed-data is
generic, `sign-typed-data` is **full fund-moving authority over the EOA**, not a bounded order signer.
EIP-3009 ≈ `transfer` (moves the whole USDC balance to any `to`); EIP-2612 ≈ `approve` (hands a spender
an allowance). Both ride the **always-on `evm_sign`** capability. Therefore:

- `evm_sign.raw_tx` (default-off) is **not** a drain-containment boundary — it only gates *arbitrary
  raw transactions* (contract calls, native value, non-EIP-3009 tokens). A caller with `evm_sign` on
  can drain the float via an EIP-3009 message with `raw_tx` off.
- We **can't** fix this by gating EIP-3009 behind `raw_tx` (that breaks your gasless exit, which *is* an
  EIP-3009 transfer) or by allowlisting the `to` (it's a dynamic 1Click/broadcaster address — same
  reason we dropped the raw-tx allowlist).

**So the real controls are: (1) the single `evm_sign` toggle, and (2) float-sizing on your side** —
keep the Polygon EOA float to what a session needs; the home balance in NEAR intents is never exposed.
We'll build and document the toggle semantics this way. Flagging so "raw_tx off" is never mistaken for
"funds safe."

> Side note: you're right that **"Model B needs only v1 signing" was wrong** — PMXT escrow
> `deposit`/`withdraw` are on-chain txs too, so B would also need raw-tx or the gasless path. Moot
> since you chose **A**, but the correction stands.

---

Confirm §7's relabel and we'll lock v1 scope.
