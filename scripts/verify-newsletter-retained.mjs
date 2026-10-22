// Read-only, no-network edition-window verification against actual committed captures.
// Run on the standard GitHub runner (or locally through codex-heavy-run).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {newsletterAssets} from './collect-newsletter.mjs';
import {buildBrief,briefStats,briefStories,briefSummary,PRODUCTION_ORIGIN} from '../worker/newsletter-brief.mjs';
import {renderBriefEmails} from '../worker/newsletter-email.mjs';
import {renderBriefPdf} from '../worker/newsletter-pdf.mjs';
import {NEWSLETTER_GITHUB_PDF_BYTES} from '../worker/newsletter-document.mjs';
import {istDay,istInstant,DEFAULT_SETTINGS} from '../public/js/data/newsletter-shared.js';
const head=JSON.parse(fs.readFileSync('public/data/market-news.json','utf8'));
const day=istDay(Date.parse(head.capturedAt)),now=istInstant(day,'10:00');
const brief=await buildBrief({edition:'morning',day,now,settings:DEFAULT_SETTINGS,includeAi:false,
  reported:{empty:false,since:now-10*86400000,has:()=>false},
  env:{ASSETS:newsletterAssets(),NEWSLETTER_GITHUB_ARCHIVES:true},
  fetcher:async()=>{throw Error('No network, mail or model in retained-input verification');}});
assert.equal(brief.announcements.more+brief.news.more+brief.trades.more+brief.moves.more+brief.calendar.more+brief.actions.more,0);
assert.equal(brief.lateFrom,null,'A ten-day empty ledger cannot reopen historical email eligibility');
assert(briefStories(brief).every(item=>item.at>=brief.window.from&&item.at<brief.window.to&&!item.late),'Every emailed report belongs to the printed publication window');
assert(brief.news.company.ok&&brief.news.source.archiveComplete&&brief.news.tradingview.archiveComplete,'All relevant committed archive descriptors and parts must verify');
const messages=renderBriefEmails(brief),keys=new Set(messages.flatMap(m=>m.keys));
for(const item of briefStories(brief))assert(item.keys.every(key=>keys.has(key)),'A committed eligible alert disappeared from multipart delivery');
const pdf=renderBriefPdf(brief);assert(pdf.byteLength<=NEWSLETTER_GITHUB_PDF_BYTES);
const stats=briefStats(brief),summary=briefSummary(brief);
const report={product:PRODUCTION_ORIGIN,day,listed:brief.book.listed,stories:stats.stories,updates:stats.updates,
  parts:messages.length,htmlBytes:messages.map(m=>m.bytes),pdfBytes:pdf.byteLength,sourceIdentities:keys.size,
  omittedByCaps:summary.eligibility.omittedByCaps,companyArchive:brief.news.company.ok,
  publisherArchive:brief.news.source.archiveComplete,tradingviewArchive:brief.news.tradingview.archiveComplete,
  upstreamTradingviewPartial:brief.news.tradingview.partial,networkRequests:0};
fs.mkdirSync('.cache/newsletter-coverage',{recursive:true});
fs.writeFileSync('.cache/newsletter-coverage/retained-inputs.json',JSON.stringify(report,null,2));
console.log('PASS retained newsletter recovery '+JSON.stringify(report));
