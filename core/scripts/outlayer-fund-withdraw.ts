#!/usr/bin/env tsx
/**
 * Bridge the funded USDC from the OutLayer intents balance → the wallet's
 * Polygon EOA (the funded-$1 test). Run AFTER scripts/outlayer-fund-setup.ts and
 * after ~$1 USDC has landed in the intents balance.
 *
 *   cd core && npx tsx scripts/outlayer-fund-withdraw.ts [--go]
 *
 * Without --go it only checks balance + dry-runs (no funds move). With --go it
 * submits the withdraw and polls to terminal.
 */
import { readFileSync } from 'fs';
import { OutlayerClient, isTerminalStatus } from '../src/integrations/outlayer/outlayer-client';
import { WkBearerAuth } from '../src/integrations/outlayer/outlayer-auth';

const NEAR_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const GO = process.argv.includes('--go');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    const secret = JSON.parse(readFileSync(`${process.cwd()}/.secrets/outlayer-funding-wallet.json`, 'utf8'));
    const client = new OutlayerClient();
    const auth = new WkBearerAuth(secret.api_key);
    const eoa: string = secret.polygon_eoa;

    console.log('Funding wallet NEAR:', secret.near_address);
    console.log('Polygon EOA target :', eoa, '\n');

    // Which USDC is actually held in intents?
    const bal = await client.balance(auth, NEAR_USDC, 'intents');
    const held = BigInt(bal.balance || '0');
    console.log(`intents USDC balance: ${held} (${Number(held) / 1e6} USDC)`);
    if (held === 0n) {
        console.log('\nNo USDC in the intents balance yet. Fund the NEAR account first (see fund-setup output).');
        return;
    }

    // Leave nothing behind; withdraw the full held amount.
    const amount = held.toString();
    const dr = await client.withdrawDryRun(auth, { chain: 'polygon', to: eoa, amount, token: NEAR_USDC });
    console.log('dry-run:', JSON.stringify(dr));
    if (!dr.would_succeed) {
        console.log('\nDry-run says it would NOT succeed — not submitting.');
        process.exitCode = 1;
        return;
    }

    if (!GO) {
        console.log('\n[dry-run only] re-run with --go to actually bridge to Polygon.');
        return;
    }

    console.log('\nSubmitting withdraw → Polygon…');
    const res = await client.withdraw(auth, { chain: 'polygon', to: eoa, amount, token: NEAR_USDC });
    console.log('withdraw submitted:', JSON.stringify(res));

    // Poll to terminal.
    const id = res.request_id;
    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const st = await client.requestStatus(auth, id);
        console.log(`  [${i}] status=${st.status}`);
        if (isTerminalStatus(st.status)) {
            console.log('\nTerminal:', JSON.stringify(st.result ?? st.status));
            console.log(st.status.toLowerCase().includes('fail') || st.status.toLowerCase().includes('refund')
                ? '❌ withdraw did not settle'
                : `✅ USDC bridged to Polygon EOA ${eoa} — check Polygonscan.`);
            return;
        }
    }
    console.log('\n(timed out polling; check status later with the request id)');
}

main().catch((e) => {
    console.error('WITHDRAW ERROR:', e?.message || e);
    if (e?.body) console.error('  body:', e.body);
    process.exitCode = 1;
});
