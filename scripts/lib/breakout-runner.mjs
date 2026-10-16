import {marketWindow,BREAKOUT_INTERVAL_MS} from '../../public/js/data/breakout-live-shared.js';
import {prepareBreakoutCapture,collectBreakouts} from '../collect-breakouts.mjs';

// One runner owns the saved store. The independent loops retain minute quotes
// while the slower fallback walk waits on its providers. Publications serialize.
export async function runBreakoutRunner(local,{discover,now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms)),runWindow=45*60000,minuteInterval=60000,publishInterval=60000,archiveInterval=15*60000,collect=collectBreakouts,notify=async()=>{},handover=async()=>{},token='',checkLevels=async()=>{}}={}) {
 if(typeof discover!=='function'||!Number.isSafeInteger(runWindow)||runWindow<1||runWindow>50*60000)throw Error('Invalid quote runner window');
 let stopped=false,firstError=null,partial=false,fallbackCycle=0,version=0,publishedVersion=-1;const started=now(),deadline=started+runWindow,active=marketWindow(started).collect;
 const wait=async ms=>{let left=ms;while(left>0&&!stopped){const part=Math.min(left,1000);await sleep(part);left-=part;}};
 const publish=async()=>{const revision=version,saved=await local.publish();publishedVersion=revision;if(!local.publishArchive)try{await notify(saved);}catch{console.warn('Prepared quotes saved; automatic static delivery request was unavailable. Scheduled deployment checks remain active.');}return saved;};
 const archive=async()=>{try{const saved=await local.publishArchive();await notify(saved);}catch{partial=true;console.warn('Historical reader publication is delayed; the complete restart history remains in the live checkpoint.');}};
 const levels=async()=>{try{const result=await checkLevels();partial||=result?.failed===true;}catch{partial=true;console.warn('Private price-level checks are unavailable; independent stock-price sampling continues.');}};
 const guard=task=>task.catch(error=>{firstError||=error;stopped=true;});
 async function fallback(){
  do{
   const at=now(),previous=local.store.readFallback(),state=await local.storage.get('github-breakout-fallback')||{};
   const last=state.lastAttemptAt||Date.parse(previous.startedAt)||0;
   if(last>at-BREAKOUT_INTERVAL_MS&&active){await wait(Math.min(last+BREAKOUT_INTERVAL_MS-at,Math.max(1,deadline-at)));continue;}
   try{
   const targets=await discover(previous);
   await local.storage.put('github-breakout-fallback',{...state,lastAttemptAt:at,reason:'checking',failed:false});
   const prepared=await prepareBreakoutCapture({targets:targets.targets,previous,client:local.client,discoveryFailed:targets.discoveryFailed,now:at});
   let result={reason:'retained-close',failures:0,noBase:0,discoveryFailed:targets.discoveryFailed};
   if(!prepared.skipCapture){local.beginCycle(++fallbackCycle);result=await collect({targets:targets.targets,previous,client:local.client,discoveryFailed:targets.discoveryFailed,token,now,sleep});}
   const failed=!!(result.failures||result.noBase||result.recoveryFailed||result.discoveryFailed||!prepared.primaryInventoryUpdated||!marketWindow(at).calendarKnown);partial||=failed;
   await local.storage.put('github-breakout-fallback',{lastAttemptAt:at,lastCompletedAt:now(),reason:failed?'partial':'ok',failed});
   console.log('Fallback quote coverage:',JSON.stringify(result));
   }catch{partial=true;await local.storage.put('github-breakout-fallback',{lastAttemptAt:at,lastCompletedAt:now(),reason:'unavailable',failed:true});console.warn('Fallback collection is unavailable; independent minute sampling continues.');}
   version++;if(!active)break;
   await wait(Math.max(1,Math.min(at+BREAKOUT_INTERVAL_MS,deadline)-now()));
  }while(!stopped&&now()<deadline-10*60000);
 }
 await publish(); // Verify retained history on GitHub before opening source work.
 if(!active){await levels();await fallback();await local.primary.wake();await publish();if(local.publishArchive)await archive();return {partial};}
 try{await handover();}catch{console.warn('The successor could not be confirmed; deployment completion and the schedule will recheck runner ownership.');}
 await Promise.all([
  guard(fallback()),
  guard((async()=>{while(!stopped&&now()<deadline){const at=now();await levels();version++;await wait(Math.max(1,minuteInterval-(now()-at)));}})()),
  guard((async()=>{while(!stopped&&now()<deadline){const at=now();await local.primary.wake();version++;const state=await local.primary.status?.();if(state)console.log('Minute quote coverage:',JSON.stringify({reason:state.reason,saved:state.saved,failed:state.failed,completedAt:state.completedAt}));await wait(Math.max(1,minuteInterval-(now()-at)));}})()),
  guard((async()=>{while(!stopped&&now()<deadline){await wait(publishInterval);if(!stopped&&now()<deadline){await publish();}}})()),
  ...(local.publishArchive?[guard((async()=>{while(!stopped&&now()<deadline){await wait(Math.min(archiveInterval,Math.max(1,deadline-now())));if(!stopped&&now()<deadline)await archive();}})())]:[]),
 ]);
 stopped=true;
 if(publishedVersion!==version||firstError)await publish();
 if(firstError)throw firstError;
 if(partial)console.warn('Quote coverage remains partial; saved prices, missing companies and historical gaps remain visible.');
 return {partial};
}
