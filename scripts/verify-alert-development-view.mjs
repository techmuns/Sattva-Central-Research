import {matchKeywords} from '../public/js/data/news-keywords.js';
import assert from 'node:assert/strict';
import {createStoryGrouping} from '../public/js/data/alert-stories.js';
import {storyRecord,sameDevelopmentSafe} from '../public/js/data/alert-stories-shared.js';
import {membersOf,developmentOfRow,developmentLine,developmentSearchText} from '../public/js/data/alert-developments.js';
const now=Date.parse('2026-09-24T12:00:00Z');
const row=(id,feed,headline,extra={})=>({id,feed,feedLabel:feed,ticker:'ALPHA',company:'Alpha Bank',day:'2026-09-23',time:'10:00',headline,
 url:`https://example.test/${id}`,importance:'high',direction:'neutral',...extra});
const headline='Alpha Bank proposes merger with Beta Bank';
const news=row('news','news',headline,{attribution:{status:'confirmed'}});
const filing=row('filing','announcements',headline,{time:'11:00',filingSubject:'Press Release'});
const first=row('one','announcements','Acquisition (including agreement to acquire)',{filingDescription:'Alpha Bank has informed the Exchange regarding Acquisition (including agreement to acquire)'});
const second={...first,id:'two',url:'https://example.test/another-filing'};
assert.equal(sameDevelopmentSafe(storyRecord(first),storyRecord(second)),false,'two generic but distinct transaction documents cannot be copies');
const store={};
const group=createStoryGrouping({now:()=>now,read:async()=>store.saved,write:async(_k,v)=>{store.saved=v;},fetcher:async(_url,init)=>{
 const reports=JSON.parse(init.body).reports;
 return Response.json({ok:true,stories:[{developments:[{reports:reports.map(r=>r.id),change:'new'}]}]});
}});
assert.equal(group.project([first,second]).length,2,'offline exact-text fallback preserves distinct filings');
await group.review([news,filing]);
const projected=group.project([news,filing]);
assert.equal(projected.length,1);
assert.equal(projected[0].feed,'announcements','a checked filing leads the presentation');
assert.equal(projected[0].time,'10:00','choosing a later filing never advances first publication');
assert.deepEqual(membersOf(projected[0]).map(r=>r.id).sort(),['filing','news']);
assert.ok(developmentLine(developmentOfRow(projected[0])).includes('proposes merger'));
assert.ok(developmentSearchText(developmentOfRow(projected[0])).includes(news.url));
const restarted=createStoryGrouping({now:()=>now,read:async()=>store.saved,write:async()=>{},fetcher:()=>{throw Error('saved decisions need no new request');}});
await restarted.load();
assert.equal(restarted.project([news,filing])[0].developmentId,projected[0].developmentId);
assert.deepEqual([news,filing].map(r=>Object.hasOwn(r,'storyId')),[false,false],'presentation does not mutate sources');
console.log('PASS: distinct filing identity, one semantic authority, exchange-first presentation, unchanged first date, original search/export members and durable IDs');

for(const title of ['Praj order intake rises','GRSE order pipeline','Triveni order bookings']) assert.ok(matchKeywords(title).some(k=>k.id==='orderbook'));
for(const title of ['in order to expand','court order','bookings for a hotel']) assert.ok(!matchKeywords(title).some(k=>k.id==='orderbook'));
for(const title of ['CEO steps down','Chairman to step down next month','CFO stepped down']) assert.ok(matchKeywords(title).some(k=>k.id==='resignation'));
for(const title of ['Eclerx Services Buys Approx. 2% Equity In Step Down Subsidiary For $1.6 Million','merger of step-down subsidiaries']) assert.ok(!matchKeywords(title).some(k=>k.id==='resignation'),'a step-down subsidiary is a company tier, not a departure');

const many=Array.from({length:3000},(_,i)=>({...news,id:`n${i}`,url:`https://example.test/n${i}`}));
let yielded=0;
assert.deepEqual(await group.projectAsync(many,{sliceMs:0,yieldForInput:async()=>{yielded++;}}),group.project(many));
assert.ok(yielded>1,'large projections yield between units of work');
assert.equal(await group.projectAsync(many,{sliceMs:0,isCurrent:()=>false}),undefined,'abandoned presentation does not publish');
