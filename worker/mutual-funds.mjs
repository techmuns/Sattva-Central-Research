import { MF_OBJECT,MF_ENDPOINT,MF_WORKFLOW,MF_SCANNER_WORKFLOW,MF_ORIGIN,validIsin } from './mutual-funds-model.mjs';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { breakoutCollectorIdentity } from './breakout-auth.mjs';
import { withTag,tagged,revalidate } from './http.mjs';
import { authoriseMutualFundsReader } from './mutual-funds-auth.mjs';
import { scannerOperationalStatus } from './mutual-funds-scanner-model.mjs';
import { githubMutualFunds } from './mutual-funds-github.mjs';
import { readerKeys,encode64 } from './mutual-funds-seal.mjs';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const privateReply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store',vary:'Authorization','x-content-type-options':'nosniff'}});
export async function handleMutualFunds(request,env,{identity=breakoutCollectorIdentity,authorise=authoriseMutualFundsReader,fetcher=fetch}={}) {
  const url=new URL(request.url);
  if(url.pathname==='/api/mutual-funds/publishing-key') {
    if(request.method!=='GET')return reply({ok:false},405);
    try{const key=await readerKeys(env.GH_DISPATCH_TOKEN);return reply({kid:key.kid,publicKey:encode64(key.publicKey)});}catch{return reply({ok:false,reason:'publishing-unavailable'},503);}
  }
  if(url.pathname==='/api/mutual-funds/collector') {
    if(request.method!=='POST'||url.origin!==MF_ORIGIN)return reply({ok:false},403);
    let body;try{body=await boundedJson(new Response(request.body),3*1024*1024);}catch{return reply({ok:false,reason:'invalid-body'},400);}
    if(!body||typeof body!=='object'||Array.isArray(body))return reply({ok:false,reason:'invalid-body'},400);
    const scannerAction=['scanner-inventory','scanner-reserve','scanner-complete','scanner-status'].includes(body.action);
    let run;try{run=await identity(request,{endpoint:MF_ENDPOINT,workflow:scannerAction?MF_SCANNER_WORKFLOW:MF_WORKFLOW});}catch{return reply({ok:false,reason:'identity'},403);}
    if(body.action==='export') {
      try{return privateReply(await env.CAPTURE_REGISTRY.getByName(MF_OBJECT).mfExport(body.table||null,body.cursor||0));}catch{return privateReply({ok:false,reason:'migration-unavailable'},503);}
    }
    return reply({ok:false,reason:'collection-moved-to-github'},410);
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
    if(env.GH_REPO) {
      const payload=await githubMutualFunds(request,env,{privateRead,fetcher});
      if(payload) {
        if(url.pathname==='/api/mutual-funds/health')return reply({...payload.meta,schedule:{runtime:'github-actions',started:false}},payload.meta.health.state==='current'?200:503);
        if(privateRead)return privateReply(payload);
        const {body,tag}=withTag(payload);return revalidate(request,tagged(body,tag,0),'github-snapshot');
      }
      // Only until the first verified GitHub publication: retain existing reads
      // during the transfer. No capture endpoint or alarm can write or re-arm.
    }
    if(!env.CAPTURE_REGISTRY)return reply({ok:false,reason:'storage-unavailable'},503);
    const store=env.CAPTURE_REGISTRY.getByName(MF_OBJECT);
    if(privateRead) {
      const payload=url.pathname.endsWith('/company')?await store.mfPrivateDetail(url.searchParams.get('isin'),url.searchParams.get('month')):await store.mfPrivateRead(ids,url.searchParams.get('cursor')||'');
      return privateReply(payload);
    }
    const payload=url.pathname==='/api/mutual-funds/company'
      ?await store.mfDetail(url.searchParams.get('isin'),url.searchParams.get('month'))
      :await store.mfRead(ids,url.searchParams.get('cursor')||'');
    if(url.pathname==='/api/mutual-funds/health') {
      const schedule=await store.mfScheduleStatus();
      const supplement=scannerOperationalStatus(await store.mfScannerStatus());
      return reply({...payload.meta,schedule,supplement},payload.meta.health.state!=='current'||schedule.overdue||schedule.reason!=='recent-run'||!schedule.source?.lastAttemptAt||schedule.source?.reason!=='recent-run'?503:200);
    }
    const {body,tag}=withTag(payload);return revalidate(request,tagged(body,tag,0),'capture');
  }catch{return (privateRead?privateReply:reply)({ok:false,reason:'capture-unavailable'},503);}
}
