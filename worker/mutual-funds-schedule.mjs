import { dispatchWorkflow, latestRun, isInFlight } from './github-actions.mjs';
import { MF_INTERVAL, MF_WORKFLOW, MF_SCANNER_WORKFLOW } from './mutual-funds-model.mjs';
export const MF_TIMER='mutual-funds-timer';
export const MF_SOURCE_WORKFLOW='amc-factsheet-monthly.yml';
const completedAt=run=>Date.parse(run?.updatedAt||run?.createdAt);
export class MutualFundsSchedule {
  constructor(storage,env,{now=Date.now,fetcher=fetch}={}) {Object.assign(this,{storage,env,now,fetcher});}
  async status() { const state=await this.storage.get(MF_TIMER)||{};const alarmAt=await this.storage.getAlarm();return {...state,alarmAt,overdue:state.started && (!alarmAt||this.now()>state.nextAt+120000)}; }
  async arm() {await this.storage.transaction(async tx=>{const state=await tx.get(MF_TIMER);if(!state)await tx.put(MF_TIMER,{started:true,nextAt:this.now()+1000});if(await tx.getAlarm()===null)await tx.setAlarm(Math.max(this.now()+1000,state?.nextAt||0));});return this.status();}
  async scannerWake(at) {
    const state=await this.storage.get(MF_TIMER)||{},scanner={...state.scanner,lastAttemptAt:at,reason:'dispatch-unavailable'};
    try {
      if(!this.env.GH_DISPATCH_TOKEN||this.env.GH_REPO!=='techmuns/Sattva-Central-Research')throw Error('Configuration');
      const cfg={token:this.env.GH_DISPATCH_TOKEN,owner:'techmuns',repo:'Sattva-Central-Research',ref:'main'};
      const runs=(await latestRun(this.fetcher,cfg,MF_SCANNER_WORKFLOW,{perPage:10})).filter(r=>r.event!=='push');
      const recent=runs[0];scanner.run=recent||null;
      if(isInFlight(recent))scanner.reason=at-Date.parse(recent.createdAt)>25*60000?'run-overdue':'running';
      else if(at-Date.parse(recent?.createdAt)<MF_INTERVAL)scanner.reason=recent.conclusion==='success'?'recent-run':'recent-failure';
      else if(at-(scanner.lastDispatchAt||0)<90000)scanner.reason='awaiting-run';
      else {
        scanner.lastDispatchAt=at;
        await this.storage.transaction(async tx=>{const latest=await tx.get(MF_TIMER);await tx.put(MF_TIMER,{...latest,scanner});});
        const out=await dispatchWorkflow(this.fetcher,cfg,MF_SCANNER_WORKFLOW,'main',{source:'durable-timer'});
        scanner.reason=out.dispatched?'dispatched':'running';if(out.run)scanner.run=out.run;
      }
    }catch(error){if(['forbidden','not-found','unauthorised'].includes(error.code))scanner.reason='access-unavailable';}
    await this.storage.transaction(async tx=>{const latest=await tx.get(MF_TIMER);await tx.put(MF_TIMER,{...latest,scanner});});
  }
  async wake() {
    const at=this.now();
    const claimed=await this.storage.transaction(async tx=>{const state=await tx.get(MF_TIMER)||{};if(state.lastAttemptAt&&state.nextAt>at){await tx.setAlarm(state.nextAt);return false;}await tx.put(MF_TIMER,{...state,started:true,lastAttemptAt:at,nextAt:at+MF_INTERVAL});await tx.setAlarm(at+MF_INTERVAL);return true;});
    if(!claimed)return;
    // Supplemental capture has its own workflow and concurrency group. A slow
    // or unavailable primary importer must not hold its next source check.
    await this.scannerWake(at);
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
        } else if(at-completedAt(latest)<MF_INTERVAL) {
          source.reason=latest.conclusion==='success'?'recent-run':'recent-failure';
          nextAt=Math.min(nextAt,Math.max(at+1000,completedAt(latest)+MF_INTERVAL));
        } else if(at-(state.source?.lastDispatchAt||0)<90000) {
          // A lost response may already have dispatched; allow run-list visibility
          // before another attempt, including after the object is evicted.
          source.reason='awaiting-run';nextAt=Math.min(nextAt,at+60000);
        } else {
          source.lastDispatchAt=at;
          await this.storage.put(MF_TIMER,{...state,source});
          const out=await dispatchWorkflow(this.fetcher,upstream,MF_SOURCE_WORKFLOW,'main',{mode:'monthly',commit:'true'});
          if(out.run)source.run=out.run;
          source.reason=out.dispatched?'dispatched':at-Date.parse(out.run?.createdAt)>45*60000?'run-overdue':'running';
          nextAt=Math.min(nextAt,at+60000);
        }
      } catch(error) {
        source.reason=error.code==='forbidden'||error.code==='not-found'||error.code==='unauthorised'?'access-unavailable':'dispatch-unavailable';
        if(error.code==='dispatch-uncertain')nextAt=Math.min(nextAt,at+60000);
      }
      const consumerRuns=(await latestRun(this.fetcher,cfg,MF_WORKFLOW,{perPage:10})).filter(r=>r.event!=='push');
      const recent=consumerRuns[0];
      // GitHub can accept POST while its response is lost. Reconcile the claim
      // against a newly visible run, including one that already finished. Run
      // timestamps have second precision; exclude every run known before POST.
      if(state.importPendingSourceRun && state.importLastDispatchAt && consumerRuns.some(r=>
        !state.importKnownRuns?.includes(r.id) && Date.parse(r.createdAt)>=Math.floor(state.importLastDispatchAt/1000)*1000)) {
        state.importSourceRun=state.importPendingSourceRun;
        state.importPendingSourceRun=null;
        await this.storage.transaction(async tx=>{const latest=await tx.get(MF_TIMER);await tx.put(MF_TIMER,{...latest,importSourceRun:state.importSourceRun,importPendingSourceRun:null});});
      }
      const newlyPublished=completedSource&&completedSource.id!==state.importSourceRun;
      if(isInFlight(recent)){reason=at-Date.parse(recent.createdAt)>45*60000?'run-overdue':'running';nextAt=at+60000;}
      else if(!newlyPublished&&at-completedAt(recent)<MF_INTERVAL){reason=recent.conclusion==='success'?'recent-run':'recent-failure';nextAt=Math.min(nextAt,Math.max(at+1000,completedAt(recent)+MF_INTERVAL));}
      else if(at-(state.importLastDispatchAt||0)<90000){reason='awaiting-run';nextAt=Math.min(nextAt,at+60000);}
      else {
        await this.storage.transaction(async tx=>{const latest=await tx.get(MF_TIMER);await tx.put(MF_TIMER,{...latest,importLastDispatchAt:at,importPendingSourceRun:completedSource?.id||null,importKnownRuns:consumerRuns.map(r=>r.id)});});
        const out=await dispatchWorkflow(this.fetcher,cfg,MF_WORKFLOW,'main',{source:'durable-timer'});reason=out.dispatched?'dispatched':at-Date.parse(out.run?.createdAt)>45*60000?'run-overdue':'running';if(out.dispatched&&completedSource)importSourceRun=completedSource.id;
        nextAt=Math.min(nextAt,at+60000);
      }
    } catch(error) {
      // Reconcile an accepted-but-unacknowledged POST promptly after eviction.
      if(error.code==='dispatch-uncertain')nextAt=Math.min(nextAt,at+60000);
      // Persist a failed dispatch, never a source-success timestamp.
    }
    await this.storage.transaction(async tx=>{const state=await tx.get(MF_TIMER);if(state?.lastAttemptAt===at){await tx.put(MF_TIMER,{...state,nextAt,reason,...(source?{source}:{}),...(importSourceRun?{importSourceRun,importPendingSourceRun:null}:{})});await tx.setAlarm(nextAt);}});
  }
}
