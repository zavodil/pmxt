#!/usr/bin/env tsx
/**
 * One-time setup for the funded-$1 → Polygon bridge test.
 *
 * Registers a dedicated OutLayer custody wallet (`wk_` key), derives its NEAR
 * funding address + its Polygon EVM EOA, lists USDC token options, and persists
 * everything to a GITIGNORED secret file. Idempotent: re-runs load the saved
 * wallet instead of registering a new one.
 *
 *   cd core && npx tsx scripts/outlayer-fund-setup.ts
 *
 * Then fund the printed NEAR address (or use the fund link) with ~$1 USDC, and
 * run scripts/outlayer-fund-withdraw.ts to bridge it to Polygon.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { OutlayerClient } from '../src/integrations/outlayer/outlayer-client';
import { WkBearerAuth } from '../src/integrations/outlayer/outlayer-auth';

const SECRET_PATH = `${process.cwd()}/.secrets/outlayer-funding-wallet.json`;

interface WalletSecret {
    api_key: string;
    near_account_id: string;
    polygon_eoa?: string;
    near_address?: string;
    created_note: string;
}

async function main(): Promise<void> {
    const client = new OutlayerClient();
    let secret: WalletSecret;

    if (existsSync(SECRET_PATH)) {
        secret = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
        console.log('Loaded existing funding wallet from', SECRET_PATH);
    } else {
        const reg = await client.register();
        if (!reg.api_key) throw new Error('register returned no api_key');
        secret = {
            api_key: reg.api_key,
            near_account_id: reg.near_account_id,
            created_note: 'OutLayer funding-test wallet for $1 → Polygon bridge. Do not commit.',
        };
        console.log('Registered NEW funding wallet.');
    }

    const auth = new WkBearerAuth(secret.api_key);

    // Derive addresses.
    const near = await client.address(auth, 'near' as never);
    secret.near_address = near.address;
    const polygon = await client.address(auth, 'polygon');
    secret.polygon_eoa = polygon.address;

    // Persist (gitignored).
    mkdirSync(dirname(SECRET_PATH), { recursive: true });
    writeFileSync(SECRET_PATH, JSON.stringify(secret, null, 2), { mode: 0o600 });

    // USDC token options (symbol is NOT unique — pick by chain).
    const { tokens } = await client.tokens(auth);
    const usdc = tokens.filter(t => t.symbol.toUpperCase() === 'USDC');
    const onNear = usdc.filter(t => t.chains.includes('near'));
    const onPolygon = usdc.filter(t => t.chains.includes('polygon'));

    console.log('\n=== Funding wallet (saved to .secrets/outlayer-funding-wallet.json) ===');
    console.log('  wk_ api key      :', secret.api_key.slice(0, 10) + '…(saved)');
    console.log('  NEAR account     :', secret.near_address);
    console.log('  Polygon EOA      :', secret.polygon_eoa, '  ← USDC will be bridged here');

    console.log('\n=== USDC asset ids (for funding / withdraw) ===');
    console.log('  USDC on NEAR    :', onNear.map(t => t.defuse_asset_id).join(', ') || '(none)');
    console.log('  USDC on Polygon :', onPolygon.map(t => t.defuse_asset_id).join(', ') || '(none)');

    console.log('\n=== Fund with ~$1 (pick one) ===');
    console.log('  A) NEAR USDC fund link (sends straight to intents balance):');
    const nearUsdcContract = onNear[0]?.defuse_asset_id?.replace(/^nep141:/, '') || '<usdc>';
    console.log('     https://outlayer.fastnear.com/wallet/fund?to=' + secret.near_address +
        '&amount=1&token=' + nearUsdcContract + '&dest=intents&msg=Fund+Polygon+bridge+test');
    console.log('  B) Cross-chain (you have USDC on Base/Eth/Solana/Polygon): tell me which chain,');
    console.log('     I will create a one-time deposit address for it.');
    console.log('\nAfter funding lands in the intents balance, run: npx tsx scripts/outlayer-fund-withdraw.ts');
}

main().catch((e) => {
    console.error('SETUP ERROR:', e?.message || e);
    if (e?.body) console.error('  body:', e.body);
    process.exitCode = 1;
});
