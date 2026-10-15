import {githubBackgroundSqlite} from './github-background-sqlite.mjs';
import {BreakoutStore} from '../../worker/breakout-store.mjs';
import {BreakoutPrimary} from '../../worker/breakout-primary.mjs';

export function localBreakouts(file,{env=process.env,now=Date.now,...options}={}) {
  const workflowRun=String(env.GITHUB_RUN_ID||now()),attempt=Number(env.GITHUB_RUN_ATTEMPT||1);
  if(!/^\d+$/.test(workflowRun)||!Number.isSafeInteger(attempt)||attempt<1||attempt>1000)throw Error('Invalid runner identity');
  const local=githubBackgroundSqlite(file),store=new BreakoutStore(local.storage,{now});store.init();
  const stub={
    breakoutPrimaryPrune:()=>store.primaryPrune(),
    breakoutReadFallback:()=>store.readFallback(),
    breakoutPrimarySave:input=>store.primarySave(input),
  };
  // Never use the Cloudflare binding fallback in the original primary class.
  const primary=new BreakoutPrimary(local.storage,env,{...options,now,store:()=>stub});
  let run=null;
  function beginCycle(cycle) {
    if(!Number.isSafeInteger(cycle)||cycle<1||cycle>9999)throw Error('Invalid collection cycle');
    // A long-lived minute runner can perform several fallback captures. Each
    // keeps an independent replay-safe identity under the actual Actions run.
    run=`${workflowRun}:${attempt*10000+cycle}`;return run;
  }
  const client=async input=>{
    const {action}=input;
    if(action==='arm')return {ok:true,schedule:{runtime:'github-actions'}};
    if(action==='inventory')return {ok:true,primary:{...await primary.inventory(input.targets,input.discoveryFailed),runtime:'github-actions'}};
    if(!run)throw Error('A GitHub capture cycle must start before collection');
    if(action==='begin')return store.begin(run,input.targets,input.discoveryFailed);
    if(action==='checkpoint')return store.checkpoint(run,input.rows,input.failures);
    if(action==='recovery')return store.recovery(run,input.ticker,input.from,input.to,input.rows);
    if(action==='finish')return store.finish(run);
    throw Error('Unknown local breakout action');
  };
  return {...local,store,primary,client,beginCycle,workflowRun};
}
