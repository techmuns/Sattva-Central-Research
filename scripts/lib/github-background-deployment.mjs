import fs from 'node:fs';
import path from 'node:path';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {installBackgroundViews} from './github-background-package.mjs';
import {BACKGROUND_FEATURES,backgroundContract} from '../../worker/github-background-contract.mjs';
import {privateMarketRelease,installPrivateMarket,PRIVATE_MARKET_FEATURE,fundingAssetPattern} from './private-market-release.mjs';
import {recommendationPublication,installRecommendations,RECOMMENDATION_FEATURE,recommendationAsset} from './recommendation-publication.mjs';

export async function preparedBackgroundPlan({env=process.env,fetcher=fetch}={}) {
  const entries=[];
  // Compare only small release metadata here. During a changed deployment the
  // bundle stays in runner scratch; only its encrypted reader files enter ASSETS.
  for(const feature of BACKGROUND_FEATURES) {
    const snapshot=await githubBackgroundRelease(feature,{env,fetcher}).latest();if(!snapshot)continue;
    entries.push(snapshot);
  }
  const funding=await privateMarketRelease({env,fetcher}).latest();if(funding)entries.push(funding);
  const recommendations=await recommendationPublication({env,fetcher}).latest();if(recommendations)entries.push(recommendations);
  return entries;
}
export const preparedBackgroundIdentity=entries=>Object.fromEntries(entries.map(entry=>{
  if(entry.feature===RECOMMENDATION_FEATURE){if(!recommendationAsset.test(entry.asset?.name||''))throw Error('Invalid recommendation generation');return [entry.feature,entry.asset.id];}
  if(entry.feature===PRIVATE_MARKET_FEATURE){if(!fundingAssetPattern.test(entry.asset?.name||''))throw Error('Invalid prepared funding generation');return [entry.feature,entry.asset.name];}
  if(![...BACKGROUND_FEATURES,PRIVATE_MARKET_FEATURE].includes(entry.feature)||!Number.isSafeInteger(entry.asset?.id)||entry.asset.id<1)throw Error('Invalid prepared generation');
  return [entry.feature,entry.asset.id];
}));
export async function installPreparedBackground(entries,{env=process.env,fetcher=fetch,publicRoot=path.resolve('public'),scratch=path.resolve('.cache/prepared-deployment')}={}) {
  const seen=new Set();fs.mkdirSync(scratch,{recursive:true});
  for(const entry of entries) {
    if(entry.feature===RECOMMENDATION_FEATURE){if(seen.has(entry.feature))throw Error('Duplicate recommendation generation');seen.add(entry.feature);await installRecommendations(entry,{env,fetcher,publicRoot});continue;}
    if(entry.feature===PRIVATE_MARKET_FEATURE){if(seen.has(entry.feature))throw Error('Duplicate funding generation');seen.add(entry.feature);await installPrivateMarket(entry,{env,fetcher,publicRoot});continue;}
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
