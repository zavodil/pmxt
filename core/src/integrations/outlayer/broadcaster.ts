/**
 * The GENERIC broadcaster (OUTLAYER_INTEGRATION_PLAN.md §6).
 *
 * OutLayer signs but will not broadcast, so WE submit and pay gas. This is the
 * ONE component that serves every EVM venue — it is NOT per-venue. Connectors
 * stay declarative: they produce either a raw signed tx (the OutLayer
 * `evm_sign.raw_tx` fast-follow) or an EIP-3009 `transferWithAuthorization`
 * (the gasless-exit primitive, signed via v1 `sign-typed-data`), and hand it
 * here to be put on chain.
 *
 * STATUS: scaffold. `broadcastRawTransaction` is real (a thin viem
 * `sendRawTransaction` + receipt wait). `broadcastEip3009` is stubbed.
 *
 * Phase-0 correction (see PHASE0_FINDINGS.md §4): EIP-3009 is NOT the pUSD
 * exit primitive — Polymarket V2 collateral **pUSD does not implement EIP-3009**
 * (it has EIP-2612 `permit` only), and the Polymarket relayer already sponsors
 * gasless wrap/unwrap/transfer/approve. EIP-3009 applies ONLY at the
 * NEAR-intents bridge boundary, on the underlying Circle USDC — and whether
 * native Circle USDC on Polygon supports it still needs on-chain ABI
 * verification. So this path stays stubbed until that boundary is settled.
 */
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { logger } from '../../utils/logger';

export interface BroadcastResult {
    txHash: Hex;
    blockNumber?: bigint;
    status?: 'success' | 'reverted';
}

export interface Eip3009Authorization {
    /** Native Circle USDC contract on the target chain. */
    usdc: `0x${string}`;
    from: `0x${string}`;
    to: `0x${string}`;
    value: string; // minimal units (USDC: 6 decimals)
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`; // 32-byte hex
    /** The EIP-712 signature from OutLayer sign-typed-data. */
    signature: `0x${string}`;
}

export interface BroadcasterOptions {
    /** Polygon RPC URL. Falls back to POLYGON_RPC_URL, then a public endpoint. */
    rpcUrl?: string;
    /**
     * Optional relayer key that PAYS gas for EIP-3009 submissions (the user's
     * EOA holds zero POL). For raw-signed-tx broadcast the gas comes from the
     * tx's own signer, so this is unused there.
     */
    relayerPrivateKey?: `0x${string}`;
}

export class GenericBroadcaster {
    private readonly publicClient: PublicClient;
    private readonly rpcUrl: string;
    private readonly relayerPrivateKey?: `0x${string}`;

    constructor(opts: BroadcasterOptions = {}) {
        this.rpcUrl = opts.rpcUrl || process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
        this.relayerPrivateKey = opts.relayerPrivateKey
            || (process.env.POLYGON_RELAYER_PRIVATE_KEY as `0x${string}` | undefined);
        this.publicClient = createPublicClient({ chain: polygon, transport: http(this.rpcUrl) });
    }

    /**
     * Broadcast a pre-signed raw transaction (from OutLayer
     * `sign-transaction`). Gas is paid by the tx's own signer. Waits for the
     * receipt.
     */
    async broadcastRawTransaction(rawSignedTx: Hex): Promise<BroadcastResult> {
        const txHash = await this.publicClient.sendRawTransaction({ serializedTransaction: rawSignedTx });
        logger.info('[broadcaster] submitted raw tx', { txHash });
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
        return { txHash, blockNumber: receipt.blockNumber, status: receipt.status };
    }

    /**
     * Submit a gasless EIP-3009 `transferWithAuthorization` — the relayer pays
     * POL, the user's EOA holds none. This is the PRIMARY exit path IF 1Click
     * delivers native Circle USDC (Phase-0 open question §11).
     *
     * STUB: wiring the USDC ABI + relayer send is straightforward, but doing it
     * before Phase-0 confirms the USDC variant risks hardcoding the wrong token.
     */
    async broadcastEip3009(_auth: Eip3009Authorization): Promise<BroadcastResult> {
        if (!this.relayerPrivateKey) {
            throw new Error('[broadcaster] EIP-3009 submit needs POLYGON_RELAYER_PRIVATE_KEY (pays gas).');
        }
        // Intentionally unconstructed until Phase-0 fixes the USDC contract.
        void createWalletClient;
        void privateKeyToAccount;
        throw new Error(
            '[broadcaster] broadcastEip3009 not implemented yet — blocked on Phase-0: ' +
            'confirm native Circle USDC (EIP-3009-capable) vs bridged USDC.e and the exact contract.',
        );
    }
}
