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

export async function githubSummaries({env=process.env,fetcher=fetch,legacyClient,recipient,file=path.resolve('.cache/summaries/state.sqlite'),out=path.resolve('.cache/summaries/publication'),transportOptions={}}={}) {
  const transport=githubBackgroundRelease('summaries',{env,fetcher,...transportOptions}),signature=await backgroundContract('summaries');
  let cycle=0,local;
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(out,{recursive:true});
  const snapshot=await transport.latest();
  if(snapshot) {
    const sealed=file+'.sealed';
    try{await transport.download(snapshot,'state',sealed,{sourceSignature:signature});await openBackgroundState(sealed,file,'summaries',{env});}
    finally{fs.rmSync(sealed,{force:true});}
  }else if(fs.existsSync(file))throw Error('Unverified local summary state cannot become a migration source');
  async function checkpoint() {
    const backup=path.join(out,'checkpoint.sqlite'),state=path.join(out,'state.bin'),views=path.join(out,'views.gz');
    fs.rmSync(backup,{force:true});await local.checkpoint(backup);await sealBackgroundState(backup,state,'summaries',{env});
    const status=local.store.status(),at=Date.now();
    const schedule={runtime:'github-actions',started:true,lastAttemptAt:at,publishedAt:at,workflowRun:env.GITHUB_RUN_ID};
    const ids=local.db.prepare('SELECT id FROM summary_records ORDER BY id').all().map(row=>row.id);
    const entries=privateRecordViews(ids,id=>local.store.read([id])[0],{version:1,repo:transport.repo,feature:'summaries',createdAt:new Date(at).toISOString(),state:{...status,schedule}},{repo:transport.repo,feature:'summaries',env});
    await packBackgroundViews(entries,recipient,views,{repo:transport.repo,feature:'summaries',sourceSignature:signature});
    return transport.publish({cycle:++cycle,state,views,sourceSignature:signature});
  }
  local=localSummaries(file,{env,checkpoint});
  try {
    if(!snapshot) {
      if(typeof legacyClient!=='function')throw Error('Retained summary source unavailable');
      const inventory=await copyBackgroundStore(local,legacyClient,{tables:SUMMARY_TABLES,keys:SUMMARY_KEYS,onProgress:progress=>console.log('Retained summary transfer:',JSON.stringify(progress))});
      console.log('Verified retained private summary transfer:',JSON.stringify(inventory.tables));
      await checkpoint();
    }
    if(local.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Retained summary database invalid');
    return {...local,publish:checkpoint};
  }catch(error){await local.close();throw error;}
}
