import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {localBreakouts} from './lib/breakout-local.mjs';
mkdirSync('.cache',{recursive:true});const root=mkdtempSync(resolve('.cache/breakout-local-')),file=join(root,'state.sqlite');
let at=Date.parse('2026-09-15T06:30:00Z'),local,requests=0;
const base={high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-09-11'};
const row=(price=108)=>({ticker:'TEST',name:'Fixture',price,volume:2300,prevClose:100,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString(),sessionDate:'2026-09-15',provider:'Upstox',exchange:'NSE',kind:'quote',base});
const options={env:{GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',UPSTOX_ACCESS_TOKEN:'fixture',CAPTURE_REGISTRY:{getByName(){throw Error('Runner must never call Cloudflare');}}},now:()=>at,
  instruments:async()=>[{segment:'NSE_EQ',instrument_key:'NSE_EQ|INE000000001',trading_symbol:'TEST'}],quotes:async()=>{requests++;return {rows:[row(110+requests)]};}};
try {
  local=localBreakouts(file,options);
  await assert.rejects(local.client({action:'begin',targets:['TEST']}),/cycle/);
  local.beginCycle(1);await local.client({action:'begin',targets:['TEST']});await local.client({action:'checkpoint',rows:[row()]});await local.client({action:'finish'});
  await local.client({action:'inventory',targets:[{ticker:'TEST',isin:'INE000000001',name:'Fixture'}]});
  await local.primary.wake();assert.equal(local.store.read().rows[0].price,111);assert.equal(requests,1);
  await local.close();local=localBreakouts(file,options);await local.primary.wake();assert.equal(requests,1,'A restart respects the saved next-check claim');
  at+=60000;await local.primary.wake();assert.equal(requests,2);assert.equal(local.store.read().rows[0].price,112);
  assert.equal(local.store.readFallback().rows[0].price,108,'Minute captures never overwrite fallback evidence');
  const history=local.store.history('TEST');assert.equal(history.rows.length,3,'Both minute observations and the fallback observation survive restart');
  local.beginCycle(2);await local.client({action:'begin',targets:['TEST']});await local.client({action:'checkpoint',rows:[row(113)]});await local.client({action:'finish'});
  assert.equal(local.store.readFallback().rows[0].price,113);assert.equal(local.store.history('TEST').rows.length,4,'Another fallback cycle has its own immutable replay identity');
  const checkpoint=join(root,'checkpoint.sqlite');await local.checkpoint(checkpoint);
  const copy=localBreakouts(checkpoint,options);assert.equal(copy.store.history('TEST').rows.length,4);await copy.close();
  console.log('PASS runner-local breakouts: exact primary collector, no Cloudflare calls, independent fallback cycles, restart-safe minute claims and retained quote history');
}finally{await local?.close();rmSync(root,{recursive:true,force:true});}
