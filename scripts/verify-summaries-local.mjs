import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {localSummaries} from './lib/summaries-local.mjs';
import {runSummaryCollection} from './collect-screener-summaries.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/summary-local-'));
let at=Date.parse('2026-10-15T08:00:00Z'),runtime,opened=0,reads=0,sequence=0,fail=false;
const env={GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1'},now=()=>at,stamp=()=>new Date(at).toISOString();
const inventory=()=>({version:1,portfolioRevision:'a'.repeat(64),portfolioCheckedAt:stamp(),sourceCheckedAt:stamp(),portfolioAsOf:'2026-10-01',portfolioWorkbookUploadedAt:stamp(),
  holdings:[{isin:'INE000000001',name:'Private Fixture',ticker:'TEST',companyKey:'TEST',discovery:'matched'}],
  targets:[{id:'1',isin:'INE000000001',name:'Private Fixture',ticker:'TEST',companyKey:'TEST',companyUrl:'https://www.screener.in/company/TEST/',publishedDate:'2026-10-01',kind:'Transcript',sourceName:'Fixture transcript',rank:0,url:'https://www.screener.in/concalls/summary/1/'}]});
const body={title:'Concall Summary - Private Fixture - October 2026',blocks:[{type:'paragraph',text:'The company discussed its operating performance and management provided its outlook for the current financial year. These captured source notes retain the original evidence without adding new conclusions or guesses.'}]};
let durable;
const checkpoint=async({phase,local,store})=>{
  if(phase==='reserve')assert.equal(store.status().automatedRequestsLast24h,1,'The claim is counted before checkpoint acknowledgement');
  if(fail)throw Error('Fixture GitHub publication unavailable');
  durable=path.join(root,`acknowledged-${++sequence}.sqlite`);await local.checkpoint(durable);
};
try {
  runtime=localSummaries(path.join(root,'local.sqlite'),{env,now,checkpoint});
  const result=await runSummaryCollection({client:runtime.client,inventory:async()=>inventory(),now,sleep:async ms=>{at+=ms;},openSession:async()=>{opened++;const restored=localSummaries(durable,{env,now,checkpoint});assert.equal(restored.store.status().automatedRequestsLast24h,1,'A new runner already sees the reserved paid attempt before login');await restored.close();return {page:{},close:async()=>{}};},read:async()=>{reads++;return body;}});
  assert.equal(result.saved,1);assert.equal(opened,1);assert.equal(reads,1);
  await runtime.close();runtime=localSummaries(durable,{env:{...env,GITHUB_RUN_ID:'12346'},now,checkpoint});
  assert.deepEqual(runtime.store.read(['1'])[0].body,body,'An acknowledged private source body survives a runner restart');
  assert.equal((await runtime.client({action:'reserve',requestId:randomUUID()})).reserved,false,'An already captured source is never fetched again');
  await runtime.close();runtime=null;
  runtime=localSummaries(path.join(root,'crashed-source.sqlite'),{env,now,checkpoint});await runtime.client({action:'sync',inventory:inventory()});
  assert((await runtime.client({action:'reserve',requestId:randomUUID()})).reserved);await runtime.close();
  runtime=localSummaries(durable,{env:{...env,GITHUB_RUN_ID:'12347'},now,checkpoint});at+=6*60000;
  assert.equal(runtime.store.status().automatedRequestsLast24h,1);assert.equal((await runtime.client({action:'reserve',requestId:randomUUID()})).reserved,false,'A crash after the paid claim retains its allowance and day-long retry delay after the lease expires');await runtime.close();runtime=null;
  const phases=[];fail=true;
  runtime=localSummaries(path.join(root,'publication-failure.sqlite'),{env,now,checkpoint:async detail=>{phases.push(detail.phase);if(detail.phase==='sync')return;return checkpoint(detail);}});
  await assert.rejects(runSummaryCollection({client:runtime.client,inventory:async()=>inventory(),now,openSession:async()=>{opened++;return {page:{}};},read:async()=>{reads++;return body;}}),/publication unavailable/);
  assert.deepEqual(phases,['sync','reserve']);assert.equal(opened,1);assert.equal(reads,1,'No metered page is opened after an unacknowledged reservation');
  await assert.rejects(runtime.client({action:'reserve',requestId:randomUUID()}),/no further source requests/);
  console.log('PASS runner-local private summaries: full inventory reconciliation, durable paid claim before source I/O, private body retention across restart and fail-closed publication without further source requests');
}finally{await runtime?.close();fs.rmSync(root,{recursive:true,force:true});}
