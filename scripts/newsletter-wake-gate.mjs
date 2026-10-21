import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {boundedJson} from '../public/js/data/family-book-contract.js';
import {newsletterWakePlan} from './lib/newsletter-wake-plan.mjs';
import {newsletterQueueAdmission} from './lib/newsletter-queue-admission.mjs';
import {BREAKOUT_ENDPOINT} from '../public/js/data/breakout-live-shared.js';

const repository='techmuns/Sattva-Central-Research';
const endpoint=new URL('/api/newsletter',BREAKOUT_ENDPOINT).href;
export async function newsletterWakeGate({event=process.env.GITHUB_EVENT_NAME,repo=process.env.GITHUB_REPOSITORY,fetcher=fetch,now=Date.now(),inputs={},coalesce=process.env.NEWSLETTER_QUEUE_COALESCE==='true',runId=process.env.GITHUB_RUN_ID,token=process.env.GITHUB_TOKEN}={}){
 if((coalesce||event==='workflow_run')&&repo!==repository)throw Error('Newsletter repository unavailable');
 const explicit=event==='workflow_dispatch'&&(typeof inputs.request==='string'&&inputs.request.length>0||inputs.bootstrap===true||inputs.bootstrap==='true');
 let plan={due:true,reason:'primary-trigger'};
 if(event==='workflow_run'){
 // Credential-free prepared-state read only. The processing job checks its
 // encrypted checkpoint again under the account mutex before any paid work.
 const response=await fetcher(endpoint,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{accept:'application/json','cache-control':'no-cache'}});
 const value=await boundedJson(response,8*1024*1024);
 if(value?.ok!==true||value.runtime!=='github-actions')throw Error('Newsletter prepared reader unavailable');
 plan=newsletterWakePlan(value,{now});
 }
 if(!coalesce||!plan.due||explicit)return plan;
 const queue=await newsletterQueueAdmission({repo,runId,token,fetcher});
 return queue.busy?{due:false,reason:queue.reason,...(queue.runId?{queuedRun:queue.runId}:{})}:plan;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  let inputs={};
  if(process.env.GITHUB_EVENT_PATH){if(fs.statSync(process.env.GITHUB_EVENT_PATH).size>8*1024*1024)throw Error('Newsletter event too large');inputs=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')).inputs||{};}
  const plan=await newsletterWakeGate({inputs});
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`run=${plan.due}\n`);
  console.log(JSON.stringify(plan));
 }catch{console.error('Newsletter wake gate could not verify prepared state; no sender was started.');process.exitCode=1;}
}
