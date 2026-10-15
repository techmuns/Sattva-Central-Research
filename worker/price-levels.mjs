import {preparedPriceLevels} from './price-levels-github.mjs';
import {boundedJson} from '../public/js/data/family-book-contract.js';
import {PRICE_LEVELS_OBJECT,PRICE_LEVELS_REQUEST_BYTES} from '../public/js/data/price-levels-shared.js';
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
async function authorized(request,expected){
  if(typeof expected!=='string'||expected.length<32)return false;
  const raw=request.headers.get('authorization')||'';
  if(!raw.startsWith('Bearer ')||raw.length>256)return false;
  const digest=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const [a,b]=await Promise.all([digest(raw.slice(7)),digest(expected)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
// Service-only route. Family's password-gated proxy owns browser authentication.
// The names-only holdings token and arbitrary Origin headers grant no access.
export async function handlePriceLevels(request,env){
  if(!await authorized(request,env.FAMILY_PRICE_LEVELS_TOKEN))return json({ok:false,reason:'unauthorized'},401);
  if(!['GET','POST'].includes(request.method))return json({ok:false,reason:'method'},405);
  if(!env.CAPTURE_REGISTRY)return json({ok:false,reason:'unavailable'},503);
  const store=env.CAPTURE_REGISTRY.getByName(PRICE_LEVELS_OBJECT);
  try{
    if(request.method==='GET'){
      const cursor=new URL(request.url).searchParams.get('cursor');
      if(cursor?.length>700)return json({ok:false,reason:'invalid-cursor'},400);
      return json({ok:true,...await preparedPriceLevels(request,env,await store.priceLevelsSnapshot(cursor))});
    }
    if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))return json({ok:false,reason:'content-type'},415);
    let input;
    try { input=await boundedJson(new Response(request.body),PRICE_LEVELS_REQUEST_BYTES); }
    catch { return json({ok:false,reason:'invalid-request'},400); }
    return json({ok:true,...await preparedPriceLevels(request,env,await store.priceLevelsApply(input?.intents))});
  }catch(error){return json({ok:false,reason:/Invalid price level|Duplicate company/.test(String(error?.message))?'invalid-request':'unavailable'},/Invalid price level|Duplicate company/.test(String(error?.message))?400:503);}
}
