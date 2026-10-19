import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {boundedJson} from '../public/js/data/family-book-contract.js';
import {newsletterWakePlan} from './lib/newsletter-wake-plan.mjs';

const origins={
 'techmuns/Sattva-Central-Research':'https://sattva-central-research.tech-441.workers.dev',
 'techmuns/Glow-Central-Research':'https://glow-central-research.tech-441.workers.dev',
};
export async function newsletterWakeGate({event=process.env.GITHUB_EVENT_NAME,repo=process.env.GITHUB_REPOSITORY,fetcher=fetch,now=Date.now()}={}){
 if(event!=='workflow_run')return {due:true,reason:'primary-trigger'};
 const origin=origins[repo];if(!origin)throw Error('Newsletter repository unavailable');
 // Credential-free prepared-state read only. The processing job checks its
 // encrypted checkpoint again under the account mutex before any paid work.
 const response=await fetcher(origin+'/api/newsletter',{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{accept:'application/json','cache-control':'no-cache'}});
 const value=await boundedJson(response,8*1024*1024);
 if(value?.ok!==true||value.runtime!=='github-actions')throw Error('Newsletter prepared reader unavailable');
 return newsletterWakePlan(value,{now});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const plan=await newsletterWakeGate();
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`run=${plan.due}\n`);
  console.log(JSON.stringify(plan));
 }catch{console.error('Newsletter wake gate could not verify prepared state; no sender was started.');process.exitCode=1;}
}
