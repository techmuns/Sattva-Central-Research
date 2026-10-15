import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {localBreakouts} from './lib/breakout-local.mjs';
import {preparedBreakoutHistory} from './lib/breakout-prepared-history.mjs';
import {privateRecordViews} from './lib/github-private-records.mjs';
import {packBackgroundViews,installBackgroundViews} from './lib/github-background-package.mjs';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {preparedBreakouts} from '../worker/breakouts-github.mjs';
fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/breakout-history-'));
let at=Date.parse('2026-09-15T06:30:00Z'),local,prepared;
const repo='techmuns/Sattva-Central-Research',feature='breakouts',secret='fixture-reader-key-123456789',env={BACKGROUND_STATE_KEY:'fixture-master-only-123456789'};
const base={high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-09-11'};
const row=(ticker='TEST',price=108)=>({ticker,name:'Fixture',price,volume:2300,prevClose:100,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString(),sessionDate:'2026-09-15',provider:'Upstox',exchange:'NSE',kind:'quote',base});
try {
 local=localBreakouts(path.join(root,'state.sqlite'),{env:{GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1'},now:()=>at});
 for(let cycle=1;cycle<=2;cycle++){local.beginCycle(cycle);await local.client({action:'begin',targets:['TEST']});await local.client({action:'checkpoint',rows:[row()]});await local.client({action:'finish'});}
 local.db.prepare('INSERT INTO breakout_recovered VALUES(?,?,?,?)').run('TEST',at,'1:1',JSON.stringify({...row(),provider:'Yahoo',kind:'recovered'}));
 for(let minute=0;minute<145;minute++){at+=60000;local.store.primarySave({at,completedAt:at,targets:['TEST','OTHER'],rows:[row('TEST',110+minute),row('OTHER',90+minute)],failures:[],discoveryFailed:false});}
 const expectedFirst=local.store.history('TEST'),oldCursor=expectedFirst.nextCursor;assert(oldCursor);
 const keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)},site=path.join(root,'public'),archive=path.join(root,'views.gz');
 async function publish(){prepared?.close();prepared=preparedBreakoutHistory(local,path.join(root,'history.sqlite'),{now:at});await packBackgroundViews(privateRecordViews(prepared.ids,prepared.read,{version:1,repo,feature},{repo,feature,env}),recipient,archive,{repo,feature,sourceSignature:'a'.repeat(64)});await installBackgroundViews(archive,site,{repo,feature,sourceSignature:'a'.repeat(64)});}
 await publish();let reads=0;
 const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,ASSETS:{fetch:async request=>{reads++;const file=path.join(site,new URL(request.url).pathname);return fs.existsSync(file)?new Response(fs.readFileSync(file)):new Response(null,{status:404});}}};
 const read=async(ticker,before)=>{const url=new URL('https://fixture.research/api/breakouts/history');url.searchParams.set('ticker',ticker);if(before)url.searchParams.set('before',before);return preparedBreakouts(new Request(url),worker);};
 for(const ticker of ['TEST','OTHER','UNKNOWN']){let cursor=null;for(let page=0;page<5;page++){const actual=await read(ticker,cursor),expected=local.store.history(ticker,cursor);assert.deepEqual(actual,expected,'Every quote, tie, correction, source label and cursor matches the retained store');if(!actual.nextCursor)break;cursor=actual.nextCursor;}}
 at+=60000;local.store.primarySave({at,completedAt:at,targets:['TEST'],rows:[row('TEST',300)],failures:[],discoveryFailed:false});await publish();assert.deepEqual(await read('TEST',oldCursor),local.store.history('TEST',oldCursor),'A cursor returned before a new capture keeps its exact history meaning');
 at+=5*86400000;local.store.primaryPrune();await publish();assert.deepEqual(await read('TEST'),local.store.history('TEST'),'Four-day minute expiry retains older detected changes and fallback/recovered observations');
 assert(reads>0);console.log('PASS prepared breakout history: exact native-store parity across all pages, tied runs, recovered labels, new-capture cursors, older detected changes and retained fallback history through encrypted static delivery');
}finally{prepared?.close();await local?.close();fs.rmSync(root,{recursive:true,force:true});}
