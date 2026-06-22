#!/usr/bin/env tsx
/** Deploy the deposit-wallet for our funded EOA via the Polymarket relayer (gasless). */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createPublicClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { OutlayerClient } from '../src/integrations/outlayer/outlayer-client';
import { OutlayerSigner } from '../src/integrations/outlayer/outlayer-signer';
import { WkBearerAuth } from '../src/integrations/outlayer/outlayer-auth';

const FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const DW = '0x56164B27FaA2E738747cE9D4951415cF69844550';
const RELAYER = process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com';
const RPC = 'https://polygon-bor-rpc.publicnode.com';
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

async function relayer(path: string, method: string, body?: any) {
  const res = await fetch(RELAYER + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'RELAYER_API_KEY': process.env.POLYMARKET_RELAYER_API_KEY!,
      'RELAYER_API_KEY_ADDRESS': process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS!,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function codeAt(addr: string) {
  const pc = createPublicClient({ chain: polygon, transport: http(RPC) });
  const code = await pc.getBytecode({ address: addr as `0x${string}` });
  return code && code !== '0x' ? code.length : 0;
}

async function main() {
  const secret = JSON.parse(readFileSync(`${process.cwd()}/.secrets/outlayer-funding-wallet.json`,'utf8'));
  const signer = new OutlayerSigner(new OutlayerClient(), new WkBearerAuth(secret.api_key), 'polygon');
  const eoa = await signer.address();
  console.log('owner EOA       :', eoa);
  console.log('deposit-wallet  :', DW);
  console.log('code @ DW before:', await codeAt(DW), 'bytes');

  console.log('\nPOST /submit WALLET-CREATE …');
  const sub = await relayer('/submit', 'POST', { type: 'WALLET-CREATE', from: eoa, to: FACTORY });
  console.log('submit ->', sub.status, JSON.stringify(sub.json).slice(0, 300));
  if (sub.status >= 300) { console.log('\n❌ submit rejected'); return; }

  const txId = sub.json?.transactionID || sub.json?.transactionId || sub.json?.id;
  console.log('txId:', txId);
  for (let i=0; i<30 && txId; i++) {
    await sleep(3000);
    const st = await relayer(`/transaction?id=${encodeURIComponent(txId)}`, 'GET');
    const row = Array.isArray(st.json) ? st.json[0] : st.json;
    const state = row?.state || row?.status;
    console.log(`  [${i}] ${state}`);
    if (state && /CONFIRMED|MINED|FAILED|INVALID/i.test(state)) break;
  }
  console.log('\ncode @ DW after :', await codeAt(DW), 'bytes', (await codeAt(DW))>0 ? '✅ deployed' : '(not yet)');
}
main().catch(e=>{ console.error('ERR', e?.message||e); process.exitCode=1; });
