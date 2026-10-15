import { boundedJson } from '../public/js/data/family-book-contract.js';
import { readableOwnership } from '../public/js/data/mutual-funds-ownership.js';
import { coverageState, validIsin, MF_ORIGIN } from './mutual-funds-model.mjs';
import { openForReader, hash,decode64 } from './mutual-funds-seal.mjs';

export const MF_RELEASE='mutual-funds-data';
export const MF_PARTS=64;
export const mfPart=isin=>[...isin].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0)%MF_PARTS;
export function mfRepo(env) {
  const expected='techmuns/Sattva-Central-Research';
  if(env.GH_REPO!==expected)throw Error('Snapshot repository unavailable');
  return env.GH_REPO;
}
export async function releaseAsset(asset,repo,{fetcher=fetch,limit=8*1024*1024}={}) {
  const prefix=`https://github.com/${repo}/releases/download/${MF_RELEASE}/`;
  if(!asset?.browser_download_url?.startsWith(prefix))throw Error('Invalid snapshot asset');
  return boundedJson(await fetcher(asset.browser_download_url,{redirect:'follow',signal:AbortSignal.timeout(20000)}),limit);
}
export async function mfRelease(env,{fetcher=fetch,edgeCache=globalThis.caches?.default}={}) {
  const repo=mfRepo(env),key=new Request(`${MF_ORIGIN}/api/mutual-funds/github-release-metadata`);
  // This metadata is public. The Worker's Actions-only dispatch credential is
  // never sent to a Contents endpoint. Cache public metadata to protect the
  // anonymous API allowance; decrypted reader data is never cached here.
  if(!env.GH_RELEASE_TOKEN&&edgeCache) {
    try{const cached=await edgeCache.match(key);if(cached)return await boundedJson(cached,4*1024*1024);}catch{/* Recheck GitHub. */}
  }
  const response=await fetcher(`https://api.github.com/repos/${repo}/releases/tags/${MF_RELEASE}`,{
    headers:{accept:'application/vnd.github+json','user-agent':'ResearchSnapshots',...(env.GH_RELEASE_TOKEN?{authorization:`Bearer ${env.GH_RELEASE_TOKEN}`}:{})},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(response.status===404){await response.body?.cancel();if(!env.GH_RELEASE_TOKEN&&edgeCache)await edgeCache.put(key,Response.json(null,{headers:{'cache-control':'public, max-age=60'}})).catch(()=>{});return null;}
  const release=await boundedJson(response,4*1024*1024);
  if(!env.GH_RELEASE_TOKEN&&edgeCache)await edgeCache.put(key,Response.json(release,{headers:{'cache-control':'public, max-age=300'}})).catch(()=>{});
  return release;
}
export async function mfManifest(env,options={}) {
  const release=await mfRelease(env,options);if(!release)return null;
  const candidates=(release.assets||[]).filter(a=>/^mf-\d+-\d+-manifest\.json$/.test(a.name)&&a.state!=='starter'&&a.size!==0).sort((a,b)=>b.id-a.id);
  if(!candidates.length)return null; // The first upload may have been interrupted.
  // An incomplete upload has no manifest. A missing/corrupt newest manifest
  // does not discard the previous fully published generation.
  for(const asset of candidates) {
    try {
      const manifest=await releaseAsset(asset,mfRepo(env),{...options,limit:1024*1024});
      if(manifest.version!==1||manifest.repo!==mfRepo(env)||!manifest.state||!manifest.publicIndex)throw Error('Invalid snapshot manifest');
      const assets=new Map((release.assets||[]).map(a=>[a.name,a]));
      if(Object.keys(manifest.files).some(name=>!assets.has(name)||assets.get(name).state==='starter'||assets.get(name).size===0))throw Error('Incomplete snapshot');
      return {manifest,assets};
    }catch{/* Try the retained complete generation. */}
  }
  throw Error('No complete GitHub snapshot');
}
export async function mfSnapshotFile(snapshot,name,env,{privateRead=false,fetcher=fetch}={}) {
  if(!Object.hasOwn(snapshot.manifest.files,name))throw Error('Unlisted snapshot part');
  const payload=await releaseAsset(snapshot.assets.get(name),mfRepo(env),{fetcher});
  const bytes=new TextEncoder().encode(JSON.stringify(payload));
  if(await hash(bytes)!==snapshot.manifest.files[name])throw Error('Snapshot integrity failed');
  if(!privateRead)return payload;
  const plain=await openForReader(payload,env.GH_DISPATCH_TOKEN,`${mfRepo(env)}:${name}`);
  if(plain.byteLength>5*1024*1024)throw Error('Private snapshot part too large');
  return JSON.parse(new TextDecoder().decode(plain));
}
export async function githubMutualFunds(request,env,{privateRead=false,fetcher=fetch}={}) {
  const snapshot=await mfManifest(env,{fetcher});if(!snapshot)return null;
  const url=new URL(request.url),company=url.pathname.endsWith('/company');
  const ids=url.searchParams.has('isins')?url.searchParams.get('isins').split(',').filter(Boolean):null;
  if(ids&&(ids.length>250||ids.some(id=>!validIsin(id))))throw Error('Invalid company scope');
  const index=await mfSnapshotFile(snapshot,privateRead?snapshot.manifest.privateIndex:snapshot.manifest.publicIndex,env,{privateRead,fetcher});
  const meta={...index.meta,health:coverageState(index.meta),runtime:'github-actions'};
  if(company) {
    const isin=url.searchParams.get('isin'),month=url.searchParams.get('month');
    if(!validIsin(isin)||month&&!/^20\d\d-(0[1-9]|1[0-2])$/.test(month))throw Error('Invalid detail scope');
    const parts=privateRead?snapshot.manifest.privateParts:snapshot.manifest.publicParts;
    const name=parts[String(mfPart(isin))];
    const part=name?await mfSnapshotFile(snapshot,name,env,{privateRead,fetcher}):{};
    const stored=part[isin];
    const selected=stored&&(month?stored.months[month]:stored.latest);
    // Inflate only the requested prepared file, never a company's entire
    // retained archive or the complete universe of monthly views.
    const value=selected?await boundedJson(new Response(new Response(decode64(selected.gzip)).body.pipeThrough(new DecompressionStream('gzip'))),5*1024*1024):null;
    return {meta,company:value?readableOwnership(value):null};
  }
  const cursor=url.searchParams.get('cursor')||'',scope=ids?new Set(ids):null;
  const eligible=index.rows.filter(row=>scope?scope.has(row.isin):row.isin>cursor).sort((a,b)=>a.isin.localeCompare(b.isin));
  const rows=eligible.slice(0,250).map(row=>readableOwnership(row));
  return {meta,rows,nextCursor:!ids&&eligible.length>250?rows.at(-1).isin:null};
}
