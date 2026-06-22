#!/usr/bin/env tsx
/**
 * EARLY LIVE CHECK for the OutLayer EVM-signing seam — ZERO FUNDS.
 *
 * Validates the whole signing path end-to-end against the LIVE OutLayer v1 API:
 *   1. GET /wallet/v1/address?chain=polygon            → derived EVM EOA
 *   2. POST /wallet/v1/evm/sign-typed-data (Order)     → ecrecover == address
 *   3. POST /wallet/v1/evm/sign-message  (EIP-191)     → personal_ecRecover == address
 *   4. address stability across a fresh signer instance
 *
 * Auth, in priority order (all zero-funds):
 *   - `Bearer near:`  if OUTLAYER_ACCOUNT_ID + OUTLAYER_NEAR_PRIVATE_KEY are set
 *                     (preferred; the deterministic per-user product path).
 *   - `Bearer wk_`    if OUTLAYER_WK_KEY is set.
 *   - else            auto-`POST /register` a throwaway `wk_` wallet (out of the
 *                     box, nothing to provide) and use it.
 *
 *   cd core && npx tsx scripts/outlayer-livecheck.ts
 */
import 'dotenv/config';
import { recoverTypedDataAddress, recoverMessageAddress } from 'viem';
import { NearAuth } from '../src/integrations/outlayer/near-auth';
import { SeedBearerAuth, WkBearerAuth } from '../src/integrations/outlayer/outlayer-auth';
import { OutlayerClient } from '../src/integrations/outlayer/outlayer-client';
import { OutlayerSigner } from '../src/integrations/outlayer/outlayer-signer';
import type { BearerAuth, EvmTypedData } from '../src/integrations/outlayer/types';

function sampleOrderTypedData(): EvmTypedData {
    return {
        domain: {
            name: 'Polymarket CTF Exchange',
            version: '1',
            chainId: 137,
            verifyingContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
        },
        types: {
            Order: [
                { name: 'salt', type: 'uint256' },
                { name: 'maker', type: 'address' },
                { name: 'signer', type: 'address' },
                { name: 'tokenId', type: 'uint256' },
                { name: 'makerAmount', type: 'uint256' },
                { name: 'takerAmount', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'side', type: 'uint8' },
            ],
        },
        primaryType: 'Order',
        message: {
            salt: '1001', maker: '0x0000000000000000000000000000000000000001',
            signer: '0x0000000000000000000000000000000000000001', tokenId: '789',
            makerAmount: '1000000', takerAmount: '500000', nonce: '0', side: 0,
        },
    };
}

async function resolveAuth(client: OutlayerClient): Promise<{ auth: BearerAuth; mode: string; detail: string }> {
    const envKey = process.env.OUTLAYER_NEAR_PRIVATE_KEY;
    const envAccount = process.env.OUTLAYER_ACCOUNT_ID;
    if (envKey && envAccount) {
        const near = new NearAuth(envAccount, envKey, process.env.OUTLAYER_VAULT_ID);
        const seed = process.env.OUTLAYER_SEED || NearAuth.seedFor('predict:user:livecheck');
        return { auth: new SeedBearerAuth(near, seed), mode: 'near', detail: `account=${envAccount} seed=${seed.slice(0, 12)}…` };
    }
    if (process.env.OUTLAYER_WK_KEY) {
        return { auth: new WkBearerAuth(process.env.OUTLAYER_WK_KEY), mode: 'wk (env)', detail: 'OUTLAYER_WK_KEY' };
    }
    // Out-of-the-box: register a throwaway custody wallet.
    const reg = await client.register();
    if (!reg.api_key) throw new Error('register returned no api_key');
    return { auth: new WkBearerAuth(reg.api_key), mode: 'wk (auto-registered)', detail: `near_account=${reg.near_account_id?.slice(0, 12)}…` };
}

async function main(): Promise<void> {
    const client = new OutlayerClient();
    const chain = 'polygon' as const;
    const { auth, mode, detail } = await resolveAuth(client);

    console.log('— OutLayer EVM signing live check —');
    console.log(`  api base : ${client.baseUrl}`);
    console.log(`  auth     : ${mode} (${detail})`);
    console.log('');

    let failures = 0;
    const ok = (label: string, pass: boolean, extra = '') => {
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${extra ? ' — ' + extra : ''}`);
        if (!pass) failures++;
    };

    const signer = new OutlayerSigner(client, auth, chain);

    // 1. Address derivation.
    const address = await signer.address();
    ok('GET /address?chain=polygon returns a 0x EOA', /^0x[0-9a-fA-F]{40}$/.test(address), address);

    // 2. EIP-712 sign + recover.
    const td = sampleOrderTypedData();
    const tdSig = await signer.signTypedData(td);
    ok('sign-typed-data returns 65-byte sig', /^0x[0-9a-f]{130}$/i.test(tdSig));
    const recoveredTd = await recoverTypedDataAddress({
        domain: td.domain as never, types: td.types as never,
        primaryType: 'Order', message: td.message as never, signature: tdSig,
    });
    ok('ecrecover(EIP-712) == derived address', recoveredTd.toLowerCase() === address.toLowerCase(), recoveredTd);

    // 3. EIP-191 sign + recover.
    const msg = 'outlayer livecheck ' + address.slice(2, 10);
    const msgSig = await signer.signMessage(msg);
    ok('sign-message returns 65-byte sig', /^0x[0-9a-f]{130}$/i.test(msgSig));
    const recoveredMsg = await recoverMessageAddress({ message: msg, signature: msgSig });
    ok('personal_ecRecover(EIP-191) == derived address', recoveredMsg.toLowerCase() === address.toLowerCase(), recoveredMsg);

    // 4. Stability across a fresh signer instance.
    const address2 = await new OutlayerSigner(client, auth, chain).address();
    ok('address stable across calls', address2.toLowerCase() === address.toLowerCase(), address2);

    console.log('');
    if (failures === 0) {
        console.log('✅ ALL CHECKS PASSED — the OutLayer signing seam is live end-to-end (zero funds).');
    } else {
        console.log(`❌ ${failures} check(s) FAILED.`);
        process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error('LIVE CHECK ERROR:', e?.message || e);
    if (e?.status) console.error('  http status:', e.status);
    if (e?.body) console.error('  body:', e.body);
    process.exitCode = 1;
});
