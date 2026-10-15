import fs from 'node:fs';
import path from 'node:path';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {sealBackgroundState,openBackgroundState} from './github-background-seal.mjs';
import {packBackgroundViews} from './github-background-package.mjs';
import {privateRecordViews} from './github-private-records.mjs';
import {copyBackgroundStore} from './github-background-restore.mjs';
import {localBreakouts} from './breakout-local.mjs';
import {preparedBreakoutHistory,breakoutRecordKey} from './breakout-prepared-history.mjs';
import {BREAKOUT_TABLES} from '../../worker/breakout-export.mjs';
import {backgroundContract} from '../../worker/github-background-contract.mjs';

export async function githubBreakouts({env=process.env,fetcher=fetch,legacyClient,recipient,file=path.resolve('.cache/breakouts/state.sqlite'),out=path.resolve('.cache/breakouts/publication'),transportOptions={},localOptions={}}={}) {
 const transport=githubBackgroundRelease('breakouts',{env,fetcher,...transportOptions}),signature=await backgroundContract('breakouts');let local,cycle=0;
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(out,{recursive:true});
 const latest=await transport.latest();
 if(latest){const sealed=file+'.sealed';try{await transport.download(latest,'state',sealed,{sourceSignature:signature});await openBackgroundState(sealed,file,'breakouts',{env});}finally{fs.rmSync(sealed,{force:true});}}
 else if(fs.existsSync(file))throw Error('Unverified local quote state cannot replace retained history');
 local=localBreakouts(file,{env,...localOptions});local.primary.config('upstox-inventory');
 try{
  if(!latest){
   if(!legacyClient)throw Error('Retained quote source unavailable');
   for(const [part,tables,keys] of [['capture',BREAKOUT_TABLES,['breakout-timer']],['primary',['upstox_config'],['upstox-minute-timer']]]){
    const copied=await copyBackgroundStore(local,input=>legacyClient({...input,part}),{tables,keys,onProgress:progress=>console.log('Retained breakout transfer:',part,JSON.stringify(progress))});
    console.log('Verified retained breakout transfer:',part,JSON.stringify(copied.tables));
   }
  }
  if(local.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Retained quote database invalid');
 }catch(error){await local.close();throw error;}
 async function publish(){
  const backup=path.join(out,'checkpoint.sqlite'),state=path.join(out,'state.bin'),views=path.join(out,'views.gz');fs.rmSync(backup,{force:true});
  await local.checkpoint(backup);let copy,prepared;
  try{
   copy=localBreakouts(backup,{env,...localOptions});const at=localOptions.now?.()??Date.now();
   prepared=preparedBreakoutHistory(copy,path.join(out,'history.sqlite'),{now:at});
   const fallback=copy.store.readFallback(),primaryRow=copy.db.prepare('SELECT payload FROM breakout_primary_current WHERE id=1').get();
   const current=primaryRow?{...JSON.parse(primaryRow.payload),rows:copy.db.prepare('SELECT payload FROM breakout_primary_latest').all().flatMap(row=>Object.values(JSON.parse(row.payload))),gaps:copy.store.archive.gaps()}:null;
   function currentPages(kind,value){const {rows,...metadata}=value,pages=[];for(let offset=0;offset<rows.length;offset+=500){const id=breakoutRecordKey(kind,String(offset));prepared.put(id,{rows:rows.slice(offset,offset+500)});pages.push(id);}return {...metadata,pages};}
   const primary=await copy.primary.status();
   const fallbackState=await copy.storage.get('github-breakout-fallback')||{},fallbackAt=fallbackState.lastAttemptAt||Date.parse(fallback.startedAt)||null;
   const schedule={...fallbackState,runtime:'github-actions',started:true,lastAttemptAt:fallbackAt,publishedAt:at,overdue:fallbackState.failed===true||!!fallbackAt&&at-fallbackAt>30*60000};
   const head={version:1,repo:transport.repo,feature:'breakouts',createdAt:new Date(at).toISOString(),primary:current?currentPages('primary',current):null,fallback:currentPages('fallback',fallback),schedule,primarySchedule:{...primary,runtime:'github-actions',alarmAt:null}};
   const entries=privateRecordViews(prepared.ids,prepared.read,head,{repo:transport.repo,feature:'breakouts',env});
   await packBackgroundViews(entries,recipient,views,{repo:transport.repo,feature:'breakouts',sourceSignature:signature});
  }finally{prepared?.close();await copy?.close();}
  await sealBackgroundState(backup,state,'breakouts',{env});
  return transport.publish({cycle:++cycle,state,views,sourceSignature:signature});
 }
 return {...local,publish};
}
