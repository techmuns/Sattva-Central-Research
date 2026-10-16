import {boundedJson} from '../../public/js/data/family-book-contract.js';
import {marketWindow} from '../../public/js/data/breakout-live-shared.js';
const REPO='techmuns/Sattva-Central-Research',FILE='breakouts-refresh.yml';
// Queue one successor while this owner is still running. Scheduled starts are
// only a fallback; ordinary completion and a failed run both have a replacement.
export async function ensureBreakoutRunner({env=process.env,fetcher=fetch,now=Date.now(),ignoreCurrent=false}={}){
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||!env.GITHUB_TOKEN)throw Error('Invalid quote handover context');
  if(!marketWindow(now).collect)return {requested:false,reason:'closed'};
  const headers={authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','user-agent':'SattvaQuoteHandover'};
  const root=`https://api.github.com/repos/${REPO}/actions/workflows/${FILE}`;
  for(const status of ['in_progress','queued','waiting','requested','pending']){
    const response=await fetcher(`${root}/runs?branch=main&status=${status}&per_page=100`,{headers,redirect:'manual',signal:AbortSignal.timeout(10000)});
    const value=await boundedJson(response,1024*1024);
    if(!Array.isArray(value.workflow_runs)||value.total_count!==value.workflow_runs.length)throw Error('Incomplete quote runner inventory');
    if(value.workflow_runs.some(run=>!Number.isSafeInteger(run.id)||run.head_branch!=='main'||run.head_repository?.full_name!==REPO))throw Error('Invalid quote runner inventory');
    if(value.workflow_runs.some(run=>!ignoreCurrent||String(run.id)!==env.GITHUB_RUN_ID))return {requested:false,reason:'active'};
  }
  const response=await fetcher(`${root}/dispatches`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({ref:'main',inputs:{source:'automatic-handover'}}),redirect:'manual',signal:AbortSignal.timeout(10000)});
  await response.body?.cancel();if(response.status!==204)throw Error('Quote handover was not acknowledged');
  return {requested:true}; // An ambiguous POST is never blindly repeated.
}
