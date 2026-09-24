#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NewsletterNewsBudget } from '../worker/newsletter-news-budget.mjs';
import { newsModelCall, NEWS_MODEL, NEWS_REVIEW_MODEL, objectSchema } from '../worker/newsletter-openai.mjs';
import { readNewsAi, validateNews } from '../worker/newsletter-news-ai.mjs';
import { readDocumentFacts, contentIdentity } from '../worker/newsletter-content.mjs';
import { NewsletterContentStore } from '../worker/newsletter-content-store.mjs';
import { topicOf, readAiNotes } from '../worker/newsletter-brief.mjs';
import { reviewNewsEvents } from '../worker/newsletter-events.mjs';
import { istInstant } from '../public/js/data/newsletter-shared.js';
const now = istInstant('2026-09-24','09:00');
const env = { OPENAI_API_KEY: 'fixture-secret' };
function storage() {
 const db = new DatabaseSync(':memory:');
 return { sql: { exec(sql,...args) { const rows=db.prepare(sql).all(...args); return { toArray:()=>rows }; } },
  transactionSync(fn) { db.exec('BEGIN'); try { const out=fn(); db.exec('COMMIT'); return out; } catch(e) { db.exec('ROLLBACK'); throw e; } } };
}
const budget = () => new NewsletterNewsBudget(storage(), { now: () => now });
const item = { ticker:'DCW', company:'DCW Limited', kind:'news', headline:'India starts anti-dumping probe into Chinese glycine imports',
 url:'https://www.tradingview.com/news/example', at:now, keys:['dcw-news'] };
// Synthetic reproducer of the two-event confusion; no publisher article is copied into the repo.
const glycine = 'Avid Organics requested an anti-dumping investigation into glycine imports from China.';
const cpvc = 'DCW, Epigral and Lubrizol applied for an anti-circumvention investigation involving CPVC imports routed through Malaysia, Japan and Thailand.';
const article = `${glycine} Separately, ${cpvc} The investigation has begun; no final extension of duties has been decided.`;
const answer = { issuerMatches:true, multiEvent:true, role:'applicant', product:'CPVC', companyQuote:cpvc,
 facts:[{field:'event',value:'DCW applied for a CPVC anti-circumvention investigation.',quote:cpvc,location:'paragraph 2'}],
 summary:'DCW is one of the applicants for an anti-circumvention investigation into CPVC imports routed through Malaysia, Japan and Thailand.',
 impact:'', unknowns:'The investigation does not establish a final duty decision.' };
const reply = (data,usage={input_tokens:1200,output_tokens:300}) => Response.json({status:'completed',usage,
 output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}]});
const forbid = async()=>{throw Error('Unexpected paid request');};
let passed=0;
async function test(name,fn) { await fn(); console.log(`PASS ${name}`); passed++; }
await test('DCW role/product evidence and neutral trade-policy label replace the headline inference',async()=>{
 assert.ok(validateNews(answer,article,item));
 assert.equal(validateNews({...answer,product:'glycine'},article,item),null);
 assert.equal(validateNews({...answer,companyQuote:glycine},article,item),null);
 assert.equal(validateNews({...answer,facts:[{...answer.facts[0],quote:glycine}]},article,item),null);
 assert.equal(validateNews({...answer,summary:answer.summary+' Sales rise 50%.'},article,item),null);
 assert.equal(topicOf({...item,keywordIds:['probe'],keywordGroups:['risk']}).label,'Trade policy');
 assert.equal(topicOf({kind:'news',headline:'Company faces fraud probe',keywordGroups:['risk']}).label,'Trouble');
});
await test('multi-event articles get independent stronger review; only corrected result is cached',async()=>{
 const b=budget(), models=[];
 const out=await readNewsAi({article,item,env,budget:b,now,fetcher:async(url,init)=>{
  assert.equal(url,'https://api.openai.com/v1/responses'); assert.equal(init.redirect,'manual');
  const body=JSON.parse(init.body); models.push(body.model);
  assert.equal(body.store,false); assert.equal(body.reasoning.effort,'none'); assert.equal(body.service_tier,'default');
  assert.equal(body.text.format.strict,true); assert.ok(body.input.includes(article));
  assert.equal(init.headers.authorization,'Bearer fixture-secret');
  return reply(models.length===1?{...answer,product:'glycine',summary:'DCW may benefit from glycine duties.'}:answer);
 }});
 assert.deepEqual(models,[NEWS_MODEL,NEWS_REVIEW_MODEL]); assert.equal(out.product,'CPVC'); assert.equal(out.reviewed,true);
 assert.equal(out.note.impact,''); assert.ok(!/glycine/.test(out.note.summary));
 const saved=await readNewsAi({article,item,env,budget:new NewsletterNewsBudget(b.storage),now:now+86400000,fetcher:forbid});
 assert.equal(saved.cached,true); assert.equal(saved.note.summary,out.note.summary);
 assert.ok(b.status(now).dayUsedUsd>0); assert.ok(!JSON.stringify(b.status(now)).includes('fixture-secret'));
});
await test('unconfirmed reviewer results stay pending, never fall back to the cheap draft',async()=>{
 let calls=0;
 const b=budget();
 await assert.rejects(readNewsAi({article,item,env,budget:b,now,fetcher:async()=>{calls++;return reply({...answer,issuerMatches:false});}}),/company-evidence-unconfirmed/);
 assert.equal(calls,2);
 await assert.rejects(readNewsAi({article,item,env,budget:new NewsletterNewsBudget(b.storage),now:now+86400000,fetcher:forbid}),/company-evidence-unconfirmed/);
});
await test('simple company news uses one call; requesting impact requires review',async()=>{
 const text='Acme Limited has signed a contract to supply equipment to Beta Limited. The contract is subject to customer approval and its value has not been disclosed.';
 const i={...item,ticker:'ACME',company:'Acme Limited',headline:'Acme signs supply contract'};
 const a={...answer,multiEvent:false,role:'participant',product:'equipment',companyQuote:text,
 facts:[{field:'event',value:'Acme signed a conditional equipment contract.',quote:text,location:'paragraph 1'}],
 summary:'Acme signed a contract to supply equipment to Beta, subject to customer approval.',unknowns:'The value was not disclosed.'};
 let calls=0;
 await readNewsAi({article:text,item:i,env,budget:budget(),now,fetcher:async()=>{calls++;return reply(a);}});
 assert.equal(calls,1);
 calls=0;
 await readNewsAi({article:text,item:i,env,budget:budget(),now,fetcher:async()=>{calls++;return reply({...a,impact:'It could add orders if approved.'});}});
 assert.equal(calls,2);
});
await test('daily/monthly reservations survive restarts, concurrency and uncertain responses',async()=>{
 const b=budget();
 const reserve=()=>b.reserve({job:crypto.randomUUID(),model:NEWS_MODEL,amount:600000,now});
 const claims=await Promise.all([Promise.resolve().then(reserve),Promise.resolve().then(reserve)]);
 assert.equal(claims.filter(c=>c.ok).length,1);
 const restart=new NewsletterNewsBudget(b.storage);
 assert.equal(restart.status(now).dayUsedUsd,0.6);
 assert.equal(restart.reserve({job:'other',model:NEWS_MODEL,amount:500000,now}).reason,'news-budget');
 const day2=now+86400000;
 assert.equal(restart.reserve({job:'next-day',model:NEWS_MODEL,amount:500000,now:day2}).ok,true);
 assert.equal(restart.status(day2).monthUsedUsd,1.1);
 const monthly=budget();
 for(let day=1;day<=25;day++) assert.equal(monthly.reserve({job:String(day),model:NEWS_MODEL,amount:1000000,now:istInstant(`2026-09-${String(day).padStart(2,'0')}`,'10:00')}).ok,true);
 assert.equal(monthly.reserve({job:'26',model:NEWS_MODEL,amount:1,now:istInstant('2026-09-26','10:00')}).reason,'news-budget');
 assert.equal(monthly.reserve({job:'oct',model:NEWS_MODEL,amount:1,now:istInstant('2026-10-01','00:00')}).ok,true);
});
await test('per-input attempts are bounded; budget denial never reaches a provider',async()=>{
 const b=budget();
 for(let n=0;n<3;n++) assert.ok(b.reserve({job:'same',model:NEWS_MODEL,amount:1,now}).ok);
 assert.equal(b.reserve({job:'same',model:NEWS_MODEL,amount:1,now}).reason,'news-attempt-limit');
 b.reserve({job:'fill',model:NEWS_MODEL,amount:999997,now});
 await assert.rejects(newsModelCall({env,fetcher:forbid,budget:b,job:'new',now,instructions:'test',input:{},schema:objectSchema({})}),/news-budget/);
 await assert.rejects(newsModelCall({env,fetcher:forbid,job:'missing',now}),/news-budget-unavailable/);
});
await test('timeouts, refusals, incomplete replies and missing usage never become successful notes or zero cost',async()=>{
 for(const fetcher of [async()=>{throw Error('network');},async()=>new Response('private upstream error',{status:401}),
  async()=>Response.json({status:'incomplete',output:[]}),async()=>Response.json({status:'completed',output:[{content:[{type:'refusal',refusal:'no'}]}]})]) {
  const b=budget();
  await assert.rejects(newsModelCall({env,fetcher,budget:b,job:'x',now,instructions:'test',input:{},schema:objectSchema({})}));
  assert.ok(b.status(now).dayUsedUsd>0);
 }
});
await test('usage accounts for all output tokens, including reasoning; no cache discount assumed',async()=>{
 const b=budget();
 await newsModelCall({env,budget:b,job:'usage',now,instructions:'test',input:{},schema:objectSchema({}),fetcher:async()=>reply({},
 {input_tokens:1000,input_tokens_details:{cached_tokens:900,cache_write_tokens:0},output_tokens:1000,output_tokens_details:{reasoning_tokens:900}})});
 assert.equal(b.status(now).dayUsedUsd,0.0006);
});
await test('restricted/missing article bodies make no AI call; publisher requests never contain the key',async()=>{
 for(const restricted of [true,false]) {
  let calls=0;
  const result=await readDocumentFacts({item,env,now,newsBudget:budget(),fetcher:async(url,init)=>{
   calls++; assert.equal(url,item.url); assert.equal(init.headers.authorization,undefined);
   return new Response(restricted?`<script type="application/ld+json">${JSON.stringify({'@type':'NewsArticle',articleBody:article,isAccessibleForFree:false})}</script>`:'<html>Sign in to read</html>',{headers:{'content-type':'text/html'}});
  }});
  assert.equal(calls,1); assert.equal(result.state,restricted?'partial':'pending'); assert.equal(result.facts.length,0);
 }
});
await test('durable source queue saves notes; second edition adds no AI writer call',async()=>{
 const store=new NewsletterContentStore(storage()); const id=await contentIdentity(item);
 store.enqueue([{...item,id}],now);
 let modelCalls=0;
 const fetcher=async(url)=>{
  if(url===item.url)return new Response(`<article>${article}</article>`,{headers:{'content-type':'text/html'}});
  modelCalls++;return reply(answer);
 };
 await store.process({env,fetcher,now});
 assert.equal(modelCalls,2); const saved=store.get(id); assert.equal(saved.state,'ready'); assert.equal(saved.note.summary,answer.summary);
 await new NewsletterContentStore(store.storage).process({env,fetcher:forbid,now:now+86400000});
 const companies=[{company:item.company,ticker:item.ticker,clusters:[{id:'c1',kind:'story',main:{...item,content:saved},others:[]}]}];
 const notes=await readAiNotes({env,fetcher:forbid,companies,now});
 assert.equal(notes.ok,true); assert.equal(notes.answered,1); assert.equal(notes.items.c1.summary,answer.summary);
 companies[0].clusters[0].main.content={state:'pending',reason:'company-evidence-unconfirmed'};
 assert.equal((await readAiNotes({env,fetcher:forbid,companies,now})).answered,0);
});
await test('source changes invalidate saved notes while unchanged inputs survive date rollover',async()=>{
 assert.notEqual(await contentIdentity(item),await contentIdentity({...item,summary:'Corrected report'}));
 const b=budget(); let calls=0;
 const fetcher=async()=>{calls++;return reply(answer);};
 await readNewsAi({article,item,env,budget:b,now,fetcher});
 await readNewsAi({article:article+' Further details are awaited.',item,env,budget:b,now,fetcher});
 assert.equal(calls,4);
});
await test('news grouping uses the same spending ledger and cache; previews make no calls',async()=>{
 const news={groups:[{ticker:'ACME',company:'Acme',items:[0,1].map(n=>({headline:'Acme signs equipment contract',summary:'A new equipment contract',at:now,url:`https://example.test/${n}`}))}]};
 const b=budget();let calls=0;
 const fetcher=async()=>{calls++;return reply({groups:[['n0.0','n0.1']]});};
 assert.equal((await reviewNewsEvents({news,env,enabled:false,budget:b,fetcher:forbid,now})).reason,'preview');
 assert.equal((await reviewNewsEvents({news,env,budget:b,fetcher,now})).combined,1);
 assert.equal((await reviewNewsEvents({news,env,budget:b,fetcher:forbid,now})).combined,1);assert.equal(calls,1);
});
await test('only article-defined company abbreviations can ground extra facts',async()=>{
 const i={...item,ticker:'ENGINERSIN',company:'Engineers India Limited'};
 const text='Engineers India (EIL) signed a consulting contract. EIL is also expanding an existing project.';
 const a={...answer,product:'',companyQuote:'Engineers India (EIL) signed a consulting contract.',
 facts:[{field:'event',value:'EIL signed a contract.',quote:'Engineers India (EIL) signed a consulting contract.',location:'paragraph 1'},
 {field:'status',value:'EIL is expanding an existing project.',quote:'EIL is also expanding an existing project.',location:'paragraph 2'}],
 summary:'Engineers India Limited signed a consulting contract and is expanding an existing project.'};
 assert.ok(validateNews(a,text,i));
 assert.equal(validateNews(a,text.replace('(EIL)',''),i),null);
});
await test('configured OpenAI route never falls back to unbudgeted Claude when the key is absent',async()=>{
 let calls=0;
 const out=await readDocumentFacts({item,env:{NEWSLETTER_NEWS_AI_PROVIDER:'openai',CLAUDE_KEY:'fixture'},newsBudget:budget(),now,
 fetcher:async(url)=>{calls++;assert.equal(url,item.url);return new Response(`<article>${article}</article>`,{headers:{'content-type':'text/html'}});}});
 assert.equal(out.state,'pending');assert.equal(out.reason,'no-key');assert.equal(calls,1);
});
await test('article identity with no company evidence makes no paid request',async()=>{
 await assert.rejects(readNewsAi({article:glycine,item,env,budget:budget(),now,fetcher:forbid}),/company-evidence-unconfirmed/);
});
await test('cache-write premiums and missing details cannot understate news spending',async()=>{
 for(const details of [{cache_write_tokens:1000},undefined]) {
  const b=budget();
  await newsModelCall({env,budget:b,job:'cache-write',now,instructions:'test',input:{},schema:objectSchema({}),fetcher:async()=>reply({},
   {input_tokens:1000,input_tokens_details:details,output_tokens:1000})});
  assert.equal(b.status(now).dayUsedUsd,0.000625);
 }
});
await test('requests crossing midnight use their actual admission day, not a stale batch timestamp',async()=>{
 let clock=istInstant('2026-09-24','23:59');const old=clock;
 const b=new NewsletterNewsBudget(storage(),{now:()=>clock});
 const request=()=>newsModelCall({env,budget:b,job:crypto.randomUUID(),now:old,instructions:'test',input:{},schema:objectSchema({}),fetcher:async()=>reply({},
  {input_tokens:1000,input_tokens_details:{cache_write_tokens:0},output_tokens:1000})});
 await request();clock=istInstant('2026-09-25','00:01');await request();
 assert.equal(b.status(old).dayUsedUsd,0.0006);assert.equal(b.status(clock).dayUsedUsd,0.0006);
 assert.equal(b.status(clock).monthUsedUsd,0.0012);
});
console.log(`${passed} OpenAI news checks passed; fixture replies do not certify live model accuracy.`);
