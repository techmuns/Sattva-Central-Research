import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {recommendationPublication,installRecommendations} from './lib/recommendation-publication.mjs';
import {preparedBackgroundIdentity} from './lib/github-background-deployment.mjs';
import {createRecommendationFeed} from '../public/js/data/ai-recommendations.js';
import {TAB_META} from '../public/js/tabs/catalog.js';
import {researchTabs} from '../public/js/tabs/registry.js';

const repo='techmuns/Sattva-Central-Research',env={GITHUB_REPOSITORY:repo,GITHUB_TOKEN:'fixture'};
const row={id:'one',isin:'INE372C01037',ticker:'PRECWIRE',company:'Fixture only',catalyst:'Verified fixture catalyst',price:'125.50',priceAsOf:'2026-10-19'};
const value={version:1,stage:'research-candidates',repository:repo,sourceRun:'42',sourceSha:'a'.repeat(40),foundationAsset:{id:50,name:'foundation-42-1-'+ 'b'.repeat(64)+'.sqlite.gz'},generatedAt:'2026-10-21T13:00:00Z',rows:[row],rowCount:1};
const body=Buffer.from(JSON.stringify(value)),hash=createHash('sha256').update(body).digest('hex');
const name=`recommendations-42-1-${hash}.json`,tag='recommendation-foundation-2026-10';
const asset={id:51,name,size:body.length,state:'uploaded',browser_download_url:`https://github.com/${repo}/releases/download/${tag}/${name}`};
let corrupt=false,inventoryIncomplete=false;
const fetcher=async url=>{
  if(url===asset.browser_download_url)return new Response(corrupt?Buffer.concat([body,Buffer.from(' ')]):body);
  if(url.includes('/releases/1/assets'))return Response.json(inventoryIncomplete?Array.from({length:100},()=>asset):[asset]);
  if(url.includes('/releases?'))return Response.json([{id:1,tag_name:tag,draft:false}]);
  throw Error('Unexpected egress '+url);
};
const transport=recommendationPublication({env,fetcher});
const entry=await transport.latest();assert.equal(entry.asset.id,51);assert.deepEqual(await transport.download(entry),value);
assert.deepEqual(preparedBackgroundIdentity([entry]),{recommendations:51});
const folder=path.resolve('.cache/recommendation-reader-tests');fs.mkdirSync(folder,{recursive:true});
await installRecommendations(entry,{env,fetcher,publicRoot:folder});
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'data/ai-recommendations.json'),'utf8')),value);
corrupt=true;await assert.rejects(transport.download(entry),/integrity/);corrupt=false;
await assert.rejects(transport.download({...entry,repo:'other/Repo'}),/destination/);
inventoryIncomplete=true;await assert.rejects(transport.latest(),/inventory incomplete/);inventoryIncomplete=false;

let network=value,fail=false,saved=null;
const feed=createRecommendationFeed({now:()=>Date.parse('2026-10-21T15:00:00Z'),readSaved:async()=>saved,save:async v=>{saved={value:v};},fetcher:async()=>{
  if(fail)throw Error('Fixture outage');return Response.json(network,{headers:{etag:'fixture'}});
}});
await feed.refresh();assert.equal(feed.rows().length,1);assert.equal(feed.meta().stale,false);
fail=true;await feed.refresh();assert.equal(feed.rows().length,1);assert.match(feed.meta().error,/outage/);
const returning=createRecommendationFeed({readSaved:async()=>saved,save:async()=>{},fetcher:async()=>{throw Error('Offline');}});
await returning.load();await returning.refresh();assert.equal(returning.rows()[0].id,'one');assert.match(returning.meta().error,/Offline/);
fail=false;network={...value,generatedAt:'2026-10-20T13:00:00Z',rows:[],rowCount:0};await feed.refresh();assert.equal(feed.rows().length,1);assert.match(feed.meta().error,/Older/);
network={...value,generatedAt:'2026-10-21T16:00:00Z',rows:[],rowCount:0};await feed.refresh();assert.equal(feed.rows().length,0,'A verified withdrawal is a real empty list');
assert.deepEqual(researchTabs.filter(t=>t.meta.navigationGroup==='alerts').map(t=>t.meta.id),['ai-alerts','ai-recommendations','daily-alerts']);
assert.equal(TAB_META['ai-recommendations'].title,'AI Recommendations');
console.log('PASS public recommendation integrity, retained failure/reload data, withdrawals, stale rejection and tab placement');
