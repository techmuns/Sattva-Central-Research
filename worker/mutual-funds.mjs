import { MF_OBJECT,MF_ENDPOINT,MF_WORKFLOW,MF_ORIGIN,validIsin } from './mutual-funds-model.mjs';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { breakoutCollectorIdentity } from './breakout-auth.mjs';
import { withTag,tagged,revalidate } from './http.mjs';
import { authoriseSummaryReader } from './concall-summary-auth.mjs';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const privateReply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store',vary:'Authorization','x-content-type-options':'nosniff'}});
export async function handleMutualFunds(request,env,{identity=breakoutCollectorIdentity,authorise=authoriseSummaryReader}={}) {
  const url=new URL(request.url);
  if(!env.CAPTURE_REGISTRY)return reply({ok:false,reason:'storage-unavailable'},503);
  const store=env.CAPTURE_REGISTRY.getByName(MF_OBJECT);
  if(url.pathname==='/api/mutual-funds/collector') {
    if(request.method!=='POST'||url.origin!==MF_ORIGIN)return reply({ok:false},403);
    let run;try{run=await identity(request,{endpoint:MF_ENDPOINT,workflow:MF_WORKFLOW});}catch{return reply({ok:false,reason:'identity'},403);}
    try{
      const body=await boundedJson(new Response(request.body),3*1024*1024);
      if(body.action==='arm')return reply({ok:true,schedule:await store.mfArm()});
      if(body.action==='begin')return reply(await store.mfBegin(run,body.manifest));
      if(body.action==='reports')return reply(await store.mfReports(run,body.reports));
      if(body.action==='fragment')return reply(await store.mfFragment(run,body.fragment));
      if(body.action==='checkpoint')return reply(await store.mfCheckpoint(run,body.companies));
      if(body.action==='confirm')return reply(await store.mfConfirm(run,body.companies));
      if(body.action==='finish')return reply(await store.mfFinish(run));
      if(body.action==='scanner-inventory')return privateReply(await store.mfScannerInventory(body.companies));
      if(body.action==='scanner-reserve')return privateReply(await store.mfScannerReserve(run,body.requestId,body.kind));
      if(body.action==='scanner-complete')return privateReply(await store.mfScannerComplete(run,body.input));
      if(body.action==='scanner-status')return privateReply({ok:true,supplement:await store.mfScannerStatus()});
      return reply({ok:false,reason:'action'},400);
    }catch{return reply({ok:false,reason:'capture-rejected'},503);}
  }
  if(request.method!=='GET')return reply({ok:false},405);
  const privateRead=url.pathname==='/api/mutual-funds/private'||url.pathname==='/api/mutual-funds/private/company';
  if(privateRead) {
    if(request.headers.get('origin')&&request.headers.get('origin')!==url.origin || request.headers.get('sec-fetch-site')==='cross-site')return privateReply({ok:false,reason:'access'},403);
    const access=await authorise(request,env);
    if(!access.ok)return privateReply({ok:false,reason:access.reason},401);
  }
  try {
    const ids=url.searchParams.has('isins')?url.searchParams.get('isins').split(',').filter(Boolean):null;
    if(ids && (ids.length>250||ids.some(id=>!validIsin(id))))return reply({ok:false},400);
    if(privateRead) {
      const payload=url.pathname.endsWith('/company')?await store.mfPrivateDetail(url.searchParams.get('isin'),url.searchParams.get('month')):await store.mfPrivateRead(ids,url.searchParams.get('cursor')||'');
      return privateReply(payload);
    }
    const payload=url.pathname==='/api/mutual-funds/company'
      ?await store.mfDetail(url.searchParams.get('isin'),url.searchParams.get('month'))
      :await store.mfRead(ids,url.searchParams.get('cursor')||'');
    if(url.pathname==='/api/mutual-funds/health') {
      const schedule=await store.mfScheduleStatus();
      return reply({...payload.meta,schedule},payload.meta.health.state!=='current'||schedule.overdue||schedule.reason!=='recent-run'||!schedule.source?.lastAttemptAt||schedule.source?.reason!=='recent-run'?503:200);
    }
    const {body,tag}=withTag(payload);return revalidate(request,tagged(body,tag,0),'capture');
  }catch{return (privateRead?privateReply:reply)({ok:false,reason:'capture-unavailable'},503);}
}
