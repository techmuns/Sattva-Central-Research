import assert from 'node:assert/strict';
import {ensureBreakoutRunner} from './lib/breakout-handover.mjs';
const repo='techmuns/Sattva-Central-Research',env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:repo,GITHUB_RUN_ID:'12',GITHUB_TOKEN:'fixture'},now=Date.parse('2026-10-22T06:00Z');
function fixture(runs=[],{incomplete=false,postStatus=204}={}){const calls=[];return {calls,fetcher:async(url,options)=>{calls.push({url,options});assert.equal(options.redirect,'manual');assert(url.startsWith(`https://api.github.com/repos/${repo}/actions/workflows/breakouts-refresh.yml/`));if(options.method==='POST'){assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{source:'automatic-handover'}});return new Response(null,{status:postStatus});}return Response.json({total_count:runs.length+(incomplete?1:0),workflow_runs:runs});}};}
const closed=fixture();assert.deepEqual(await ensureBreakoutRunner({env,now:Date.parse('2026-10-25T06:00Z'),fetcher:closed.fetcher}),{requested:false,reason:'closed'});assert.equal(closed.calls.length,0);
const absent=fixture();assert.equal((await ensureBreakoutRunner({env,now,fetcher:absent.fetcher})).requested,true);assert.equal(absent.calls.length,6);
for(const status of ['in_progress','queued','waiting','requested','pending']){const run={id:13,head_branch:'main',head_repository:{full_name:repo}};let posts=0;const fetcher=async(url,options)=>{if(options.method==='POST')posts++;return Response.json({total_count:new URL(url).searchParams.get('status')===status?1:0,workflow_runs:new URL(url).searchParams.get('status')===status?[run]:[]});};assert.equal((await ensureBreakoutRunner({env,now,fetcher})).reason,'active');assert.equal(posts,0);}
const owner=fixture([{id:12,head_branch:'main',head_repository:{full_name:repo}}]);assert.equal((await ensureBreakoutRunner({env,now,ignoreCurrent:true,fetcher:owner.fetcher})).requested,true);
const unknown=fixture([],{incomplete:true});await assert.rejects(ensureBreakoutRunner({env,now,fetcher:unknown.fetcher}),/Incomplete/);assert.equal(unknown.calls.length,1);
const ambiguous=fixture([],{postStatus:503});await assert.rejects(ensureBreakoutRunner({env,now,fetcher:ambiguous.fetcher}),/not acknowledged/);assert.equal(ambiguous.calls.length,6);
await assert.rejects(ensureBreakoutRunner({env:{...env,GITHUB_REPOSITORY:'wrong/repo'},now,fetcher:absent.fetcher}),/context/);
for (const time of ['2026-10-29T05:59:00+05:30','2026-10-29T16:16:00+05:30','2026-10-20T08:00:00+05:30','2026-10-25T08:00:00+05:30']) {
 const idle=fixture();assert.equal((await ensureBreakoutRunner({env,now:Date.parse(time),fetcher:idle.fetcher})).reason,'closed');assert.equal(idle.calls.length,0);
}
for (const time of ['2026-10-29T06:00:00+05:30','2026-10-29T08:24:00+05:30','2026-10-29T09:14:59+05:30','2026-10-29T09:15:00+05:30']) {
 const warm=fixture();assert.equal((await ensureBreakoutRunner({env,now:Date.parse(time),fetcher:warm.fetcher})).requested,true,'Pre-open ownership survives a delayed cron');
}
console.log('PASS fixed-repository quote recovery: no duplicate owners, closed-market dispatch or ambiguous retry');
