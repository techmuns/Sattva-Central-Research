import {newsletterRequest,NEWSLETTER_DEADLINE} from '../worker/newsletter-request.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {randomBytes,createHash} from 'node:crypto';
import {localNewsletter} from './lib/newsletter-local.mjs';
import {githubNewsletter,decodeNewsletterColumn} from './lib/newsletter-github.mjs';
import {exportNewsletter} from '../worker/newsletter-export.mjs';
import {installPreparedBackground} from './lib/github-background-deployment.mjs';
import {readerKeys,encode64,openForReader,sealForReader} from '../worker/mutual-funds-seal.mjs';
import {handleGithubNewsletter} from '../worker/newsletter-github.mjs';
import {newsletterAssets} from './collect-newsletter.mjs';
import {newsletterWakePlan} from './lib/newsletter-wake-plan.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/newsletter-github-'));
let at=Date.parse('2026-09-15T06:30:00Z');
const repo='techmuns/Sattva-Central-Research',secret='fixture-reader-secret-only-123456789',now=()=>at;
const env={NEWSLETTER_PROCESSING_ENABLED:'true',GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions-token',BACKGROUND_STATE_KEY:'fixture-master-secret-only-123456789'};
let published=0,failUpload=false,providerCalls=0,emailCalls=0,removeDuringPdf=false,pdfWait=0,allowFixtureMail=false,cancelDuringPdf=null;
let exists=false,sequence=1,body='',assetReads=0;const remote=new Map(),tag='newsletter-data';
const fetcher=async(raw,options={})=>{
  const url=new URL(raw),method=options.method||'GET';
  if(['api.github.com','uploads.github.com'].includes(url.hostname)) {
    assert.equal(options.headers.authorization,`Bearer ${env.GITHUB_TOKEN}`);assert(url.pathname.startsWith(`/repos/${repo}/`));
    if(url.hostname==='uploads.github.com'){if(failUpload)throw Error('Fixture archive rejected');
      const chunks=[];for await(const chunk of options.body)chunks.push(chunk);const bytes=Buffer.concat(chunks),name=url.searchParams.get('name');
      const asset={id:sequence++,name,size:bytes.length,state:'uploaded',created_at:new Date().toISOString(),browser_download_url:`https://github.com/${repo}/releases/download/${tag}/${name}`,bytes};remote.set(name,asset);const {bytes:_,...metadata}=asset;return Response.json(metadata);
    }
    if(method==='POST'){exists=true;return Response.json({id:77,tag_name:tag});}
    if(method==='PATCH'){body=JSON.parse(options.body).body;return Response.json({id:77,tag_name:tag,body});}
    if(method==='DELETE'){const id=Number(url.pathname.split('/').at(-1)),asset=[...remote.values()].find(a=>a.id===id);assert(asset);remote.delete(asset.name);return new Response(null,{status:204});}
    if(url.pathname.endsWith('/assets'))return Response.json([...remote.values()].map(({bytes,...asset})=>asset));
    assert(url.pathname.endsWith('/releases/tags/'+tag));return exists?Response.json({id:77,tag_name:tag,body}):new Response(null,{status:404});
  }
  if(url.hostname==='devde.muns.io'){emailCalls++;if(!allowFixtureMail)throw Error('The removed recipient must never reach a provider');assert.equal(options.signal?.aborted,false,'Only provider I/O consumes its request timeout, after checkpoint/PDF waits');assert.equal(options[NEWSLETTER_DEADLINE],undefined);return Response.json({success:true,data:{messageId:'<fixture@example.test>'}});}
  if(url.hostname==='api.openai.com'){providerCalls++;assert(published>0);assert(remote.size>0);return Response.json({status:'completed',output:[]});}
  if(/^bedrock-runtime\./.test(url.hostname)){providerCalls++;throw Error('Previews must never call a model');}
  if(url.hostname!=='github.com')return new Response(null,{status:404}); // Offline market/source unavailability.
  assert.equal(options.headers?.authorization,undefined);const asset=remote.get(decodeURIComponent(url.pathname.split('/').at(-1)));assert(asset);return new Response(asset.bytes);
};
let source,runtime,restarted;
try{
 const inputRoot=path.join(root,'source');fs.mkdirSync(path.join(inputRoot,'data'),{recursive:true});fs.writeFileSync(path.join(inputRoot,'data/portfolio-companies.json'),JSON.stringify({holdings:[]}));
 fs.writeFileSync(path.join(inputRoot,'outside.json'),'{}');fs.symlinkSync(path.join(inputRoot,'outside.json'),path.join(inputRoot,'data/escape.json'));
 env.ASSETS=newsletterAssets(inputRoot);
 assert.deepEqual(await (await env.ASSETS.fetch(new Request('https://fixture.test/data/portfolio-companies.json'))).json(),{holdings:[]});
 for(const pathname of ['/outside.json','/data/%2e%2e/outside.json','/data/escape.json','/data/missing.json'])assert.equal((await env.ASSETS.fetch(new Request('https://fixture.test'+pathname))).status,404,'The runner source binding reads only the pinned data tree');
 source=localNewsletter(path.join(root,'old.sqlite'),{env,now});source.store.apply([{op:'subscribe',by:'Fixture',email:'fixture@example.com',editions:['morning','evening']}]);
 source.store.beginDelivery({key:'old-unknown',edition:'morning',day:'2026-09-14',source:'timer',recipients:1});
 const pdf=randomBytes(1500000);pdf.set(Buffer.from('%PDF-1.7'));const pdfId=source.store.saveDocument(pdf,'sattva-2026-09-14-morning-brief.pdf','old-unknown');
 source.db.prepare('UPDATE newsletter_documents SET rowid=0 WHERE id=?').run(pdfId);
 const oldBudget=source.schedule.content.newsBudget.reserve({job:'old-news',model:'fixture',amount:1234,now:at});assert(oldBudget.ok);
 const before=source.db.prepare('SELECT total_changes() n').get().n,keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
 const options={env,fetcher,recipient,verifyPdf:async()=>{cancelDuringPdf?.abort(new DOMException('Fixture caller cancelled','AbortError'));if(pdfWait)await new Promise(done=>setTimeout(done,pdfWait));if(removeDuringPdf)source.store.apply([{op:'unsubscribe',email:'fixture@example.com',by:'Fixture'}]);},localOptions:{now},inputs:()=>exportNewsletter(source.storage,{inputs:true}),notify:async()=>{published++;},transportOptions:{sleep:async()=>{},head:()=>env.GITHUB_SHA}};
 runtime=await githubNewsletter({...options,file:path.join(root,'runner.sqlite'),out:path.join(root,'publication'),legacyClient:input=>exportNewsletter(source.storage,input)});
 assert.equal(source.db.prepare('SELECT total_changes() n').get().n,before);assert.deepEqual(runtime.store.snapshot(),source.store.snapshot());assert.deepEqual(Buffer.from(runtime.store.document(pdfId).body),pdf);assert.equal(runtime.store.delivery('old-unknown').finishedAt,null);
 assert.throws(()=>decodeNewsletterColumn({blob64:'AA==',bytes:1,hash:'wrong'},'newsletter_documents','body'),/integrity/);
 const stalePreview=()=>runtime.db.prepare('INSERT OR REPLACE INTO newsletter_views VALUES(?,?)').run('preview-morning-html-2',JSON.stringify({ok:true,body:'Old second part',part:2,parts:2}));
 stalePreview();await runtime.preparePreviews();assert.equal(providerCalls,0);assert.equal(emailCalls,0);
 const preview=JSON.parse(runtime.db.prepare('SELECT payload FROM newsletter_views WHERE id=?').get('preview-morning-html-1').payload);assert.equal(preview.ok,true);assert.equal(preview.part,1);assert.equal(preview.parts,1);
 const saved=await runtime.publish(),site=path.join(root,'public');await installPreparedBackground([saved],{env,fetcher,publicRoot:site,scratch:path.join(root,'install')});
 const cipherFiles=new Map(fs.readdirSync(path.join(site,'generated-views/newsletter')).map(name=>[name,fs.readFileSync(path.join(site,'generated-views/newsletter',name),'utf8')]));
 const again=await runtime.publish();await installPreparedBackground([again],{env,fetcher,publicRoot:site,scratch:path.join(root,'install-again')});for(const [name,value]of cipherFiles)assert.equal(fs.readFileSync(path.join(site,'generated-views/newsletter',name),'utf8'),value,'Unchanged private readers reuse ciphertext instead of reuploading PDF history');
 const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,ASSETS:{fetch:async request=>{assetReads++;const file=path.join(site,new URL(request.url).pathname);return fs.existsSync(file)?new Response(fs.readFileSync(file)):new Response(null,{status:404});}}};
 const common={object:{newsletterPdf(){throw Error('Prepared saved PDFs cannot touch Cloudflare SQL');},newsletterSnapshot:async()=>source.store.snapshot()},now,pdfHeaders:filename=>({'content-type':'application/pdf','cache-control':'private, no-store'}),guardWrite:async()=>null};
 const statusResponse=await handleGithubNewsletter(new Request('https://fixture.test/api/newsletter'),worker,common),publicStatus=await statusResponse.json();
 assert.equal(statusResponse.status,200);assert.equal(publicStatus.sourceOnlyTests,true);assert.equal(publicStatus.inputRevision,undefined);assert.equal(typeof publicStatus.revision,'number');
 publicStatus.schedule={...publicStatus.schedule,lastWakeAt:new Date(at).toISOString(),lastCheckedAt:new Date(at).toISOString(),reason:null};
 assert.equal(newsletterWakePlan(publicStatus,{now:at+1}).due,false,'The actual public response coalesces a recent check without a checkpoint revision field');
 publicStatus.schedule.reason='waiting-for-inputs';assert.equal(newsletterWakePlan(publicStatus,{now:at+1}).reason,'inputs-changed');
 let response=await handleGithubNewsletter(new Request('https://fixture.test/api/newsletter/pdf/'+pdfId),worker,common);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
 const bigPdf=Buffer.alloc(5096797,97);bigPdf.set(Buffer.from('%PDF-1.7'));const bigId=runtime.store.saveDocument(bigPdf,'sattva-2026-09-15-morning-brief.pdf','large-recovery');
 const bigSaved=await runtime.publish();await installPreparedBackground([bigSaved],{env,fetcher,publicRoot:site,scratch:path.join(root,'install-large')});
 response=await handleGithubNewsletter(new Request('https://fixture.test/api/newsletter/pdf/'+bigId),worker,common);assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(bigPdf.length));assert.deepEqual(Buffer.from(await response.arrayBuffer()),bigPdf,'A recovery PDF larger than 1.5 MB streams exact bytes from bounded encrypted private records');
 response=await handleGithubNewsletter(new Request('https://fixture.test/api/newsletter/preview?edition=morning'),worker,common);assert.equal(response.status,200);assert.equal(response.headers.get('x-newsletter-part'),'1');assert.equal(await response.text(),preview.body,'The default preview URL serves the actual prepared HTML through encrypted static delivery');
 response=await handleGithubNewsletter(new Request('https://fixture.test/api/newsletter/preview?edition=morning&part=2'),worker,common);assert.equal(response.status,503);assert.equal((await response.json()).reason,'preview-unavailable','A bookmark to a removed part cannot serve an older edition');
 stalePreview();fs.rmSync(path.join(inputRoot,'data/portfolio-companies.json'));await runtime.preparePreviews();assert.equal(runtime.db.prepare('SELECT payload FROM newsletter_views WHERE id=?').get('preview-morning-html-2'),undefined);assert.equal(JSON.parse(runtime.db.prepare('SELECT payload FROM newsletter_views WHERE id=?').get('preview-morning-html-1').payload).ok,false,'A failed build replaces its current preview and clears older parts');
 fs.writeFileSync(path.join(inputRoot,'data/portfolio-companies.json'),JSON.stringify({holdings:[]}));await runtime.preparePreviews();assert.equal(providerCalls,0);assert.equal(emailCalls,0);
 let requestEnvelope;
 response=await handleGithubNewsletter(new Request('https://fixture.test/api/newsletter/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({edition:'morning',to:'me',email:'fixture@example.com',sourceOnly:true})}),worker,{...common,fetcher:async(raw,options)=>{assert.equal(raw,`https://api.github.com/repos/${repo}/actions/workflows/newsletter-refresh.yml/dispatches`);const value=JSON.parse(options.body);assert.equal(value.ref,'main');assert(!value.inputs.request.includes('fixture@example.com'));requestEnvelope=JSON.parse(value.inputs.request);return new Response(null,{status:204});}});assert.equal(response.status,202);const queued=await response.json();assert(queued.requestId);assert.equal(queued.queued,true);
 const firstSend=runtime.schedule.sendNow;let testOptions;runtime.schedule.sendNow=async(...args)=>{testOptions=args[0];return firstSend.apply(runtime.schedule,args);};
 const result=await runtime.processRequest(requestEnvelope);assert.equal(testOptions.sourceOnly,true,'Source-only test requests remain source-only through the encrypted GitHub queue');runtime.schedule.sendNow=firstSend;assert.equal(result.reason,'no-token');const count=runtime.db.prepare('SELECT COUNT(*) n FROM newsletter_manual_attempts').get().n;await runtime.processRequest(requestEnvelope);assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM newsletter_manual_attempts').get().n,count,'Replayed request does not reserve or send twice');
 const originalSend=runtime.schedule.sendNow;runtime.schedule.sendNow=async()=>{runtime.store.beginDelivery({key:'waiting-pdf',edition:'morning',day:'2026-09-15',source:'button',recipients:1});return runtime.schedule.fetcher('https://devde.muns.io/email/send/raw',{method:'POST',body:JSON.stringify({email:'fixture@example.com',html:'Synthetic'})});};
 removeDuringPdf=true;const queueKey=await readerKeys(env.BACKGROUND_STATE_KEY),removeEnvelope=await sealForReader(new TextEncoder().encode(JSON.stringify({id:crypto.randomUUID(),at,edition:'morning',to:'all',email:null,token:null})),{kid:queueKey.kid,publicKey:encode64(queueKey.publicKey)},`${repo}:github-newsletter-request:v1`);
 await assert.rejects(runtime.processRequest(removeEnvelope),/Recipient removed/);assert.equal(emailCalls,0,'An unsubscribe during static PDF publication is rechecked before email I/O');removeDuringPdf=false;runtime.schedule.sendNow=originalSend;source.store.apply([{op:'subscribe',email:'fixture@example.com',by:'Fixture',editions:['morning','evening']}]);
 // Real guarded fetch: a private checkpoint/PDF wait outlasts the original
 // transport signal, then the provider receives a fresh deadline exactly once.
 pdfWait=80;allowFixtureMail=true;
 const deadlineRequest=async(label,signal)=>{
  runtime.schedule.sendNow=async()=>{runtime.store.beginDelivery({key:label,edition:'morning',day:'2026-09-15',source:'button',recipients:1});return newsletterRequest(runtime.schedule.fetcher,'https://devde.muns.io/email/send/raw',{method:'POST',body:JSON.stringify({email:'fixture@example.com',html:'Synthetic'}),signal},50);};
  const envelope=await sealForReader(new TextEncoder().encode(JSON.stringify({id:crypto.randomUUID(),at,edition:'morning',to:'all',email:null,token:null})),{kid:queueKey.kid,publicKey:encode64(queueKey.publicKey)},`${repo}:github-newsletter-request:v1`);
  return runtime.processRequest(envelope);
 };
 await deadlineRequest('deadline-pdf');assert.equal(emailCalls,1,'The ordinary request reaches the stub provider after slow publication');
 cancelDuringPdf=new AbortController();await assert.rejects(deadlineRequest('cancelled-pdf',cancelDuringPdf.signal),error=>error.name==='AbortError');assert.equal(emailCalls,1,'Caller cancellation during PDF publication prevents provider I/O');
 pdfWait=0;allowFixtureMail=false;cancelDuringPdf=null;runtime.schedule.sendNow=originalSend;
 const claim=runtime.schedule.content.newsBudget.reserve({job:'new-news',model:'fixture',amount:5678,now:at});assert(claim.ok);await runtime.schedule.fetcher('https://api.openai.com/v1/responses',{method:'POST',body:'{}'});assert.equal(providerCalls,1);
 await runtime.close();runtime=null;restarted=await githubNewsletter({...options,file:path.join(root,'restarted.sqlite'),out:path.join(root,'restarted-publication'),legacyClient:async()=>{throw Error('An initialized archive cannot reset');}});assert(restarted.db.prepare('SELECT id FROM newsletter_news_ai_calls WHERE id=?').get(claim.id),'Metered I/O follows acknowledged restart storage containing its actual reservation');assert.equal(restarted.store.delivery('old-unknown').finishedAt,null);assert.deepEqual(Buffer.from(restarted.store.document(pdfId).body),pdf);
 // A stale public reader may admit multiple completion jobs. Recheck the actual
 // restored state under the shared sender mutex, without publication or paid I/O.
 await restarted.schedule.record({lastWakeAt:at,lastCheckedAt:at});
 let beforeWake=published;
 for(let i=0;i<20;i++)assert.equal((await restarted.wake({onlyIfDue:true})).processed,false);
 assert.equal(published,beforeWake);assert.equal(providerCalls,1);assert.equal(emailCalls,1);
 at=Date.parse('2026-09-15T10:30:00Z');
 await restarted.schedule.record({lastWakeAt:at-1000,lastCheckedAt:at-1000});
 assert.equal((await restarted.wake({onlyIfDue:true})).processed,true);
 assert.equal(restarted.store.delivery('2026-09-15:evening').reason,'no-token','The actual timer claims the due edition; fixture has no sender credential');
 beforeWake=published;assert.equal((await restarted.wake({onlyIfDue:true})).processed,false);assert.equal(published,beforeWake);
 assert.equal(restarted.store.delivery('old-unknown').finishedAt,null);assert.deepEqual(Buffer.from(restarted.store.document(pdfId).body),pdf);
 assert(restarted.db.prepare('SELECT id FROM newsletter_news_ai_calls WHERE id=?').get(claim.id));
 failUpload=true;await assert.rejects(restarted.schedule.fetcher('https://api.openai.com/v1/responses',{method:'POST',body:'{}'}),/archive rejected/);assert.equal(providerCalls,1);await assert.rejects(restarted.schedule.fetcher('https://api.openai.com/v1/responses',{method:'POST',body:'{}'}),/stopped/);assert.equal(providerCalls,1);
 console.log('PASS newsletter GitHub migration: 1.5 MB legacy PDF and 5.1 MB chunked PDF exact bytes/hash, unknown deliveries and paid budgets retained, encrypted master restart, static PDF reader, cached ciphertext, private queued request and replay safety, acknowledged reservation before stubbed model I/O, publication failure stops further provider work');
}finally{await restarted?.close();await runtime?.close();await source?.close();fs.rmSync(root,{recursive:true,force:true});}
