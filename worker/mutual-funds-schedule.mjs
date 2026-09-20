import { dispatchWorkflow, latestRun, isInFlight } from './github-actions.mjs';
import { MF_INTERVAL, MF_WORKFLOW } from './mutual-funds-model.mjs';
export const MF_TIMER='mutual-funds-timer';
export const MF_SOURCE_WORKFLOW='amc-factsheet-monthly.yml';
export class MutualFundsSchedule {
  constructor(storage,env,{now=Date.now,fetcher=fetch}={}) {Object.assign(this,{storage,env,now,fetcher});}
  async status() { const state=await this.storage.get(MF_TIMER)||{};const alarmAt=await this.storage.getAlarm();return {...state,alarmAt,overdue:state.started && (!alarmAt||this.now()>state.nextAt+120000)}; }
  async arm() {await this.storage.transaction(async tx=>{const state=await tx.get(MF_TIMER);if(!state)await tx.put(MF_TIMER,{started:true,nextAt:this.now()+1000});if(await tx.getAlarm()===null)await tx.setAlarm(Math.max(this.now()+1000,state?.nextAt||0));});return this.status();}
  async wake() {
    const at=this.now();
    const claimed=await this.storage.transaction(async tx=>{const state=await tx.get(MF_TIMER)||{};if(state.lastAttemptAt&&state.nextAt>at){await tx.setAlarm(state.nextAt);return false;}await tx.put(MF_TIMER,{...state,started:true,lastAttemptAt:at,nextAt:at+MF_INTERVAL});await tx.setAlarm(at+MF_INTERVAL);return true;});
    if(!claimed)return;
    let reason='dispatch-unavailable',nextAt=at+MF_INTERVAL,source=null,importSourceRun=null;
    try {
      if(!this.env.GH_DISPATCH_TOKEN || this.env.GH_REPO!=='techmuns/Sattva-Central-Research')throw Error('Configuration');
      const cfg={token:this.env.GH_DISPATCH_TOKEN,owner:'techmuns',repo:'Sattva-Central-Research',ref:'main'};
      const state=await this.storage.get(MF_TIMER)||{};
      source={...state.source,lastAttemptAt:at,reason:'dispatch-unavailable'};
      let completedSource=null;
      try {
        // One fixed upstream repository; no reader-supplied target or credential.
        const upstream={...cfg,repo:'AmfiBeas',token:this.env.GH_AMFI_DISPATCH_TOKEN||cfg.token};
        const runs=await latestRun(this.fetcher,upstream,MF_SOURCE_WORKFLOW,{perPage:10});
        const latest=runs.find(r=>!r.title?.includes('scheme-benchmarks'));
        source.run=latest||null;
        if(latest?.status==='completed')completedSource=latest;
        if(isInFlight(latest)) {
          source.reason=at-Date.parse(latest.createdAt)>45*60000?'run-overdue':'running';
          nextAt=Math.min(nextAt,at+60000);
        } else if(at-Date.parse(latest?.createdAt)<MF_INTERVAL) {
          source.reason='recent-run';
          nextAt=Math.min(nextAt,Math.max(at+1000,Date.parse(latest.createdAt)+MF_INTERVAL));
        } else if(at-(state.source?.lastDispatchAt||0)<90000) {
          // A lost response may already have dispatched; allow run-list visibility
          // before another attempt, including after the object is evicted.
          source.reason='awaiting-run';nextAt=Math.min(nextAt,at+60000);
        } else {
          source.lastDispatchAt=at;
          await this.storage.put(MF_TIMER,{...state,source});
          const out=await dispatchWorkflow(this.fetcher,upstream,MF_SOURCE_WORKFLOW,'main',{mode:'monthly',commit:'true'});
          source.reason=out.dispatched?'dispatched':'running';
          nextAt=Math.min(nextAt,at+60000);
        }
      } catch(error) {source.reason=error.code==='forbidden'||error.code==='not-found'||error.code==='unauthorised'?'access-unavailable':'dispatch-unavailable';}
      const recent=(await latestRun(this.fetcher,cfg,MF_WORKFLOW,{perPage:10})).find(r=>r.event!=='push');
      const newlyPublished=completedSource&&completedSource.id!==state.importSourceRun;
      if(isInFlight(recent)){reason=at-Date.parse(recent.createdAt)>45*60000?'run-overdue':'running';nextAt=at+60000;}
      else if(!newlyPublished&&at-Date.parse(recent?.createdAt)<MF_INTERVAL){reason=recent.conclusion==='success'?'recent-run':'recent-failure';nextAt=Math.min(nextAt,Math.max(at+1000,Date.parse(recent.createdAt)+MF_INTERVAL));}
      else if(at-(state.importLastDispatchAt||0)<90000){reason='awaiting-run';nextAt=Math.min(nextAt,at+60000);}
      else {
        await this.storage.transaction(async tx=>{const latest=await tx.get(MF_TIMER);await tx.put(MF_TIMER,{...latest,importLastDispatchAt:at});});
        const out=await dispatchWorkflow(this.fetcher,cfg,MF_WORKFLOW,'main',{source:'durable-timer'});reason=out.dispatched?'dispatched':'running';if(out.dispatched&&completedSource)importSourceRun=completedSource.id;
      }
    } catch { /* Persist a failed dispatch, never a source-success timestamp. */ }
    await this.storage.transaction(async tx=>{const state=await tx.get(MF_TIMER);if(state?.lastAttemptAt===at){await tx.put(MF_TIMER,{...state,nextAt,reason,...(source?{source}:{}),...(importSourceRun?{importSourceRun}:{})});await tx.setAlarm(nextAt);}});
  }
}
