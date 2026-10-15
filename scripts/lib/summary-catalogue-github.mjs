import {latestRun,isInFlight,dispatchWorkflow} from '../../worker/github-actions.mjs';
import {SCREENER_CONCALL_WORKFLOW,SCREENER_CONCALL_FRESH_MS} from '../../public/js/data/screener-concalls-shared.js';
import {mfRepo} from '../../worker/mutual-funds-github.mjs';

// Preserve the existing half-freshness dispatch window and durable dispatch claim.
// The runner waits for a fresh document checkpoint before any premium source I/O.
export async function ensureSummaryCatalogue(local,{env=process.env,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms)),maxWait=45*60000}={}) {
  const repo=mfRepo({GH_REPO:env.GITHUB_REPOSITORY}),[owner,name]=repo.split('/'),cfg={owner,repo:name,ref:'main',token:env.GITHUB_TOKEN},deadline=now()+maxWait;
  for(;;) {
    const recent=(await latestRun(fetcher,cfg,SCREENER_CONCALL_WORKFLOW,{perPage:1}))[0],started=Date.parse(recent?.createdAt),at=now();
    if(recent&&!Number.isFinite(started))throw Error('Catalogue run time unavailable');
    if(recent&&!isInFlight(recent)&&started>at-SCREENER_CONCALL_FRESH_MS/2)return;
    if(isInFlight(recent)&&at-started>45*60000)throw Error('Catalogue run is overdue');
    if(!isInFlight(recent)) {
      const state=await local.storage.get('summary-timer')||{};
      if(!(state.catalogueRequestedAt>at-SCREENER_CONCALL_FRESH_MS/2)) {
        await local.storage.put('summary-timer',{...state,catalogueRequestedAt:at});
        await local.publish();
        await dispatchWorkflow(fetcher,cfg,SCREENER_CONCALL_WORKFLOW,'main',{source:'github-summary',full:'false'});
      }
    }
    if(at>=deadline)throw Error('Fresh catalogue unavailable within the runner window');
    await sleep(Math.min(2*60000,deadline-at));
  }
}
