import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {randomBytes,createHash} from 'node:crypto';
import {localNewsletter} from './lib/newsletter-local.mjs';
import {githubNewsletter,decodeNewsletterColumn} from './lib/newsletter-github.mjs';
import {exportNewsletter} from '../worker/newsletter-export.mjs';
import {installPreparedBackground} from './lib/github-background-deployment.mjs';
import {readerKeys,encode64,openForReader} from '../worker/mutual-funds-seal.mjs';
import {handleGithubNewsletter} from '../worker/newsletter-github.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/newsletter-github-'));
const repo='techmuns/Sattva-Central-Research',secret='fixture-reader-secret-only-123456789',at=Date.parse('2026-09-15T06:30:00Z'),now=()=>at;
const env={NEWSLETTER_PROCESSING_ENABLED:'true',GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions-token',BACKGROUND_STATE_KEY:'fixture-master-secret-only-123456789'};
let published=0,failUpload=false,providerCalls=0;
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
  if(url.hostname==='api.openai.com'){providerCalls++;assert(published>0);assert(remote.size>0);return Response.json({status:'completed',output:[]});}
  assert.equal(options.headers?.authorization,undefined);const asset=remote.get(decodeURIComponent(url.pathname.split('/').at(-1)));assert(asset);return new Response(asset.bytes);
};
let source,runtime,restarted;
try{
 source=localNewsletter(path.join(root,'old.sqlite'),{env,now});source.store.apply([{op:'subscribe',by:'Fixture',email:'fixture@example.com',editions:['morning','evening']}]);
 source.store.beginDelivery({key:'old-unknown',edition:'morning',day:'2026-09-14',source:'timer',recipients:1});
 const pdf=randomBytes(1500000);pdf.set(Buffer.from('%PDF-1.7'));const pdfId=source.store.saveDocument(pdf,'sattva-2026-09-14-morning-brief.pdf','old-unknown');
 const oldBudget=source.schedule.content.newsBudget.reserve({job:'old-news',model:'fixture',amount:1234,now:at});assert(oldBudget.ok);
 const before=source.db.prepare('SELECT total_changes() n').get().n,keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)};
 const options={env,fetcher,recipient,localOptions:{now},inputs:()=>exportNewsletter(source.storage,{inputs:true}),notify:async()=>{published++;},transportOptions:{sleep:async()=>{},head:()=>env.GITHUB_SHA}};
 runtime=await githubNewsletter({...options,file:path.join(root,'runner.sqlite'),out:path.join(root,'publication'),legacyClient:input=>exportNewsletter(source.storage,input)});
 assert.equal(source.db.prepare('SELECT total_changes() n').get().n,before);assert.deepEqual(runtime.store.snapshot(),source.store.snapshot());assert.deepEqual(Buffer.from(runtime.store.document(pdfId).body),pdf);assert.equal(runtime.store.delivery('old-unknown').finishedAt,null);
 assert.throws(()=>decodeNewsletterColumn({blob64:'AA==',bytes:1,hash:'wrong'},'newsletter_documents','body'),/integrity/);
 const saved=await runtime.publish(),site=path.join(root,'public');await installPreparedBackground([saved],{env,fetcher,publicRoot:site,scratch:path.join(root,'install')});
 const cipherFiles=new Map(fs.readdirSync(path.join(site,'generated-views/newsletter')).map(name=>[name,fs.readFileSync(path.join(site,'generated-views/newsletter',name),'utf8')]));
 const again=await runtime.publish();await installPreparedBackground([again],{env,fetcher,publicRoot:site,scratch:path.join(root,'install-again')});for(const [name,value]of cipherFiles)assert.equal(fs.readFileSync(path.join(site,'generated-views/newsletter',name),'utf8'),value,'Unchanged private readers reuse ciphertext instead of reuploading PDF history');
 const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,ASSETS:{fetch:async request=>{assetReads++;const file=path.join(site,new URL(request.url).pathname);return fs.existsSync(file)?new Response(fs.readFileSync(file)):new Response(null,{status:404});}}};
 const common={object:{newsletterPdf(){throw Error('Prepared saved PDFs cannot touch Cloudflare SQL');}},now,pdfHeaders:filename=>({'content-type':'application/pdf','cache-control':'private, no-store'}),guardWrite:async()=>null};
 let response=await handleGithubNewsletter(new Request('https://fixture.test/api/newsletter/pdf/'+pdfId),worker,common);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf);
 let requestEnvelope;
 response=await handleGithubNewsletter(new Request('https://fixture.test/api/newsletter/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({edition:'morning',to:'me',email:'fixture@example.com'})}),worker,{...common,fetcher:async(raw,options)=>{assert.equal(raw,`https://api.github.com/repos/${repo}/actions/workflows/newsletter-refresh.yml/dispatches`);const value=JSON.parse(options.body);assert.equal(value.ref,'main');assert(!value.inputs.request.includes('fixture@example.com'));requestEnvelope=JSON.parse(value.inputs.request);return new Response(null,{status:204});}});assert.equal(response.status,202);const queued=await response.json();assert(queued.requestId);assert.equal(queued.queued,true);
 const result=await runtime.processRequest(requestEnvelope);assert.equal(result.reason,'no-token');const count=runtime.db.prepare('SELECT COUNT(*) n FROM newsletter_manual_attempts').get().n;await runtime.processRequest(requestEnvelope);assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM newsletter_manual_attempts').get().n,count,'Replayed request does not reserve or send twice');
 const claim=runtime.schedule.content.newsBudget.reserve({job:'new-news',model:'fixture',amount:5678,now:at});assert(claim.ok);await runtime.schedule.fetcher('https://api.openai.com/v1/responses',{method:'POST',body:'{}'});assert.equal(providerCalls,1);
 await runtime.close();runtime=null;restarted=await githubNewsletter({...options,file:path.join(root,'restarted.sqlite'),out:path.join(root,'restarted-publication'),legacyClient:async()=>{throw Error('An initialized archive cannot reset');}});assert(restarted.db.prepare('SELECT id FROM newsletter_news_ai_calls WHERE id=?').get(claim.id),'Metered I/O follows acknowledged restart storage containing its actual reservation');assert.equal(restarted.store.delivery('old-unknown').finishedAt,null);assert.deepEqual(Buffer.from(restarted.store.document(pdfId).body),pdf);
 failUpload=true;await assert.rejects(restarted.schedule.fetcher('https://api.openai.com/v1/responses',{method:'POST',body:'{}'}),/archive rejected/);assert.equal(providerCalls,1);await assert.rejects(restarted.schedule.fetcher('https://api.openai.com/v1/responses',{method:'POST',body:'{}'}),/stopped/);assert.equal(providerCalls,1);
 console.log('PASS newsletter GitHub migration: 1.5 MB PDF exact bytes/hash, unknown deliveries and paid budgets retained, encrypted master restart, static PDF reader, cached ciphertext, private queued request and replay safety, acknowledged reservation before stubbed model I/O, publication failure stops further provider work');
}finally{await restarted?.close();await runtime?.close();await source?.close();fs.rmSync(root,{recursive:true,force:true});}
