# BACKUP — self-contained on-chain USDC.e swap path (NOT the default)

> ⚠️ **This is a FALLBACK, not the recommended path.** The default/production path is **native USDC via
> Polymarket's bridge services** (`/deposit` and `/withdraw`) — see
> [POLYMARKET_NATIVE_USDC_GUIDE.md](POLYMARKET_NATIVE_USDC_GUIDE.md). Those services accept/return **native
> USDC** and do the USDC.e swap + pUSD wrap/unwrap **internally**, so you normally **never swap yourself**.
>
> Use this backup only if you need **full self-custody** (never route funds through a Polymarket-operated
> bridge address), or if the bridge services are unavailable. It keeps every hop under our own
> OutLayer signature, at the cost of extra on-chain steps + a USDC swap + dependence on pool liquidity.
>
> Validated live (2026-06-15) for the ENTRY direction; the EXIT direction has an open caveat (see below).

## Why a swap is needed in this path

Polymarket V2 collateral is **pUSD**, minted by the permissionless **CollateralOnramp**, which accepts
**USDC.e only** (native USDC is `paused` on it). OutLayer's 1Click delivers/accepts **native** USDC on
Polygon (no USDC.e in its catalog; `nep141` only for deposits). So to wrap/unwrap ourselves we must
convert native ↔ USDC.e via a DEX. The two-$1-stablecoins pool is deep and ~1:1.

- Uniswap V3 **USDC/USDC.e fee-100 pool**: `0xd36ec33c8bed5a9f7b6630855f1533455b98a418`
- Uniswap V3 **SwapRouter02**: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`
- Observed slippage on ~$2: ~$0.0002.

## ENTRY (self-contained): native USDC → pUSD in the deposit-wallet (gasless via builder relayer)

Funds start as native USDC on the user's deposit-wallet (1Click `intents/withdraw chain=polygon` to the
deposit-wallet; if they land on the EOA, move EOA→deposit-wallet gaslessly via an EIP-3009
`transferWithAuthorization` inside a relayer batch).

Then two gasless `RelayClient.executeDepositWalletBatch` batches:

```ts
// Batch A — swap native USDC → USDC.e (Uniswap V3 SwapRouter02, fee 100, recipient = deposit-wallet)
[ ERC20(USDC).approve(SWAP_ROUTER02, amountIn),
  SWAP_ROUTER02.exactInputSingle({ tokenIn: USDC, tokenOut: USDCe, fee: 100,
                                   recipient: depositWallet, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0 }) ]

// Batch B — wrap USDC.e → pUSD into the deposit-wallet
[ ERC20(USDCe).approve(COLLATERAL_ONRAMP, amountUsdce),
  COLLATERAL_ONRAMP.wrap(USDCe, depositWallet, amountUsdce) ]   // native is paused; USDC.e ok
```
Result: pUSD in the deposit-wallet. Then approvals + trading are identical to the main guide (§5/§6).
(Live result: 1.988 native USDC → 1.987971 USDC.e → 1.987971 pUSD.)

## EXIT (self-contained): pUSD → native USDC → NEAR intents — ⚠️ unreliable, prefer the service

Documented mechanism: `CollateralOfframp.unwrap(pUSD → USDC.e)` then Uniswap swap USDC.e → native, then
1Click home.

- CollateralOfframp: `0x2957922Eb93258b93368531d39fAcCA3B4dC5854`, `unwrap(address _asset=pUSD, _to, _amount)`,
  needs `pUSD.approve(offramp)` first; permissionless; checks `paused[_asset]`.
- **Caveat (live):** our `unwrap` reverted — the offramp held **0 USDC.e reserve** at the time (backing
  sits in the onramp + the pUSD contract), plus a dust-size amount. Polymarket's help docs note the
  Uniswap pool "can be exhausted → break into smaller amounts / wait for rebalance." So the self-contained
  exit is liquidity-dependent and was not completed live.
- **Therefore prefer the withdraw SERVICE** for exit (`POST bridge.polymarket.com/withdraw`, native USDC,
  confirmed live) — it routes the offramp + pool itself. This backup exit is only for full-self-custody
  scenarios and must be tested per-conditions.

## Contracts (Polygon 137)

| | address |
|---|---|
| Uniswap USDC/USDC.e pool (fee 100) | `0xd36ec33c8bed5a9f7b6630855f1533455b98a418` |
| Uniswap SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| CollateralOnramp (wrap, USDC.e only) | `0x93070a847efEf7F70739046A929D47a521F5B8ee` |
| CollateralOfframp (unwrap) | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` |
| pUSD | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| native USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

**Bottom line:** default to the native-USDC bridge services
([POLYMARKET_NATIVE_USDC_GUIDE.md](POLYMARKET_NATIVE_USDC_GUIDE.md)). Keep this only as the
self-custodial / service-outage fallback.
