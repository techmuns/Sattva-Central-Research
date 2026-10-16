import fs from 'node:fs';
import path from 'node:path';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {openBackgroundState,sealBackgroundState} from './github-background-seal.mjs';
import {packBackgroundViews} from './github-background-package.mjs';
import {backgroundContract} from '../../worker/github-background-contract.mjs';
import {privateRecordViews} from './github-private-records.mjs';
import {localSummaries} from './summaries-local.mjs';
import {copyBackgroundStore} from './github-background-restore.mjs';
import {SUMMARY_TABLES,SUMMARY_KEYS} from '../../worker/summaries-export.mjs';
import {summaryRefreshPlan} from './summary-refresh-plan.mjs';

export async function githubSummaries({env=process.env,fetcher=fetch,legacyClient,recipient,now=Date.now,file=path.resolve('.cache/summaries/state.sqlite'),out=path.resolve('.cache/summaries/publication'),transportOptions={}}={}) {
  const transport=githubBackgroundRelease('summaries',{env,fetcher,...transportOptions}),signature=await backgroundContract('summaries');
  let cycle=0,local;
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(out,{recursive:true});
  const snapshot=await transport.latest();
  // Prepare and source collection are separate processes in the same workflow run.
  // Continue its acknowledged generation rather than reusing an immutable asset name.
  const previousCycle=new RegExp(`^su-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT||1}-(\\d+)-bundle\\.bin$`).exec(snapshot?.asset?.name||'');
  if(previousCycle)cycle=Number(previousCycle[1]);
  if(snapshot) {
    const sealed=file+'.sealed';
    try{await transport.download(snapshot,'state',sealed,{sourceSignature:signature});await openBackgroundState(sealed,file,'summaries',{env});}
    finally{fs.rmSync(sealed,{force:true});}
  }else if(fs.existsSync(file))throw Error('Unverified local summary state cannot become a migration source');
  async function checkpoint() {
    const backup=path.join(out,'checkpoint.sqlite'),state=path.join(out,'state.bin'),views=path.join(out,'views.gz');
    fs.rmSync(backup,{force:true});await local.checkpoint(backup);await sealBackgroundState(backup,state,'summaries',{env});
    const status=local.store.status(),at=now();
    const schedule={runtime:'github-actions',started:true,lastAttemptAt:at,publishedAt:at,workflowRun:env.GITHUB_RUN_ID,
      nextCheckAt:summaryRefreshPlan(status,{now:at}).nextCheckAt,recovery:true};
    const ids=local.db.prepare('SELECT id FROM summary_records ORDER BY id').all().map(row=>row.id);
    const entries=privateRecordViews(ids,id=>local.store.read([id])[0],{version:1,repo:transport.repo,feature:'summaries',createdAt:new Date(at).toISOString(),state:{...status,schedule}},{repo:transport.repo,feature:'summaries',env});
    await packBackgroundViews(entries,recipient,views,{repo:transport.repo,feature:'summaries',sourceSignature:signature});
    return transport.publish({cycle:++cycle,state,views,sourceSignature:signature});
  }
  local=localSummaries(file,{env,checkpoint,now});
  try {
    if(!snapshot) {
      if(typeof legacyClient!=='function')throw Error('Retained summary source unavailable');
      const source=await legacyClient({action:'export'});
      if(source?.ok!==true||!Array.isArray(source.tables))throw Error('Retained summary inventory unavailable');
      const inventory=source.tables.length?await copyBackgroundStore(local,legacyClient,{tables:SUMMARY_TABLES,keys:SUMMARY_KEYS,onProgress:progress=>console.log('Retained summary transfer:',JSON.stringify(progress))}):source;
      if(!source.tables.length&&JSON.stringify(await legacyClient({action:'export'}))!==JSON.stringify(source))throw Error('Unused summary source changed during import');
      console.log('Verified retained private summary transfer:',JSON.stringify(inventory.tables));
      await checkpoint();
    }
    if(local.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Retained summary database invalid');
    return {...local,publish:checkpoint};
  }catch(error){await local.close();throw error;}
}
