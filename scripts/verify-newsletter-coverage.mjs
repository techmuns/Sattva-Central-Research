// Regressions for actual omissions: sharded archive records, partial reads, per-company/edition
// caps, long-lag arrivals and a morning job that starts after the next market has opened.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildBrief,briefStories,briefSummary,readNews,readSessionQuotes} from '../worker/newsletter-brief.mjs';
import {renderBriefEmails} from '../worker/newsletter-email.mjs';
import {newsletterRows} from '../worker/newsletter-sources.mjs';
import {tradingViewTargets} from './lib/tradingview-news.mjs';

const now=Date.parse('2026-10-21T04:22:31Z'),from=Date.parse('2026-10-20T10:30:00Z'),to=Date.parse('2026-10-21T02:30:00Z');
const holdings=[{ticker:'ALPHA',name:'Alpha Solar',isin:'INE000000001'}];
const entity={entityId:'isin:INE000000001',key:'ALPHA',ticker:'ALPHA',name:'Alpha Solar',legalName:'Alpha Solar',queries:['Alpha Solar']};
const articles=Array.from({length:95},(_,i)=>({entityId:entity.entityId,ticker:'ALPHA',company:'Alpha Solar',
 title:`Alpha Solar contract ${i} worth ${i+100} crore`,source:'Fixture Publisher',url:`https://publisher.test/company/${i}`,
 publishedAt:i===94?'2026-10-15T12:00:00Z':'2026-10-20T12:00:00Z'}));
const part=JSON.stringify({items:articles}),sha=createHash('sha256').update(part).digest('hex');
const files=new Map([
 ['/data/portfolio-companies.json',{holdings}],
 ['/data/market-news.json',{articles:[],capturedAt:'2026-10-21T02:00:00Z'}],
 ['/data/market-news/2026-10.json',{articles:[{title:'Alpha Solar publisher-only retained report',source:'Publisher',url:'https://publisher.test/older-head',publishedAt:'2026-10-20T11:00:00Z'}]}],
 ['/data/company-news/index.json',{entities:[entity],updatedAt:'2026-10-21T02:00:00Z',queries:{[entity.entityId]:{'Alpha Solar':{lastSuccessAt:'2026-10-21T02:00:00Z'}}}}],
 ['/data/company-news/2026-10.json',{articles:[],_jsonShards:{version:1,field:'articles',rows:95,parts:[{file:`2026-10.parts/${sha}.json`,sha256:sha,bytes:Buffer.byteLength(part),rows:95}]}}],
 [`/data/company-news/2026-10.parts/${sha}.json`,part],
 ['/data/tradingview-news/latest.json',{byTicker:{},entities:[entity],capturedAt:'2026-10-21T02:00:00Z',tradingViewCoverage:{staleOrFailedSymbols:1,unresolvedCompanies:0,possibleGapSymbols:1}}],
 ['/data/tradingview-news/2026-10.json',{articles:[]}],
 ['/data/corp-announcements.json',{capturedAt:'2026-10-21T02:00:00Z',byTicker:{ALPHA:Array.from({length:85},(_,i)=>({newsId:`filing${i}`,date:'2026-10-20',time:'18:00',headline:`Alpha Solar award ${i}`,category:'Company Update',subCategory:'General',url:`https://filings.test/${i}`}))}}],
 ['/data/technicals.json',{price_date:'2026-10-19',generated_at:'2026-10-19T15:00:00Z',rows:[{ticker:'ALPHA',bar_date:'2026-10-19',cmp:110,pct_change_today:10}]}],
]);
const env={ASSETS:{fetch:async request=>{const value=files.get(new URL(request.url).pathname);return value===undefined?new Response(null,{status:404}):typeof value==='string'?new Response(value):Response.json(value);}}};
const common={env,holdings,window:{from,to},reported:{empty:false,since:Date.parse('2026-10-01T00:00:00Z'),has:()=>false}};
const quotes=await readSessionQuotes({env,holdings,now,edition:'morning'});
assert.equal(quotes.session,'2026-10-19','Dussehra and a late start must not turn an unfinished 21 October session into a completed session');
assert.equal(quotes.state,'daily');assert.equal(quotes.rows[0].last,110);
const captureEnv={...env,ASSETS:{fetch:async()=>new Response(null,{status:404})},NEWSLETTER_QUOTES:{read:async()=>({rows:[{ticker:'ALPHA',price:110,prevClose:100,sessionDate:'2026-10-19',quoteAt:'2026-10-19T10:29:00Z',checkedAt:'2026-10-19T10:31:00Z'}]})}};
assert.equal((await readSessionQuotes({env:captureEnv,holdings,now,edition:'morning'})).state,'capture','Closing-quote fallback uses the edition session even after the next open');
const news=await readNews({...common,uncapped:true});
assert.equal(news.count,95,'94 new company articles and the publisher archive row survive a failed TradingView symbol');
assert.equal(news.more,0);assert.equal(news.tradingview.partial,true);assert.equal(news.company.ok,true);
const brief=await buildBrief({edition:'morning',day:'2026-10-21',settings:{morning:{time:'08:00'},evening:{time:'16:00'}},env,now,reported:common.reported,includeAi:false,fetcher:async()=>{throw Error('offline fixture')}});
assert.equal(brief.announcements.count,85);assert.equal(brief.announcements.more,0,'No 80-filing or eight-per-company cap');
assert.equal(brief.news.count,96,'A late source arrival older than two windows is included within the retained ledger interval');
assert.equal(brief.news.more,0);assert.equal(briefSummary(brief).eligibility.omittedByCaps,0);
const messages=renderBriefEmails(brief),keys=new Set(messages.flatMap(m=>m.keys));
for(const item of briefStories(brief))assert(item.keys.every(key=>keys.has(key)),'Every eligible source identity survives grouping and multipart rendering');
assert(messages.length>1);assert(messages.every(m=>m.bytes<=90000));
const old=files.get(`/data/company-news/2026-10.parts/${sha}.json`);
files.set(`/data/company-news/2026-10.parts/${sha}.json`,old.replace('Alpha Solar','Other Solar'));
assert.equal((await newsletterRows(env,'/data/company-news/2026-10.json')).ok,false,'A corrupt transport part cannot become an empty successful capture');
const partial=await readNews({...common,uncapped:true});assert.equal(partial.company.ok,false);assert.equal(partial.count,1,'A failed company archive retains independent publisher evidence');
files.set(`/data/company-news/2026-10.parts/${sha}.json`,old);
const bajaj=tradingViewTargets([{entityId:'isin:INE917I01010',ticker:'BAJAJ-AUTO',name:'Bajaj Auto'}],[{isin:'INE917I01010',ticker:'BAJAJ-AUTO',bseSymbol:'BAJAJ-AUTO'}]);
assert.deepEqual(bajaj[0].symbols,['NSE:BAJAJ_AUTO','BSE:BAJAJ_AUTO']);
console.log(`PASS newsletter coverage: late holiday morning prices, closing fallback, verified sharded company/publisher archives, independent-source recovery, 85 filings and 96 news items without caps, ten-day catch-up, ${messages.length} complete multipart messages, corrupt-part status, exact-ISIN provider alias`);
