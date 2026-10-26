// Read-only, no-network edition-window verification against actual committed captures.
// Run on the standard GitHub runner (or locally through codex-heavy-run).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {newsletterSourceShortcuts} from './lib/newsletter-source-shortcuts.mjs';
import {emailSourceUrl} from '../worker/newsletter-source-shortcuts.mjs';
import {newsletterAssets} from './collect-newsletter.mjs';
import {buildBrief,briefStats,briefStories,briefSummary,PRODUCTION_ORIGIN} from '../worker/newsletter-brief.mjs';
import {renderBriefEmails,renderBriefDeliveryEmails,MAX_DELIVERY_EMAIL_PARTS} from '../worker/newsletter-email.mjs';
import {renderBriefPdf} from '../worker/newsletter-pdf.mjs';
import {NEWSLETTER_GITHUB_PDF_BYTES} from '../worker/newsletter-document.mjs';
import {editorialEvents} from '../worker/newsletter-editorial.mjs';
import {newsletterSourceUrl} from '../worker/newsletter-source-links.mjs';
import {istDay,istInstant,DEFAULT_SETTINGS} from '../public/js/data/newsletter-shared.js';
const head=JSON.parse(fs.readFileSync('public/data/market-news.json','utf8'));
const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE newsletter_views(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
const sources=newsletterSourceShortcuts(db,PRODUCTION_ORIGIN);
const day=istDay(Date.parse(head.capturedAt)),now=istInstant(day,'10:00');
const brief=await buildBrief({edition:'morning',day,now,settings:DEFAULT_SETTINGS,includeAi:false,
  reported:{empty:false,since:now-10*86400000,has:()=>false},
  env:{ASSETS:newsletterAssets(),NEWSLETTER_GITHUB_ARCHIVES:true},
  fetcher:async()=>{throw Error('No network, mail or model in retained-input verification');}});
assert.equal(brief.announcements.more+brief.news.more+brief.trades.more+brief.moves.more+brief.calendar.more+brief.actions.more,0);
assert.equal(brief.lateFrom,null,'A ten-day empty ledger cannot reopen historical email eligibility');
assert(briefStories(brief).every(item=>!item.late&&item.at<brief.window.to&&(item.at>=brief.window.from||item.kind==='move'&&item.keys[0].endsWith('|'+brief.moves.session))),'Every emailed report belongs to the printed publication window');
assert(brief.news.company.ok&&brief.news.source.archiveComplete&&brief.news.tradingview.archiveComplete,'All relevant committed archive descriptors and parts must verify');
let messages=[],deliveryBlocked=null;
try { messages=renderBriefEmails(brief); }
catch(error) {
  // A growing ten-day archive can exceed the existing 99-email safety limit.
  // Certify that specific fail-closed boundary, never accept arbitrary packing
  // failures, truncate the retained corpus or raise the production send budget.
  assert.equal(error.code,'email-too-large');
  assert.equal(error.maxParts,99);
  assert(Number.isSafeInteger(error.requiredParts)&&error.requiredParts>error.maxParts);
  deliveryBlocked={reason:error.code,requiredParts:error.requiredParts,maxParts:error.maxParts};
}
const keys=new Set(messages.flatMap(m=>m.keys));
if(!deliveryBlocked)for(const item of briefStories(brief))assert(item.keys.every(key=>keys.has(key)),'A committed eligible alert disappeared from multipart delivery');
else assert.equal(messages.length,0,'An oversized edition must not return a partial delivery plan');
const pdf=renderBriefPdf(brief);assert(pdf.byteLength<=NEWSLETTER_GITHUB_PDF_BYTES);
sources.prepare(brief);
const delivery=renderBriefDeliveryEmails(brief,{dashboardUrl:PRODUCTION_ORIGIN,sourceLinks:sources.links,pdfUrl:PRODUCTION_ORIGIN+'/api/newsletter/pdf/00000000-0000-0000-0000-000000000001',editorial:true});
assert(delivery.length<=3&&delivery.every(m=>m.part?.investor),'The actual retained edition must use the bounded investor reading layer');
assert(delivery.length<=MAX_DELIVERY_EMAIL_PARTS,'Actual retained current reports fit the inbox budget without discarding evidence');
const deliveredKeys=new Set(delivery.flatMap(m=>m.keys));
for(const item of briefStories(brief))assert(item.keys.every(key=>deliveredKeys.has(key)),'The complete-report delivery must carry every eligible source identity');
if(deliveryBlocked||messages.length>MAX_DELIVERY_EMAIL_PARTS)assert(delivery.every(m=>m.part.reportLink===true));
const stats=briefStats(brief),summary=briefSummary(brief);
const events=editorialEvents(brief,stats.companies).events;
assert.deepEqual(delivery.flatMap(message=>message.part.eventIds).sort(),events.map(event=>event.id).sort(),'The retained edition carries every investor update once');
const sourceUrls=events.map(event=>newsletterSourceUrl(event.lead)).filter(Boolean),inbox=delivery.map(message=>message.html).join('');
const escape=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
for(const source of sourceUrls)assert(inbox.includes(`href="${escape(emailSourceUrl(source,sources.links,PRODUCTION_ORIGIN))}"`),'Every retained event links to its exact captured source');
assert(!inbox.includes('Evidence →'),'The complete report must not masquerade as an item source');
// Prepared on-demand previews extend to the actual capture time, which can be
// much denser than the scheduled morning cutoff. Exercise both real windows.
const currentPreview=[],previewAt=Math.max(now,Date.parse(head.capturedAt));
for(const edition of ['morning','evening']){
 const current=await buildBrief({edition,day,now:previewAt,to:previewAt,settings:DEFAULT_SETTINGS,includeAi:false,
  env:{ASSETS:newsletterAssets(),NEWSLETTER_GITHUB_ARCHIVES:true},fetcher:async()=>{throw Error('No network, mail or model in current preview verification');}});
 const currentEvents=editorialEvents(current,briefStats(current).companies).events;
 sources.prepare(current);
 const parts=renderBriefDeliveryEmails(current,{dashboardUrl:PRODUCTION_ORIGIN,sourceLinks:sources.links,editorial:true,preview:true});
 assert(parts.length<=3&&parts.every(p=>p.bytes<=90000),'Actual capture-time previews fit the same inbox budget');
 assert.deepEqual(parts.flatMap(p=>p.part.eventIds).sort(),currentEvents.map(e=>e.id).sort(),'Every preview update appears exactly once');
 const allKeys=new Set(parts.flatMap(p=>p.keys));
 for(const item of briefStories(current))assert(item.keys.every(key=>allKeys.has(key)),'No current source identity disappears to meet the email budget');
 const body=parts.map(p=>p.html).join('');
 for(const event of currentEvents){const url=newsletterSourceUrl(event.lead);if(url){
  const href=emailSourceUrl(url,sources.links,PRODUCTION_ORIGIN);
  assert(body.includes(`href="${escape(href)}"`),'Current previews retain every exact source destination');
  if(href!==url)assert.equal(sources.record(href.split('/').at(-1)).url,url,'Every short link resolves to the original, unmodified report URL');
 }}
 currentPreview.push({edition,at:previewAt,events:currentEvents.length,parts:parts.length,bytes:parts.map(p=>p.bytes)});
}
const report={product:PRODUCTION_ORIGIN,day,listed:brief.book.listed,stories:stats.stories,updates:stats.updates,
  parts:messages.length,deliveryBlocked,deliveryParts:delivery.length,deliveryFormat:delivery[0]?.part?.investor?'investor-brief':'inline',deliveryBytes:delivery.map(m=>m.bytes),investorUpdates:events.length,directSourceLinks:sourceUrls.length,htmlBytes:messages.map(m=>m.bytes),pdfBytes:pdf.byteLength,sourceIdentities:keys.size,
  omittedByCaps:summary.eligibility.omittedByCaps,companyArchive:brief.news.company.ok,
  publisherArchive:brief.news.source.archiveComplete,tradingviewArchive:brief.news.tradingview.archiveComplete,
  upstreamTradingviewPartial:brief.news.tradingview.partial,currentPreview,networkRequests:0};
fs.mkdirSync('.cache/newsletter-coverage',{recursive:true});
fs.writeFileSync('.cache/newsletter-coverage/retained-inputs.json',JSON.stringify(report,null,2));
db.close();
console.log('PASS retained newsletter recovery '+JSON.stringify(report));
