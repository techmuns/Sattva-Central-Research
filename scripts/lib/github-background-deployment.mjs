import fs from 'node:fs';
import path from 'node:path';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {installBackgroundViews} from './github-background-package.mjs';
import {BACKGROUND_FEATURES,backgroundContract} from '../../worker/github-background-contract.mjs';

export async function preparedBackgroundPlan({env=process.env,fetcher=fetch}={}) {
  const entries=[];
  // Compare only small release metadata here. During a changed deployment the
  // bundle stays in runner scratch; only its encrypted reader files enter ASSETS.
  for(const feature of BACKGROUND_FEATURES) {
    const snapshot=await githubBackgroundRelease(feature,{env,fetcher}).latest();if(!snapshot)continue;
    entries.push(snapshot);
  }
  return entries;
}
export const preparedBackgroundIdentity=entries=>Object.fromEntries(entries.map(entry=>{
  if(!BACKGROUND_FEATURES.includes(entry.feature)||!Number.isSafeInteger(entry.asset?.id)||entry.asset.id<1)throw Error('Invalid prepared generation');
  return [entry.feature,entry.asset.id];
}));
export async function installPreparedBackground(entries,{env=process.env,fetcher=fetch,publicRoot=path.resolve('public'),scratch=path.resolve('.cache/prepared-deployment')}={}) {
  const seen=new Set();fs.mkdirSync(scratch,{recursive:true});
  for(const entry of entries) {
    if(!BACKGROUND_FEATURES.includes(entry.feature)||seen.has(entry.feature))throw Error('Invalid prepared deployment plan');
    seen.add(entry.feature);
    const transport=githubBackgroundRelease(entry.feature,{env,fetcher});
    if(entry.repo!==transport.repo)throw Error('Prepared data belongs to another repository');
    const file=path.join(scratch,entry.feature+'.json.gz');
    const sourceSignature=await backgroundContract(entry.feature);
    await transport.download(entry,'views',file,{sourceSignature});
    await installBackgroundViews(file,publicRoot,{repo:transport.repo,feature:entry.feature,sourceSignature});
    fs.rmSync(file,{force:true});
  }
}
