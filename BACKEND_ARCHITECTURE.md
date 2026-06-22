# Backend architecture — two layers, one mergeable fork

**Audience:** an AI agent (or engineer) building the production backend on top of this fork.
**Core decision:** split the system in two. This repo stays a *thin, additive, auth-free* trading core that
tracks upstream `pmxt`. Everything that churns on **your** cadence — end-user auth, identity, business rules —
lives in a **separate service** with no upstream. Companion: [POLYMARKET_NATIVE_USDC_GUIDE.md](POLYMARKET_NATIVE_USDC_GUIDE.md),
[SYNCING_UPSTREAM.md](SYNCING_UPSTREAM.md).

---

## 0. THE SPLIT (non-negotiable)

```
   end users / agents
          │  (HTTPS, OAuth: Google / Twitter / wallet)
          ▼
┌─────────────────────────────┐        ┌──────────────────────────────────────┐
│  ACCOUNT SERVICE             │  S2S   │  TRADING CORE  (THIS FORK of pmxt)     │
│  — your repo, NO upstream    │ ─────▶ │  — additive only, tracks upstream      │
│                              │ token  │                                        │
│  • OAuth / sessions / KYC    │        │  • /api/polymarket/* (vanilla pmxt)    │
│  • issues internal userId    │        │  • /outlayer/* (custody + funding)     │
│  • provider-id ↔ userId DB   │        │  • holds OUTLAYER_NEAR_PRIVATE_KEY     │
│    (SOURCE OF TRUTH)         │        │  • builder HMAC creds (gas sponsor)    │
│  • business rules, limits    │        │  • stateless re: users (cache only)    │
│  • payout policy             │        │  • NO end-user auth, NO user DB        │
└─────────────────────────────┘        └──────────────────────────────────────┘
```

The account service authenticates a human, resolves them to a stable internal `userId`, and calls the trading
core passing that `userId` inside `credentials`. The core derives the wallet from `userId`, signs with its
env-held NEAR key, and executes. The core trusts its caller — it has no notion of "who" the user is.

---

## 1. WHY THIS SPLIT

- **Upstream mergeability.** Trading runs through pmxt's *vanilla* `/api/polymarket/*` dispatcher; the only
  custom hook is an exchange-factory branch that swaps the signer (§5). So when pmxt ships new markets /
  exchanges / fixes, `git merge upstream/main` pulls them in for free — you never forked venue logic. Keep this
  property and merges stay trivial ([SYNCING_UPSTREAM.md](SYNCING_UPSTREAM.md)).
- **Auth churns, markets don't.** OAuth providers, sessions, KYC, limits, payout rules change constantly and on
  your schedule. Put them in the core and every upstream merge becomes a conflict. Put them in a separate repo
  with no upstream and they never collide.
- **Blast radius / custody.** The core is the only thing that holds the custody root. The account service holds
  user data but **no signing secret** — it only knows `userId`s. Compromise of the account DB cannot move funds
  without also reaching the core.

---

## 2. TRADING CORE (this fork) — responsibilities

**Does:**
- Exposes trading via the unmodified pmxt dispatcher `POST /api/{exchange}/{method}` — OutLayer-backed when the
  request carries an OutLayer identity (exchange-factory hook, [exchange-factory.ts](core/src/server/exchange-factory.ts)).
- Exposes the custody/funding surface under `/outlayer/*` ([outlayer-routes.ts](core/src/server/outlayer-routes.ts)):

  | route | purpose | funds? |
  |---|---|---|
  | `GET  /outlayer/health` | liveness / config probe | no |
  | `POST /outlayer/address` `{credentials, chain?}` | derive (auto-create) the EVM EOA (§5) | no |
  | `POST /outlayer/derive-api-key` `{credentials}` | one-time CLOB API-cred derivation (§8); re-derivable | no |
  | `POST /outlayer/tokens` `{credentials}` | OutLayer token catalog | no |
  | `POST /outlayer/fund-polygon` `{credentials,to,amount,token,dryRun?}` | intents → Polygon (§7) | yes |
  | `POST /outlayer/status` `{credentials,requestId}` | async op status | no |
  | `POST /outlayer/onramp-pusd`, `/cashout` | Phase-0 stubs → `501` | — |

- Holds app-level singletons in **env only**: `OUTLAYER_NEAR_PRIVATE_KEY` + `OUTLAYER_ACCOUNT_ID` (custody root),
  builder HMAC creds + `BUILDER_CODE` (§2 of the guide, §12a backup rules).
- Treats per-user state as **cache, not truth** — `eoa`, `depositWallet`, `clobCreds`, `setupDone` all
  re-derive from `userId` (guide §12a). In-memory / Redis is fine; losing it is not fatal.

**Does NOT (push to the account service):**
- No end-user authentication, OAuth, sessions, password/JWT issuance.
- No `userId` issuance or provider-identity mapping; no durable user DB.
- No business rules (limits, fees-on-top, payout policy, KYC).
- No public exposure. See §4.

---

## 3. ACCOUNT SERVICE (separate repo) — responsibilities

- **Authenticate the human** (Google, Twitter/X, wallet, email — your choice).
- **Issue and own the internal `userId`** (the per-user money-loss root, guide §12a). Store it durably.
- **Own the identity map** `provider-identity → internal userId` as the **source of truth**, plus the reverse
  index `depositWallet → userId` for deposit attribution (it has the full `userId` set; the core does not).
- **Apply business rules** before calling the core: balance/limit checks, fee-on-top, payout eligibility, KYC.
- **Call the core** over the service-to-service channel (§4), injecting `credentials.outlayerUserId`.
- Holds **no custody secret** — only `userId`s and its own session secrets.

---

## 4. BOUNDARY CONTRACT (how the two talk)

- **Identity in `credentials`.** Every mutating core call carries `body.credentials` =
  `{ outlayerAccountId, outlayerUserId | outlayerSeed, [apiKey, apiSecret, passphrase], [signatureType, funderAddress] }`.
  The account service sets `outlayerUserId`; the core computes `seed = sha256("predict:user:"+userId)` and signs
  with the **env** NEAR key (never in the body). `outlayerAccountId` is the public NEAR account id, not a secret.
- **Trust model — READ.** The core has **no per-end-user auth**: anyone who can reach it and name a `userId`
  can move that user's funds. Therefore:
  - The core MUST NOT be internet-exposed. Bind to a private network / VPC; allow only the account service.
  - Keep pmxt's existing **access-token middleware** on (it already guards `/outlayer/*` and `/api/*`). Set a
    strong `ACCESS_TOKEN`; treat it as the service-to-service secret. This is the auth you keep — it gates
    *service* access, not *end users*, so it doesn't churn with your product.
  - Optionally add mTLS between the two services. Do this in deployment config, not in forked code.
- **Caching is the caller's job.** First call to `/outlayer/derive-api-key` returns `{apiKey, apiSecret,
  passphrase}`; the account service may cache them and pass them back on trading calls to skip re-derivation —
  but they are re-derivable, so caching is an optimization, not a persistence requirement (guide §12a).

---

## 5. `userId` / IDENTITY DERIVATION (account-service rules)

The core hashes whatever `userId` it receives ([near-auth.ts](core/src/integrations/outlayer/near-auth.ts) `seedFor`).
Choosing that string correctly is the account service's job, and it is irreversible — get it wrong and funds
strand or collide. Rules:

1. **Prefer your own internal id.** Issue an immutable internal id (UUID / DB PK) at first signup, persist it,
   and link external identities to it. Derive the wallet from the internal id — provider-agnostic, supports
   linking several logins to one wallet, mergeable without moving funds.
2. **If deriving directly from a provider id** (no mapping table — the "lite" mode):
   - **Namespace by provider** or you get cross-provider collisions: Google `12345` and Twitter `12345` would
     hash to the same wallet. Use `google:<sub>`, `twitter:<id>`. (Colons are safe — they're hashed away; the
     "no `:`" rule in guide §1 is about the resulting hex seed, which is always valid.)
   - **Use the immutable subject id, never a handle/email.** Google: OIDC `sub`. Twitter/X: numeric user id.
     Handles and emails get renamed/reused → new seed → stranded funds.
3. **Freeze the formula forever.** Any change to the `userId` string = a different wallet. There is no
   recovery beyond knowing the old input.
4. One human via two providers = two wallets unless you add the linking layer in rule 1.

---

## 6. STATE OWNERSHIP

| data | owner | durability |
|---|---|---|
| internal `userId`, provider-id map | account service | **source of truth, durable, backed up** |
| `depositWallet → userId` reverse index | account service | source of truth (derivable, but it owns the userId set) |
| custody root (NEAR key / `wk_`), builder creds | trading core (env) + offline backup | **never lose** (guide §12a) |
| `eoa`, `depositWallet`, `clobCreds`, `setupDone` | trading core | cache only — re-derivable |
| business rules, limits, payout policy | account service | source of truth |

---

## 7. FORK MERGE HYGIENE (keep upstream pulls trivial)

- **Additive-only.** Add files under `core/src/integrations/outlayer/` and new route files. Do not edit pmxt
  files except to *register* the integration.
- **Mark every upstream edit** so it's obvious on merge. Current touchpoints (the entire conflict surface):
  - [core/src/server/app.ts](core/src/server/app.ts) — 1 import + 1 `app.use("/outlayer", …)`, wrapped in
    `// >>> outlayer-integration … // <<< outlayer-integration`.
  - [core/src/server/exchange-factory.ts](core/src/server/exchange-factory.ts) — 1 import + 1 early-return
    branch (`if (isOutlayerEnabled(credentials)) …`), same markers.
  - `core/package.json` — additive deps (`@polymarket/*`, `viem`).
  - `.env.example`, `.gitignore` — additive lines.
- **Why new markets "just work":** trading dispatches through pmxt's own code; our hook only swaps the *signer*.
  A new venue pmxt adds is reachable via `/api/{newexchange}/{method}` with zero changes here.
- **On merge:** `git merge upstream/main`; conflicts, if any, appear only at the five touchpoints above —
  re-apply the marked blocks. Build `core/` before pushing. Full procedure: [SYNCING_UPSTREAM.md](SYNCING_UPSTREAM.md).

---

## 8. DO / DON'T

- ✅ Build auth, userId issuance, identity mapping, business rules in the **separate** account service.
- ✅ Keep this fork additive + marked; let trading flow through vanilla pmxt.
- ✅ Keep the core on a private network behind the access token; back up the custody root offline.
- ❌ Don't add OAuth / sessions / a user DB to this repo — it poisons every upstream merge.
- ❌ Don't expose the core publicly — it has no per-user auth and holds the custody root.
- ❌ Don't hash a raw mutable OAuth field (email/handle) into the wallet seed.
