import { dispatchWorkflow, isInFlight, latestRun, TELEGRAM_WORKFLOW } from './github-actions.mjs';

export const TELEGRAM_INTERVAL_MS = 10 * 60 * 1000;
export const TELEGRAM_RUN_OVERDUE_MS = 30 * 60 * 1000;
export const TELEGRAM_SCHEDULER_NAME = 'researchreportss-main-v1';
export const TELEGRAM_PRODUCTION_HOST = 'sattva-central-research.tech-441.workers.dev';
const REPO = 'techmuns/Sattva-Central-Research';
const REASONS = new Set(['unauthorised','forbidden','rate-limited','refused','not-found','invalid-runs','unreachable']);
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;

// GitHub owns the recurring schedule and source safety checkpoints. The unused
// storage argument preserves old RPC construction without reading or writing it.
export class TelegramSchedule {
  constructor(_storage, env, { fetcher=fetch, now=Date.now }={}) {Object.assign(this,{env,fetcher,now});}
  config() {
    if(this.env.GH_REPO!==REPO||(this.env.GH_REF||'main')!=='main'||!this.env.GH_DISPATCH_TOKEN)throw Error('configuration');
    return {token:this.env.GH_DISPATCH_TOKEN,owner:'techmuns',repo:'Sattva-Central-Research',ref:'main',now:this.now};
  }
  disabled() {return this.env.TELEGRAM_SCHEDULER_DISABLED==='true';}
  async status() {
    const base={runtime:'github-actions',enabled:!this.disabled(),intervalSeconds:TELEGRAM_INTERVAL_MS/1000,
      alarmAt:null,nextAttemptAt:null,lastAttemptAt:null,lastResult:'not-started',reason:null,failures:0,activeRun:null,runOverdue:false};
    if(this.disabled())return {...base,lastResult:'disabled',reason:'operator-disabled'};
    try {
      const recent=(await latestRun(this.fetcher,this.config(),TELEGRAM_WORKFLOW,{perPage:1}))[0];
      if(!recent)return base;
      const active=isInFlight(recent),at=Date.parse(recent.createdAt),runOverdue=active&&Number.isFinite(at)&&this.now()-at>TELEGRAM_RUN_OVERDUE_MS;
      return {...base,lastAttemptAt:iso(at),lastResult:runOverdue?'blocked':active?'running':recent.conclusion==='success'?'recent-run':'recent-run-failed',
        reason:runOverdue?'run-overdue':!active&&recent.conclusion!=='success'?'latest-run-failed':null,
        activeRun:active?{id:recent.id,status:recent.status,createdAt:recent.createdAt}:null,runOverdue};
    }catch(error){return {...base,enabled:error.message==='configuration'?false:base.enabled,lastResult:'failed',reason:error.message==='configuration'?'configuration':REASONS.has(error.code)?error.code:'upstream'};}
  }
  async request(source='auto') {
    if(this.disabled())return {ok:false,dispatched:false,reason:'operator-disabled'};
    source=['cron','auto','button'].includes(source)?source:'button';
    try {
      const cfg=this.config(),at=this.now(),recent=(await latestRun(this.fetcher,cfg,TELEGRAM_WORKFLOW,{perPage:1}))[0];
      const started=Date.parse(recent?.createdAt);
      if(Number.isFinite(started)&&started>at-TELEGRAM_INTERVAL_MS&&started<=at+60000) {
        const failed=recent.status==='completed'&&recent.conclusion!=='success';
        return {ok:!failed,dispatched:false,reason:failed?'latest-run-failed':'cooling-down',run:recent,cooldownS:TELEGRAM_INTERVAL_MS/1000};
      }
      const out=await dispatchWorkflow(this.fetcher,cfg,TELEGRAM_WORKFLOW,'main',{source},{recoverTelegramQueues:true});
      const overdue=isInFlight(out.run)&&Number.isFinite(Date.parse(out.run.createdAt))&&at-Date.parse(out.run.createdAt)>TELEGRAM_RUN_OVERDUE_MS;
      return {ok:!overdue,dispatched:out.dispatched,reason:overdue?'run-overdue':out.dispatched?'dispatched':'already-running',run:out.run,
        workflow:TELEGRAM_WORKFLOW,source,requestedAt:iso(at)};
    }catch(error){return {ok:false,dispatched:false,reason:error.message==='configuration'?'configuration':REASONS.has(error.code)?error.code:'upstream',message:'Telegram collection could not be started. The next GitHub schedule will check again.'};}
  }
}
