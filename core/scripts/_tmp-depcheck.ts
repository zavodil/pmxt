import { readFileSync } from 'fs';
import { OutlayerClient } from '../src/integrations/outlayer/outlayer-client';
import { WkBearerAuth } from '../src/integrations/outlayer/outlayer-auth';
const EOA='0x791c61B3c693dF9380e4eFe8Bc25Dd763D67d1Ef';
const DW='0x56164B27FaA2E738747cE9D4951415cF69844550';
const NEAR_USDC='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BUILDER=process.env.POLYMARKET_BUILDER_CODE||'0xfbfbc047be037f1638f96de48eac65f9b973fecd36bae53348bd1a318264b5a5';
async function dep(addr:string){
  const r=await fetch('https://bridge.polymarket.com/deposit',{method:'POST',headers:{'Content-Type':'application/json','X-Builder-Code':BUILDER},body:JSON.stringify({address:addr})});
  return {status:r.status, body:await r.json()};
}
async function main(){
  const secret=JSON.parse(readFileSync(`${process.cwd()}/.secrets/outlayer-funding-wallet.json`,'utf8'));
  const c=new OutlayerClient(); const auth=new WkBearerAuth(secret.api_key);
  const bal=await c.balance(auth, NEAR_USDC, 'intents');
  console.log('intents USDC:', Number(BigInt(bal.balance||'0'))/1e6);
  for(const [label,a] of [['EOA',EOA],['DW',DW]] as const){
    const d=await dep(a);
    console.log(`\n/deposit {address:${label} ${a}} -> ${d.status}`);
    console.log('  '+JSON.stringify(d.body));
  }
}
main().catch(e=>console.error('ERR',e?.message||e));
