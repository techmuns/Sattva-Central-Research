import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { legacyExportClient } from './collect-mutual-funds.mjs';
import { MF_ORIGIN } from '../worker/mutual-funds-model.mjs';
import { MF_RELEASE,mfRepo,mfRelease,mfManifest } from '../worker/mutual-funds-github.mjs';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { localMutualFunds } from './lib/mutual-funds-local.mjs';
import { restoreState,buildSnapshot,MF_LOCAL_FILE,runnerEnv } from './lib/mutual-funds-state.mjs';

async function recipient() {
  return boundedJson(await fetch(`${MF_ORIGIN}/api/mutual-funds/publishing-key`,{redirect:'error',signal:AbortSignal.timeout(20000)}),4096);
}
function requirePublisher(env) {
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||!env.GITHUB_TOKEN||!/^\d+$/.test(env.GITHUB_RUN_ID||''))throw Error('Publication is restricted to main-branch GitHub Actions');
  mfRepo(runnerEnv(env));
}
export async function publishSnapshot(built,{env=process.env,fetcher=fetch}={}) {
  requirePublisher(env);
  const config=runnerEnv(env),repo=mfRepo(config),headers={authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','user-agent':'ResearchSnapshots'};
  const api=async (url,options={})=>{
    const response=await fetcher(url,{...options,headers:{...headers,...options.headers},redirect:'error',signal:AbortSignal.timeout(300000)});
    if(!response.ok){await response.body?.cancel();throw Error(`GitHub snapshot operation failed (${response.status})`);}
    if(response.status===204){await response.body?.cancel();return null;}
    return boundedJson(response,1024*1024);
  };
  let release=await mfRelease(config,{fetcher});
  if(!release)release=await api(`https://api.github.com/repos/${repo}/releases`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tag_name:MF_RELEASE,target_commitish:env.GITHUB_SHA,name:'Mutual Funds retained data',body:'GitHub Actions generated disclosure snapshots. Private source data and restart state are encrypted. This release does not deploy a Worker.',make_latest:'false'})});
  // The complete manifest is uploaded LAST. An interrupted publish leaves the
  // previous manifest and every referenced asset readable.
  for(const name of [...Object.keys(built.manifest.files),built.manifestName]) {
    const file=path.join(built.out,name);if(!fs.existsSync(file))continue;
    const size=fs.statSync(file).size;
    if(size>=1900*1024*1024)throw Error('Snapshot exceeds release asset limit');
    await api(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,{method:'POST',headers:{'content-type':'application/octet-stream','content-length':String(size)},body:fs.createReadStream(file),duplex:'half'});
  }
  release=await mfRelease(config,{fetcher});
  if(!release.assets.some(a=>a.name===built.manifestName))throw Error('Published manifest was not acknowledged');
  // Each state contains ALL observations/corrections. Two complete generations
  // survive; pruning obsolete transport copies does not prune disclosure history.
  const manifests=release.assets.filter(a=>/^mf-\d+-\d+-manifest\.json$/.test(a.name)).sort((a,b)=>b.id-a.id).slice(0,2);
  const keep=new Set(manifests.map(a=>a.name));
  for(const asset of manifests) {
    const document=await boundedJson(await fetcher(asset.browser_download_url,{redirect:'follow',signal:AbortSignal.timeout(30000)}),1024*1024);
    if(document.repo!==repo||document.version!==1)throw Error('Retention manifest invalid');
    for(const name of Object.keys(document.files))keep.add(name);
  }
  for(const asset of release.assets)if(/^mf-\d+-\d+-/.test(asset.name)&&!keep.has(asset.name))await api(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`,{method:'DELETE'});
}
async function main() {
  requirePublisher(process.env);
  if(process.argv.includes('restore')) {
    // The automatic deployment may still be catching up with this merge.
    let ready=false;for(let attempt=0;attempt<60;attempt++){try{await recipient();ready=true;break;}catch{await new Promise(r=>setTimeout(r,10000));}}
    if(!ready)throw Error('Snapshot reader deployment is not ready');
    await restoreState({legacyClient:legacyExportClient()});
    console.log('Verified retained Mutual Funds state restored on the GitHub runner.');
  } else if(process.argv.includes('publish')) {
    if(!fs.existsSync(MF_LOCAL_FILE))throw Error('No verified runner state; refusing empty publication');
    const previous=await mfManifest(runnerEnv());
    const local=localMutualFunds(MF_LOCAL_FILE),built=await buildSnapshot(local,await recipient(),{previous:previous?.manifest});
    await publishSnapshot(built);
    console.log('Retained Mutual Funds state and prepared reader snapshots published on GitHub.');
  } else throw Error('Expected restore or publish');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('GitHub snapshot transfer failed. Previous publication and Cloudflare history are retained.');process.exitCode=1;});
