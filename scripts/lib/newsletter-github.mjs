import {PrivateMarketsJob} from './private-markets-job.mjs';
import {NEWSLETTER_PDF_CHUNK_BYTES} from '../../worker/newsletter-document.mjs';
import {beginNewsletterRequest,newsletterCallerSignal} from '../../worker/newsletter-request.mjs';
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {openBackgroundState,sealBackgroundState} from './github-background-seal.mjs';
import {packBackgroundViews} from './github-background-package.mjs';
import {privateRecordViews} from './github-private-records.mjs';
import {copyBackgroundStore} from './github-background-restore.mjs';
import {backgroundContract} from '../../worker/github-background-contract.mjs';
import {NEWSLETTER_TABLES,NEWSLETTER_KEYS} from '../../worker/newsletter-export.mjs';
import {readerKeys,encode64,openForReader} from '../../worker/mutual-funds-seal.mjs';
import {buildBrief,briefSubject,briefSummary,renderBriefHtml,renderBriefText} from '../../worker/newsletter-brief.mjs';
import {renderBriefEmails} from '../../worker/newsletter-email.mjs';
import {renderBriefPdf,pdfFilename} from '../../worker/newsletter-pdf.mjs';
import {istDay} from '../../public/js/data/newsletter-shared.js';
import {localNewsletter} from './newsletter-local.mjs';
import {NewsletterDeliveryQueue} from './newsletter-delivery-queue.mjs';
import {newsletterWakePlan,newsletterRetryState} from './newsletter-wake-plan.mjs';

export function decodeNewsletterColumn(value,table,column){
 if(table!=='newsletter_documents'||column!=='body')return value;
 if(!value||typeof value.blob64!=='string'||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>1500000)throw Error('Invalid retained PDF');
 const bytes=Buffer.from(value.blob64,'base64');if(bytes.toString('base64')!==value.blob64||bytes.length!==value.bytes||createHash('sha256').update(bytes).digest('hex')!==value.hash)throw Error('Retained PDF integrity failed');return bytes;
}
export const newsletterRequestContext=repo=>`${repo}:github-newsletter-request:v1`;
// Source-only copies cannot spend model credits or address the subscriber list.
// Keep their signed intent valid through a bounded free-runner backlog; ordinary
// sends retain the one-hour window. The durable request ID still prevents replay.
export function newsletterRequestIsFresh(input,now=Date.now()){
 const age=now-input?.at,maxAge=input?.to==='me'&&input?.sourceOnly===true?24*3600000:3600000;
 return Number.isFinite(input?.at)&&Number.isFinite(now)&&age>=-3600000&&age<=maxAge;
}
const metered=url=>url==='https://devde.muns.io/email/send/raw'||new URL(url).origin==='https://api.openai.com'||/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(new URL(url).hostname);
export async function githubNewsletter({env=process.env,fetcher=fetch,legacyClient,inputs,recipient,notify=async()=>{},verifyPdf=async()=>{throw Error('Live PDF delivery must be verified before email');},file=path.resolve('.cache/newsletter/state.sqlite'),out=path.resolve('.cache/newsletter/publication'),transportOptions={},localOptions={},privateMarketsSources=null}={}){
 const transport=githubBackgroundRelease('newsletter',{env,fetcher,...transportOptions}),signature=await backgroundContract('newsletter');let local,cycle=0,blocked=false,tail=Promise.resolve(),activeRequest=null;
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(out,{recursive:true});const saved=await transport.latest();
 if(saved){const sealed=file+'.sealed';try{await transport.download(saved,'state',sealed,{sourceSignature:signature});await openBackgroundState(sealed,file,'newsletter',{env});}finally{fs.rmSync(sealed,{force:true});}}
 else if(fs.existsSync(file))throw Error('Unverified newsletter history cannot replace retained state');
 const refresh=async()=>{if(typeof inputs!=='function')throw Error('Newsletter inputs unavailable');await local.applyInputs(await inputs());};
 const guardedFetch=async(raw,options)=>{
  newsletterCallerSignal(options)?.throwIfAborted();
  const url=String(raw);if(blocked)throw Error('Newsletter publication failed; external work stopped');
  if(metered(url)){
   await refresh();await publish();
   if(url==='https://devde.muns.io/email/send/raw'){
    if(privateMarketsJob?.senderHeld())throw Error('Newsletter sender is held after a provider refusal');
    const body=JSON.parse(options.body),privateMarkets=activeRequest?.edition==='private-markets',test=activeRequest?.to==='me'&&activeRequest.email===body.email;
    if(!privateMarkets&&activeRequest?.automatic&&!local.store.settings()[activeRequest.edition]?.enabled)throw Error('Edition disabled before delivery');
    if(!test&&!(privateMarkets?local.store.subscriberRows():local.store.recipients(activeRequest?.edition)).some(row=>row.email===body.email))throw Error('Recipient removed before delivery');
    const documents=privateMarkets?[]:local.db.prepare("SELECT id,filename,body FROM newsletter_documents WHERE delivery_state='pending' ORDER BY created_at DESC").all();
    if(!privateMarkets)for(const document of documents)await verifyPdf(document,env);
    await refresh();
    if(!privateMarkets&&activeRequest?.automatic&&!local.store.settings()[activeRequest.edition]?.enabled)throw Error('Edition disabled before delivery');
    if(!test&&!(privateMarkets?local.store.subscriberRows():local.store.recipients(activeRequest?.edition)).some(row=>row.email===body.email))throw Error('Recipient removed before delivery');
   }
  }
  if(blocked)throw Error('Newsletter publication failed; external work stopped');return fetcher(raw,beginNewsletterRequest(options));
 };
 local=localNewsletter(file,{env,...localOptions,fetcher:guardedFetch});
 local.db.exec('CREATE TABLE IF NOT EXISTS newsletter_cipher_cache(name TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,payload TEXT NOT NULL)');
 const cache={get:(name,fingerprint)=>{const row=local.db.prepare('SELECT fingerprint,payload FROM newsletter_cipher_cache WHERE name=?').get(name);return row?.fingerprint===fingerprint?JSON.parse(row.payload):null;},put:(name,fingerprint,value)=>local.db.prepare('INSERT INTO newsletter_cipher_cache VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload').run(name,fingerprint,JSON.stringify(value))};
 try{
  if(!saved){const inventory=await legacyClient({action:'export'});if(inventory?.ok!==true||!Array.isArray(inventory.tables)||inventory.tables.some(row=>!NEWSLETTER_TABLES.includes(row.name)))throw Error('Newsletter source inventory invalid');if(inventory.tables.length)console.log('Verified retained newsletter transfer:',JSON.stringify((await copyBackgroundStore(local,legacyClient,{tables:inventory.tables.map(row=>row.name),keys:NEWSLETTER_KEYS,decode:decodeNewsletterColumn})).tables));else if(JSON.stringify(await legacyClient({action:'export'}))!==JSON.stringify(inventory))throw Error('Unused newsletter source changed');}
  local.store.initialised=false;local.store.init();
  if(local.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Newsletter retained database invalid');
 }catch(error){await local.close();throw error;}
 async function checkpoint(){
  const backup=path.join(out,'checkpoint.sqlite'),state=path.join(out,'state.bin'),views=path.join(out,'views.gz');fs.rmSync(backup,{force:true});await local.checkpoint(backup);let copy;
  try{
   copy=localNewsletter(backup,{env,...localOptions});const records=new Map();
   const savePdf=(id,value,bytes)=>{
    if(bytes.length<=1500000){records.set(id,{...value,body:bytes.toString('base64')});return;}
    const parts=[];for(let offset=0;offset<bytes.length;offset+=NEWSLETTER_PDF_CHUNK_BYTES){const body=bytes.subarray(offset,offset+NEWSLETTER_PDF_CHUNK_BYTES),partId=id+'-chunk-'+parts.length;records.set(partId,{body:body.toString('base64')});parts.push({id:partId,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});}
    const {body,...metadata}=value;records.set(id,{...metadata,format:'chunked-pdf-v1',bytes:bytes.length,parts});
   };
   for(const row of copy.db.prepare('SELECT id,filename,body FROM newsletter_documents').iterate())savePdf('pdf-'+row.id,{filename:row.filename},Buffer.from(row.body));
   for(const row of copy.db.prepare('SELECT id,state,result,at FROM newsletter_requests').iterate())records.set('request-'+row.id,{state:row.state,result:row.result?JSON.parse(row.result):null,at:row.at});
   for(const row of copy.db.prepare('SELECT id,payload FROM newsletter_views').iterate()){const value=JSON.parse(row.payload);if(value.binary&&value.body)savePdf(row.id,value,Buffer.from(value.body,'base64'));else records.set(row.id,value);}
   const keys=await readerKeys(env.BACKGROUND_STATE_KEY),schedule=await copy.schedule.status();
   schedule.deliveryRecovery=newsletterRetryState(copy.db.prepare("SELECT edition,source,next_at FROM newsletter_delivery_queue WHERE payload IS NOT NULL AND source != 'test'").all());
   const head={privateMarkets:privateMarketsJob?privateMarketsJob.status():null,version:1,repo:transport.repo,feature:'newsletter',createdAt:new Date(localOptions.now?.()??Date.now()).toISOString(),snapshot:copy.store.snapshot(),schedule:{...schedule,runtime:'github-actions',armed:false,alarmAt:null},requestKey:{kid:keys.kid,publicKey:encode64(keys.publicKey)},processingEnabled:env.NEWSLETTER_PROCESSING_ENABLED==='true',inputRevision:await copy.storage.get('newsletter-source-revision')??null};
   // Small pages bound edge decoding for streamed PDFs; an older large single
   // record retains its existing delivery limit and occupies a page on its own.
   await packBackgroundViews(privateRecordViews([...records.keys()],id=>records.get(id),head,{repo:transport.repo,feature:'newsletter',env,partBytes:512*1024,recordBytes:4*1024*1024}),recipient,views,{repo:transport.repo,feature:'newsletter',sourceSignature:signature,cache});
  }finally{await copy?.close();}
  await sealBackgroundState(backup,state,'newsletter',{env});const result=await transport.publish({cycle:++cycle,state,views,sourceSignature:signature});try{await notify(result);}catch{/* Existing scheduled deployment also catches up. */}return result;
 }
 function publish(){const work=tail.then(()=>{if(blocked)throw Error('Newsletter publication is blocked');return checkpoint();});tail=work.catch(()=>{blocked=true;});return work;}
 const privateMarketsJob=env.PRIVATE_MARKETS_INTELLIGENCE_ENABLED==='true'&&privateMarketsSources?new PrivateMarketsJob(local,{readSources:privateMarketsSources,publish,refreshInputs:refresh,now:localOptions.now,fetcher:async(raw,options)=>{const previous=activeRequest;activeRequest={edition:'private-markets',automatic:true};try{return await guardedFetch(raw,options);}finally{activeRequest=previous;}}}):null;
 local.schedule.deliveryQueue=new NewsletterDeliveryQueue(local,{publish,now:localOptions.now,
  context:async(plan,work)=>{const previous=activeRequest;activeRequest={edition:plan.edition,to:plan.source==='test'?'me':'all',email:plan.source==='test'?plan.recipients[0]?.email:null,automatic:plan.source==='timer'};try{return await work();}finally{activeRequest=previous;}}});
 async function privateMarketsWork(work){try{await work();}catch(error){if(blocked)throw error;privateMarketsJob.fail();await publish();}}
 async function processRequest(envelope){
  const raw=await openForReader(envelope,env.BACKGROUND_STATE_KEY,newsletterRequestContext(transport.repo));if(raw.length>32768)throw Error('Newsletter request too large');const input=JSON.parse(new TextDecoder().decode(raw));
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.id||'')||!newsletterRequestIsFresh(input,localOptions.now?.()??Date.now())||!['morning','evening'].includes(input.edition)||!['me','all'].includes(input.to))throw Error('Invalid newsletter request');
  const previous=local.db.prepare('SELECT state,result FROM newsletter_requests WHERE id=?').get(input.id);if(previous)return previous.result?JSON.parse(previous.result):{ok:false,reason:'delivery-uncertain'};
  await refresh();local.db.prepare('INSERT INTO newsletter_requests VALUES(?,?,NULL,?)').run(input.id,'claimed',input.at);await publish();
  activeRequest=input;
  try{const result=await local.schedule.sendNow({edition:input.edition,to:input.to,email:input.email,sourceOnly:input.sourceOnly===true},input.token||null);local.db.prepare('UPDATE newsletter_requests SET state=?,result=? WHERE id=?').run('completed',JSON.stringify(result),input.id);await publish();return result;}finally{activeRequest=null;}
 }
 async function wake({onlyIfDue=false}={}){
  const prior=await local.storage.get('newsletter-source-revision');await refresh();
  if(onlyIfDue){
   const settings=local.store.settings(),state=await local.storage.get('newsletter-timer')||{};
   const plan=newsletterWakePlan({settings,inputRevision:prior,revision:await local.storage.get('newsletter-source-revision'),
    schedule:{...state,privateMarkets:privateMarketsJob?.status(),deliveryRecovery:newsletterRetryState(local.schedule.deliveryQueue.pending())}},{now:localOptions.now?.()??Date.now()});
   if(!plan.due)return {processed:false,reason:plan.reason};
  }
  await publish();
  const deliver=local.schedule.deliver.bind(local.schedule);local.schedule.deliver=async input=>{activeRequest={edition:input.edition,to:'all',automatic:true};try{return await deliver(input);}finally{activeRequest=null;}};
  try{if(privateMarketsJob)await privateMarketsWork(async()=>{await privateMarketsJob.prepare();await privateMarketsJob.wake();});
   if(privateMarketsJob?.senderHeld()){const at=localOptions.now?.()??Date.now(),reason=privateMarketsJob.senderHoldReason();await local.schedule.record({lastWakeAt:at,lastCheckedAt:at,lastResult:reason,reason:reason==='sender-unavailable'?'unauthorised':'rate-limited'});await publish();return {processed:true,reason};}
   const recovered=await local.schedule.deliveryQueue.recover();await local.schedule.wake();if(blocked)throw Error('Newsletter stopped before external work');
   if(recovered.length&&(await local.schedule.status()).lastResult==='nothing-due')await local.schedule.record({lastResult:recovered.at(-1).reason||'sent',reason:recovered.at(-1).reason||null});
   if(local.schedule.deliveryQueue.pending().length)await local.schedule.record({lastResult:'partial-send',reason:'delivery-retry-pending'});
   await publish();return {processed:true};}finally{local.schedule.deliver=deliver;activeRequest=null;}
 }
 async function preparePreviews(){
  if(privateMarketsJob)await privateMarketsWork(()=>privateMarketsJob.prepare());
  const save=(id,value)=>local.db.prepare('INSERT INTO newsletter_views VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(value));
  for(const edition of ['morning','evening']){
   const at=localOptions.now?.()??Date.now();
   local.db.prepare('DELETE FROM newsletter_views WHERE id LIKE ?').run(`preview-${edition}-html-%`);
   try{
    const brief=await buildBrief({edition,day:istDay(at),settings:local.store.settings(),env,fetcher:guardedFetch,now:at,to:at,reported:local.store.reportedLookup(),includeAi:false,contentService:local.schedule.content}),options=local.schedule.renderOptions();
    const messages=renderBriefEmails(brief,options),base={ok:true,edition,subject:briefSubject(brief,options),builtAt:new Date(at).toISOString(),summary:briefSummary(brief)};
    for(const message of messages){const part=message.part?.index||1;save(`preview-${edition}-html-${part}`,{...base,subject:message.subject,part,parts:messages.length,body:renderBriefHtml(brief,{...options,part:message.part,preview:true})});}
    save(`preview-${edition}-text-1`,{...base,body:renderBriefText(brief,options)});
    save(`preview-${edition}-pdf-1`,{...base,body:Buffer.from(renderBriefPdf(brief,options)).toString('base64'),binary:true,filename:pdfFilename(brief)});
   }catch{for(const format of ['html','text','pdf'])save(`preview-${edition}-${format}-1`,{ok:false,reason:'preview-build-failed',builtAt:new Date(at).toISOString()});}
  }
 }
 return {...local,publish,wake,processRequest,preparePreviews,privateMarketsJob};
}
