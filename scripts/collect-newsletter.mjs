import {newsletterQuotes} from './lib/newsletter-quotes.mjs';
import fs from 'node:fs';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {boundedJson} from '../public/js/data/family-book-contract.js';
import {PRODUCTION_ORIGIN} from '../worker/newsletter-brief.mjs';
import {dispatchWorkflow} from '../worker/github-actions.mjs';
import {githubNewsletter} from './lib/newsletter-github.mjs';
import {backgroundExportReady} from './lib/background-export-ready.mjs';
const endpoint=PRODUCTION_ORIGIN+'/api/newsletter/collector';
// The Worker reads committed source captures through ASSETS. On GitHub the
// checkout pins those same JSON files to the workflow revision; never fetch a
// changing deployment or expose other files as source inputs.
export function newsletterAssets(root=resolve('public')){
 return {fetch:async request=>{
  try{
   const pathname=decodeURIComponent(new URL(request.url).pathname),file=resolve(root,'.'+pathname);
   if(!pathname.startsWith('/data/')||!pathname.endsWith('.json')||!file.startsWith(resolve(root,'data')+'/'))return new Response(null,{status:404});
   const actual=fs.realpathSync(file);if(!actual.startsWith(fs.realpathSync(resolve(root,'data'))+'/'))return new Response(null,{status:404});
   const stat=fs.statSync(actual);if(!stat.isFile()||stat.size>32*1024*1024)return new Response(null,{status:404});
   return new Response(fs.readFileSync(actual),{headers:{'content-type':'application/json'}});
  }catch{return new Response(null,{status:404});}
 }};
}
export function newsletterCollectorClient({env=process.env,fetcher=fetch}={}){
 return async input=>{
  const url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL||'');if(url.protocol!=='https:'||!url.hostname.endsWith('.actions.githubusercontent.com')||url.username||url.password||url.port)throw Error('OIDC unavailable');url.searchParams.set('audience',endpoint);
  const identity=await boundedJson(await fetcher(url,{headers:{authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},redirect:'manual',signal:AbortSignal.timeout(15000)}),64000);if(typeof identity.value!=='string'||identity.value.length>16000)throw Error('OIDC unavailable');
  const value=await boundedJson(await fetcher(endpoint,{method:'POST',headers:{authorization:`Bearer ${identity.value}`,'content-type':'application/json'},body:JSON.stringify(input),redirect:'manual',signal:AbortSignal.timeout(45000)}),2*1024*1024);if(value.ok!==true)throw Error('Read-only newsletter source unavailable');return value;
 };
}
async function main(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_REPOSITORY!=='techmuns/Sattva-Central-Research')throw Error('Newsletter requires its fixed main workflow');
 const legacy=newsletterCollectorClient();await backgroundExportReady(()=>legacy({action:'configuration'}),{valid:value=>value?.ok===true&&value.rowidCursor===2&&value.runtime==='github'});
 const recipient=await boundedJson(await fetch(PRODUCTION_ORIGIN+'/api/mutual-funds/publishing-key',{redirect:'manual',signal:AbortSignal.timeout(20000)}),4096),verifiedPdfs=new Map();
 const verifyPdf=document=>{
  if(!verifiedPdfs.has(document.id))verifiedPdfs.set(document.id,(async()=>{
   const expected=createHash('sha256').update(document.body).digest('hex'),deadline=Date.now()+12*60000;
   do{
    try{const response=await fetch(`${PRODUCTION_ORIGIN}/api/newsletter/pdf/${document.id}`,{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20000)});if(response.ok&&response.headers.get('content-type')?.includes('application/pdf')){const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length===document.body.length&&createHash('sha256').update(bytes).digest('hex')===expected)return;}else await response.body?.cancel();}catch{/* Static publication is independent of the runner. */}
    await new Promise(done=>setTimeout(done,15000));
   }while(Date.now()<deadline);throw Error('PDF was not published; email was not sent');
  })());return verifiedPdfs.get(document.id);
 };
 const runtime=await githubNewsletter({env:{...process.env,NEWSLETTER_GITHUB_ARCHIVES:true,ASSETS:newsletterAssets(),NEWSLETTER_QUOTES:newsletterQuotes()},legacyClient:input=>legacy({...input,action:'export'}),inputs:()=>legacy({action:'inputs'}),recipient,verifyPdf,notify:()=>dispatchWorkflow(fetch,{token:process.env.GITHUB_TOKEN,owner:'techmuns',repo:'Sattva-Central-Research',ref:'main'},'deploy.yml','main')});
 try{
  const completionWake=process.env.GITHUB_EVENT_NAME==='workflow_run';
  if(!completionWake)await runtime.publish();let request=null,bootstrap=false;
  if(process.env.GITHUB_EVENT_PATH){const stat=fs.statSync(process.env.GITHUB_EVENT_PATH);if(stat.size>8*1024*1024)throw Error('Workflow event too large');const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));bootstrap=event.inputs?.bootstrap===true||event.inputs?.bootstrap==='true';if(event.inputs?.request){if(typeof event.inputs.request!=='string'||event.inputs.request.length>64000)throw Error('Newsletter request too large');request=JSON.parse(event.inputs.request);}}
  if(bootstrap||process.env.NEWSLETTER_PROCESSING_ENABLED!=='true'){console.log('Read-only newsletter transfer: no model or email work.');}
  else if(request){const result=await runtime.processRequest(request);if(result?.ok===false)process.exitCode=1;}else{const wake=await runtime.wake({onlyIfDue:true});if(wake?.processed===false){console.log('Newsletter automatic wake coalesced with a recent retained check.');return;}const status=await runtime.schedule.status();if(['failed','missed','no-token','build-failed','book-unavailable','partial-send','unauthorised','upstream','timeout','request-expired'].includes(status.lastResult)||['discovery-failed','partial-source-read'].includes(status.content?.reason))process.exitCode=1;}
  await runtime.preparePreviews();await runtime.publish();console.log('Newsletter history, delivery claims and prepared files acknowledged on GitHub.');
 }finally{await runtime.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Newsletter processing stopped; retained claims prevent automatic duplicate delivery.');process.exitCode=1;});
