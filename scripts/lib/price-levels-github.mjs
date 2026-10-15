import fs from 'node:fs';import path from 'node:path';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {openBackgroundState,sealBackgroundState} from './github-background-seal.mjs';
import {packBackgroundViews} from './github-background-package.mjs';
import {privateRecordViews} from './github-private-records.mjs';
import {copyBackgroundStore} from './github-background-restore.mjs';
import {backgroundContract} from '../../worker/github-background-contract.mjs';
import {LEVEL_TABLES,LEVEL_KEYS} from '../../worker/price-levels-export.mjs';
import {localPriceLevels} from './price-levels-local.mjs';

export async function githubPriceLevels({env=process.env,fetcher=fetch,legacyClient,inputs,recipient,file=path.resolve('.cache/price-levels/state.sqlite'),out=path.resolve('.cache/price-levels/publication'),transportOptions={},localOptions={}}={}){
 const transport=githubBackgroundRelease('price-levels',{env,fetcher,...transportOptions}),signature=await backgroundContract('price-levels');let cycle=0,local;
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(out,{recursive:true});const saved=await transport.latest();
 if(saved){const sealed=file+'.sealed';try{await transport.download(saved,'state',sealed,{sourceSignature:signature});await openBackgroundState(sealed,file,'price-levels',{env});}finally{fs.rmSync(sealed,{force:true});}}
 else if(fs.existsSync(file))throw Error('Unverified local levels cannot replace retained history');
 const readInputs=async()=>{if(typeof inputs!=='function')throw Error('Price-level inputs unavailable');await local.applyInputs(await inputs());};
 local=localPriceLevels(file,{env,...localOptions,fetcher:async(...args)=>{const response=await fetcher(...args);try{await readInputs();return response;}catch(error){await response.body?.cancel();throw error;}}});
 try{
  if(!saved){const inventory=await legacyClient({action:'export'});if(inventory?.ok!==true||!Array.isArray(inventory.tables))throw Error('Price-level history unavailable');if(inventory.tables.length)console.log('Verified retained price-level transfer:',JSON.stringify((await copyBackgroundStore(local,legacyClient,{tables:LEVEL_TABLES,keys:LEVEL_KEYS})).tables));else if(JSON.stringify(await legacyClient({action:'export'}))!==JSON.stringify(inventory))throw Error('Unused price-level source changed during import');}
  if(local.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Retained price-level database invalid');
 }catch(error){await local.close();throw error;}
 async function publish(){
  const backup=path.join(out,'checkpoint.sqlite'),state=path.join(out,'state.bin'),views=path.join(out,'views.gz');fs.rmSync(backup,{force:true});await local.checkpoint(backup);const copy=localPriceLevels(backup,{env,...localOptions});
  try{
  const records=new Map(),pages=[];let cursor=null,snapshot;
  do{snapshot=await copy.schedule.snapshot(cursor);const id=String(pages.length);records.set(id,{hits:snapshot.hits});if(snapshot.hits.length)pages.push({id,first:[snapshot.hits[0].reachedAt,snapshot.hits[0].id],last:[snapshot.hits.at(-1).reachedAt,snapshot.hits.at(-1).id]});cursor=snapshot.nextCursor;}while(cursor);
  const {hits,nextCursor,...current}=await copy.schedule.snapshot();
  const head={version:1,repo:transport.repo,feature:'price-levels',createdAt:new Date(localOptions.now?.()??Date.now()).toISOString(),inputRevision:await copy.storage.get('price-level-source-revision')??null,snapshot:current,pages};
  await packBackgroundViews(privateRecordViews([...records.keys()],id=>records.get(id),head,{repo:transport.repo,feature:'price-levels',env}),recipient,views,{repo:transport.repo,feature:'price-levels',sourceSignature:signature});
  }finally{await copy.close();}
  await sealBackgroundState(backup,state,'price-levels',{env});
  return transport.publish({cycle:++cycle,state,views,sourceSignature:signature});
 }
 async function tick(){await readInputs();await local.schedule.wake();return local.schedule.status();}
 return {...local,publish,tick};
}
