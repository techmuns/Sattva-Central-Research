import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const DEPLOY_ENV='cloudflare-direct';
const sha=value=>/^[a-f0-9]{40}$/.test(value||'');
function configuration(env) {
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||!env.GITHUB_TOKEN||!/^techmuns\/[A-Za-z0-9-]+$/.test(env.GITHUB_REPOSITORY||''))throw Error('Deployment tracking is restricted to main-branch GitHub Actions');
  return `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/deployments`;
}
function apiClient(env,fetcher) {
  return async(url,body)=>{
    const response=await fetcher(url,{method:body?'POST':'GET',headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'ResearchDeployment'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok){await response.body?.cancel();throw Error(`Deployment tracking unavailable (${response.status})`);}
    const text=await response.text();if(text.length>1024*1024)throw Error('Deployment tracking response too large');return JSON.parse(text);
  };
}
export async function planDeployment({env=process.env,fetcher=fetch,git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}={}) {
  const base=configuration(env),api=apiClient(env,fetcher),head=git('rev-parse','HEAD');
  if(!sha(head)||head!==env.GITHUB_SHA)throw Error('Deployment checkout does not match the main event');
  const deployments=await api(`${base}?environment=${DEPLOY_ENV}&per_page=30`);
  if(!Array.isArray(deployments))throw Error('Invalid deployment history');
  let previous;
  for(const item of deployments) {
    if(!Number.isSafeInteger(item.id)||!sha(item.sha)||item.payload?.publisher!=='github-direct-v1')continue;
    const statuses=await api(`${base}/${item.id}/statuses?per_page=10`);
    if(statuses.some(s=>s.state==='success')){previous=item.sha;break;}
  }
  // Tree IDs include every nested asset. No data blob downloads or Cloudflare
  // calls are needed when a collector changed no published input.
  const signature=ref=>['public','worker','wrangler.jsonc'].map(path=>git('rev-parse',`${ref}:${path}`)).join(':');
  if(previous) {
    if(previous===head)return {changed:false};
    try{signature(previous);}catch{git('fetch','--depth=1','--filter=blob:none','origin',previous);}
    if(signature(previous)===signature(head))return {changed:false};
  }
  const deployment=await api(base,{ref:head,environment:DEPLOY_ENV,auto_merge:false,required_contexts:[],production_environment:true,payload:{publisher:'github-direct-v1'},description:'Direct upload from the standard GitHub Actions runner'});
  if(!Number.isSafeInteger(deployment.id)||deployment.sha!==head)throw Error('Deployment claim invalid');
  await api(`${base}/${deployment.id}/statuses`,{state:'in_progress'});
  return {changed:true,id:deployment.id};
}
export async function finishDeployment({env=process.env,fetcher=fetch}={}) {
  const base=configuration(env),id=Number(env.DEPLOYMENT_ID);
  if(!Number.isSafeInteger(id)||id<=0)throw Error('Deployment identity unavailable');
  await apiClient(env,fetcher)(`${base}/${id}/statuses`,{state:env.DEPLOY_OUTCOME==='success'?'success':'failure',description:env.DEPLOY_OUTCOME==='success'?'Worker and static assets uploaded directly from GitHub':'Upload did not succeed; previous deployment remains the baseline',log_url:`https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv.includes('finish'))await finishDeployment();
    else {
      const result=await planDeployment();
      fs.appendFileSync(process.env.GITHUB_OUTPUT,`changed=${result.changed}\n${result.id?`deployment_id=${result.id}\n`:''}`);
      console.log(result.changed?'Published inputs changed; direct upload is due.':'Published inputs match the last successful GitHub upload.');
    }
  }catch{console.error('Deployment tracking failed; no upload will be assumed successful.');process.exitCode=1;}
}
