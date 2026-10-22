// Regressions for actual omissions: sharded archive records, partial reads, per-company/edition
// caps, long-lag arrivals and a morning job that starts after the next market has opened.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildBrief,briefStories,briefSummary,briefStats,renderBriefHtml,readNews,readMoves,readTrades,readSessionQuotes,readAnnouncements} from '../worker/newsletter-brief.mjs';
import {renderBriefEmails} from '../worker/newsletter-email.mjs';
import {newsletterRows,newsletterHoldings} from '../worker/newsletter-sources.mjs';
import {tradingViewTargets} from './lib/tradingview-news.mjs';

const now=Date.parse('2026-10-21T04:22:31Z'),from=Date.parse('2026-10-20T10:30:00Z'),to=Date.parse('2026-10-21T02:30:00Z');
const holdings=[{ticker:'ALPHA',name:'Alpha Solar',isin:'INE000000001',bseCode:'500001'},...Array.from({length:50},(_,i)=>({ticker:`HELD${i}`,name:`Held Company ${i}`}))];
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
files.set('/data/earnings-calendar.json',{capturedAt:'2026-10-21T02:00:00Z',byDate:{'2026-10-21':{rows:holdings.map(h=>({ticker:h.ticker}))}}});
files.set('/data/corporate-actions.json',{capturedAt:'2026-10-21T02:00:00Z',rows:holdings.map((h,i)=>({ticker:h.ticker,id:`action${i}`,actionType:'dividend',exDate:'2026-10-21',purpose:'Interim dividend'}))});
files.set('/data/insider-archive/index.json',{months:{'2026-10':45}});
files.set('/data/insider-archive/2026-10.json',{rows:Array.from({length:45},(_,i)=>({ticker:'ALPHA',date:'2026-10-19',cells:{'Trade Category':'Bulk deals','Insider':`Person ${i}`,'Transaction':'Buy','Trade Shares':i+1,'Source':'NSE'}}))});
const env={NEWSLETTER_GITHUB_ARCHIVES:true,ASSETS:{fetch:async request=>{const value=files.get(new URL(request.url).pathname);return value===undefined?new Response(null,{status:404}):typeof value==='string'?new Response(value):Response.json(value);}}};
files.set('/data/announcement-identities.json',{entries:[{bseCode:'999000'},{isin:'INE000000001',bseCode:'500001'},{isin:'INE000000002',bseCode:'500002'}]});
const extra=await newsletterHoldings({holdings:[{name:'BSE Only Holding',isin:'INE000000002',listed:true},{name:'Unresolved Listed Holding',isin:'INE000000003',listed:true},{name:'Private Holding',isin:'INE000000004',listed:false}]},env);
assert.deepEqual(extra.map(h=>h.ticker),['500002','INE000000003'],'BSE-only and unresolved listed holdings remain in coverage by exact security identity; private lines stay out');
files.get('/data/market-news.json').archive=[{month:'2026-10',file:'market-news/2026-10.json',count:1}];
files.get('/data/company-news/index.json').archive=[{month:'2026-10',file:'company-news/2026-10.json',count:95}];
files.set('/data/tradingview-news/index.json',{archive:[{month:'2026-10',file:'tradingview-news/2026-10.json',count:0}]});
files.set('/data/announcements-archive/index.json',{months:{'2026-10':0}});
files.set('/data/announcements-archive/2026-10.json',{kind:'announcements',rows:[]});
const common={env,holdings,window:{from,to},reported:{empty:false,since:Date.parse('2026-10-01T00:00:00Z'),has:()=>false}};
const quotes=await readSessionQuotes({env,holdings,now,edition:'morning'});
assert.equal(quotes.session,'2026-10-19','Dussehra and a late start must not turn an unfinished 21 October session into a completed session');
assert.equal(quotes.state,'daily');assert.equal(quotes.rows[0].last,110);
const captureEnv={...env,ASSETS:{fetch:async()=>new Response(null,{status:404})},NEWSLETTER_QUOTES:{read:async()=>({rows:[{ticker:'ALPHA',price:110,prevClose:100,sessionDate:'2026-10-19',quoteAt:'2026-10-19T10:29:00Z',checkedAt:'2026-10-19T10:31:00Z'}]})}};
assert.equal((await readSessionQuotes({env:captureEnv,holdings,now,edition:'morning'})).state,'capture','Closing-quote fallback uses the edition session even after the next open');
assert.equal((await newsletterRows({...env,NEWSLETTER_GITHUB_ARCHIVES:false},'/data/company-news/2026-10.json')).ok,false,'Archive calculations cannot run in a Worker/legacy path');
const news=await readNews({...common,uncapped:true});
assert.equal(news.count,95,'94 new company articles and the publisher archive row survive a failed TradingView symbol');
assert.equal(news.more,0);assert.equal(news.tradingview.partial,true);assert.equal(news.company.ok,true);
const tv=files.get('/data/tradingview-news/latest.json');const previousHealth=tv.tradingViewCoverage;
tv.tradingViewCoverage={checkedAt:'2026-10-21T02:00:00Z',activeCompanies:1,plannedSymbols:1,staleOrFailedSymbols:0,oldestSuccessAt:'2026-10-21T02:00:00Z',restrictedHeadlines:1};
assert.equal((await readNews({...common,uncapped:true})).tradingview.partial,true,'Restricted headlines alone remain explicit partial coverage');
tv.tradingViewCoverage={...tv.tradingViewCoverage,restrictedHeadlines:0,blockedUntil:'2026-10-21T03:00:00Z'};
assert.equal((await readNews({...common,uncapped:true})).tradingview.partial,true,'Active provider backoff alone remains explicit partial coverage');tv.tradingViewCoverage=previousHealth;
const brief=await buildBrief({edition:'morning',day:'2026-10-21',settings:{morning:{time:'08:00'},evening:{time:'16:00'}},env,now,reported:common.reported,includeAi:false,fetcher:async()=>{throw Error('offline fixture')}});
assert.equal(brief.announcements.count,85);assert.equal(brief.announcements.more,0,'No 80-filing or eight-per-company cap');
assert.equal(brief.news.count,95,'An old source arrival must stay outside the daily email even when never reported');
assert.equal(brief.lateFrom,null);
assert(briefStories(brief).every(s=>s.at>=brief.window.from&&s.at<brief.window.to&&!s.late));
assert.equal(brief.news.more,0);assert.equal(briefSummary(brief).eligibility.omittedByCaps,0);
assert.equal(brief.calendar.rows.length,51);assert.equal(brief.actions.rows.length,51,'Supplemental events cannot disappear at a forty-row cap');
const dealWindow={from:Date.parse('2026-10-19T00:00:00Z'),to:Date.parse('2026-10-20T00:00:00Z')};
assert.equal((await readTrades({env,holdings,window:dealWindow,uncapped:true})).count,45);
assert.equal((await readTrades({env,holdings,window:dealWindow,uncapped:true})).more,0);
const moves=readMoves({holdings,window:dealWindow,uncapped:true,quotes:{state:'daily',session:'2026-10-19',rows:holdings.map(h=>({ticker:h.ticker,pct:10,at:Date.parse('2026-10-19T10:00:00Z')}))}});assert.equal(moves.count,51);assert.equal(moves.more,0);
assert.equal(renderBriefHtml(brief,{stats:briefStats(brief)}),renderBriefHtml(brief),'Reusing the completed edition grouping preserves the exact email body');
const messages=renderBriefEmails(brief),keys=new Set(messages.flatMap(m=>m.keys));
for(const item of briefStories(brief))assert(item.keys.every(key=>keys.has(key)),'Every eligible source identity survives grouping and multipart rendering');
assert(messages.length>1);assert(messages.every(m=>m.bytes<=90000));
assert.equal((await newsletterRows(env,'/data/company-news/2026-10.json',()=>true,{count:96})).ok,false,'A valid subset cannot satisfy a larger owning archive descriptor');
const v2rows=[{title:'Original first'},{title:'Original second'}],parts=v2rows.map((row,i)=>{const body=JSON.stringify({items:[row]}),hash=createHash('sha256').update(body).digest('hex');files.set(`/data/company-news/v2.parts/${hash}.json`,body);return {file:`v2.parts/${hash}.json`,sha256:hash,bytes:Buffer.byteLength(body),rows:1,order:[i]};});
files.set('/data/company-news/v2.json',{articles:[],_jsonShards:{version:2,field:'articles',rows:2,parts:parts.reverse()}});
assert.deepEqual((await newsletterRows(env,'/data/company-news/v2.json')).rows.map(r=>r.title),['Original first','Original second'],'Transport grouping cannot reorder source observations');
const old=files.get(`/data/company-news/2026-10.parts/${sha}.json`);
files.set(`/data/company-news/2026-10.parts/${sha}.json`,old.replace('Alpha Solar','Other Solar'));
assert.equal((await newsletterRows(env,'/data/company-news/2026-10.json')).ok,false,'A corrupt transport part cannot become an empty successful capture');
const partial=await readNews({...common,uncapped:true});assert.equal(partial.company.ok,false);assert.equal(partial.count,1,'A failed company archive retains independent publisher evidence');
files.set(`/data/company-news/2026-10.parts/${sha}.json`,old);
const bajaj=tradingViewTargets([{entityId:'isin:INE917I01010',ticker:'BAJAJ-AUTO',name:'Bajaj Auto'}],[{isin:'INE917I01010',ticker:'BAJAJ-AUTO',bseSymbol:'BAJAJ-AUTO'}]);
assert.deepEqual(bajaj[0].symbols,['NSE:BAJAJ_AUTO','BSE:BAJAJ_AUTO']);

// A full-source walk must preserve genuine company news without treating a search word
// as company proof. The source rows remain unchanged for the broader News reader.
const eternalHolding={ticker:'ETERNAL',name:'Eternal',isin:'INE758T01015'};
const eternalEntity={...eternalHolding,entityId:'isin:INE758T01015',queries:['Eternal']};
const eternalRows=['Eternal Lord of Music - Dictators (Official Music Video)',
 'Eternal Q2 preview: can Blinkit sustain growth?','Zomato announces quarterly results',
 'Eternal Limited announces a corporate update'].map((title,i)=>({title,entityId:eternalEntity.entityId,
 ticker:'ETERNAL',publishedAt:'2026-10-20T12:00:00Z',url:`https://publisher.test/eternal/${i}`}));
const eternalOriginal=JSON.stringify(eternalRows);
const identityFiles=new Map([
 ['/data/market-news.json',{articles:[],archive:[{month:'2026-10',file:'market-news/2026-10.json',count:0}]}],
 ['/data/market-news/2026-10.json',{articles:[]}],
 ['/data/company-news/index.json',{entities:[eternalEntity],queries:{[eternalEntity.entityId]:{Eternal:{lastSuccessAt:'2026-10-21T02:00:00Z'}}},archive:[{month:'2026-10',file:'company-news/2026-10.json',count:4}]}],
 ['/data/company-news/2026-10.json',{articles:eternalRows}],
 ['/data/tradingview-news/latest.json',{byTicker:{},entities:[eternalEntity]}],
 ['/data/tradingview-news/index.json',{archive:[{month:'2026-10',file:'tradingview-news/2026-10.json',count:0}]}],
 ['/data/tradingview-news/2026-10.json',{articles:[]}],
]);
const identityEnv={NEWSLETTER_GITHUB_ARCHIVES:true,ASSETS:{fetch:async request=>{
 const value=identityFiles.get(new URL(request.url).pathname);return value?Response.json(value):new Response(null,{status:404});}}};
const identityNews=await readNews({...common,env:identityEnv,holdings:[eternalHolding],uncapped:true});
assert.equal(identityNews.count,3,'Legal, former-name and reviewed-context headlines remain eligible; a common-word music result does not');
assert(!identityNews.groups.flatMap(g=>g.items).some(row=>row.headline.includes('Lord of Music')));
assert.equal(identityNews.company.coverage.unchecked,1,'A saved old single-query success cannot certify newly reviewed legal-name/alias checks');
assert.equal(JSON.stringify(eternalRows),eternalOriginal,'Source records are retained unchanged');


const known=await newsletterHoldings({holdings:[{name:'Alpha Solar',ticker:'ALPHA',isin:'INE000000001'},{name:'Unmapped',ticker:'UNMAPPED'}]},env);
assert.equal(known[0].bseCode,'500001','Existing NSE holdings also carry the exact-ISIN BSE code for retained filings');
assert.equal(known[1].bseCode,null,'A directory entry without ISIN cannot attach to an ISIN-less holding');
const latestBse=files.get('/data/corp-announcements.json');
const retainedBse=[{...latestBse.byTicker.ALPHA[0],ticker:'ALPHA',source:'BSE'},
 {newsId:'retained-only',ticker:'OLDALPHA',scripCode:'500001',source:'BSE',date:'2026-10-15',time:'18:00',headline:'Retained BSE-only award',category:'Company Update',subCategory:'General',url:'https://www.bseindia.com/xml-data/corpfiling/retained.pdf'},
 {newsId:'wrong-isin',ticker:'ALPHA',scripCode:'500001',isin:'INE000000999',source:'BSE',date:'2026-10-15',time:'18:00',headline:'Different security award'},
 {ticker:'ALPHA',source:'NSE',date:'2026-10-15',time:'18:03',title:'Retained NSE-only award',url:'https://nsearchives.nseindia.com/corporate/retained-nse.pdf'},
 {ticker:'ALPHA',isin:'INE000000001',scripCode:'500001',source:'Screener',date:'2026-10-15',time:'18:05',title:'New manufacturing capacity commissioned',referenceUrl:'https://www.screener.in/company/ALPHA/',documentUnavailable:true},
 {ticker:'ALPHA',scripCode:'500001',date:'2026-10-15',time:'18:06',title:'Legacy captured capacity commissioned'},
 {ticker:'ALPHA',scripCode:'999999',source:'BSE',date:'2026-10-15',time:'18:07',title:'Wrong security code award'},
 {ticker:'ALPHA',scripCode:'500001',source:'Screener',publishedAt:'2026-10-15',title:'Dated-only retained manufacturing expansion'}];
const retainedBody=JSON.stringify({items:retainedBse}),retainedHash=createHash('sha256').update(retainedBody).digest('hex');
const retainedPart=`/data/announcements-archive/2026-10.parts/${retainedHash}.json`;
files.set(retainedPart,retainedBody);
files.set('/data/announcements-archive/index.json',{months:{'2026-10':8},updatedAt:'2026-10-21T02:00:00Z'});
files.set('/data/announcements-archive/2026-10.json',{kind:'announcements',rows:[],_jsonShards:{version:2,field:'rows',rows:8,parts:[{file:`2026-10.parts/${retainedHash}.json`,sha256:retainedHash,bytes:Buffer.byteLength(retainedBody),rows:8,order:[0,1,2,3,4,5,6,7]}]}});
const filingOptions={...common,lateFrom:Date.parse('2026-10-10T00:00:00Z'),uncapped:true,fetcher:async()=>{throw Error('offline fixture')}};
const retainedFilings=await readAnnouncements(filingOptions);
assert.equal(retainedFilings.count,90,'Older BSE/NSE/Screener filings survive the rolled head; duplicates fold and an explicit foreign ISIN is rejected');
assert.equal(retainedFilings.filingArchive.ok,true);
assert.deepEqual(retainedFilings.filingArchive.sources,{BSE:2,NSE:1,Screener:2,'Captured filing':1});
assert.equal(retainedFilings.filingArchive.unverifiedSources,1);
const datedOnly=retainedFilings.groups.flatMap(g=>g.items).find(row=>row.headline==='Dated-only retained manufacturing expansion');
assert.equal(datedOnly.dayOnly,true,'A date-only retained value cannot become a precise midnight timestamp');
assert(retainedFilings.groups.flatMap(g=>g.items).some(row=>row.exchanges.includes('Screener')&&row.url==='https://www.screener.in/company/ALPHA/'),'Unlinked notices keep their source and reference page');
const oldFiling=retainedFilings.groups.flatMap(g=>g.items).find(row=>row.keys.includes('bse:retained-only'));
assert.equal(oldFiling.ticker,'ALPHA','Immutable BSE code resolves a captured older ticker');assert.equal(oldFiling.late,true);
assert(renderBriefEmails({...brief,announcements:retainedFilings}).some(message=>message.keys.includes('bse:retained-only')),'The retained source identity is included in actual multipart email output');
files.delete('/data/corp-announcements.json');
const withoutHead=await readAnnouncements(filingOptions);
assert.equal(withoutHead.count,6,'Independent retained filings survive a failed latest head');assert.equal(withoutHead.bse.ok,false);assert.equal(withoutHead.filingArchive.ok,true);
files.set('/data/corp-announcements.json',latestBse);
files.set(retainedPart,retainedBody.replace('Retained BSE-only','Corrupted BSE-only'));
const corruptFilings=await readAnnouncements(filingOptions);
assert.equal(corruptFilings.count,85,'A bad history part never discards the usable latest head');assert.equal(corruptFilings.filingArchive.ok,false);assert(corruptFilings.filingArchive.failedParts.length>0);
assert.equal((await newsletterRows({...env,NEWSLETTER_GITHUB_ARCHIVES:false},'/data/announcements-archive/2026-10.json')).ok,false,'Retained filing calculations stay on GitHub, not the Worker');

console.log(`PASS newsletter coverage: late holiday morning prices, closing fallback, verified sharded company/publisher archives, independent-source recovery, 85 filings, 95 current news items, 45 trades, 51 movers and 51 calendar/action rows without caps, historical catch-up excluded, ${messages.length} complete multipart messages, corrupt-part status, exact-ISIN provider alias, retained multi-provider filing history and independent failures`);
