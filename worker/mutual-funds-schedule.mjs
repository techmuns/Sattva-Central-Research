import { dispatchWorkflow, latestRun, isInFlight } from './github-actions.mjs';
import { MF_INTERVAL, MF_WORKFLOW } from './mutual-funds-model.mjs';
export const MF_TIMER='mutual-funds-timer';
export class MutualFundsSchedule {
  constructor(storage,env,{now=Date.now,fetcher=fetch}={}) {Object.assign(this,{storage,env,now,fetcher});}
  async status() { const state=await this.storage.get(MF_TIMER)||{};const alarmAt=await this.storage.getAlarm();return {...state,alarmAt,overdue:state.started && (!alarmAt||this.now()>state.nextAt+120000)}; }
  async arm() {await this.storage.transaction(async tx=>{const state=await tx.get(MF_TIMER);if(!state)await tx.put(MF_TIMER,{started:true,nextAt:this.now()+1000});if(await tx.getAlarm()===null)await tx.setAlarm(Math.max(this.now()+1000,state?.nextAt||0));});return this.status();}
  async wake() {
    const at=this.now();
    const claimed=await this.storage.transaction(async tx=>{const state=await tx.get(MF_TIMER)||{};if(state.lastAttemptAt&&state.nextAt>at){await tx.setAlarm(state.nextAt);return false;}await tx.put(MF_TIMER,{...state,started:true,lastAttemptAt:at,nextAt:at+MF_INTERVAL});await tx.setAlarm(at+MF_INTERVAL);return true;});
    if(!claimed)return;
    let reason='dispatch-unavailable',nextAt=at+MF_INTERVAL;
    try {
      if(!this.env.GH_DISPATCH_TOKEN || this.env.GH_REPO!=='techmuns/Sattva-Central-Research')throw Error('Configuration');
      const cfg={token:this.env.GH_DISPATCH_TOKEN,owner:'techmuns',repo:'Sattva-Central-Research',ref:'main'};
      const recent=(await latestRun(this.fetcher,cfg,MF_WORKFLOW,{perPage:10})).find(r=>r.event!=='push');
      if(isInFlight(recent)){reason=at-Date.parse(recent.createdAt)>45*60000?'run-overdue':'running';nextAt=at+60000;}
      else if(at-Date.parse(recent?.createdAt)<MF_INTERVAL){reason=recent.conclusion==='success'?'recent-run':'recent-failure';nextAt=Math.max(at+1000,Date.parse(recent.createdAt)+MF_INTERVAL);}
      else {const out=await dispatchWorkflow(this.fetcher,cfg,MF_WORKFLOW,'main',{source:'durable-timer'});reason=out.dispatched?'dispatched':'running';}
    } catch { /* Persist a failed dispatch, never a source-success timestamp. */ }
    await this.storage.transaction(async tx=>{const state=await tx.get(MF_TIMER);if(state?.lastAttemptAt===at){await tx.put(MF_TIMER,{...state,nextAt,reason});await tx.setAlarm(nextAt);}});
  }
}
