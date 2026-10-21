import {readProfile} from './concall-summary-auth.mjs';
import {newsletterPdfResponse} from './newsletter-document.mjs';
import {readBackgroundView} from './github-background-views.mjs';
import {readPrivateRecord} from './github-private-records.mjs';
import {sealForReader,decode64} from './mutual-funds-seal.mjs';
import {mfRepo} from './mutual-funds-github.mjs';
import {boundedJson} from '../public/js/data/family-book-contract.js';
import {normaliseEmail,EDITION_IDS,NEWSLETTER_REQUEST_BYTES,nextScheduled} from '../public/js/data/newsletter-shared.js';
import {callerToken} from './muns.mjs';
const uuid=value=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value||'');
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
export async function handleGithubNewsletter(request,env,{object,guardWrite,pdfHeaders,fetcher=fetch,now=Date.now}={}){
 const url=new URL(request.url);let posted=null;
 if(request.method==='POST'&&['/api/newsletter','/api/newsletter/send'].includes(url.pathname)){
  const refused=await guardWrite(request,env,url);if(refused)return refused;
  if(url.pathname==='/api/newsletter'){
   let input;try{input=await boundedJson(new Response(request.body),NEWSLETTER_REQUEST_BYTES);}catch{return json({ok:false,reason:'invalid-request'},400);}if(!Array.isArray(input?.intents)&&!input?.settings)return json({ok:false,reason:'invalid-request'},400);
   posted=await object.newsletterApply({intents:Array.isArray(input.intents)?input.intents:null,settings:input.settings||null});
  }
 }
 let head;try{head=await readBackgroundView(env,request.url,'newsletter','head.json');}catch(error){if(posted)return json({ok:true,...posted.snapshot,outcomes:posted.outcomes,settingsChanged:posted.settingsChanged,schedule:{runtime:'github-actions',armed:false,reason:'prepared-unavailable'},delivery:'unavailable'});throw error;}
 if(head&&(head.version!==1||head.repo!==mfRepo(env)||head.feature!=='newsletter'||!head.snapshot||!head.schedule))throw Error('Invalid newsletter prepared inventory');
 const memo=new Map(),read=id=>readPrivateRecord(env,request.url,'newsletter',head,id,{memo});
 if(url.pathname.startsWith('/api/newsletter/private-markets')){
  if(request.method!=='GET')return json({ok:false,reason:'method'},405);
  if(url.pathname==='/api/newsletter/private-markets')return json({ok:true,...head?.privateMarkets,preparedAt:head?.createdAt||null});
  if(url.pathname!=='/api/newsletter/private-markets/preview')return json({ok:false,reason:'not-found'},404);
  // Fund relationships are private even though the underlying Inc42 facts are public.
  const token=callerToken(request);let email;try{if(token)email=await readProfile(token,fetcher);}catch{}
  if(!email)return json({ok:false,reason:'Sign in through Research Central to preview the fund section.'},401);
  const current=await object.newsletterSnapshot();
  if(!current.subscribers?.some(row=>row.email===email))return json({ok:false,reason:'The private preview is available to active newsletter recipients.'},403);
  const part=url.searchParams.get('part')||'1';if(!/^[1-9][0-9]{0,2}$/.test(part))return json({ok:false,reason:'invalid-part'},400);
  const value=head?await read(`preview-private-markets-html-${part}`):null;
  if(!value?.ok)return json({ok:false,reason:'The weekly preview is being prepared.'},503);
  return new Response(value.html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','content-security-policy':"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'",'referrer-policy':'no-referrer','x-newsletter-parts':String(value.parts),'x-newsletter-part':String(value.part),'x-newsletter-built-at':value.builtAt}});
 }

 if(url.pathname.startsWith('/api/newsletter/pdf/')){
  if(request.method!=='GET')return json({ok:false,reason:'method'},405);const id=url.pathname.split('/').at(-1);if(!uuid(id))return json({ok:false,reason:'not-found'},404);
  const value=head?await read('pdf-'+id):await object.newsletterPdf(id);if(!value)return json({ok:false,reason:'not-found'},404);
  return head?newsletterPdfResponse(value,read,pdfHeaders(value.filename)):new Response(value.body,{headers:pdfHeaders(value.filename)});
 }
 if(url.pathname==='/api/newsletter/preview'){
  if(request.method!=='GET')return json({ok:false,reason:'method'},405);
  const edition=url.searchParams.get('edition')||'morning',format=['text','pdf'].includes(url.searchParams.get('format'))?url.searchParams.get('format'):'html',part=url.searchParams.get('part')||'1';
  if(!EDITION_IDS.includes(edition)||!/^[1-9][0-9]?$/.test(part))return json({ok:false,reason:'invalid-request'},400);
  if(!head)return json({ok:false,reason:'preparing'},503);const value=await read(`preview-${edition}-${format}-${part}`);
  if(!value?.ok)return json({ok:false,reason:value?.reason||'preview-unavailable'},503);
  if(format==='pdf')return newsletterPdfResponse(value,read,pdfHeaders(value.filename));
  return new Response(value.body,{headers:{'content-type':format==='text'?'text/plain; charset=utf-8':'text/html; charset=utf-8','cache-control':'private, no-store','content-security-policy':"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'",'x-newsletter-subject':encodeURIComponent(value.subject||''),'x-newsletter-part':String(value.part||1),'x-newsletter-parts':String(value.parts||1),'x-newsletter-built-at':value.builtAt||head.createdAt}});
 }
 if(url.pathname.startsWith('/api/newsletter/requests/')){
  if(request.method!=='GET')return json({ok:false,reason:'method'},405);const id=url.pathname.split('/').at(-1);if(!uuid(id))return json({ok:false,reason:'invalid-request'},400);
  const result=head?await read('request-'+id):null;return json({ok:true,requestId:id,state:result?.state||'awaiting-publication',result:result?.result||null});
 }
 if(url.pathname==='/api/newsletter/send'){
  if(request.method!=='POST')return json({ok:false,reason:'method'},405);
  let input;try{input=await boundedJson(new Response(request.body),NEWSLETTER_REQUEST_BYTES);}catch{return json({ok:false,reason:'invalid-request'},400);}if(!EDITION_IDS.includes(input?.edition)||!['me','all'].includes(input?.to)||input.to==='me'&&!normaliseEmail(input.email))return json({ok:false,reason:'invalid-request'},400);
  if(!head?.requestKey||head.processingEnabled!==true)return json({ok:false,reason:head?'processing-paused':'preparing'},503);const id=input.id||crypto.randomUUID();if(!uuid(id))return json({ok:false,reason:'invalid-request'},400);
  const repo=mfRepo(env),payload=new TextEncoder().encode(JSON.stringify({id,at:now(),edition:input.edition,to:input.to,email:normaliseEmail(input.email),sourceOnly:input.to==='me'&&input.sourceOnly===true,token:head.schedule.tokenConfigured?null:callerToken(request)}));if(payload.length>32768)return json({ok:false,reason:'invalid-request'},400);
  const envelope=await sealForReader(payload,head.requestKey,`${repo}:github-newsletter-request:v1`),[owner,name]=repo.split('/'),statusUrl=`/api/newsletter/requests/${id}`;
  try{if(!env.GH_DISPATCH_TOKEN)throw Error('Queue unavailable');const response=await fetcher(`https://api.github.com/repos/${owner}/${name}/actions/workflows/newsletter-refresh.yml/dispatches`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{authorization:`Bearer ${env.GH_DISPATCH_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'ResearchNewsletterQueue'},body:JSON.stringify({ref:'main',inputs:{request:JSON.stringify(envelope)}})});await response.body?.cancel();if(response.status!==204)throw Error('Dispatch unconfirmed');}catch{return json({ok:false,reason:'dispatch-unconfirmed',requestId:id,statusUrl},503);}
  return json({ok:true,queued:true,requestId:id,statusUrl},202);
 }
 if(url.pathname!=='/api/newsletter')return json({ok:false,reason:'not-found'},404);
 if(!['GET','POST'].includes(request.method))return json({ok:false,reason:'method'},405);
 let out=posted||{},source=posted?posted.snapshot:await object.newsletterSnapshot();
 const next=nextScheduled(source.settings,now());const schedule=head?{...head.schedule,privateMarkets:head.privateMarkets,next:next?{edition:next.edition,day:next.day,at:new Date(next.at).toISOString(),key:next.key}:null,...(head.inputRevision!==source.revision?{reason:'waiting-for-inputs'}:{})}:{runtime:'github-actions',armed:false,reason:'preparing'};
 return json({ok:true,privateMarkets:head?.privateMarkets||null,sourceOnlyTests:true,...source,...(head?{deliveries:head.snapshot.deliveries}:{}),outcomes:out.outcomes||[],settingsChanged:out.settingsChanged||false,schedule,runtime:'github-actions',delivery:head?'static-assets':'initial-transfer',preparedAt:head?.createdAt||null,dashboardUrl:env.DASHBOARD_ORIGIN||url.origin});
}
