import fs from 'node:fs';
import {dirname} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline,finished} from 'node:stream/promises';
import {execFileSync} from 'node:child_process';
import {boundedJson} from '../../public/js/data/family-book-contract.js';
import {mfRepo} from '../../worker/mutual-funds-github.mjs';
import {backgroundFileHash} from './github-background-seal.mjs';
import {createBackgroundBundle,readBackgroundBundle,MAX_BACKGROUND_BUNDLE} from './github-background-bundle.mjs';
const FEATURES={'mutual-funds':{tag:'mutual-funds-runner-data',prefix:'mfbg'},breakouts:{tag:'breakout-data',prefix:'br'},summaries:{tag:'summary-data',prefix:'su'},'price-levels':{tag:'price-level-data',prefix:'pl'},newsletter:{tag:'newsletter-data',prefix:'nl'}};
const INITIALIZED='Retained archive initialized';
export function githubBackgroundRelease(feature,{env=process.env,fetcher=fetch,sleep=ms=>new Promise(done=>setTimeout(done,ms)),now=Date.now,head=()=>execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}={}) {
  const spec=FEATURES[feature],repo=mfRepo({GH_REPO:env.GITHUB_REPOSITORY});
  if(!spec||!env.GITHUB_TOKEN)throw Error('Background repository configuration unavailable');
  const root=`https://api.github.com/repos/${repo}`,downloadRoot=`https://github.com/${repo}/releases/download/${spec.tag}/`;
  const owned=new RegExp(`^${spec.prefix}-\\d+-\\d+-\\d+-bundle\\.bin$`);
  const headers={authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','user-agent':'ResearchBackgroundState'};
  let mutation=false;
  function publisher() {
    if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||!/^\d+$/.test(env.GITHUB_RUN_ID||'')||!/^\d+$/.test(env.GITHUB_RUN_ATTEMPT||'1')||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))throw Error('Publication requires a main-branch GitHub runner');
    if(head()!==env.GITHUB_SHA)throw Error('Background checkout does not match its source commit');
  }
  async function api(url,options={}) {
    if(![root,`https://uploads.github.com/repos/${repo}`].some(prefix=>url.startsWith(prefix+'/')))throw Error('Invalid GitHub operation destination');
    if(options.method&&options.method!=='GET'){publisher();if(mutation)await sleep(1000);mutation=true;}
    const response=await fetcher(url,{...options,headers:{...headers,...options.headers},redirect:'manual',signal:AbortSignal.timeout(300000)});
    if(options.allowMissing&&response.status===404){await response.body?.cancel();return null;}
    if(!response.ok){await response.body?.cancel();throw Error(`GitHub background operation failed (${response.status})`);}
    if(response.status===204){await response.body?.cancel();return null;}
    return boundedJson(response,4*1024*1024);
  }
  async function release() {
    const value=await api(`${root}/releases/tags/${spec.tag}`,{allowMissing:true});if(!value)return null;
    if(!Number.isSafeInteger(value.id)||value.id<1||value.tag_name!==spec.tag)throw Error('Invalid background release');
    const assets=[];
    for(let page=1;page<=11;page++) {
      const batch=await api(`${root}/releases/${value.id}/assets?per_page=100&page=${page}`);
      if(!Array.isArray(batch)||batch.length>100)throw Error('Invalid release asset inventory');
      assets.push(...batch);if(assets.length>1000)throw Error('Release asset budget exceeded');
      if(batch.length<100){value.assets=assets;return value;}
    }
    throw Error('Release asset inventory incomplete');
  }
  function candidates(current) {
    return current.assets.filter(asset=>owned.test(asset.name)&&asset.state==='uploaded'&&Number.isSafeInteger(asset.id)&&asset.id>0&&Number.isSafeInteger(asset.size)&&asset.size>33&&asset.size<MAX_BACKGROUND_BUNDLE).sort((a,b)=>b.id-a.id);
  }
  async function latest(current=null) {
    current||=await release();if(!current)return null;
    const asset=candidates(current)[0];if(!asset&&String(current.body||'').includes(INITIALIZED))throw Error('Initialized background history is missing; refusing a reset');return asset?{repo,feature,asset}:null;
  }
  async function download(snapshot,kind,destination,{sourceSignature}={}) {
    const asset=snapshot.asset;
    if(!['state','views'].includes(kind)||snapshot.repo!==repo||snapshot.feature!==feature||!owned.test(asset?.name||'')||asset.browser_download_url!==downloadRoot+asset.name)throw Error('Unknown background file');
    const response=await fetcher(asset.browser_download_url,{redirect:'follow',signal:AbortSignal.timeout(300000)});
    if(!response.ok||Number(response.headers.get('content-length'))>MAX_BACKGROUND_BUNDLE){await response.body?.cancel();throw Error('Background download unavailable');}
    fs.mkdirSync(dirname(destination),{recursive:true});const temporary=destination+'.downloading';let bytes=0;
    async function* bounded(){for await(const chunk of Readable.fromWeb(response.body)){bytes+=chunk.length;if(bytes>asset.size||bytes>MAX_BACKGROUND_BUNDLE)throw Error('Background download exceeds declared size');yield chunk;}}
    try {
      await pipeline(bounded(),fs.createWriteStream(temporary));
      if(bytes!==asset.size||asset.digest&&asset.digest!==`sha256:${await backgroundFileHash(temporary)}`)throw Error('Background download integrity failed');
      const manifest=await readBackgroundBundle(temporary,{[kind]:destination},{repo,feature,sourceSignature});
      return {file:destination,manifest};
    }finally{fs.rmSync(temporary,{force:true});}
  }
  async function prune(current) {
    const keep=new Set();let complete=0;
    for(const asset of candidates(current)){keep.add(asset.name);if(++complete>=2&&!(Date.parse(asset.created_at)>now()-10*60000))break;}
    for(const asset of current.assets)if(owned.test(asset.name)&&!keep.has(asset.name))await api(`${root}/releases/assets/${asset.id}`,{method:'DELETE'});
  }
  async function publish({cycle,state,views,sourceSignature}) {
    publisher();if(!Number.isSafeInteger(cycle)||cycle<1||cycle>9999||!/^[a-f0-9]{64}$/.test(sourceSignature||''))throw Error('Invalid background publication');
    const bundle=state+'.bundle',name=`${spec.prefix}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT||1}-${cycle}-bundle.bin`;
    const built=await createBackgroundBundle(state,views,bundle,{repo,feature,createdAt:new Date(now()).toISOString(),workflowRun:env.GITHUB_RUN_ID,sourceSha:env.GITHUB_SHA,sourceSignature},{env});
    try {
      let current=await release();
      if(!current)current=await api(`${root}/releases`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tag_name:spec.tag,target_commitish:env.GITHUB_SHA,name:`${feature} retained background data`,body:'Authenticated encrypted restart state and individually encrypted static reader files. No plaintext private records.',make_latest:'false'})});
      if(!Number.isSafeInteger(current.id)||current.id<1||current.tag_name!==spec.tag)throw Error('Invalid background release');
      current.assets||=[];await prune(current);
      const body=fs.createReadStream(bundle),closed=finished(body,{cleanup:true}).catch(()=>{});let asset;
      try{asset=await api(`https://uploads.github.com/repos/${repo}/releases/${current.id}/assets?name=${encodeURIComponent(name)}`,{method:'POST',headers:{'content-type':'application/octet-stream','content-length':String(built.size)},body,duplex:'half'});}
      finally{body.destroy();await closed;}
      if(asset.name!==name||asset.size!==built.size||asset.state!=='uploaded'||asset.digest&&asset.digest!==`sha256:${built.hash}`)throw Error('Background upload was not acknowledged');
      current=await release();const acknowledged=await latest(current);
      if(acknowledged?.asset.id!==asset.id)throw Error('Published background generation was not acknowledged');
      if(!String(current.body||'').includes(INITIALIZED))await api(`${root}/releases/${current.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({body:`${current.body||''}\n\n${INITIALIZED}: ${asset.id}`})});
      await prune(current);return {...acknowledged,manifest:built.manifest};
    }finally{fs.rmSync(bundle,{force:true});}
  }
  return {release,latest,download,publish,repo,feature,tag:spec.tag};
}
