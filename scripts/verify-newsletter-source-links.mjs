// Source-copy conservation through the real readers and the complete PDF; no network/model/mail.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildBrief,briefStories} from '../worker/newsletter-brief.mjs';
import {renderBriefPdf} from '../worker/newsletter-pdf.mjs';
import {DEFAULT_SETTINGS,istInstant} from '../public/js/data/newsletter-shared.js';
export async function verifyNewsletterSourceLinks(){
 const book=JSON.parse(readFileSync(new URL('./fixtures/newsletter/book.json',import.meta.url))),holding=book.holdings.find(h=>h.ticker);
 const day='2026-10-23',at=istInstant(day,'16:00'),url=name=>'https://fixture.test/'+name;
 const copies=['news-publisher','news-tv','news-archive-copy','news-later-copy'].map(url);
 const article={title:holding.name+' announces a new contract',url:copies[0],tradingViewUrl:copies[1],sourceUrls:copies.slice(0,3),publishedAt:new Date(at-1000).toISOString(),publisher:'Fixture'};
 const actions=['action-screener','action-nse','action-extra','action-later-copy'].map(url),calendar=['calendar-event','calendar-company','calendar-mc'].map(url),trades=['trade-original','trade-copy','trade-later-copy'].map(url);
 const trade={ticker:holding.ticker,date:day,sourceId:'nse-bulk',url:trades[0],sourceUrls:[trades[1]],cells:{'Trade Category':'Bulk','Person':'Fixture holder','Transaction':'Buy','Trade Shares':'1000','Price':'100','Source':'NSE'}};
 const data={
  '/data/portfolio-companies.json':book,
  '/data/market-news.json':{articles:[article,{...article,sourceUrls:[copies[3]]}]},
  '/data/corporate-actions.json':{rows:[{id:'action',ticker:holding.ticker,isin:holding.isin,actionType:'dividend',purpose:'Dividend of INR 5 per share',exDate:day,sources:['NSE','Screener'],screenerCompanyUrl:actions[0],sourceUrl:actions[1],sourceUrls:[actions[2]]}]},
  '/data/earnings-calendar.json':{byDate:{[day]:{rows:[{ticker:holding.ticker,mcUrl:calendar[2]}]}}},
  '/data/insider-archive/index.json':{months:{'2026-10':{}}},
  '/data/insider-archive/2026-10.json':{rows:[trade,{...trade,sourceUrls:[trades[2]]}]},
 };
 data['/data/corporate-actions.json'].rows.push({...data['/data/corporate-actions.json'].rows[0],sourceUrls:[actions[3]]});
 const before=JSON.stringify(data);
 const brief=await buildBrief({edition:'evening',day,now:at,settings:DEFAULT_SETTINGS,includeAi:false,
  screener:async()=>({capture:{portfolioUpcoming:[{ticker:holding.ticker,date:day,eventType:'Result',sourceUrl:calendar[0],companyUrl:calendar[1]}]}}),
  env:{ASSETS:{fetch:async r=>data[new URL(r.url).pathname]?Response.json(data[new URL(r.url).pathname]):new Response(null,{status:404})}},
  fetcher:async()=>new Response(null,{status:503})});
 assert.equal(brief.news.count,1,'Repeated observations remain one news report');
 assert.deepEqual(new Set(briefStories(brief).find(s=>s.kind==='news').sourceUrls),new Set(copies),'Merged publisher/TradingView/archive links survive both reader mappings');
 assert.deepEqual(new Set(brief.actions.rows[0].sourceUrls),new Set(actions));
 assert.equal(brief.actions.rows.length,1,'Repeated action observations stay one action');
 assert.equal(brief.trades.count,1,'Repeated trade observations stay one trade');
 assert.deepEqual(new Set(briefStories(brief).find(s=>s.kind==='trade').sourceUrls),new Set(trades));
 assert.equal(brief.calendar.rows.length,1,'Two calendars retain one event');
 assert.deepEqual(new Set(brief.calendar.rows[0].sourceUrls),new Set(calendar));
 const pdf=Buffer.from(renderBriefPdf(brief)).toString('latin1');
 for(const link of [...copies,...actions,...calendar,...trades])assert(pdf.includes('/URI ('+link+')'),'Every original source remains a clickable PDF link: '+link);
 assert.equal(JSON.stringify(data),before,'Source-copy conservation never mutates captured history');
 console.log('PASS newsletter source links: merged publisher/TradingView/archive observations, corroborated actions and calendar event copies all survive into the complete PDF');
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file://').href)await verifyNewsletterSourceLinks();
