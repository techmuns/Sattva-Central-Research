import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {runBreakoutRunner} from './lib/breakout-runner.mjs';
const market=Date.parse('2026-09-15T06:30:00Z');
function fixture({failInitial=false,failOnce=false}={}){
 const started=performance.now(),values=new Map(),events=[];let publications=0,quotes=0,captures=0,finished=false;
 const now=()=>market+Math.floor(performance.now()-started);
 const local={storage:{get:async key=>values.get(key),put:async(key,value)=>{values.set(key,value);}},store:{readFallback:()=>({version:1,state:'not-started',rows:[],targets:[]})},client:async()=>({ok:true}),beginCycle:()=>{},primary:{wake:async()=>{events.push('quote');quotes++;}},publish:async()=>{publications++;if(failInitial||failOnce&&publications===2)throw Error('Fixture archive unavailable');events.push({publication:publications,finished});return {ok:true};}};
 const options={now,runWindow:100,minuteInterval:10,publishInterval:15,sleep:ms=>delay(ms),discover:async()=>({targets:[{ticker:'TEST'}],discoveryFailed:false}),collect:async()=>{assert(publications>0,'Verified history is acknowledged before provider work');captures++;const before=quotes;await delay(35);assert(quotes>before,'Minute capture continues while the fallback provider is waiting');finished=true;return {failures:0,noBase:0,discoveryFailed:false};}};
 return {local,options,events,stats:()=>({publications,quotes,captures,finished})};
}
const normal=fixture();await runBreakoutRunner(normal.local,normal.options);assert.equal(normal.stats().captures,1);assert(normal.stats().quotes>=2);assert(normal.events[0].publication===1);assert(normal.events.some(event=>event.finished===true));
const initial=fixture({failInitial:true});await assert.rejects(runBreakoutRunner(initial.local,initial.options),/archive unavailable/);assert.equal(initial.stats().quotes,0);assert.equal(initial.stats().captures,0);
const interrupted=fixture({failOnce:true});await assert.rejects(runBreakoutRunner(interrupted.local,interrupted.options),/archive unavailable/);assert(interrupted.events.some(event=>event.finished===true),'Interrupted source progress is retained before the run fails');const count=interrupted.stats().quotes;await delay(30);assert.equal(interrupted.stats().quotes,count,'A failed runner leaves no detached quote loop');
const partial=fixture();partial.options.collect=async()=>({failures:1});assert.equal((await runBreakoutRunner(partial.local,partial.options)).partial,true);assert(partial.stats().publications>=2,'Partial captures publish their evidence without ending automatic collection');
const fallbackFailure=fixture();fallbackFailure.options.collect=async()=>{throw Error('Fixture provider unavailable');};assert.equal((await runBreakoutRunner(fallbackFailure.local,fallbackFailure.options)).partial,true);assert(fallbackFailure.stats().quotes>=2,'A fallback failure cannot stop the independent minute collector');
const levelsFailure=fixture();levelsFailure.options.checkLevels=async()=>{throw Error('Fixture private levels unavailable');};assert.equal((await runBreakoutRunner(levelsFailure.local,levelsFailure.options)).partial,true);assert(levelsFailure.stats().quotes>=2,'Private-level failures cannot stop stock-price collection');
const slowArchive=fixture();let archiveStarted=false,archiveFinished=false,handovers=0;
slowArchive.local.publishArchive=async()=>{archiveStarted=true;const before=slowArchive.stats().quotes;await delay(40);assert(slowArchive.stats().quotes>before,'History publication does not block minute sampling');archiveFinished=true;};
slowArchive.options.archiveInterval=25;slowArchive.options.handover=async()=>{handovers++;};await runBreakoutRunner(slowArchive.local,slowArchive.options);assert(archiveStarted&&archiveFinished);assert.equal(handovers,1);assert(slowArchive.stats().publications>=3,'Current generations publish independently of slower history');
console.log('PASS GitHub quote orchestration: acknowledged history before source work, independent minute collection during slow fallback, retained partial progress and no continuing source work after publication failure');
