import fs from 'node:fs';
import path from 'node:path';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {openBackgroundState} from './github-background-seal.mjs';
import {copyBackgroundStore} from './github-background-restore.mjs';
import {localBreakouts} from './breakout-local.mjs';
import {prepareBreakoutPublication} from './breakout-publication.mjs';
import {BREAKOUT_TABLES} from '../../worker/breakout-export.mjs';
import {backgroundContract} from '../../worker/github-background-contract.mjs';

export async function githubBreakouts({env=process.env,fetcher=fetch,legacyClient,recipient,file=path.resolve('.cache/breakouts/state.sqlite'),out=path.resolve('.cache/breakouts/publication'),transportOptions={},localOptions={}}={}) {
 const archiveTransport=githubBackgroundRelease('breakouts',{env,fetcher,...transportOptions});
 const live=env.BREAKOUT_LIVE_DELIVERY==='github-release',feature=live?'breakouts-live':'breakouts';
 const transport=live?githubBackgroundRelease(feature,{env,fetcher,...transportOptions}):archiveTransport,signature=await backgroundContract(feature);let local,cycle=0,archiveCycle=0;
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(out,{recursive:true});
 let restore=transport,latest=await transport.latest();
 if(!latest&&live){restore=archiveTransport;latest=await restore.latest();}
 if(latest){const sealed=file+'.sealed';try{await restore.download(latest,'state',sealed,{sourceSignature:await backgroundContract(restore.feature)});await openBackgroundState(sealed,file,restore.feature,{env});}finally{fs.rmSync(sealed,{force:true});}}
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
 async function publication(target,directory,cycle,history){
  fs.mkdirSync(directory,{recursive:true});const backup=path.join(directory,'checkpoint.sqlite');fs.rmSync(backup,{force:true});
  await local.checkpoint(backup);
  const signature=await backgroundContract(target.feature),workerEnv={GITHUB_REPOSITORY:env.GITHUB_REPOSITORY,GITHUB_RUN_ID:env.GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT:env.GITHUB_RUN_ATTEMPT,BACKGROUND_STATE_KEY:env.BACKGROUND_STATE_KEY,UPSTOX_ACCESS_TOKEN:env.UPSTOX_ACCESS_TOKEN?'configured':''};
  const prepared=await prepareBreakoutPublication({backup,out:directory,env:workerEnv,recipient,signature,feature:target.feature,at:localOptions.now?.()??Date.now(),history});
  return target.publish({cycle,...prepared,sourceSignature:signature});
 }
 const publish=()=>publication(transport,out,++cycle,!live);
 const publishArchive=live?()=>publication(archiveTransport,path.join(out,'archive'),++archiveCycle,true):null;
 return {...local,publish,publishArchive};
}
