import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { discover, parseArticle, sourceDay, mergeArticle, emptyCapture, validateCapture, SOURCE } from './lib/private-market-news.mjs';
import { collect } from './collect-private-market-news.mjs';
import { privateMarketRelease } from './lib/private-market-release.mjs';
import { runPrivateMarketJob } from './private-market-job.mjs';
import { health, bindLifecycle } from '../public/js/data/private-market-news.js';
const at = '2026-10-21T08:00:00Z', url = 'https://inc42.com/buzz/from-fixture-to-fixture-this-week/';
const article = { url,title:'Fixture funding this week' };
const row = (name,amount) => `<tr><td>16 Oct 2026</td><td>${name}</td><td>AI</td><td>Software</td><td>B2B</td><td>${amount}</td><td>Series A</td><td>One &amp; Two, Three (Investor)</td><td>One &amp; Two</td></tr>`;
const html = (rows = row('Fixture Company','$11.4 Mn *')) => `<h1>Fixture funding this week</h1><meta property="article:published_time" content="2026-10-17T09:00:00+05:30"><table><tr>${['Date','Name','Sector','Subsector','Business Model','Funding Round Size','Funding Round Type','Investors','Lead Investor'].map(s=>`<td>${s}</td>`).join('')}</tr>${rows}<tr><td></td><td colspan="6">Source: Inc42<br>*Mix of equity and debt<br>** Part of a larger round</td><td></td><td></td></tr></table>`;
const listing = `<a href="${url}" title="Fixture funding this week">Fixture</a><script>var ajax_object = {"ajax_url":"https://inc42.com/wp-admin/admin-ajax.php","api_nonce":"public-fixture","max_page":"2"}; var data = {'query':'{"tag":"funding-galore"}'};</script>`;
assert.equal(discover(listing).articles.length,1);
assert.equal(discover(`<h2 class="entry-title"><a href="${url}">An older funding recap</a></h2>`).articles.length,1,'Every actual source card is discovered even when its title uses an older format');
assert.equal(discover(`<a href="https://evil.test/buzz/funding-this-week/">Funding this week</a>`).articles.length,0);
const parsed = parseArticle(html(),article);
assert.equal(parsed.rows.length,1); assert.equal(parsed.rows[0].amount,'$11.4 Mn *'); assert.equal(parsed.rows[0].investors,'One & Two, Three (Investor)');
assert.equal(parsed.rows[0].dateISO,'2026-10-16'); assert.equal(parsed.notes.length,1);
assert.equal(parseArticle('<table><tr><td>Ad</td></tr></table>',article).status,'unavailable');
assert.throws(()=>parseArticle(html('<tr><td>16 Oct 2026</td><td>Truncated</td></tr>'),article),/incomplete/);
assert.throws(()=>parseArticle(html().replace('<td>16 Oct 2026</td>','<td rowspan="2">16 Oct 2026</td>'),article),/merged data cells/);
assert.equal(sourceDay('31 Feb 2026'),null); assert.equal(sourceDay('Oct 2026'),null);
assert.equal(sourceDay('2026-07-08'),'2026-07-08');assert.equal(sourceDay('7 Sep 2026 **'),'2026-09-07');assert.equal(sourceDay('5 Oct 2926'),null);assert.equal(sourceDay('15 Dec 20205'),null);
assert.equal(parseArticle(html().replace('Source: Inc42','*Completely subscribed.\nSource : Inc42'),article).rows.length,1);
assert.equal(parseArticle(html().replace('Source: Inc42','“Source: Inc42'),article).rows.length,1);
const noLead=parseArticle(html().replace('<td>One &amp; Two</td></tr>','</tr>'),article);assert.equal(noLead.rows[0].leadInvestor,'');assert.equal(noLead.rows[0].investors,'One & Two, Three (Investor)');
const state = emptyCapture(); state.articles.push({...article,status:'pending'});
mergeArticle(state,state.articles[0],parseArticle(html(row('Fixture Company','$11.4 Mn *')+row('Other Company','—')),article),at);
const id=state.deals[0].id;
mergeArticle(state,state.articles[0],parseArticle(html(row('Fixture Company','$12 Mn')),article),'2026-10-22T08:00:00Z');
assert.equal(state.deals.length,2);assert.equal(state.deals[0].id,id);assert.equal(state.deals[0].revisions[0].sourceFields['Funding Round Size'],'$11.4 Mn *');assert.equal(state.deals[1].sourceMissing,true);
const unavailableState=structuredClone(state), heldNotes=structuredClone(state.articles[0].notes), heldPublication=state.articles[0].publishedAt;
mergeArticle(unavailableState,unavailableState.articles[0],parseArticle('<h1>Funding roundup</h1>',article),'2026-10-23T08:00:00Z');
assert.deepEqual(unavailableState.deals,state.deals);assert.deepEqual(unavailableState.articles[0].notes,heldNotes,'An unavailable table retains the captured funding footnotes');
assert.equal(unavailableState.articles[0].publishedAt,heldPublication);assert.equal(unavailableState.articles[0].status,'unavailable');
const repeat = parseArticle(html(row('Same Company','$1 Mn')+row('Same Company','$2 Mn')),article);assert.notEqual(repeat.rows[0].id,repeat.rows[1].id);
let calls=[],pauses=[];
const older='https://inc42.com/buzz/older-funding-this-week/';
const request=async (target,options)=>{calls.push({target,options});return new Response(target===SOURCE?listing:target.includes('admin-ajax')?`<a href="${older}" title="Older funding this week">Older</a>`:html());};
const captured=await collect(emptyCapture(),{request,now:()=>at,sleep:async ms=>pauses.push(ms),budget:4});
assert.equal(calls.length,4);assert(pauses.every(ms=>ms===3000));assert.equal(captured.deals.length,2);assert.equal(captured.archive.complete,true);assert.equal(captured.sourceCheckedAt,at);
let elapsed=0, deadlineReads=0;
const timed=await collect(emptyCapture(),{request:async()=>{deadlineReads++;elapsed=6000;return new Response(listing);},now:()=>at,clock:()=>elapsed,timeBudgetMs:5000});
assert.equal(deadlineReads,1);assert.equal(timed.lastRun.timeBudgetReached,true);assert.equal(timed.articles[0].status,'pending');assert.equal(timed.error,null,'A time-bounded batch retains pending work without inventing source failure');
const archiveCall=calls.find(c=>c.target.includes('admin-ajax'));assert(archiveCall.options.body instanceof URLSearchParams);assert.equal(archiveCall.options.body.get('page'),'2');
await collect(captured,{request,now:()=>at});assert.equal(calls.length,4,'Repeated triggers share the durable six-hour gate');
const limited=emptyCapture();let refusals=0;
await collect(limited,{request:async()=>{refusals++;return new Response('',{status:429,headers:{'retry-after':'172800'}});},now:()=>at});
assert.equal(refusals,1);assert.equal(limited.cooldownUntil,'2026-10-23T08:00:00.000Z');assert.equal(limited.sourceCheckedAt,null);
await collect(limited,{request,now:()=> '2026-10-22T08:00:00Z'});assert.equal(calls.length,4);
limited.deals=captured.deals;limited.articles=captured.articles;
await collect(limited,{request:async()=>new Response('',{status:503}),now:()=> '2026-10-24T08:00:00Z'});assert.equal(limited.deals.length,2,'Failed refresh retains all history');
const resumed=emptyCapture();resumed.archive={nextPage:2,maxPage:2,complete:false};let checkpoints=0;
await collect(resumed,{request,now:()=>at,sleep:async()=>{},budget:4,checkpoint:()=>checkpoints++});assert(checkpoints>=3);
assert.equal(health({...captured,error:'HTTP 429'},Date.parse(at)).readState,'unavailable');
assert.equal(health({...captured,sourceCheckedAt:'bad'},Date.parse(at)).readState,'dated');
assert.equal(health({...captured,articles:[{status:'unavailable'}]},Date.parse(at)).readState,'partial');
assert.equal(health(captured,Date.parse(at)).readState,'read');
assert.equal(health(captured,Date.parse(at)+13*3600000).readState,'dated');
const redirected=emptyCapture();let redirectedReads=0;
await collect(redirected,{request:async target=>{redirectedReads++;return target===SOURCE?new Response(null,{status:302,headers:{location:'https://unapproved.test/'}}):new Response(listing);},now:()=>at});assert.equal(redirectedReads,1);assert.match(redirected.error,/redirect/);
// Current public snapshot and transport are bounded and validated before publication.
assert.throws(()=>validateCapture({...captured,deals:[{...captured.deals[0],sourceUrl:'javascript:alert(1)'}]}));
const repo='techmuns/Sattva-Central-Research';const env={GITHUB_REPOSITORY:repo,GITHUB_TOKEN:'fixture-only',GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
const bytes=gzipSync(JSON.stringify(captured)),digest=createHash('sha256').update(bytes).digest('hex'),name=`funding-123-1-1-${digest}.json.gz`;
const asset={id:101,name,state:'uploaded',size:bytes.length,browser_download_url:`https://github.com/${repo}/releases/download/private-market-news-data/${name}`};
let corrupt=false,missing=false,mutations=0;
const graphReply=(assets,exists=true,body='Capture initialized',pageInfo={hasPreviousPage:false,startCursor:null})=>Response.json({data:{repository:{release:exists?{databaseId:7,tagName:'private-market-news-data',description:body,releaseAssets:{nodes:assets.map(a=>({name:a.name,size:a.size,downloadUrl:a.browser_download_url})),pageInfo}}:null}}});
const fetcher=async(target,options={})=>{
  if(target.startsWith('https://github.com/')){assert.equal(options.headers?.authorization,undefined);return new Response(corrupt?Buffer.from('corrupt'):bytes);}
  assert.equal(options.headers.authorization,'Bearer fixture-only');
  if(target==='https://api.github.com/graphql'){assert.match(JSON.parse(options.body).query,/^query FundingCapture/);return graphReply(missing?[]:[asset]);}
  if(options.method)mutations++;
  if(target.includes('/assets?'))return Response.json(missing?[]:[asset]);
  return Response.json({id:7,tag_name:'private-market-news-data',body:'Capture initialized'});
};
const transport=privateMarketRelease({env,fetcher,head:()=>env.GITHUB_SHA});const latest=await transport.latest();assert.deepEqual(await transport.download(latest),captured);
corrupt=true;await assert.rejects(transport.download(latest),/integrity/);corrupt=false;
missing=true;await assert.rejects(transport.latest(),/refusing reset/);missing=false;
await assert.rejects(privateMarketRelease({env:{...env,GITHUB_REF:'refs/heads/codex/test'},fetcher,head:()=>env.GITHUB_SHA}).publish(captured),/main-branch/);assert.equal(mutations,0);
let retained=null, sourceWalks=0;const ordering=[];
const memoryTransport={latest:async()=>retained?{asset:{id:1}}:null,download:async()=>structuredClone(retained),publish:async value=>{retained=structuredClone(value);ordering.push(value.error?'reservation':'completion');}};
const jobOptions={transport:memoryTransport,bootstrap:emptyCapture,now:()=>at,collector:async value=>{ordering.push('source');sourceWalks++;value.error=null;value.sourceCheckedAt=at;}};
assert.equal((await runPrivateMarketJob(jobOptions)).attempted,true);assert.deepEqual(ordering,['reservation','source','completion']);
assert.equal((await runPrivateMarketJob(jobOptions)).attempted,false);assert.equal(sourceWalks,1,'An hourly wake cannot repeat a reserved source walk');
await assert.rejects(runPrivateMarketJob({...jobOptions,transport:{...memoryTransport,latest:async()=>null,publish:async()=>{throw Error('GitHub unavailable');}}}),/GitHub unavailable/);assert.equal(sourceWalks,1,'Source traffic cannot start without durable reservation');
let promoted=0;assert.equal((await runPrivateMarketJob({...jobOptions,bootstrap:()=>({...captured,attemptedAt:at}),transport:{...memoryTransport,latest:async()=>null,publish:async()=>promoted++}})).attempted,false);assert.equal(promoted,1);assert.equal(sourceWalks,1,'A recent verified bootstrap is retained without another source request');
let releaseExists=false,releaseBody='',sequence=1,loseAcknowledgement=false;const assets=[];
const publishingFetcher=async(target,options={})=>{
  if(target.startsWith('https://github.com/')){assert.equal(options.headers?.authorization,undefined);const held=assets.find(a=>a.browser_download_url===target);return new Response(held.bytes);}
  assert.equal(options.headers.authorization,'Bearer fixture-only');
  if(target==='https://api.github.com/graphql')return graphReply(assets,releaseExists,releaseBody);
  if(target.startsWith('https://uploads.github.com/')){
    const name=new URL(target).searchParams.get('name'),bytes=Buffer.from(options.body);
    const asset={id:sequence++,name,state:'uploaded',size:bytes.length,browser_download_url:`https://github.com/${repo}/releases/download/private-market-news-data/${name}`,bytes};
    if(!loseAcknowledgement)assets.push(asset);return Response.json({...asset,bytes:undefined});
  }
  if(target.includes('/assets?'))return Response.json(assets.map(({bytes,...a})=>a));
  if(options.method==='POST'){releaseExists=true;return Response.json({id:7,tag_name:'private-market-news-data',body:releaseBody,assets:[]});}
  if(options.method==='PATCH'){releaseBody=JSON.parse(options.body).body;return Response.json({id:7});}
  return releaseExists?Response.json({id:7,tag_name:'private-market-news-data',body:releaseBody,assets:assets.map(({bytes,...a})=>a)}):new Response(null,{status:404});
};
const publishing=privateMarketRelease({env,fetcher:publishingFetcher,head:()=>env.GITHUB_SHA,sleep:async()=>{}});
const published=await publishing.publish(captured);assert.equal(published.asset.name,name);assert.deepEqual(await publishing.download(published),captured);
await publishing.publish(captured);assert.equal(assets.length,1,'Identical captures do not consume another asset');
loseAcknowledgement=true;await assert.rejects(publishing.publish({...captured,generatedAt:'2026-10-21T09:00:00Z'}),/durably acknowledged/);
assert.deepEqual(await publishing.download(await publishing.latest()),captured,'Failed publication preserves the last complete capture');
let pages=0;
const paged=privateMarketRelease({env,fetcher:async(target,options)=>{assert.equal(target,'https://api.github.com/graphql');pages++;return JSON.parse(options.body).variables.before?graphReply([asset]):graphReply([{name:'incomplete',size:0}],true,'Capture initialized',{hasPreviousPage:true,startCursor:'older'});}});
assert.equal((await paged.latest()).asset.name,name);assert.equal(pages,2,'A bounded reverse cursor recovers earlier complete data without scanning years of metadata');
// A late callback after leaving the view cannot fetch, and lifecycle hooks are removed.
const doc=new EventTarget(),win=new EventTarget();doc.visibilityState='hidden';let callback,cancelled=0;
const stop=bindLifecycle({doc,win,schedule:fn=>{callback=fn;return 1;},cancel:()=>cancelled++});stop();await callback();assert.equal(cancelled,1);
const workflow=readFileSync('.github/workflows/private-market-news.yml','utf8');assert.match(workflow,/runs-on: ubuntu-latest/);assert.match(workflow,/cancel-in-progress: false/);assert.doesNotMatch(workflow,/wrangler|git push|force/);
console.log('PASS private funding: source table fidelity, dates, repeat rounds, corrections, removals, archive resume, pacing, durable gates, refusals, retained failures, public release integrity, provenance and lifecycle cleanup.');
