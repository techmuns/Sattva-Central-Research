import {readBackgroundView} from './github-background-views.mjs';
import {readPrivateRecord} from './github-private-records.mjs';
import {mfRepo} from './mutual-funds-github.mjs';
import {marketWindow,expectedSession} from '../public/js/data/breakout-live-shared.js';
import {PRICE_LEVELS_HIT_WIRE} from '../public/js/data/price-levels-shared.js';
const older=(hit,cursor)=>!cursor||hit.reachedAt<cursor[0]||hit.reachedAt===cursor[0]&&hit.id<cursor[1];
// Called only after service authentication. Immediate edits own the current
// levels; only an identical value AND set time may inherit a prepared hit.
export async function preparedPriceLevels(request,env,source,{now=Date.now()}={}){
 const head=await readBackgroundView(env,request.url,'price-levels','head.json');if(!head)return source;
 if(head.version!==1||head.repo!==mfRepo(env)||head.feature!=='price-levels'||!head.snapshot||!Array.isArray(head.pages))throw Error('Invalid prepared price-level inventory');
 const saved=head.snapshot,known=new Map(saved.companies.map(row=>[row.ticker,row]));
 const companies=source.companies.map(company=>({...company,levels:Object.fromEntries(Object.entries(company.levels).map(([kind,level])=>{
  const savedCompany=known.get(company.ticker),prior=savedCompany?.isin===company.isin?savedCompany.levels[kind]:null;return [kind,level&&prior?.value===level.value&&prior.setAt===level.setAt?{...level,reached:prior.reached||level.reached}:level];
 }))}));
 const pending=companies.reduce((sum,row)=>sum+Object.values(row.levels).filter(level=>level&&!level.reached).length,0);
 let cursor=null;const raw=new URL(request.url).searchParams.get('cursor');if(raw){try{cursor=JSON.parse(raw);}catch{throw Error('Invalid price level cursor');}if(!Array.isArray(cursor)||cursor.length!==2||!cursor.every(value=>typeof value==='string'&&value.length<=300))throw Error('Invalid price level cursor');}
 const found=[],memo=new Map();
 for(const page of head.pages){if(cursor&&(page.last[0]>cursor[0]||page.last[0]===cursor[0]&&page.last[1]>=cursor[1]))continue;const value=await readPrivateRecord(env,request.url,'price-levels',head,page.id,{memo});if(!Array.isArray(value?.hits))throw Error('Prepared hit page missing');for(const hit of value.hits)if(older(hit,cursor)){found.push(hit);if(found.length>PRICE_LEVELS_HIT_WIRE)break;}if(found.length>PRICE_LEVELS_HIT_WIRE)break;}
 const hits=found.slice(0,PRICE_LEVELS_HIT_WIRE),last=hits.at(-1),check={...saved.check,runtime:'github-actions',nextAt:null};
 const mismatched=head.inputRevision!==source.revision,late=marketWindow(now).collect&&(!check.lastAttemptAt||now-Date.parse(check.lastAttemptAt)>3*60000);
 if(pending&&(mismatched||late||check.session!==expectedSession(now))){check.current=false;check.state=mismatched?'waiting':late?'overdue':check.state;check.failed=late||check.failed;}
 if(!pending){check.current=true;check.state='idle';check.failed=false;}
 return {...source,revision:source.revision+saved.revision,updatedAt:[source.updatedAt,saved.updatedAt].filter(Boolean).sort().at(-1)||null,companies,pending,hits,retainedHits:saved.retainedHits,firstHitAt:saved.firstHitAt,nextCursor:found.length>PRICE_LEVELS_HIT_WIRE?JSON.stringify([last.reachedAt,last.id]):null,check,runtime:'github-actions',delivery:'static-assets'};
}
