import {boundedJson} from '../../public/js/data/family-book-contract.js';

const STATUSES=['queued','pending','in_progress'];
const MAX_INSPECTED_RUNS=8;
const positive=value=>Number.isSafeInteger(value)&&value>0;

// Read GitHub's queue, rather than a deployed snapshot that may lag publication.
// This is admission only: it never cancels work or reads recipient/model secrets.
// The existing processor mutex and retained clock remain the serialization boundary.
export async function newsletterQueueAdmission({repo,runId,token,fetcher=fetch}={}){
 if(!/^techmuns\/(Sattva-Central-Research|Glow-Central-Research)$/.test(repo||'')||!positive(Number(runId))||!token)throw Error('Newsletter queue configuration unavailable');
 const root=`https://api.github.com/repos/${repo}/actions`,deadline=performance.now()+60000;
 async function read(path){
  const remaining=Math.floor(deadline-performance.now());if(remaining<1)throw Error('Newsletter queue inventory deadline exceeded');
  const response=await fetcher(root+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(Math.min(20000,remaining)),headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json','user-agent':'ResearchNewsletterAdmission','x-github-api-version':'2022-11-28'}});
  if(!response.ok){await response.body?.cancel();throw Error('Newsletter queue inventory unavailable');}
  return boundedJson(response,4*1024*1024);
 }
 const batches=await Promise.allSettled(STATUSES.map(status=>read(`/workflows/newsletter-refresh.yml/runs?status=${status}&per_page=100&exclude_pull_requests=true`)));
 if(batches.some(result=>result.status!=='fulfilled'))throw Error('Newsletter queue inventory unavailable');
 const runs=new Map();let complete=true;
 for(const {value}of batches){
  if(!Array.isArray(value.workflow_runs)||!Number.isSafeInteger(value.total_count)||value.total_count<value.workflow_runs.length||value.workflow_runs.length>100)throw Error('Newsletter queue inventory invalid');
  complete&&=value.total_count===value.workflow_runs.length&&value.workflow_runs.length<100;
  for(const run of value.workflow_runs){
   if(!positive(run?.id))throw Error('Newsletter queue identity invalid');
   if(run.id!==Number(runId)&&run.head_branch==='main')runs.set(run.id,run);
  }
 }
 if(!complete)return {busy:true,reason:'queue-inventory-incomplete'};
 const candidates=[...runs.values()].sort((a,b)=>a.id-b.id);
 for(const run of candidates.slice(0,MAX_INSPECTED_RUNS)){
  const value=await read(`/runs/${run.id}/jobs?per_page=100`);
  if(!Array.isArray(value.jobs)||!Number.isSafeInteger(value.total_count)||value.total_count!==value.jobs.length||value.jobs.length>100)throw Error('Newsletter queue jobs invalid');
  const processor=value.jobs.find(job=>job.name==='process');
  if(processor&&processor.status!=='completed')return {busy:true,reason:'processor-already-admitted',runId:run.id};
 }
 // A bounded/incomplete view cannot certify an empty queue. A later timer checks again.
 if(candidates.length>MAX_INSPECTED_RUNS)return {busy:true,reason:'queue-admission-unverified'};
 return {busy:false,reason:'queue-clear'};
}
