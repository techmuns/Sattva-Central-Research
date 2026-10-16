import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import path from 'node:path';
import {localBreakouts} from './breakout-local.mjs';
import {preparedBreakoutHistory,breakoutRecordKey} from './breakout-prepared-history.mjs';
import {packBackgroundViews} from './github-background-package.mjs';
import {privateRecordViews} from './github-private-records.mjs';
import {sealBackgroundState} from './github-background-seal.mjs';

// Work on an immutable SQLite checkpoint. Expanding/encrypting historical pages
// must never occupy the event loop that samples the next minute's prices.
export function prepareBreakoutPublication(options) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:options});let result;
    worker.on('message',value=>{result=value;});worker.once('error',reject);
    worker.once('exit',code=>code===0&&result?resolve(result):reject(Error('Quote publication preparation failed')));
  });
}
async function prepare({backup,out,env,recipient,signature,feature,at,history}) {
  const copy=localBreakouts(backup,{env,now:()=>at});let prepared;
  const state=path.join(out,'state.bin'),views=path.join(out,'views.gz');
  try {
    const fallback=copy.store.readFallback(),primaryRow=copy.db.prepare('SELECT payload FROM breakout_primary_current WHERE id=1').get();
    const primary=primaryRow?{...JSON.parse(primaryRow.payload),rows:copy.db.prepare('SELECT payload FROM breakout_primary_latest').all().flatMap(row=>Object.values(JSON.parse(row.payload))),gaps:copy.store.archive.gaps()}:null;
    const primaryState=await copy.primary.status(),fallbackState=await copy.storage.get('github-breakout-fallback')||{};
    const fallbackAt=fallbackState.lastAttemptAt||Date.parse(fallback.startedAt)||null;
    const schedule={...fallbackState,runtime:'github-actions',started:true,lastAttemptAt:fallbackAt,publishedAt:at,overdue:!!fallbackAt&&at-fallbackAt>30*60000};
    // There is no Cloudflare alarm in the GitHub runtime. Age the real attempt.
    const primarySchedule={...primaryState,runtime:'github-actions',alarmAt:null,overdue:!primaryState.lastAttemptAt||at-primaryState.lastAttemptAt>120000};
    const head={version:1,repo:env.GITHUB_REPOSITORY,feature,createdAt:new Date(at).toISOString(),primary,fallback,schedule,primarySchedule};
    let entries;
    if(history){
      prepared=preparedBreakoutHistory(copy,path.join(out,'history.sqlite'),{now:at});
      function pages(kind,value){const {rows,...metadata}=value,ids=[];for(let offset=0;offset<rows.length;offset+=500){const id=breakoutRecordKey(kind,String(offset));prepared.put(id,{rows:rows.slice(offset,offset+500)});ids.push(id);}return {...metadata,pages:ids};}
      head.fallback=pages('fallback',fallback);head.primary=primary?pages('primary',primary):null;
      entries=privateRecordViews(prepared.ids,prepared.read,head,{repo:env.GITHUB_REPOSITORY,feature,env});
    }else entries=[{name:'head.json',value:head}];
    await packBackgroundViews(entries,recipient,views,{repo:env.GITHUB_REPOSITORY,feature,sourceSignature:signature});
  }finally{prepared?.close();await copy.close();}
  // The complete retained database accompanies EVERY live generation. Losing a
  // runner cannot lose minute history merely because the historical UI is slower.
  await sealBackgroundState(backup,state,feature,{env});
  return {state,views};
}
if(!isMainThread)await prepare(workerData).then(value=>parentPort.postMessage(value));
