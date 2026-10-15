import assert from 'node:assert/strict';
import {ensureSummaryCatalogue} from './lib/summary-catalogue-github.mjs';
let at=Date.parse('2026-10-15T08:00:00Z'),requested=null,latest=null,dispatches=0,publications=0,polls=0,uncertain=false;
const env={GITHUB_REPOSITORY:'techmuns/Sattva-Central-Research',GITHUB_TOKEN:'fixture-only'};
const local={storage:{get:async()=>requested,put:async(key,value)=>{assert.equal(key,'summary-timer');requested=value;}},publish:async()=>{publications++;assert.equal(requested.catalogueRequestedAt,at);}};
const fetcher=async(raw,options={})=>{
 const url=new URL(raw);assert.equal(url.origin,'https://api.github.com');assert.equal(options.headers.authorization,'Bearer fixture-only');assert(url.pathname.includes('/screener-concalls-refresh.yml/'));
 if(options.method==='POST'){dispatches++;assert(publications>0,'Dispatch intent is acknowledged before source work is requested');if(uncertain)throw Error('Acknowledgement lost');latest={id:1,status:'queued',conclusion:null,created_at:new Date(at).toISOString()};return new Response(null,{status:204});}
 return Response.json({workflow_runs:url.searchParams.has('status')?[]:latest?[latest]:[]});
};
const now=()=>at,sleep=async ms=>{at+=ms;if(latest){polls++;latest.status=polls>=2?'completed':'in_progress';latest.conclusion=polls>=2?'success':null;}};
await ensureSummaryCatalogue(local,{env,fetcher,now,sleep});assert.equal(dispatches,1);assert.equal(publications,1);assert.equal(polls,2);
await ensureSummaryCatalogue(local,{env,fetcher,now,sleep});assert.equal(dispatches,1,'A fresh catalogue is reused');
at+=31*60000;latest=null;requested=null;uncertain=true;await assert.rejects(ensureSummaryCatalogue(local,{env,fetcher,now,sleep}));assert.equal(dispatches,2);
await assert.rejects(ensureSummaryCatalogue(local,{env,fetcher,now,sleep,maxWait:4*60000}),/Fresh catalogue unavailable/);assert.equal(dispatches,2,'An uncertain dispatch cannot become a two-minute source job');
latest={id:2,status:'in_progress',created_at:new Date(at-46*60000).toISOString()};await assert.rejects(ensureSummaryCatalogue(local,{env,fetcher,now,sleep}),/overdue/);
latest={id:3,status:'completed',created_at:'invalid'};await assert.rejects(ensureSummaryCatalogue(local,{env,fetcher,now,sleep}),/time unavailable/);
console.log('PASS GitHub summary dependency: acknowledged source-dispatch claim, fresh catalogue reuse, bounded polling, uncertain dispatch suppression and overdue/invalid source refusal');
