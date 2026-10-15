import {randomUUID} from 'node:crypto';
import {githubBackgroundSqlite} from './github-background-sqlite.mjs';
import {ConcallSummaryStore} from '../../worker/concall-summary-store.mjs';
import {SUMMARY_INVENTORY_BATCH} from '../../public/js/data/concall-summaries-shared.js';

export function localSummaries(file,{env=process.env,now=Date.now,checkpoint}={}) {
  if(typeof checkpoint!=='function'||!/^\d+$/.test(env.GITHUB_RUN_ID||'')||!/^\d+$/.test(env.GITHUB_RUN_ATTEMPT||'1'))throw Error('GitHub summary runtime configuration unavailable');
  const run=`${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT||1}`,local=githubBackgroundSqlite(file),store=new ConcallSummaryStore(local.storage,{now});store.init();
  let tail=Promise.resolve(),blocked=false;
  const client=input=>{
    const task=tail.then(async()=>{
      if(blocked)throw Error('Summary publication failed; no further source requests are permitted');
      let result;
      if(input.action==='status')return {ok:true,state:store.status()};
      if(input.action==='sync') {
        const {targets,...manifest}=input.inventory,syncId=randomUUID();
        store.beginInventory(run,syncId,{...manifest,targetCount:targets.length});
        for(let offset=0;offset<targets.length;offset+=SUMMARY_INVENTORY_BATCH)store.inventoryBatch(run,syncId,offset,targets.slice(offset,offset+SUMMARY_INVENTORY_BATCH));
        result={ok:true,state:store.finishInventory(run,syncId)};
      }else if(input.action==='discovery-failed')result={ok:true,state:store.discoveryFailed()};
      else if(input.action==='reserve')result=store.reserve(run,input.requestId);
      else if(input.action==='complete')result=store.complete(run,input);
      else throw Error('Unknown local summary action');
      if(input.action!=='reserve'||result.reserved) {
        // The collector cannot open a metered source page until the reserved
        // attempt has been ACKNOWLEDGED by encrypted GitHub restart storage.
        // A publication failure halts this process even if a caller catches it.
        try{await checkpoint({phase:input.action,local,store,run});}
        catch(error){blocked=true;throw error;}
      }
      return result;
    });
    tail=task.catch(()=>{});return task;
  };
  return {...local,store,client,async close(){await tail;await local.close();}};
}
