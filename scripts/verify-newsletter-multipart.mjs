import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const sourceRoot=path.resolve('.');
const load=file=>import(pathToFileURL(path.join(sourceRoot,file)));
const {githubNewsletter}=await load('scripts/lib/newsletter-github.mjs');
const {localNewsletter}=await load('scripts/lib/newsletter-local.mjs');
const {exportNewsletter}=await load('worker/newsletter-export.mjs');
const {readerKeys,encode64}=await load('worker/mutual-funds-seal.mjs');
const {SEND_TIMEOUT_MS,EMAIL_SEND_URL}=await load('worker/newsletter-schedule.mjs');
const {NEWSLETTER_DEADLINE}=await load('worker/newsletter-request.mjs');
let at=Date.parse('2026-09-17T02:30:00Z'); const now=()=>at,repo='techmuns/Sattva-Central-Research';
fs.mkdirSync('.cache',{recursive:true});
const book=JSON.parse(fs.readFileSync(path.join(sourceRoot,'scripts/fixtures/newsletter/book.json')));
const articles=book.holdings.filter(h=>h.ticker).flatMap(h=>Array.from({length:8},(_,i)=>({
 id:`${h.ticker}-${i}`,title:`${h.name} announces fixture business update ${i}`,
 summary:`${h.name} supplied details ${i}. `+'Full fixture source details. '.repeat(200),
 url:`https://example.test/${h.ticker}/${i}`,publisher:'Fixture publisher',publishedAt:new Date(at-60000*(i+1)).toISOString()
})));
const payloads={'/data/portfolio-companies.json':book,'/data/market-news.json':{articles}};
async function scenario(mode){
const dir=fs.mkdtempSync(path.resolve('.cache/newsletter-multipart-'));
at=Date.parse('2026-09-17T02:30:00Z');
payloads['/data/market-news.json']={articles};
const env={NEWSLETTER_PROCESSING_ENABLED:'true',GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-only',BACKGROUND_STATE_KEY:'fixture-master-secret-only-123456789',MUNS_TOKEN:'fixture-mail-only',ASSETS:{fetch:async request=>{
 const value=payloads[new URL(request.url).pathname];return value?Response.json(value):new Response(null,{status:404});
}}};
const remote=new Map(),mail=[],guards=[];let release=false,sequence=1,body='',notifications=0,failedOnce=false,failUpload=false;
const fetcher=async(raw,options={})=>{
 const url=new URL(raw),method=options.method||'GET';
 if(['api.github.com','uploads.github.com'].includes(url.hostname)){
  assert.equal(options.headers.authorization,`Bearer ${env.GITHUB_TOKEN}`);assert(url.pathname.startsWith(`/repos/${repo}/`));
  if(url.hostname==='uploads.github.com'){
   if(failUpload)throw Error('Fixture checkpoint interrupted');
   const chunks=[];for await(const chunk of options.body)chunks.push(chunk);const bytes=Buffer.concat(chunks),name=url.searchParams.get('name');
   const asset={id:sequence++,name,size:bytes.length,state:'uploaded',created_at:new Date().toISOString(),browser_download_url:`https://github.com/${repo}/releases/download/newsletter-data/${name}`,bytes};remote.set(name,asset);const {bytes:_,...metadata}=asset;return Response.json(metadata);
  }
  if(method==='POST'){release=true;return Response.json({id:77,tag_name:'newsletter-data'});}
  if(method==='PATCH'){body=JSON.parse(options.body).body;return Response.json({id:77,tag_name:'newsletter-data',body});}
  if(method==='DELETE'){const id=Number(url.pathname.split('/').at(-1)),asset=[...remote.values()].find(a=>a.id===id);assert(asset);remote.delete(asset.name);return new Response(null,{status:204});}
  if(url.pathname.endsWith('/assets'))return Response.json([...remote.values()].map(({bytes,...asset})=>asset));
  assert(url.pathname.endsWith('/releases/tags/newsletter-data'));return release?Response.json({id:77,tag_name:'newsletter-data',body}):new Response(null,{status:404});
 }
 if(String(raw)===EMAIL_SEND_URL){
  options.signal.throwIfAborted();assert.equal(options[NEWSLETTER_DEADLINE],undefined);assert(notifications>0);
  mail.push(JSON.parse(options.body));
  const message=mail.at(-1),target=message.email==='first@example.test';
  const root=!message.inReplyTo;
  if(target&&!failedOnce&&((mode==='root-timeout'&&root)||(mode!=='healthy'&&mode!=='root-timeout'&&!root))){
   failedOnce=true;
   if(mode==='root-timeout')throw new DOMException('Fixture response lost','TimeoutError');
   if(mode==='checkpoint-crash')failUpload=true;
   else return Response.json({success:false},{status:429});
  }
  return Response.json({success:true,data:{messageId:mail.at(-1).messageId}},{status:201});
 }
 if(url.hostname==='github.com'){const asset=remote.get(decodeURIComponent(url.pathname.split('/').at(-1)));assert(asset);return new Response(asset.bytes);}
 assert(!/openai|bedrock/.test(url.hostname),'No model calls during this test');
 return new Response(null,{status:503});
};
const originalTimeout=AbortSignal.timeout;
// Compress the production 15-second send timeout. Every PDF guard deliberately
// exceeds it; only the provider I/O timer is allowed to start again afterwards.
AbortSignal.timeout=ms=>originalTimeout.call(AbortSignal,ms===SEND_TIMEOUT_MS?30:ms);
let source,runtime,restarted;
try{
 source=localNewsletter(path.join(dir,'source.sqlite'),{env,now});
 const addresses=['first@example.test','second@example.test','third@example.test'];
 await source.storage.put('newsletter-timer',{lastCheckedAt:at-60000});
 source.store.apply(addresses.map(email=>({op:'subscribe',email,by:'Synthetic fixture',editions:['morning','evening']})));
 const keys=await readerKeys('fixture-reader-secret-only-123456789');
 const options={env,fetcher,recipient:{kid:keys.kid,publicKey:encode64(keys.publicKey)},localOptions:{now},inputs:()=>exportNewsletter(source.storage,{inputs:true}),notify:async()=>{notifications++;},transportOptions:{sleep:async()=>{},head:()=>env.GITHUB_SHA},verifyPdf:async document=>{guards.push(document.id);await delay(80);}};
 runtime=await githubNewsletter({...options,file:path.join(dir,'runner.sqlite'),out:path.join(dir,'publication'),legacyClient:input=>exportNewsletter(source.storage,input)});
 if(mode==='checkpoint-crash')await assert.rejects(runtime.wake(),/stopped|blocked/);else await runtime.wake();
 let result=runtime.store.delivery('2026-09-17:morning');
 assert(result,'The real scheduler must claim the due edition');assert.equal(result.summary.emailParts,3);
 if(mode==='reply-rate-limit'){
  for(let i=0;i<205;i++){runtime.store.beginDelivery({key:`prune-${i}`,edition:'morning',day:'2026-09-17',source:'test',recipients:0});runtime.store.finishDelivery(`prune-${i}`,{outcomes:[]});}
  assert(runtime.store.delivery(result.key),'Pruning finished history preserves the incomplete edition');
 }
 const firstRun=mail.map(m=>structuredClone(m));
 if(mode!=='healthy'){
  assert(runtime.schedule.deliveryQueue.pending().length);
  const savedPlan=JSON.parse(gunzipSync(runtime.db.prepare('SELECT payload FROM newsletter_delivery_queue WHERE payload IS NOT NULL').get().payload));
  assert(savedPlan.recipients.every(r=>r.parts.every(p=>!('html' in p))),'Recovery metadata never contains the recipient/part HTML cross product');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM newsletter_delivery_bodies').get().n,9,'Frozen bodies are independently bounded rows');
  assert.equal((await runtime.schedule.status()).lastResult,mode==='checkpoint-crash'?'failed':'partial-send');
 }
 const retained=runtime.store.sentStoryKeys().size;assert(retained>0);
 await runtime.close();runtime=null;failUpload=false;
 at+=300001;
 if(mode==='unsubscribe')source.store.apply([{op:'unsubscribe',email:addresses[0],by:'Fixture'}]);
 if(mode==='disabled')source.store.setSettings({...source.store.settings(),morning:{...source.store.settings().morning,enabled:false}});
 // If recovery tried to rebuild from today's sources, every original story is now missing.
 payloads['/data/market-news.json']={articles:[]};
 restarted=await githubNewsletter({...options,file:path.join(dir,'restarted.sqlite'),out:path.join(dir,'restarted-publication'),legacyClient:()=>{throw Error('History must restore from the encrypted checkpoint');}});
 if(mode==='healthy')assert.equal(restarted.store.sentStoryKeys().size,retained);
 await restarted.wake();
 if(mode==='disabled'){
  assert.equal(mail.length,firstRun.length,'Disabled editions cannot resume');
  source.store.setSettings({...source.store.settings(),morning:{...source.store.settings().morning,enabled:true}});
  at+=300001;await restarted.wake();
 }
 result=restarted.store.delivery(result.key);
 assert.equal(restarted.schedule.deliveryQueue.pending().length,0);
 assert.equal(restarted.db.prepare('SELECT COUNT(*) n FROM newsletter_delivery_bodies').get().n,0,'Acknowledged plans release only their completed frozen bodies');
 assert.equal(result.sent,mode==='unsubscribe'?2:3);
 if(mode==='unsubscribe'){
  assert.equal(mail.filter(m=>m.email===addresses[0]).length,2,'Removed recipient cannot get the pending reply');
  assert.equal(result.outcomes[0].reason,'recipient-removed');
 }else{
  assert.equal(result.reason,null);assert.equal(result.failed,0);
  assert.equal(new Set(mail.map(m=>m.messageId)).size,9,'Nine stable identities across all attempts');
  assert.equal(mail.length,mode==='healthy'?9:10);
  assert.equal(guards.length,mail.length,'Each send passes its slow PDF guard');
  for(const address of addresses){
   const sent=mail.filter(m=>m.email===address),outcome=result.outcomes.find(o=>o.email===address);
   assert(outcome.parts.every(p=>p.ok&&p.messageId));
   assert.equal(new Set(sent.map(m=>m.subject)).size,1);
   const originals=new Map();
   for(const message of sent){
    assert(Buffer.byteLength(message.html)<=90000);
    if(message.inReplyTo){assert.equal(message.inReplyTo,outcome.threadMessageId);assert.deepEqual(message.references,[outcome.threadMessageId]);}
    if(originals.has(message.messageId))assert.deepEqual(message,originals.get(message.messageId),'Retries keep identical body, subject, Message-ID and references');
    else originals.set(message.messageId,message);
   }
   assert.equal(originals.size,3);
   for(const part of outcome.parts){
    const request=part.request,message=originals.get(request.messageId);
    assert(message,'Retained receipt identifies the actual submitted request');
    assert.equal(request.subject,message.subject);
    assert.equal(request.inReplyTo,message.inReplyTo??null);
    assert.deepEqual(request.references,message.references??[]);
    assert.equal(request.bodySha256,createHash('sha256').update(message.html).digest('hex'));
   }
   for(const [i,message]of [...originals.values()].entries()){
    assert(message.html.includes(`Part ${i+1} of 3`));
    assert.equal(message.inReplyTo,i?outcome.threadMessageId:undefined);
   }
  }
 }
 const before=mail.length;at+=3600000;await restarted.wake();assert.equal(mail.length,before,'Completed editions never replay');
 const report={scenario:mode,recipients:3,partsPerRecipient:3,sendAttempts:mail.length,slowPdfGuards:guards.length,retainedStoryIdentities:retained,stableIdentities:new Set(mail.map(m=>m.messageId)).size,productionRequests:0};
 console.log('PASS '+JSON.stringify(report));
}finally{AbortSignal.timeout=originalTimeout;await restarted?.close();await runtime?.close();await source?.close();fs.rmSync(dir,{recursive:true,force:true});}

}
for(const mode of ['healthy','root-timeout','reply-rate-limit','checkpoint-crash','unsubscribe','disabled'])await scenario(mode);
