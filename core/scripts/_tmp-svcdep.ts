import 'dotenv/config';
import { readFileSync } from 'fs';
import { createPublicClient, http, getAddress } from 'viem';
import { polygon } from 'viem/chains';
import { OutlayerClient, isTerminalStatus } from '../src/integrations/outlayer/outlayer-client';
import { WkBearerAuth } from '../src/integrations/outlayer/outlayer-auth';

const DW=getAddress('0x56164B27FaA2E738747cE9D4951415cF69844550');
const PUSD=getAddress('0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB');
const USDC=getAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
const NEAR_USDC='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BUILDER=process.env.POLYMARKET_BUILDER_CODE!;
const RPC='https://polygon-bor-rpc.publicnode.com';
const pc=createPublicClient({chain:polygon,transport:http(RPC)});
const E20=[{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}] as const;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function b(t:string,a:string){return Number(await pc.readContract({address:getAddress(t),abi:E20,functionName:'balanceOf',args:[getAddress(a)]}) as bigint)/1e6;}

async function main(){
  // 1) bridge-in for our deposit-wallet
  const r=await fetch('https://bridge.polymarket.com/deposit',{method:'POST',headers:{'Content-Type':'application/json','X-Builder-Code':BUILDER},body:JSON.stringify({address:DW})});
  const j:any=await r.json(); const bridgeIn=getAddress(j.address.evm);
  console.log('bridge-in (for DW '+DW+'):', bridgeIn);

  const secret=JSON.parse(readFileSync(`${process.cwd()}/.secrets/outlayer-funding-wallet.json`,'utf8'));
  const c=new OutlayerClient(); const auth=new WkBearerAuth(secret.api_key);
  const bal=BigInt((await c.balance(auth,NEAR_USDC,'intents')).balance||'0');
  console.log('intents USDC:', Number(bal)/1e6);
  console.log('DW pUSD before:', await b(PUSD,DW));
  if(bal===0n){console.log('no intents balance');return;}

  const dr=await c.withdrawDryRun(auth,{chain:'polygon',to:bridgeIn,amount:bal.toString(),token:NEAR_USDC});
  console.log('dry-run:',JSON.stringify(dr));
  if(!dr.would_succeed){console.log('dry-run failed, abort');return;}

  console.log('\n1Click: intents -> native USDC -> bridge-in '+bridgeIn+' …');
  const w=await c.withdraw(auth,{chain:'polygon',to:bridgeIn,amount:bal.toString(),token:NEAR_USDC});
  console.log('withdraw:',JSON.stringify(w));
  for(let i=0;i<25;i++){await sleep(3000);const st=await c.requestStatus(auth,w.request_id);if(isTerminalStatus(st.status)){console.log('1Click terminal:',st.status);break;}}

  console.log('\nwaiting for Polymarket service to swap+wrap -> pUSD into DW …');
  for(let i=0;i<60;i++){
    await sleep(4000);
    const [pusd,biUsdc]=await Promise.all([b(PUSD,DW), b(USDC,bridgeIn)]);
    console.log(`  [${i}] DW pUSD=${pusd} | bridge-in native USDC=${biUsdc}`);
    if(pusd>0){console.log('\n✅✅ pUSD CREDITED to our deposit-wallet 0x56164B27 — service deposit works, lands in OUR wallet!');return;}
  }
  console.log('\n(no pUSD in DW yet after ~4min — service may still be processing; native USDC location above tells where funds sit)');
}
main().catch(e=>{console.error('ERR',e?.message||e,e?.body||'');process.exitCode=1;});
