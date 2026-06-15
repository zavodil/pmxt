# Reply to OutLayer's EVM-signing response

> Re: `OUTLAYER_EVM_SIGNING_RESPONSE.md`. From: voulai/ai-intents team.
> Status: **v1 scope accepted** with answers to your §6, + one reframe of the gas section (you replied
> before seeing request §4.6) and one small confirmation request.

## TL;DR

- **v1 (§4.1 address, §4.2 EIP-712, §4.3 EIP-191) — accepted as-is.** We'll build our `OutlayerSigner`
  against that contract now, with a `LocalKeySigner` stand-in, and swap when live.
- **Chain-signatures correction — accepted, docs fixed.** Thanks; the in-TEE / sub-ms detail is exactly
  what we want and we've removed the "chain-signatures" wording from our request + plan.
- **Broadcast (§4.5) declined, raw-tx (§4.4) fast-follow — fine.** We broadcast.
- **Gas: we do NOT need you to sponsor gas. But please confirm one thing (below) that makes the
  "no per-wallet POL deposit" goal work without any new scope on your side.**

## 1. The gas reframe (request §4.6 — you hadn't seen it)

Our hard product constraint: **we will not pre-fund each EVM wallet with native POL.** That per-wallet
"deposit POL" step doesn't scale across many users/venues. We're fine with gas being *paid* (out of
proceeds) — we just won't manage POL as a per-wallet asset.

We agree you should **not** sponsor gas or broadcast. Here's why that's compatible with our constraint —
and why it needs **nothing new** from you beyond v1:

- A **plain-EOA** transaction's gas can't be sponsored by anyone (protocol fact) — so "no POL on the
  EOA" means we avoid plain-EOA gas-bearing txs, two ways:
  1. **Entry:** the **venue's own** relayer sponsors deploy + approvals (Polymarket V2 deposit-wallet).
     No POL on our side. (Their relayer = one HTTP call in the connector, not infra we run.)
  2. **Exit:** instead of a plain ERC-20 `transfer`, the EOA signs an **EIP-3009
     `transferWithAuthorization`** (or EIP-2612 `permit`) — which is **just an EIP-712 typed-data
     message → already covered by your §4.2 `sign-typed-data`.** *We* run a single generic broadcaster
     that submits it and pays the POL; the user's EOA holds **zero** POL.
- So the gasless path rides entirely on **v1 sign-typed-data** + our broadcaster. **No gas sponsorship,
  no native-POL withdraw, no raw-tx needed for it.**

**Caveat (Phase 0):** EIP-3009 works only for **native Circle USDC**, not bridged **USDC.e**. Which
variant 1Click delivers / Polymarket settles (pUSD) is exactly what our spike resolves. If it turns out
to be USDC.e everywhere, the gasless-exit path is unavailable and we fall back to your §4 native-POL
gotcha (or raw-tx + a tiny float). So your §4 note stays a **fallback**, not the primary plan.

**One confirmation we need from you:** that `sign-typed-data` will sign **arbitrary** EIP-712 structs —
specifically **EIP-3009 `TransferWithAuthorization`** and **EIP-2612 `Permit`** domains/types, not just
Polymarket order structs. (It should — it's generic typed-data — but please confirm there's no
struct/domain allowlist.)

## 2. Answers to your §6 ("what we need from you to finalize")

1. **A vs B → A (direct pmxt-core → venue native CLOB).** We're keeping PMXT out of the loop. Note: your
   "Model B needs only v1 signing" isn't quite right — PMXT's PreFundedEscrow `deposit`/`withdraw` are
   on-chain txs the wallet signs+sends too (the `pmxt-builder-widgets` flow is `eth_sendTransaction`), so
   B would also need raw-tx or the gasless path. Doesn't change our choice — **A**.
2. **One EVM address across all chains → confirmed, yes.** Standard EVM model; that's what we want.
3. **One toggle or two → two.** Please split raw-tx into its own `evm_sign.raw_tx` (default-off), separate
   from order/message signing. We may avoid raw-tx entirely (gasless path), so keeping trade-signing on
   while the instant-drain primitive has its own kill-switch is the right safety posture.
4. **Phase-0 spike output → coming.** We'll run it next and send you: the chosen `signatureType`
   (leaning deposit-wallet / sigType 3), the exact on-chain step list, and whether raw-tx (§4.4) is
   needed at all. This drives whether you ever build §4.4.
5. **Native-POL withdraw dry-run → we'll run it,** but it's now a **fallback** (see §1), not critical
   path. We'll report the result; don't block v1 on it.

## 3. Net

Ship **v1 as specced** (address + EIP-712 + EIP-191, single `evm_sign` capability default-on, split
`evm_sign.raw_tx` default-off). That unblocks us completely for the order path **and** the gasless-exit
path. Raw-tx stays your fast-follow; we'll confirm if it's even needed after Phase 0. Your §7 confirmed
arbitrary EIP-712 (no allowlist) — see §4 for our acceptance of the §7 relabel; **no blockers remain.**

## 4. Confirmed — §7 relabel accepted (v1 can lock)

We accept it explicitly: **`evm_sign` is full fund-moving authority over the Polygon EOA float**, not a
bounded order signer. EIP-3009 (≈ `transfer`) and EIP-2612 (≈ `approve`) ride the always-on capability,
so `evm_sign.raw_tx` off is **not** a drain-containment boundary. Your reasoning is correct; we won't ask
you to allowlist typed-data in v1.

Compensating controls live on **our** side, where you put them:
- **Minimal float / just-in-time:** we bridge onto Polygon only what a bet needs and sweep proceeds back
  to NEAR intents promptly; idle EOA balance ≈ 0. Drain blast-radius = funds mid-flight, never the user's
  NEAR-intents home balance (which no EVM signature can reach).
- **Bearer stays server-side:** the NEAR key + `seed` that authorizes `evm_sign` lives only in our
  trusted backend; the chat agent never requests raw typed-data. "Compromised caller" = our backend,
  bounded further by the float.
- **Two toggles kept** (`evm_sign` + `evm_sign.raw_tx` default-off) — not as a fund boundary, but because
  arbitrary contract-calls / native-value / non-EIP-3009 tokens are a distinct capability worth its own
  kill-switch.
- *(Future, non-blocking):* if you ever want to harden, a light **structural** typed-data filter
  (`primaryType ∈ {Order, TransferWithAuthorization, Permit}`, domain ∈ known venue/USDC contracts) would
  shrink the blast radius without a per-tx `to` allowlist. Not needed for v1.

**Lock v1.** First implementation item on your side (per your §1 / our Phase 0): `sign_secp256k1` →
recoverable signature (keccak prehash, `r‖s‖v`, low-s).
