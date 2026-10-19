import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DEFAULT_SETTINGS,istInstant} from '../public/js/data/newsletter-shared.js';
import {newsletterWakePlan,newsletterRetryState,NEWSLETTER_WAKE_MS} from './lib/newsletter-wake-plan.mjs';
import {newsletterWakeGate} from './newsletter-wake-gate.mjs';
import {breakoutCollectorIdentity} from '../worker/breakout-auth.mjs';
import {BREAKOUT_ENDPOINT,BREAKOUT_WORKFLOW} from '../public/js/data/breakout-live-shared.js';

const due=istInstant('2026-10-19','08:00');
const fixture=()=>({ok:true,runtime:'github-actions',settings:structuredClone(DEFAULT_SETTINGS),revision:7,inputRevision:7,
 schedule:{lastWakeAt:new Date(due-1000).toISOString(),lastCheckedAt:new Date(due-1000).toISOString()}});
const plan=(value,now)=>newsletterWakePlan(value,{now});
assert.equal(plan(fixture(),due-1).due,false);
assert.equal(plan(fixture(),due).reason,'edition-due','The send boundary wakes even one second after a prior check');
assert.equal(plan(fixture(),due+2*3600000).reason,'edition-due','Reproduce the missed Monday 08:00 GitHub cron');
const checked=fixture();checked.schedule.lastWakeAt=checked.schedule.lastCheckedAt=new Date(due).toISOString();
for(let i=1;i<100;i++)assert.equal(plan(checked,due+i*1000).due,false,'Completion storms cannot multiply checks');
assert.equal(plan(checked,due+NEWSLETTER_WAKE_MS-1).due,false);
assert.equal(plan(checked,due+NEWSLETTER_WAKE_MS).reason,'check-overdue');
const evening=fixture();evening.schedule.lastWakeAt=evening.schedule.lastCheckedAt=istInstant('2026-10-19','15:59');
assert.equal(plan(evening,istInstant('2026-10-19','16:00')).reason,'edition-due');
for(const day of ['2026-10-20','2026-10-21','2026-10-22','2026-10-23']){
 const value=fixture(),at=istInstant(day,'08:00');value.schedule.lastWakeAt=value.schedule.lastCheckedAt=at-1000;
 assert.equal(plan(value,at).reason,'edition-due');
}
for(const day of ['2026-10-17','2026-10-18']){
 const value=fixture(),at=istInstant(day,'08:00');value.schedule.lastWakeAt=value.schedule.lastCheckedAt=at-1000;
 assert.equal(plan(value,at).due,false,'No automatic weekend edition');
}
const custom=fixture();custom.settings.morning.time='08:30';custom.schedule.lastWakeAt=custom.schedule.lastCheckedAt=due+29*60000;
assert.equal(plan(custom,due+30*60000).reason,'edition-due','Use edited send times rather than hard-coded 08:00');
const disabled=fixture();disabled.settings.morning.enabled=false;assert.equal(plan(disabled,due).due,false);
const retry=structuredClone(checked);retry.schedule.deliveryRecovery=newsletterRetryState([{edition:'morning',source:'timer',next_at:due+1000}]);
assert.equal(plan(retry,due+999).due,false);assert.equal(plan(retry,due+1000).reason,'delivery-retry-due');
retry.settings.morning.enabled=false;
assert.equal(plan(retry,due+1000).due,false,'A disabled morning retry cannot make every collector completion start a job');
retry.schedule.deliveryRecovery=newsletterRetryState([{edition:'morning',source:'timer',next_at:due},{edition:'morning',source:'button',next_at:due+1000},{edition:'morning',source:'test',next_at:due}]);
assert.equal(retry.schedule.deliveryRecovery.pendingEditions,2);assert.equal(retry.schedule.deliveryRecovery.pending.length,2);
assert.equal(plan(retry,due+1000).reason,'delivery-retry-due','Explicit subscriber sends retain their independent recovery');
const aggregate=structuredClone(checked);aggregate.schedule.deliveryRecovery={pendingEditions:1,nextRetryAt:new Date(due).toISOString()};
assert.equal(plan(aggregate,due+1).due,false,'Older aggregate readers use the five-minute cadence instead of a stale retry deadline');
assert.equal(plan(aggregate,due+NEWSLETTER_WAKE_MS).reason,'check-overdue');
const changed=structuredClone(checked);changed.revision++;assert.equal(plan(changed,due+1).reason,'inputs-changed');
const publicShape=structuredClone(checked);delete publicShape.inputRevision;
assert.equal(plan(publicShape,due+1).due,false,'The public response has revision but omits inputRevision');
publicShape.schedule.reason='waiting-for-inputs';assert.equal(plan(publicShape,due+1).reason,'inputs-changed');
const unknown=fixture();delete unknown.schedule.lastWakeAt;assert.equal(plan(unknown,due).reason,'wake-unverified');

const repo='techmuns/Sattva-Central-Research';
let reads=0;
const gate=await newsletterWakeGate({event:'workflow_run',repo,now:due,fetcher:async(url,options)=>{
 reads++;assert.equal(url,new URL('/api/newsletter',BREAKOUT_ENDPOINT).href);
 assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert(!options.headers.authorization);assert(!options.body);
 return Response.json({...fixture(),subscribers:[{email:'private@example.test'}]});
}});
assert.equal(gate.reason,'edition-due');assert(!JSON.stringify(gate).includes('private'));
for(const event of ['schedule','push','workflow_dispatch']){
 assert((await newsletterWakeGate({event,fetcher:()=>{throw Error('Primary triggers do not depend on the deployed reader');}})).due);
}
assert.equal(reads,1);
await assert.rejects(newsletterWakeGate({event:'workflow_run',repo:'untrusted/other'}),/repository/);
const options={event:'workflow_run',repo,now:due};
await assert.rejects(newsletterWakeGate({...options,fetcher:async()=>new Response(null,{status:503})}));
await assert.rejects(newsletterWakeGate({...options,fetcher:async()=>Response.json({ok:false})}),/reader/);
await assert.rejects(newsletterWakeGate({...options,fetcher:async()=>new Response('x'.repeat(8*1024*1024+1))}),/size/);
const workflow=fs.readFileSync('.github/workflows/newsletter-refresh.yml','utf8');
assert(workflow.includes('workflows: [Alert pool refresh, Announcement index refresh, Corporate announcements refresh, Market news refresh, RSS news refresh, TradingView portfolio news, Family book sync, Data refresh]'));
assert(workflow.includes("head_repository.full_name == github.repository"));assert(workflow.includes("head_branch == 'main'"));
assert(workflow.includes("conclusion == 'success'"));assert(workflow.includes("if: needs.gate.outputs.run == 'true'"));
const gateJob=workflow.slice(workflow.indexOf('  gate:'),workflow.indexOf('  process:'));
assert(!/secrets\.|contents: write|actions: write|id-token: write/.test(gateJob),'The preflight job cannot send or decrypt');
assert(workflow.slice(workflow.indexOf('  process:')).includes('group: newsletter-account'));
assert(workflow.includes('queue: max'),'Distinct manual requests retain their queue');

// Detect the actual workflow_run dependency cycle, including through Deploy.
const graph=new Map();
for(const file of fs.readdirSync('.github/workflows').filter(name=>name.endsWith('.yml'))){
 const source=fs.readFileSync('.github/workflows/'+file,'utf8');
 const name=source.match(/^name:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g,'');
 const block=source.match(/^  workflow_run:\s*\n((?: {4}.*\n|[ \t]*\n)*)/m)?.[1]||'';
 const inline=block.match(/^ {4}workflows:\s*\[([^\]]+)\]/m)?.[1];
 const entries=inline?inline.split(','):Array.from((block.match(/^ {4}workflows:\s*\n((?: {6}- .*\n)*)/m)?.[1]||'').matchAll(/^ {6}- (.*)$/gm),m=>m[1]);
 for(const entry of entries){const parent=entry.trim().replace(/^["']|["']$/g,'');if(!graph.has(parent))graph.set(parent,new Set());graph.get(parent).add(name);}
}
function newsletterCycle(edges){
 const pending=[...(edges.get('Newsletter processing')||[])],seen=new Set();
 while(pending.length){const name=pending.shift();if(name==='Newsletter processing')return true;if(seen.has(name))continue;seen.add(name);pending.push(...(edges.get(name)||[]));}
 return false;
}
assert(graph.get('Newsletter processing')?.has('Deploy'),'The regression must include the existing deployment trigger');
assert(!newsletterCycle(graph),'Newsletter completion must not trigger its own recovery workflow indirectly');
const reciprocal=new Map([...graph].map(([key,values])=>[key,new Set(values)]));if(!reciprocal.has('Deploy'))reciprocal.set('Deploy',new Set());reciprocal.get('Deploy').add('Newsletter processing');
assert(newsletterCycle(reciprocal),'Reproduce the reciprocal Deploy trigger found by automated review');

// Exercise real signed OIDC claims: adding workflow_run to YAML alone is not
// enough if the read-only input/export endpoint refuses that identity.
const endpoint=new URL('/api/newsletter/collector',BREAKOUT_ENDPOINT).href;
const key=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',key.publicKey),kid:'fixture',use:'sig',alg:'RS256'};
const claims={iss:'https://token.actions.githubusercontent.com',aud:endpoint,repository:repo,repository_id:'1329567087',repository_owner_id:'278697674',ref:'refs/heads/main',workflow_ref:`${repo}/.github/workflows/newsletter-refresh.yml@refs/heads/main`,event_name:'workflow_run',exp:due/1000+300,iat:due/1000,nbf:due/1000,run_id:'123',run_attempt:'1'};
async function identity(patch={},overrides={}){
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const body=encode({alg:'RS256',kid:'fixture'})+'.'+encode({...claims,...patch});
 const signature=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(body))).toString('base64url');
 return breakoutCollectorIdentity(new Request(endpoint,{headers:{authorization:`Bearer ${body}.${signature}`}}),{endpoint,workflow:'newsletter-refresh.yml',now:due,fetcher:async()=>Response.json({keys:[jwk]}),...overrides});
}
assert.equal(await identity(),'123:1');
for(const patch of [{event_name:'pull_request'},{repository:'untrusted/fork'},{repository_id:'1'},{repository_owner_id:'1'},{ref:'refs/heads/feature'},{aud:'https://example.test'},{workflow_ref:claims.workflow_ref.replace('newsletter-refresh','other')},{exp:due/1000-1}])await assert.rejects(identity(patch));
await assert.rejects(identity({aud:BREAKOUT_ENDPOINT,workflow_ref:`${repo}/.github/workflows/${BREAKOUT_WORKFLOW}@refs/heads/main`},{endpoint:BREAKOUT_ENDPOINT,workflow:BREAKOUT_WORKFLOW}),'Other collectors retain their event restrictions');
console.log('PASS newsletter scheduling: missed cron, exact IST boundaries, edited/disabled/weekend schedules, retries, five-minute coalescing, credential-free bounded gate and trusted GitHub completion events.');
