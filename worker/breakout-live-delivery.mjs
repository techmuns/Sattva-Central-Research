import {boundedJson} from '../public/js/data/family-book-contract.js';
import {mfRepo} from './mutual-funds-github.mjs';
import {openForReader,decode64,hash} from './mutual-funds-seal.mjs';
import {backgroundContract} from './github-background-contract.mjs';
import {mergePrimary} from './breakout-store.mjs';
import {marketWindow} from '../public/js/data/breakout-live-shared.js';

const FEATURE='breakouts-live',TAG='breakout-live-data',MAX_VIEWS=2*1024*1024;
async function bytes(response,maximum){
  if(!response.ok||Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw Error('Prepared quote delivery unavailable');}
  const reader=response.body?.getReader(),chunks=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>maximum)throw Error('Prepared quote delivery too large');chunks.push(next.value);}}
  finally{await reader?.cancel();}
  const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}return out;
}
// This is delivery of an already collected, encrypted file. Request-time code
// never contacts Upstox, starts Actions, or reads/writes a capture database.
export async function readLiveBreakouts(env,origin,{fetcher=fetch,edgeCache=globalThis.caches?.default,now=Date.now(),fallbackOnly=false}={}){
  if(env.BREAKOUT_LIVE_DELIVERY!=='github-release')return null;
  const repo=mfRepo(env),cacheKey=name=>new Request(new URL(`/_prepared-quotes/${name}`,origin)),deadline=Date.now()+10000;
  const signal=()=>AbortSignal.timeout(Math.max(1,deadline-Date.now()));
  async function cached(name,ttl,load){
    const key=cacheKey(name),found=await edgeCache?.match(key).catch(()=>null);if(found)return found;
    const value=await load();if(edgeCache)await edgeCache.put(key,value.clone()).catch(()=>{});return value;
  }
  const metadata=await cached('release',15,async()=>{
    const response=await fetcher(`https://api.github.com/repos/${repo}/releases/tags/${TAG}`,{headers:{accept:'application/vnd.github+json','user-agent':'SattvaPreparedQuotes',...(env.GH_DISPATCH_TOKEN?{authorization:`Bearer ${env.GH_DISPATCH_TOKEN}`}:{})},redirect:'manual',signal:signal()});
    if(response.status===404){await response.body?.cancel();return Response.json({missing:true},{headers:{'cache-control':'public, max-age=15'}});}
    const value=await boundedJson(response,1024*1024);
    if(value.tag_name!==TAG||!Array.isArray(value.assets)||value.assets.length>=100)throw Error('Invalid prepared quote inventory');
    const assets=value.assets.filter(asset=>/^brlive-\d+-\d+-\d+-bundle\.bin$/.test(asset.name)&&asset.state==='uploaded'&&Number.isSafeInteger(asset.id)&&asset.id>0&&Number.isSafeInteger(asset.size)&&asset.size>33&&asset.size<1900*1024*1024).sort((a,b)=>b.id-a.id);
    if(!assets.length)throw Error('Prepared quote generation missing');
    const asset=assets[0];if(asset.browser_download_url!==`https://github.com/${repo}/releases/download/${TAG}/${asset.name}`)throw Error('Invalid prepared quote destination');
    return Response.json(asset,{headers:{'cache-control':'public, max-age=15'}});
  });
  const asset=await metadata.json();if(asset.missing)throw Error('Live quote publication unavailable');
  async function range(start,end){
    let url=asset.browser_download_url;
    for(let redirects=0;redirects<3;redirects++){
      // A repository token must never be forwarded to a release/CDN redirect.
      const response=await fetcher(url,{headers:{range:`bytes=${start}-${end}`,'user-agent':'SattvaPreparedQuotes'},redirect:'manual',signal:signal()});
      if([301,302,303,307,308].includes(response.status)){
        const next=new URL(response.headers.get('location'),url);await response.body?.cancel();
        if(next.protocol!=='https:'||next.username||next.password||next.port||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname))throw Error('Invalid prepared quote redirect');
        url=next.href;continue;
      }
      if(response.status!==206||response.headers.get('content-range')!==`bytes ${start}-${end}/${asset.size}`){await response.body?.cancel();throw Error('Prepared quote range unavailable');}
      const value=await bytes(response,end-start+1);if(value.length!==end-start+1)throw Error('Incomplete prepared quote range');return value;
    }
    throw Error('Prepared quote redirect limit');
  }
  const envelopeResponse=await cached(`generation-${asset.id}`,86400,async()=>{
    const header=await range(0,Math.min(asset.size-1,16392));
    if(new TextDecoder().decode(header.subarray(0,5))!=='GHRB1')throw Error('Invalid prepared quote bundle');
    const length=new DataView(header.buffer,header.byteOffset,header.byteLength).getUint32(5);
    if(length<1||length>16384||length+9>header.length)throw Error('Invalid prepared quote header');
    const manifest=JSON.parse(new TextDecoder().decode(header.subarray(9,9+length))),state=manifest.files?.state,views=manifest.files?.views;
    if(manifest.version!==1||manifest.repo!==repo||manifest.feature!==FEATURE||manifest.sourceSignature!==await backgroundContract(FEATURE)||!Number.isSafeInteger(state?.size)||state.size<33||!Number.isSafeInteger(views?.size)||views.size<1||views.size>MAX_VIEWS||!(/^[a-f0-9]{64}$/).test(views.hash||'')||9+length+state.size+views.size!==asset.size)throw Error('Invalid prepared quote manifest');
    const start=9+length+state.size,compressed=await range(start,start+views.size-1);
    if(await hash(compressed)!==views.hash)throw Error('Prepared quote integrity failed');
    const plain=await bytes(new Response(new Response(compressed).body.pipeThrough(new DecompressionStream('gzip'))),MAX_VIEWS);
    const lines=new TextDecoder().decode(plain).trimEnd().split('\n').map(line=>JSON.parse(line));
    if(lines.length!==3||lines[0].format!=='encrypted-static-views-v1'||lines[0].repo!==repo||lines[0].feature!==FEATURE||lines[0].sourceSignature!==manifest.sourceSignature||lines[1].name!=='head.json'||lines[2].format!=='complete'||lines[2].files!==1)throw Error('Invalid prepared quote package');
    return Response.json(lines[1].envelope,{headers:{'cache-control':'public, max-age=86400'}});
  });
  const context=`${repo}:github-prepared:${FEATURE}:head.json:v1`;
  const packed=await boundedJson(new Response(await openForReader(await envelopeResponse.json(),env.GH_DISPATCH_TOKEN,context)),MAX_VIEWS);
  if(packed.format!=='gzip-json'||typeof packed.gzip!=='string'||packed.gzip.length>MAX_VIEWS)throw Error('Invalid prepared quotes');
  const head=await boundedJson(new Response(new Response(decode64(packed.gzip)).body.pipeThrough(new DecompressionStream('gzip'))),5*1024*1024);
  if(head.version!==1||head.repo!==repo||head.feature!==FEATURE||!Array.isArray(head.fallback?.rows)||!Array.isArray(head.fallback.targets)||head.primary&&!Array.isArray(head.primary.rows))throw Error('Invalid live quote inventory');
  const active=marketWindow(now).collect,schedule={...head.schedule,overdue:head.schedule?.overdue===true||active&&now-(head.schedule?.lastAttemptAt||0)>30*60000};
  const primarySchedule={...head.primarySchedule,overdue:head.primarySchedule?.overdue===true||active&&now-(head.primarySchedule?.lastAttemptAt||0)>120000};
  return {...(fallbackOnly?head.fallback:mergePrimary(head.fallback,head.primary,now)),schedule,primarySchedule,runtime:'github-actions',delivery:'github-release',publishedAt:head.createdAt};
}
