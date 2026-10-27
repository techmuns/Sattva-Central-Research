// Replay the customer's 26 October failures without network, model credits or email delivery.
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pdfFixture } from './verify-newsletter-pdf.mjs';
import {DEFAULT_SETTINGS,istInstant} from '../public/js/data/newsletter-shared.js';
import { briefStats,briefStoryKeys,renderBriefHtml,aiItemsFor,readAiNotes,buildBrief,briefStories,clusterStories,NEWSLETTER_STYLE,MOODS } from '../worker/newsletter-brief.mjs';
import { editorialEvents,referenceReason,annotateEditorialHistory,EDITORIAL_EMAIL_PARTS } from '../worker/newsletter-editorial.mjs';
import { renderInvestorEmails,emailBytes } from '../worker/newsletter-email.mjs';
import { renderBriefPdf } from '../worker/newsletter-pdf.mjs';
import { NewsletterContentStore } from '../worker/newsletter-content-store.mjs';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import { fetchContent,readDocumentFacts } from '../worker/newsletter-content.mjs';
import { reviewNewsEvents } from '../worker/newsletter-events.mjs';
import { newsletterSourceUrl } from '../worker/newsletter-source-links.mjs';
import { scheduledBoardMeetingSummary } from '../worker/newsletter-filing-events.mjs';
import { investorSourceFacts, xbrlBoardMeetingNote } from '../worker/newsletter-source-notes.mjs';
import {newsletterSourceShortcuts,newsletterSourceViews,sourcePublicationVerifier} from './lib/newsletter-source-shortcuts.mjs';
import {emailSourceUrl,emailSourceIds,SOURCE_LINK_FORMAT,sourceTarget,SOURCE_LOOKUP_BATCH_SIZE,SOURCE_PAGE_BYTES,SOURCE_RECORD_BYTES,SOURCE_INDEX_FORMAT} from '../worker/newsletter-source-shortcuts.mjs';
import {newsletterSourceReader} from '../worker/newsletter-source-index.mjs';

const excluded=[
 ['INDIANB','South Indian Bank Leveraging Digital Technology For Biz Growth'],
 ['INDIANB','HDFC Bank Q2 Results Good Or Bad: Largest Indian Bank Earns Rs 19,510 Crore Profit'],
 ['LUPIN',"'Nobody Wants This' Season 3 and 'Lupin' Lead Netflix UK's 43 New Releases This Week"],
 ['CUB','GUEST APPEARANCE: Time for Town-City union'],
 ['MOTILALOFS','Upgrade to Buy BSE Ltd For Target Rs.4,000 by Motilal Oswal Financial Services Ltd'],
 ['LXCHEM','Laxmi Organic Industries Ltd. Estimates - NSE:LXCHEM'],
 ['SAGILITY','SAGILITY LIMITED Option Chain'],
 ['TECHM','Tech Mahindra slides Friday, underperforms competitors'],
 ['ICICIBANK','ICICI Bank climbs Friday, outperforms competitors'],
 ['SBIN','State Bank of India slips Friday, outperforms competitors'],
];
for(const [ticker,headline] of excluded)assert(referenceReason({ticker,headline,kind:'news'}),headline);
for(const [ticker,headline] of [
 ['INDIANB','ICICI Bank and Indian Bank increase FD interest rates'],
 ['LUPIN',"Lupin's Goa facility receives Form-483 with one observation from U.S. FDA"],
 ['MOTILALOFS','Motilal Oswal Financial Services reports its quarterly results'],
 ['LXCHEM','Laxmi Organic analyst profit estimates revised upward - NSE:LXCHEM'],
 ['TECHM','Tech Mahindra slides Friday after cutting revenue guidance'],
])assert.equal(referenceReason({ticker,headline,kind:'news'}),null,headline);

const brief=pdfFixture(),at=brief.at;
brief.book.listed=170;brief.calendar.rows=brief.calendar.rows.slice(0,3);brief.performance.rows=brief.performance.rows.slice(0,5);
brief.news.groups=excluded.map(([ticker,headline],i)=>({ticker,company:ticker,items:[{headline,at:at-i*1000,url:`https://fixture.test/reference/${i}`,publisher:'Captured publisher',keywords:[],keys:[`reference:${i}`]}]}));
const official=brief.announcements.groups[0].items[0];
official.keys=['official:NSE'];official.content={state:'ready',hash:'same-source-bytes',version:1,facts:[
 {field:'event',value:'A customer contract was approved subject to final conditions',quote:'A customer contract was approved subject to final conditions',location:'page 1'},
 {field:'amount',value:'INR 100 crore',quote:'INR 100 crore',location:'page 1'},
]};
brief.announcements.groups[0].items.push({...structuredClone(official),at:at-2*86400000,keys:['official:BSE'],url:'https://fixture.test/cross-exchange-copy.pdf'});
let stats=briefStats(brief),reading=editorialEvents(brief,stats.companies);
assert.equal(reading.events.length,1,'The economic disclosure appears once, even if its exchange copy arrives two days later');
assert.equal(reading.events[0].sourceCount,2);assert.equal(reading.reference.length,excluded.length);
brief.ai={ok:true,items:{[reading.events[0].id]:{summary:'A customer contract worth INR 100 crore was approved, subject to final conditions.',impact:'It could support future revenue if the conditions are satisfied.',unknowns:'Completion is conditional.'}}};
const pdfUrl='https://example.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000001';
const options={dashboardUrl:'https://example.test',brand:'Sattva Ventures',pdfUrl};
const messages=renderInvestorEmails(brief,options);
assert.equal(messages.length,1);assert(messages[0].html.includes('INR 100 crore'));assert(messages[0].html.includes('Watch next:'));
const inbox=messages[0].html;
function assertEnding(messages,source){
 const ending=messages.at(-1).html;
 for(const [title,rows]of [['UPCOMING RESULTS & CALLS',source.calendar.rows],['CORPORATE ACTION DATES',source.actions.rows],['MARKET CONTEXT',source.markets.rows]]){
  assert.equal(messages.filter(m=>m.html.includes(title)).length,rows.length?1:0,title);
  if(rows.length)assert(ending.includes(title),`${title} belongs only in the final email`);
 }
 assert.equal(messages.filter(m=>m.html.includes('Automated by Munshot')).length,1);
 assert(ending.includes('Automated by Munshot')&&!ending.includes('Continued in Part'));
 for(const [i,message]of messages.entries()){
  assert(message.html.includes('Unsubscribe'),'Reader controls remain available in every part');
  if(i<messages.length-1){assert(message.html.includes(`Continued in Part ${i+2} of ${messages.length}`));assert(!message.html.includes('AI impacts are interpretations.'));}
  assert(!message.html.includes('Dates and markets (PDF)'),'Closing tables cannot be replaced by a PDF-only count');
 }
 const tables=ending.indexOf('UPCOMING RESULTS & CALLS');
 if(tables>=0)assert(tables>ending.lastIndexOf('data-company='),'All company readings precede the closing tables');
 assert(ending.indexOf('Automated by Munshot')>ending.indexOf('MARKET CONTEXT'));
}
assertEnding(messages,brief);
const coloured=structuredClone(brief);
coloured.markets.rows=[1.25,-2.5,0,null].map((changePct,i)=>({...structuredClone(brief.markets.rows[0]),label:`Market colour ${i}`,changePct}));
const colouredHtml=renderInvestorEmails(coloured,options).at(-1).html;
for(const [colour,value]of [[MOODS.good.color,'+1.25%'],[MOODS.watch.color,'−2.50%'],[MOODS.neutral.color,'0.00%'],[NEWSLETTER_STYLE.META,'Change unavailable']])
 assert(colouredHtml.includes(`<span style="color:${colour};font-weight:bold">${value}</span>`),'Gain/loss/flat/unavailable changes retain the original market colours and signs');
for(const token of [NEWSLETTER_STYLE.CREAM,NEWSLETTER_STYLE.INK,NEWSLETTER_STYLE.GOLD,NEWSLETTER_STYLE.GOLD_LIGHT,NEWSLETTER_STYLE.SERIF])assert(inbox.includes(token),'The original newsletter palette and serif design must remain');
assert(inbox.includes('border-top:3px double')&&inbox.includes('max-width:640px')&&inbox.includes('Evening Portfolio Brief'),'Retain the original masthead, paper width and edition format');
assert(!inbox.includes(official.headline),'A grounded summary replaces the repetitive source headline in the inbox');
assert(!inbox.includes('Descriptions are abbreviated')&&!inbox.includes('reference/calendar groups'),'Detailed diagnostics belong in the complete report');
const incomplete=structuredClone(brief);incomplete.announcements.nseHistory={ok:true,days:[],missingDays:['2026-10-06']};
incomplete.content={pending:69,partial:4};
for(const message of renderInvestorEmails(incomplete,options))for(const label of ['Partial coverage:','pending reads','partial reads','Coverage details (PDF)','Open dashboard'])assert(!message.html.includes(label),'Edition diagnostics and the dashboard shortcut stay out of the inbox');
const incompletePdf=Buffer.from(renderBriefPdf(incomplete)).toString('latin1');
assert(incompletePdf.includes('69 source items remain unread')&&incompletePdf.includes('2026-10-06'),'The full report retains unread counts and missing source days');
for(const [,headline]of excluded)assert(!messages[0].html.includes(headline),'Reference records must not become investor developments');
assert.deepEqual(messages.flatMap(m=>m.keys).sort(),briefStoryKeys(brief).sort(),'The verified report retains every source identity, including reference records');
const before=JSON.stringify(brief),pdf=Buffer.from(renderBriefPdf(brief)).toString('latin1');
assert.equal(JSON.stringify(brief),before,'Reading and rendering never mutate the retained facts');
for(let i=0;i<excluded.length;i++)assert(pdf.includes(`https://fixture.test/reference/${i}`));
assert(pdf.includes('https://fixture.test/cross-exchange-copy.pdf'));

// Same publisher / different ingestion routes is one copy; a real revised amount stays separate.
const story={kind:'news',ticker:'TEST',source:'NDTV Profit',headline:'Company secures INR 360 crore from anchor investors ahead of IPO',at,score:1,url:'https://fixture.test/article'};
assert.equal(clusterStories([story,{...story,url:'https://fixture.test/article?utm_source=another-route'}]).length,1);
assert.equal(clusterStories([story,{...story,url:'https://fixture.test/different-event'}]).length,2,'The same unread headline is not proof of a repeated development');
const readStory={...story,content:{state:'ready',hash:'same-confirmed-source',facts:official.content.facts}};
assert.equal(clusterStories([readStory,{...readStory,url:'https://fixture.test/exchange-copy'}]).length,1);
assert.equal(clusterStories([story,{...story,headline:story.headline.replace('360','460')}]).length,2);

// Customer's real Bharat Parenteral PDF: paraphrased extraction values cannot veto
// matching document bytes. A changed version of that URL remains a separate update.
const bharat={kind:'filing',ticker:'BPLPHARMA',score:1,at,headline:'Revised voting results of EGM held on 23 October 2026',
 url:'https://www.bseindia.com/xml-data/corpfiling/AttachLive/c3f78439-f2b8-4e93-805c-2eb08122c184.pdf',
 content:{state:'ready',hash:'bharat-voting-results',facts:[{field:'conditions',value:'Revision is limited to shareholder classification and does not change votes cast or resolution outcomes'}]}};
const bharatCopy={...bharat,headline:'Approval of Preferential Issue by Shareholders of the Company through EGM Held on October 23, 2026.',
 content:{...bharat.content,facts:[{field:'conditions',value:'Revision only relates to shareholder classification/category, not votes cast or outcome'}]}};
assert.equal(clusterStories([bharat,bharatCopy]).length,1,'The same read PDF is one update despite extraction paraphrases');
assert.equal(clusterStories([bharat,{...bharatCopy,content:{...bharatCopy.content,hash:'corrected-bharat-document'}}]).length,2,'Changed bytes at a reused URL remain visible');
assert.equal(clusterStories([{...bharat,content:{state:'pending'}},{...bharatCopy,content:{state:'pending'}}]).length,1,'Duplicate capture metadata cannot split one unread PDF');
assert.equal(clusterStories([{...bharat,headline:'Order for Customer A for INR 15 crore',content:{state:'pending'},sourceUrls:[bharat.url]},
 {...bharat,headline:'Order for Customer B for INR 20 crore',url:'https://www.bseindia.com/another-order.pdf',content:{state:'pending'},sourceUrls:[bharat.url]}]).length,2,'Shared supporting attachments cannot merge distinct unread orders');

// Customer's Aurobindo NSE/BSE meeting notices, eight minutes apart, with different
// date formats and one generic exchange wrapper. The specific agenda must lead.
const auro={kind:'filing',ticker:'AUROPHARMA',score:1,at,content:{state:'pending'},
 headline:'AUROBINDO PHARMA LIMITED has informed the Exchange about Board Meeting to be held on 04-Nov-2026 to consider and approve the Half Yearly Unaudited Financial results of the Company for the period ended September 2026 and Dividend.',
 url:'https://nsearchives.nseindia.com/corporate/xbrl/PRIOR_INTIMATION_934_WebXMLFile_20261026_075640876.xml'};
const auroBse={...auro,at:at-8*60000,
 headline:'Aurobindo Pharma Ltdhas informed BSE that the meeting of the Board of Directors of the Company is scheduled on 04/11/2026 ,inter alia, to consider and approve Intimation of Board Meeting ....',
 url:'https://www.bseindia.com/xml-data/corpfiling/AttachLive/ed83a911-4c69-490e-bbb3-b4c68c62a1a1.pdf'};
const auroGroups=clusterStories([auro,auroBse],{company:'Aurobindo Pharma Ltd'});
assert.equal(auroGroups.length,1);assert.equal(auroGroups[0].main.url,auro.url,'The detailed notice leads its generic exchange copy');
assert.equal(scheduledBoardMeetingSummary(auro),'Board meeting 4 Nov 2026: to consider half-year unaudited financial results for the period ended September 2026 and dividend.');
assert.equal(clusterStories([auro,{...auroBse,headline:auroBse.headline.replace('04/11/2026','05/11/2026')}]).length,2);
assert.equal(clusterStories([auro,{...auroBse,headline:auroBse.headline.replace('04/11/2026','31/11/2026')}]).length,2,'Invalid dates cannot establish meeting identity');
assert.equal(clusterStories([auro,{...auroBse,at:at-2*86400000}]).length,2,'Distant notices need stronger evidence');
assert.equal(clusterStories([auro,{...auro,url:'https://fixture.test/other-quarter',headline:auro.headline.replace('September','June')}]).length,2,'Different financial periods remain separate');
assert.equal(clusterStories([{...auro,headline:auro.headline.replace('September 2026','30/09/2026')},
 {...auro,url:'https://fixture.test/other-numeric-quarter',headline:auro.headline.replace('September 2026','30/06/2026')}]).length,2,'Numeric financial periods are also part of the event identity');
const proposedIssue={...auro,headline:'Board Meeting to be held on 04-Nov-2026 to consider a preferential issue to Investor Alpha for INR 15 crore'};
assert(scheduledBoardMeetingSummary(proposedIssue).includes('Investor Alpha for INR 15 crore'),'A concise meeting description must retain stated counterparties and amounts');
assert.equal(clusterStories([proposedIssue,{...proposedIssue,url:'https://fixture.test/different-proposal',headline:proposedIssue.headline.replace('Investor Alpha','Investor Beta').replace('15','20')}]).length,2,'Two detailed capital proposals do not become one update merely because they share a meeting date');
assert.equal(clusterStories([proposedIssue,{...auroBse,headline:auroBse.headline.replace('Intimation of Board Meeting ....','Other business including a proposed loan to Investor Beta.')}]).length,2,'An unrecognized purpose is not a generic exchange wrapper');

// The live read notice must not dump NSE symbols, ISINs, SME/trading-window flags
// or dimensionless units into the investor sentence. Reuse saved XBRL fields;
// source history and the full extraction are unchanged and no model is called.
const sourceFields=[['NSESymbol','AUROPHARMA'],['NameOfTheCompany','AUROBINDO PHARMA LIMITED'],['WhetherCompanyIsSME','false'],
 ['ISIN','INE406A01037'],['TypeOfMeeting','Board Meeting'],['TypeOfIntimation','New'],['DateOfProposedMeeting','2026-11-04'],
 ['WhetherTradingWindowIsClosed','true'],['DateOfStartOfTradingWindowClosure','2026-10-01'],
 ['DetailsOfDateOfEndOfTradingWindowClosure','Routine trading-window metadata remains in the source register.'],
 ['Agenda1','Financial results'],['Agenda2','Dividend'],['WhetherResultsAreAuditedOrUnaudited','Unaudited'],
 ['NatureOfReportStandaloneConsolidated','Standalone And Consolidated'],['ReportingPeriodType','Half Yearly'],
 ['MonthOfPeriodEnded','September'],['YearOfPeriodEnded','2026 [source unit: pure]'],['TypeOfDividend','Interim']];
const readAuro={...auro,content:{state:'ready',format:'xbrl',hash:'read-prior-intimation',facts:sourceFields.map(([tag,value])=>({field:'source',name:tag,value,quote:value,location:'Main/'+tag}))}};
const notice='Board meeting 4 Nov 2026: to consider unaudited standalone and consolidated half-year financial results for the period ended September 2026 and interim dividend.';
assert.equal(xbrlBoardMeetingNote(readAuro),notice);
assert.deepEqual(investorSourceFacts(readAuro),[],'XBRL administrative metadata is not an investor fact strip');
const metadataBrief=structuredClone(brief);metadataBrief.news.groups=[];metadataBrief.ai={ok:false,items:{}};
metadataBrief.announcements.groups=[{ticker:'AUROPHARMA',company:'Aurobindo Pharma Ltd',items:[{...official,headline:auro.headline,url:auro.url,keys:['read-auro'],content:readAuro.content}]}];
const metadataBefore=JSON.stringify(metadataBrief),metadataHtml=renderInvestorEmails(metadataBrief,options)[0].html;
assert(metadataHtml.includes(notice)&&metadataHtml.includes('Source facts')&&!metadataHtml.includes('AI summary'));
for(const noise of ['INE406A01037','source unit: pure','Routine trading-window metadata'])assert(!metadataHtml.includes(noise),'Metadata stays out of the investor sentence');
assert(!/\b(?:true|false)\b/.test(metadataHtml));
const metadataPdf=Buffer.from(renderBriefPdf(metadataBrief)).toString('latin1');
assert(metadataPdf.includes('Board meeting 4 Nov 2026')&&metadataPdf.includes('interim dividend.'),'The PDF investment briefing uses the same readable source note');
assert.equal(JSON.stringify(metadataBrief),metadataBefore,'Readable notes never alter retained source values');
const changedDate=structuredClone(readAuro);changedDate.content.facts.find(f=>f.location.endsWith('/DateOfProposedMeeting')).value='2026-11-05';
assert(xbrlBoardMeetingNote(changedDate).startsWith('Board meeting 5 Nov 2026'),'A read date overrides an older captured headline');
const cancelled=structuredClone(readAuro);cancelled.content.facts.find(f=>f.location.endsWith('/TypeOfIntimation')).value='Cancelled';
assert.equal(xbrlBoardMeetingNote(cancelled),null,'A cancelled notice cannot become a future plan');
const conflicted=structuredClone(readAuro);conflicted.content.facts.push({...conflicted.content.facts.find(f=>f.location.endsWith('/DateOfProposedMeeting')),value:'2026-11-06'});
assert.equal(xbrlBoardMeetingNote(conflicted),null,'Conflicting read contexts cannot be silently collapsed into one date');
assert.deepEqual(investorSourceFacts({content:{facts:[{field:'conditions',name:'Approval required',value:'false'}]}}).map(f=>f.value),['Approval required: No']);

const copiedNews={...story,sourceUrls:['https://www.livemint.com/companies/the-exact-article.html'],url:'https://news.google.com/rss/articles/opaque-one'};
assert.equal(clusterStories([copiedNews,{...copiedNews,url:'https://news.google.com/rss/articles/opaque-two'}]).length,1,'Captured article aliases corroborate different ingestion routes');
assert.equal(clusterStories([copiedNews,{...copiedNews,url:'https://news.google.com/rss/articles/opaque-two',headline:copiedNews.headline.replace('360','460')}]).length,2,'Conflicting figures cannot be hidden by an alias');
assert.equal(newsletterSourceUrl(copiedNews),'https://www.livemint.com/companies/the-exact-article.html','Use the captured publisher article rather than its discovery wrapper');
assert.equal(clusterStories([{...copiedNews,content:{state:'ready',hash:'old-news-body',facts:[]}},
 {...copiedNews,url:'https://news.google.com/rss/articles/opaque-two',content:{state:'ready',hash:'different-html-chrome',facts:[]}}]).length,1,'Different page HTML bytes alone cannot split the same corroborated article');
assert.equal(clusterStories([{...copiedNews,content:{state:'ready',hash:'old-news-body',facts:[{field:'amount',value:'INR 360 crore'}]}},
 {...copiedNews,url:'https://news.google.com/rss/articles/opaque-two',content:{state:'ready',hash:'corrected-news-body',facts:[{field:'amount',value:'INR 460 crore'}]}}]).length,2,'Material article corrections remain separate across discovery aliases');
assert.equal(newsletterSourceUrl({...story,url:'javascript:alert(1)',sourceUrls:[]}),null);
assert.equal(newsletterSourceUrl({...story,url:'https://www.livemint.com/'}),null,'A publisher homepage is not exact article evidence');
assert.equal(newsletterSourceUrl({...story,url:'https://www.livemint.com/?utm_source=discovery'}),null,'Tracking parameters cannot make a homepage into article evidence');
assert.equal(newsletterSourceUrl({...story,url:'https://fixture.test/?p=123'}),'https://fixture.test/?p=123','An exact query-based article identity remains usable');

// A long source URL is never substituted with the newsletter PDF, in either mode.
const traceable=structuredClone(brief),longSource='https://www.livemint.com/companies/exact-report.html?article='+('a'.repeat(1500))+'&edition=morning';
traceable.news.groups=[{ticker:'TRACED',company:'Traced company',items:[{...story,headline:'Traced company receives a signed customer contract',url:longSource,keys:['long-article'],keywords:[]}]}];
for(const compact of [false,true]){
 const tracedStats=briefStats(traceable),events=editorialEvents(traceable,tracedStats.companies).events;
 const html=renderBriefHtml(traceable,{...options,stats:tracedStats,part:{investor:true,reportLink:true,eventIds:events.map(e=>e.id),compact,supplements:false,index:1,total:1}});
 assert(html.includes('href="'+longSource.replaceAll('&','&amp;')+'"'),'The full article URL survives compact rendering');
 assert(!html.includes('Evidence →'),'An event link cannot be disguised as the complete-edition PDF');
 assert(html.includes('News report →')&&html.includes('Announcement →'));
}
// Every original attached to one deduplicated row is available directly from the inbox.
const multipleSources=structuredClone(traceable),multiRow=multipleSources.news.groups[0].items[0];
multiRow.content={state:'pending'};multiRow.sourceUrls=[longSource,'https://www.tradingview.com/news/exact-copy','https://archive.test/exact-captured-copy'];
const multiDb=new DatabaseSync(':memory:');multiDb.exec('CREATE TABLE newsletter_views(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
const multiShortcuts=newsletterSourceShortcuts(multiDb,options.dashboardUrl);multiShortcuts.prepare(multipleSources);
assert(multiShortcuts.links.has(longSource),'A long attached original is registered before publication');
const multiHtml=renderInvestorEmails(multipleSources,{...options,sourceLinks:multiShortcuts.links}).map(m=>m.html).join('');
for(const url of multiRow.sourceUrls)assert(multiHtml.includes('href="'+emailSourceUrl(url,multiShortcuts.links,options.dashboardUrl).replaceAll('&','&amp;')+'"'),'Every attached original is linked in email, including short-link publication');
multiDb.close();
const subscribed=renderInvestorEmails(traceable,{...options,recipient:{addedBy:'Ravi <Desk> & Team'},settings:{morning:{time:'09:15'},evening:{time:'15:45'}}})[0].html;
assert(subscribed.includes('Weekdays '+(traceable.edition==='morning'?'09:15':'15:45')+' IST.'));
assert(subscribed.includes('Added by Ravi &lt;Desk&gt; &amp; Team.')&&!subscribed.includes('Ravi <Desk>'),'Subscription provenance stays concise and escaped');

const pending=Array.from({length:40},(_,i)=>({id:`pending${i}`,kind:'story',main:{kind:'filing',content:{state:'pending'}},others:[]}));
const ready={id:'readable41',kind:'story',main:{kind:'filing',content:official.content},others:[]};
assert.deepEqual(aiItemsFor([{company:'Test',ticker:'TEST',clusters:[...pending,ready]}],new Map(),{readableOnly:true}).map(i=>i.id),['readable41'],'Pending leaders cannot consume the summary allowance');

{
// A delivered event cannot take a summary slot or inflate new-event coverage.
const covered=Array.from({length:40},(_,i)=>({id:'covered-'+i,kind:'story',main:{kind:'filing',headline:'Already covered',content:official.content,editorialReported:true},others:[]}));
const fresh={...ready,id:'fresh',main:{...ready.main,headline:'A genuinely new customer contract'}};
assert.deepEqual(aiItemsFor([{company:'Test',ticker:'TEST',clusters:[...covered,fresh]}],new Map(),{readableOnly:true}).map(i=>i.id),['fresh']);
let summaries=0;
const freshNotes=await readAiNotes({env:{CLAUDE_KEY:'ABSKfixture-only'},companies:[{company:'Test',ticker:'TEST',clusters:[...covered,fresh]}],fetcher:async(_url,init)=>{
 summaries++;const items=JSON.parse(JSON.parse(init.body).messages[0].content).ITEMS;assert.deepEqual(items.map(i=>i.id),['fresh']);
 return Response.json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify([{id:'fresh',summary:'A new customer contract was disclosed.',impact:'It could support revenue.'}])}]});
}});
assert.equal(summaries,1);assert.equal(freshNotes.requested,1);assert.equal(freshNotes.partial,false);
const historyNow=istInstant('2026-10-27','08:00'),historyData={
 '/data/portfolio-companies.json':{holdings:[{ticker:'TCS',name:'Tata Consultancy Services Limited'}]},
 '/data/market-news.json':{articles:[]},'/data/nse-filings/index.json':{days:[{day:'2026-10-26'}]},
 '/data/nse-filings/2026-10-26.json':{rows:[{ticker:'TCS',company:'Tata Consultancy Services Limited',subject:'Press Release',description:'A customer contract was announced',publishedAt:'2026-10-26T14:00:00Z',url:'https://nsearchives.nseindia.com/corporate/new-transport-copy.pdf'}]},
};let historyWriterCalls=0;
const acknowledged=await buildBrief({edition:'morning',day:'2026-10-27',now:historyNow,settings:DEFAULT_SETTINGS,includeAi:true,
 reported:{empty:false,since:historyNow-86400000,has:key=>key.startsWith('newsletter-event:')},
 env:{CLAUDE_KEY:'ABSKfixture-only',ASSETS:{fetch:async request=>historyData[new URL(request.url).pathname]?Response.json(historyData[new URL(request.url).pathname]):new Response(null,{status:404})}},
 contentService:{enqueue(){},async process(){},get:()=>({...official.content,hash:'acknowledged-document'})},
 fetcher:async(_url,init)=>{if(init?.body&&JSON.parse(init.body).messages){historyWriterCalls++;throw Error('An acknowledged source must not reach a writer');}return new Response(null,{status:503});},
});
assert.equal(briefStories(acknowledged).length,1,'The copied source remains in the complete report');
assert.equal(editorialEvents(acknowledged,briefStats(acknowledged).companies).events.length,0);
assert.equal(historyWriterCalls,0,'Durable event history is applied before the summary request');
assert.equal(acknowledged.ai.requested,0);assert.equal(acknowledged.ai.partial,false);
}

const db=new DatabaseSync(':memory:');
const storage={sql:{exec:(sql,...args)=>{const rows=db.prepare(sql).all(...args);return {toArray:()=>rows};}},transactionSync:fn=>{db.exec('BEGIN');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
const store=new NewsletterStore(storage,{now:()=>at});store.init();
await annotateEditorialHistory(brief,briefStats(brief).companies,store.reportedLookup());
const records=briefStats(brief).companies.flatMap(c=>c.stories.flatMap(s=>s.keys.map(key=>({key,publishedAt:s.at}))));
store.markReported(records,'acknowledged-edition',{windowFrom:brief.window.from});
const restarted=new NewsletterStore(storage,{now:()=>at+3600000});
await annotateEditorialHistory(brief,briefStats(brief).companies,restarted.reportedLookup());
assert.equal(editorialEvents(brief,briefStats(brief).companies).repeated.length,1,'An acknowledged event stays covered after restart');
brief.news.groups.push({ticker:brief.announcements.groups[0].ticker,company:brief.announcements.groups[0].company,items:[{headline:'Customer contract',at,keys:['new-unknown-source'],url:'https://fixture.test/new-unknown',publisher:'New publisher',keywords:[]}]});
await annotateEditorialHistory(brief,briefStats(brief).companies,restarted.reportedLookup());
assert.equal(editorialEvents(brief,briefStats(brief).companies).events.length,1,'A known member cannot suppress unknown new evidence without an event identity');
brief.news.groups.pop();
const sameTitle=structuredClone(brief);sameTitle.news.groups=[];
sameTitle.announcements.groups[0].items=[{...structuredClone(official),headline:'Lupin receives approval from the United States Food and Drug Administration',keys:['new-drug-approval'],content:{state:'pending'}}];
await annotateEditorialHistory(sameTitle,briefStats(sameTitle).companies,{has:()=>true,at:()=>at});
assert.equal(editorialEvents(sameTitle,briefStats(sameTitle).companies).events.length,1,'A later unread approval cannot be hidden just because an earlier event had the same specific-looking headline');
assert.deepEqual(sameTitle.announcements.groups[0].items[0].keys,['new-drug-approval'],'Headlines alone never supply durable delivered-version aliases');
for(const row of brief.announcements.groups[0].items){row.content.hash='corrected-document';row.content.facts[1].value='INR 110 crore';}
await annotateEditorialHistory(brief,briefStats(brief).companies,restarted.reportedLookup());
assert.equal(editorialEvents(brief,briefStats(brief).companies).events.length,1,'A changed document is a new material version');
const aged=new NewsletterStore(storage,{now:()=>at+20*86400000});
aged.markReported([{key:'recent-transport',publishedAt:at+20*86400000}],'later-edition');
assert.equal(aged.reportedLookup().has('official:NSE'),false,'Ordinary transport pruning remains bounded');
assert(aged.reportedLookup().has(records.find(r=>r.key.startsWith('newsletter-event:')).key),'Event versions survive transport/log retention');

// Migrate the actual old queue schema. Fresh risk disclosures lead; the oldest pending source
// still receives a reserved slot. No historical job or completed extraction is discarded.
db.exec("CREATE TABLE newsletter_content (id TEXT PRIMARY KEY,input TEXT NOT NULL,state TEXT NOT NULL,first_seen INTEGER NOT NULL,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,result TEXT)");
const queue=new NewsletterContentStore(storage);
const old={id:'a'.repeat(64),ticker:'OLD',kind:'news',headline:'Old retained company source',at:at-86400000,url:'https://fixture.test/old'};
queue.enqueue([old],at-86400000);
const fresh=Array.from({length:7},(_,i)=>({id:String(i+1).repeat(64),ticker:`NEW${i}`,kind:'filing',headline:'FDA inspection disclosure',at,url:`https://nsearchives.nseindia.com/fresh-${i}.pdf`}));
queue.enqueue(fresh,at);
assert.equal(queue.claim(at).item.kind,'filing');
assert.equal(queue.claim(at,[],{oldest:true}).item.ticker,'OLD');
assert.equal(queue.status().pending,8,'Claims preserve the complete pending queue');
db.prepare('UPDATE newsletter_content SET next_at=?').run(at+86400000);
queue.enqueue([{...old,id:'c'.repeat(64),ticker:'STALE_RISK',kind:'filing',headline:'FDA warning letter',at:at-10*86400000},
 {...old,id:'d'.repeat(64),ticker:'CURRENT',kind:'filing',headline:'Corporate announcement',at}],at);
assert.equal(queue.claim(at).item.ticker,'CURRENT','A newly discovered old risk disclosure cannot crowd out a current filing');
const legacyLink={...old,id:'b'.repeat(64),url:'https://news.google.com/rss/articles/opaque'};
db.prepare("INSERT INTO newsletter_content(id,input,state,first_seen,next_at,result) VALUES (?,?,'pending',?,?,?)").run(legacyLink.id,JSON.stringify(legacyLink),at-86400000,at+86400000,JSON.stringify({state:'pending',reason:'unsupported-source'}));
queue.enqueue([legacyLink],at);
assert.equal(db.prepare('SELECT next_at FROM newsletter_content WHERE id=?').get(legacyLink.id).next_at,at,'A newly supported legacy link receives one normal retry instead of waiting another day');
db.prepare('UPDATE newsletter_content SET next_at=? WHERE id=?').run(at+86400000,legacyLink.id);
queue.enqueue([legacyLink],at);
assert.equal(db.prepare('SELECT next_at FROM newsletter_content WHERE id=?').get(legacyLink.id).next_at,at+86400000,'The link-policy upgrade cannot reset backoff on every discovery');
const refused={...old,id:'e'.repeat(64)};queue.enqueue([refused],at);
const refusalJob=queue.claim(at,[refused.id]);queue.complete(refusalJob,{state:'pending',reason:'rate-limited'},at);
assert(db.prepare('SELECT next_at FROM newsletter_content WHERE id=?').get(refused.id).next_at<at+86400000,'A transient refusal keeps the normal retry backoff instead of a day-long unresolved-link delay');
db.close();

// Free discovery wrappers may resolve only to explicitly supported public publishers.
const publisher='https://www.livemint.com/companies/fixture-report.html';
await assert.rejects(fetchContent({kind:'news',url:'https://news.google.com/rss/articles/opaque'},async()=>new Response('',{status:503})),error=>error.reason==='rate-limited','Google 503 is a transient refusal, just like 429');
const wrapper='https://news.google.com/rss/articles/'+btoa('\x08\x13'+publisher+'\x00').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
let requests=0;
const resolved=await fetchContent({kind:'news',url:wrapper},async(url,options)=>{
 requests++;assert.equal(url,publisher);assert.equal(options.headers.authorization,undefined);
 return new Response('<article>Literal publisher content</article>',{headers:{'content-type':'text/html'}});
});
assert.equal(requests,1);assert.equal(resolved.url,publisher);
const opaque='https://news.google.com/rss/articles/opaque';
const redirected=await fetchContent({kind:'news',url:opaque},async url=>url===opaque?new Response(null,{status:302,headers:{location:publisher}}):new Response('Publisher body'));
assert.equal(redirected.url,publisher);
await assert.rejects(fetchContent({kind:'news',url:opaque},async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}})),/unsupported-redirect/);
await assert.rejects(fetchContent({kind:'news',url:opaque},async()=>new Response('<article>A Google interstitial is not the publisher article</article>')),/source-link-unresolved/);
const cached=await readDocumentFacts({item:{kind:'filing',ticker:'TEST',url:'https://www.bseindia.com/copy.pdf'},env:{},fetcher:async()=>new Response('%PDF-1.4 fixture'),cachedDocument:()=>({state:'ready',version:1,facts:official.content.facts})});
assert.equal(cached.state,'ready');assert.equal(cached.sourceUrl,'https://www.bseindia.com/copy.pdf');

let groupingCalls=0;
const manyCompanies={groups:Array.from({length:4},(_,i)=>({ticker:`ISSUER${i}`,company:`Issuer ${i}`,items:Array.from({length:60},(_,j)=>({headline:`Distinct business disclosure ${j}`,at,publisher:'Fixture',url:`https://fixture.test/source/${'x'.repeat(2000)}`,content:{facts:[{field:'event',value:'Source reading retained outside the grouping prompt'}]}}))}))};
const grouped=await reviewNewsEvents({news:manyCompanies,env:{CLAUDE_KEY:'ABSKfixture-only'},fetcher:async(_url,init)=>{
 groupingCalls++;const reports=JSON.parse(JSON.parse(init.body).messages[0].content).REPORTS;
 return Response.json({content:[{type:'text',text:JSON.stringify(reports.map(r=>[r.id]))}]});
}});
assert.equal(grouped.reviewed,240);assert.equal(groupingCalls,4);assert.equal(grouped.partial,false,'A shared 80-report ceiling cannot exclude every later company');
let packedCalls=0;
const smallCompanies={groups:Array.from({length:16},(_,i)=>({ticker:`SMALL${i}`,company:`Small issuer ${i}`,items:Array.from({length:5},(_,j)=>({headline:`Distinct company disclosure ${j}`,at,publisher:'Fixture'}))}))};
const packed=await reviewNewsEvents({news:smallCompanies,env:{CLAUDE_KEY:'ABSKfixture-only'},fetcher:async(_url,init)=>{
 packedCalls++;const reports=JSON.parse(JSON.parse(init.body).messages[0].content).REPORTS;
 return Response.json({content:[{type:'text',text:JSON.stringify(reports.map(r=>[r.id]))}]});
}});
assert.equal(packed.reviewed,80);assert.equal(packedCalls,1,'Small companies share the existing request capacity rather than consuming one call each');

// A busy edition has a fixed inbox budget, all distinct developments, no repeated raw snippets,
// and stable rendering for every personalised footer. HTML is inert and byte bounded.
const busy=structuredClone(brief);busy.announcements.groups[0].items=Array.from({length:180},(_,i)=>({...structuredClone(official),
 headline:`Distinct contract ${i} with Customer ${i}`,url:`https://fixture.test/material/${i}`,keys:[`material:${i}`],content:{state:'pending'},editorialReported:false,at:at-i*1000}));
busy.ai={ok:false,items:{}};
const digest=renderInvestorEmails(busy,options);
assert(digest.length<=EDITORIAL_EMAIL_PARTS);assert(digest.every(m=>m.bytes<=90000));
assert(digest.length>1);assertEnding(digest,busy);
assert.deepEqual(digest.flatMap(m=>m.part.eventIds),editorialEvents(busy,briefStats(busy).companies).events.map(e=>e.id),'Reserving the ending cannot reorder the company reading flow');
assert.deepEqual(digest.flatMap(m=>m.part.eventIds).sort(),editorialEvents(busy,briefStats(busy).companies).events.map(e=>e.id).sort());
for(const message of digest)assert(message.html.includes('Headline only'));
const supplemented=structuredClone(busy);supplemented.announcements.groups[0].items=supplemented.announcements.groups[0].items.slice(0,30);
supplemented.calendar.rows=Array.from({length:80},(_,i)=>({...structuredClone(brief.calendar.rows[0]),label:`Results/call ${i} ${'x'.repeat(250)}`}));
const supplementStats=briefStats(supplemented),supplementEvents=editorialEvents(supplemented,supplementStats.companies).events;
const measured=(ids,closing)=>emailBytes(renderBriefHtml(supplemented,{...options,stats:supplementStats,part:{investor:true,reportLink:true,eventIds:ids,index:closing?3:1,total:3,packing:true,supplements:true,compact:false}}));
const ordinaryBase=measured([],false),endingBase=measured([],true),oneCard=measured([supplementEvents[0].id],false)-ordinaryBase;
const supplementalBudget=endingBase+3*oneCard+1024;
assert(supplementalBudget<90000&&endingBase-ordinaryBase>27*oneCard,'The fixture needs company readings first, then a substantial final table section');
const supplementDigest=renderInvestorEmails(supplemented,options,{maxBytes:supplementalBudget});
assert.equal(supplementDigest.length,2);assert(supplementDigest.every(m=>m.part.supplements&&!m.part.compact&&m.bytes<=supplementalBudget),'Only the ending must reserve the complete tables and full footer');
assert.equal(supplementDigest.flatMap(m=>m.part.eventIds).length,30);
assertEnding(supplementDigest,supplemented);
assert.equal(supplementDigest[0].part.eventIds.length,30,'Keep the whole company together before the final tables');
assert.equal(supplementDigest[1].part.eventIds.length,0);
assert(!supplementDigest[1].html.includes('YOUR PORTFOLIO COMPANIES')&&!supplementDigest[1].html.includes('No new developments'),'A tables-only ending must not imply that the preceding company readings are empty');
for(const row of supplemented.calendar.rows)assert(supplementDigest.at(-1).html.includes(row.label),'Every upcoming row is retained in the final email');
const oversizedEnding=structuredClone(brief);oversizedEnding.calendar.rows[0].label='x'.repeat(100000);
assert.throws(()=>renderInvestorEmails(oversizedEnding,options),e=>e.code==='email-too-large','An unfit closing table cannot silently disappear into a PDF fallback');
const crowded=structuredClone(busy);
crowded.announcements.groups=Array.from({length:320},(_,i)=>({ticker:`CROWDED${i}`,company:`Material Issuer ${i}`,items:[{...structuredClone(busy.announcements.groups[0].items[0]),headline:`Distinct contract ${i} with Customer ${i}`,keys:[`crowded:${i}`],url:`https://fixture.test/material/${i}?discovery=${'x'.repeat(1000)}`}]}));
assert.throws(()=>renderInvestorEmails(crowded,options),error=>error.code==='email-too-large','An edition with exceptionally large source URLs must fail closed, never replace article links or send a partial plan');
const shortcutDb=new DatabaseSync(':memory:');shortcutDb.exec('CREATE TABLE newsletter_views(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
const shortcuts=newsletterSourceShortcuts(shortcutDb,options.dashboardUrl);shortcuts.prepare(crowded);
const shortcutDigest=renderInvestorEmails(crowded,{...options,sourceLinks:shortcuts.links});
assert(shortcutDigest.length<=3&&shortcutDigest.every(m=>m.bytes<=90000));
assert.deepEqual(shortcutDigest.flatMap(m=>m.keys).sort(),briefStoryKeys(crowded).sort());
assert.equal(new Set(shortcutDigest.flatMap(m=>m.part.eventIds)).size,320);
for(const group of crowded.announcements.groups){
 const original=group.items[0].url,alias=shortcuts.links.get(original);
 assert(alias);assert.equal(shortcuts.record(alias.split('/').at(-1)).url,original);
 assert(shortcutDigest.some(m=>m.html.includes(`href="${alias}"`)));
}
const restoredShortcuts=newsletterSourceShortcuts(shortcutDb,options.dashboardUrl);
assert.deepEqual(restoredShortcuts.links,shortcuts.links,'Restart never changes emailed source destinations');
const firstOriginal=crowded.announcements.groups[0].items[0].url,firstAlias=shortcuts.links.get(firstOriginal);
assert.equal(shortcuts.register(firstOriginal),firstAlias);
assert.equal(emailSourceUrl(firstOriginal,new Map([[firstOriginal,options.pdfUrl]]),options.dashboardUrl),firstOriginal);
assert.equal(emailSourceUrl(firstOriginal,new Map([[firstOriginal,firstAlias.replace(new URL(firstAlias).origin,'https://evil.test')]]),options.dashboardUrl),firstOriginal);
assert.equal(sourceTarget({format:SOURCE_LINK_FORMAT,url:options.pdfUrl}),null);
const ids=emailSourceIds(shortcutDigest.map(m=>m.html).join(''),options.dashboardUrl);assert.equal(ids.length,320);
let verifyCalls=0;
const expected=ids.map(id=>({id,url:shortcuts.record(id).url}));
const verifySources=sourcePublicationVerifier(options.dashboardUrl,{timeout:0,fetcher:async url=>{verifyCalls++;const wanted=new URL(url).searchParams.get('ids').split(',');assert(wanted.length<=SOURCE_LOOKUP_BATCH_SIZE);return Response.json({ok:true,format:SOURCE_LINK_FORMAT,lookupFormat:SOURCE_INDEX_FORMAT,links:expected.filter(r=>wanted.includes(r.id))});}});
await verifySources(expected);assert.equal(verifyCalls,64);await verifySources(expected);assert.equal(verifyCalls,64,'Verified immutable targets are reused within a run');
await assert.rejects(sourcePublicationVerifier(options.dashboardUrl,{timeout:0,fetcher:async()=>new Response(null,{status:404})})(expected),/not published/);
await assert.rejects(sourcePublicationVerifier(options.dashboardUrl,{timeout:0,fetcher:async url=>{const wanted=new URL(url).searchParams.get('ids').split(',');return Response.json({ok:true,format:SOURCE_LINK_FORMAT,lookupFormat:SOURCE_INDEX_FORMAT,links:expected.filter(r=>wanted.includes(r.id)).map(r=>({...r,url:options.pdfUrl}))});}})(expected),/not published/);
await assert.rejects(sourcePublicationVerifier(options.dashboardUrl,{timeout:0,fetcher:async url=>{const wanted=new URL(url).searchParams.get('ids').split(',');return Response.json({ok:true,format:SOURCE_LINK_FORMAT,links:expected.filter(r=>wanted.includes(r.id))});}})(expected),/not published/,'The old resource-heavy lookup cannot pass publication verification');
shortcutDb.close();
// Link reads have an independent byte budget. A large neighbouring PDF and a
// growing immutable source history must not inflate the source lookup payload.
const indexedRecords=new Map(Array.from({length:2048},(_,i)=>[`source-00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,{format:SOURCE_LINK_FORMAT,url:`https://publisher.test/story/${i}?captured=${'x'.repeat(500)}`} ]));
indexedRecords.set('pdf-unrelated',{body:'PDF_SENTINEL_NOT_IN_SOURCE_INDEX'});
const index=newsletterSourceViews(indexedRecords,{repo:'techmuns/Sattva-Central-Research',env:{BACKGROUND_STATE_KEY:'fixture-source-index-secret-only'}});
assert.equal(index.directory.format,SOURCE_INDEX_FORMAT);assert(Object.keys(index.directory.buckets).length<=64);
const indexedPages=index.views.filter(v=>v.name.startsWith('sources-page-'));
assert(indexedPages.length>64,'The fixture must exercise multiple bounded pages per bucket');
assert(indexedPages.every(v=>Buffer.byteLength(JSON.stringify(v.value))<=SOURCE_PAGE_BYTES+128),'Ordinary source-only pages stay around 12 KiB, regardless of PDF history');
const indexedEntries=indexedPages.flatMap(v=>Object.entries(v.value.records));
assert.equal(indexedEntries.length,2048);assert.equal(new Set(indexedEntries.map(([id])=>id)).size,2048);
for(const [id,value]of indexedEntries)assert.deepEqual(value,indexedRecords.get(id));
assert(!JSON.stringify(index.views).includes('PDF_SENTINEL'));
const fallback=await newsletterSourceReader({},options.dashboardUrl,{},async key=>{assert.equal(key,'source-'+ids[0]);return {format:SOURCE_LINK_FORMAT,url:firstOriginal};})(ids[0]);
assert.equal(fallback,firstOriginal,'A deployed reader still supports earlier prepared snapshots');
const oversized=new Map([['source-00000000-0000-4000-8000-000000000000',{format:SOURCE_LINK_FORMAT,url:'https://publisher.test/story/'+('x'.repeat(SOURCE_RECORD_BYTES))}]]);
assert.throws(()=>newsletterSourceViews(oversized,{repo:'fixture/repo',env:{BACKGROUND_STATE_KEY:'fixture-source-index-secret-only'}}),/exceeds/,'Oversized source records fail publication rather than truncating their destination');
for(const group of crowded.announcements.groups)group.items[0].url=group.items[0].url.split('?')[0];
const compactDigest=renderInvestorEmails(crowded,options);
assertEnding(compactDigest,crowded);
assert(compactDigest.length<=3&&compactDigest.every(m=>m.part.compact&&m.bytes<=90000),'A busy multi-company edition must use the genuinely compact branded rows');
assert.equal(compactDigest.flatMap(m=>m.part.eventIds).length,320);
assert.deepEqual(compactDigest.flatMap(m=>m.keys).sort(),briefStoryKeys(crowded).sort());
const dense=structuredClone(busy);
dense.announcements.groups=Array.from({length:500},(_,i)=>({ticker:`DENSE${i}`,company:`Material Issuer ${i}`,items:[{...structuredClone(official),
 headline:`Issuer ${i} signed an INR 100 crore customer contract, subject to final approvals, with work scheduled to start in November 2026. The filing describes implementation steps and supporting administrative details available in the original announcement and its supporting source documents.`,
 keys:[`dense:${i}`],content:{state:'pending'},sourceUrls:[],
 url:`https://www.bseindia.com/xml-data/corpfiling/AttachLive/00000000-0000-4000-8000-${String(i).padStart(12,'0')}.pdf`}]}));
const denseBefore=JSON.stringify(dense),packingStarted=performance.now(),denseDigest=renderInvestorEmails(dense,options),denseHtml=denseDigest.map(m=>m.html).join('');
const packing500Ms=Math.round(performance.now()-packingStarted);
assertEnding(denseDigest,dense);
assert(packing500Ms<20000,'500 distinct disclosures pack within 20 seconds on one standard runner');
assert(denseDigest.length<=3&&denseDigest.every(m=>m.part.compact&&m.part.summaryChars===140&&m.bytes<=90000),'A dense edition shortens excerpts before exceeding the existing three-email limit');
assert.equal(denseDigest.flatMap(m=>m.part.eventIds).length,500);
assert.equal(new Set(denseDigest.flatMap(m=>m.part.eventIds)).size,500,'Every investor update appears once');
assert.deepEqual(denseDigest.flatMap(m=>m.keys).sort(),briefStoryKeys(dense).sort());
for(const group of dense.announcements.groups)assert(denseHtml.includes(`href="${group.items[0].url}"`),'Dense packing retains the full exact announcement URL');
assert.equal(JSON.stringify(dense),denseBefore,'Shorter inbox excerpts cannot rewrite the captured record');
const shortestDigest=renderInvestorEmails(dense,options,{maxBytes:80000});
assertEnding(shortestDigest,dense);
assert(shortestDigest.length<=3&&shortestDigest.every(m=>m.part.summaryChars===100&&m.bytes<=80000),'The shortest tier stays bounded under additional byte pressure');
assert.equal(new Set(shortestDigest.flatMap(m=>m.part.eventIds)).size,500);
assert.deepEqual(shortestDigest.flatMap(m=>m.keys).sort(),briefStoryKeys(dense).sort());
const noticeStats=briefStats(metadataBrief),noticeEvents=editorialEvents(metadataBrief,noticeStats.companies).events;
const denseNotice=renderBriefHtml(metadataBrief,{...options,stats:noticeStats,part:{investor:true,reportLink:true,eventIds:noticeEvents.map(e=>e.id),compact:true,summaryChars:100,supplements:false,index:1,total:1}});
assert(denseNotice.includes(notice),'A structured meeting notice retains its later dividend agenda in the shortest mode');
const longNoticeBrief=structuredClone(metadataBrief);
const longNoticeItem=longNoticeBrief.announcements.groups.flatMap(g=>g.items).find(s=>s.content?.format==='xbrl');
longNoticeItem.content.facts.find(f=>f.location.endsWith('/Agenda1')).value='Financial results and consideration of the detailed implementation schedule, regulatory conditions, reporting requirements and financial arrangements relating to the proposed business expansion';
const longNotice=xbrlBoardMeetingNote({...longNoticeItem,kind:'filing'});assert(longNotice.length>220&&longNotice.includes('dividend'));
const longNoticeStats=briefStats(longNoticeBrief),longNoticeEvents=editorialEvents(longNoticeBrief,longNoticeStats.companies).events;
const longNoticeHtml=renderBriefHtml(longNoticeBrief,{...options,stats:longNoticeStats,part:{investor:true,reportLink:true,eventIds:longNoticeEvents.map(e=>e.id),compact:true,summaryChars:100,supplements:false,index:1,total:1}});
assert(longNoticeHtml.includes(longNotice),'A free-form agenda cannot truncate the later dividend or any other structured agenda');
assert.throws(()=>renderInvestorEmails(brief,{...options,pdfUrl:'https://example.test/api/newsletter/preview'}),/immutable/);
if(process.env.NEWSLETTER_INVESTOR_OUTPUT){
 const dir=process.env.NEWSLETTER_INVESTOR_OUTPUT;mkdirSync(dir,{recursive:true});
 writeFileSync(`${dir}/investor-email.html`,messages[0].html);
 writeFileSync(`${dir}/investor-brief.pdf`,renderBriefPdf(brief));
 writeFileSync(`${dir}/busy-email.html`,digest[0].html);
 digest.forEach((message,i)=>writeFileSync(`${dir}/busy-email-${i+1}.html`,message.html));
 writeFileSync(`${dir}/market-colours.html`,colouredHtml);
 writeFileSync(`${dir}/compact-ending.html`,shortestDigest.at(-1).html);
}
console.log(`PASS investor replay: ${excluded.length} actual attribution/noise cases, direct source links, Aurobindo/Bharat copy regressions, lossless source register, corrections, acknowledged restart, readable summary admission, queue priority/fairness, ${digest.length} email(s) for 180 distinct material disclosures; 500-disclosure packing ${packing500Ms}ms`);
