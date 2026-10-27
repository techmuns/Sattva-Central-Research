// Real 27 October Biocon/HFCL/SONACOMS failures, replayed without network, paid
// lookup/model credits or email. The source fixture contains public evidence only.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {pdfFixture} from './verify-newsletter-pdf.mjs';
import {briefStats,briefStoryKeys,briefCompanies,clusterStories,aiItemsFor,renderBriefHtml} from '../worker/newsletter-brief.mjs';
import {editorialEvents,EDITORIAL_VERSION} from '../worker/newsletter-editorial.mjs';
import {headlineKey,companyReadings,supportingDocumentSummary} from '../worker/newsletter-company-reading.mjs';
import {renderInvestorEmails} from '../worker/newsletter-email.mjs';
import {xbrlFacts} from '../worker/newsletter-content.mjs';
import {renderBriefPdf} from '../worker/newsletter-pdf.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/newsletter/company-headlines-2026-10-27.json',import.meta.url)));
const rows=fixture.rows;
for(const [name,index]of [['biocon',1],['hfcl',2]])assert.deepEqual(rows[index].content.facts,xbrlFacts(readFileSync(new URL(`./fixtures/newsletter/${name}-2026-10-26.xml`,import.meta.url),'utf8'),name.toUpperCase()),'Replay the actual native XML, not a hand-written projection');
const companies=items=>briefCompanies(items.map(r=>({...r,mood:{id:'neutral'}})));
const fromRows=items=>{
  const brief=pdfFixture();brief.ai=null;brief.edition='morning';brief.day='2026-10-27';brief.at=brief.builtAt=Date.parse('2026-10-27T08:00:00+05:30');brief.window={from:Date.parse('2026-10-26T16:00:00+05:30'),to:brief.at};brief.performance.rows=[];
  const groups=kind=>[...new Set(items.filter(r=>r.kind===kind).map(r=>r.ticker))].map(ticker=>({ticker,company:items.find(r=>r.ticker===ticker).company,items:items.filter(r=>r.kind===kind&&r.ticker===ticker).map(r=>({...r,publisher:r.source,exchanges:['NSE'],keywords:[]}))}));
  brief.announcements.groups=groups('filing');brief.news.groups=groups('news');
  brief.announcements.count=items.filter(r=>r.kind==='filing').length;brief.news.count=items.filter(r=>r.kind==='news').length;
  brief.trades.groups=[];brief.moves.groups=[];brief.calendar.rows=[];brief.actions.rows=[];brief.markets.rows=[];
  return brief;
};
const reading=editorialEvents({},companies(rows));
assert.equal(EDITORIAL_VERSION,1,'Do not invalidate the durable delivered-source ledger and resend historical events');
assert.equal(reading.readingVersion,2);
assert.equal(reading.events.filter(e=>e.ticker==='BIOCON').length,1,'Biocon: mixed board/call PDF and native NSE meeting notice are one source event');
assert.equal(clusterStories(rows.filter(r=>r.ticker==='BIOCON')).length,1,'Consolidate before summary generation');
const hfcl=reading.events.filter(e=>e.ticker==='HFCL');assert.equal(hfcl.length,1,'HFCL: cover notice, full transcript and unread exchange notice share one reading');
assert(hfcl[0].summary.includes('394.22')&&!hfcl[0].summary.includes('no financial content'),'Full source reading leads over cover logistics');
assert.equal(hfcl[0].sources.length,3);assert.equal(hfcl[0].variants.length,3,'Uncertain source relationships remain retained as distinct variants');
for(const ticker of ['BIOCON','HFCL']){
 const requests=aiItemsFor(companies(rows),new Map(),{readableOnly:true}).filter(i=>i.ticker===ticker);
 assert.equal(requests.length,1,'Exactly one summary request per consolidated reading');
 assert(requests[0].SOURCE_EVIDENCE.length>=2,'All source evidence reaches that one summary request');
}
const sona=reading.events.filter(e=>e.ticker==='SONACOMS');assert.equal(sona.length,6);
assert(sona.some(e=>e.summary?.includes('DENSO')),'Results headlines cannot erase genuine transaction developments');
assert.equal(new Set(reading.events.flatMap(e=>e.sources)).size,new Set(rows.map(r=>r.url)).size,'Every exact source survives consolidation');
const assertBlocks=sequence=>{const closed=new Set();let previous;for(const ticker of sequence){if(ticker!==previous){assert(!closed.has(ticker),'A company must not reopen after another company');if(previous)closed.add(previous);previous=ticker;}}};
assertBlocks(reading.events.map(e=>e.ticker));
for(const ticker of new Set(rows.map(r=>r.ticker))){const seen=new Set();for(const event of reading.events.filter(e=>e.ticker===ticker))for(const v of event.variants){const key=headlineKey(v.lead.headline);if(seen.has(key))assert(event.variants.some(x=>x!==v&&headlineKey(x.lead.headline)===key));seen.add(key);}}
// Source revisions and new terms are never deleted to obtain a unique headline.
const base=rows.find(r=>r.kind==='news'),one={...base,url:'https://fixture.test/order-a',headline:'Company approves an investment',content:{state:'ready',hash:'order-a',facts:[{field:'event',value:'Order awarded to Customer Alpha'},{field:'amount',value:'INR 100 crore'}]}};
const two={...one,url:'https://fixture.test/order-b',content:{state:'ready',hash:'order-b',facts:[{field:'event',value:'Revised order awarded to Customer Beta'},{field:'amount',value:'INR 200 crore'}]}};
const changed=editorialEvents({},companies([one,two])).events;
assert.equal(changed.length,1,'One heading for identical titles');assert.equal(changed[0].variants.length,2,'Separate economic versions remain present');
assert.equal(changed[0].additionalReadings.length,1);assert(JSON.stringify(changed).includes('100 crore')&&JSON.stringify(changed).includes('200 crore')&&JSON.stringify(changed).includes('Customer Beta'));
const biocon=rows.filter(r=>r.ticker==='BIOCON');
for(const [name,alter] of [
 ['date',s=>s.replaceAll('2026-11-04','2026-11-05')],
 ['period',s=>s.replaceAll('September','June')],
 ['revision',s=>s.replace('"New"','"Revised"')],
]){const changed=JSON.parse(alter(JSON.stringify(biocon[1])));changed.url='https://fixture.test/'+name;changed.content.hash='other-'+name;assert.equal(clusterStories([biocon[0],changed]).length,2,`Different ${name} must survive`);}
const extraAgenda=structuredClone(biocon[0]);extraAgenda.url='https://fixture.test/extra-agenda';extraAgenda.content.hash='extra-agenda';extraAgenda.content.facts.find(f=>f.field==='event').value+=' and employee stock option plan';
assert.equal(clusterStories([extraAgenda,biocon[1]]).length,2,'Mixed board documents cannot hide an unclassified additional proposal even with a matching financial period');
const dated=structuredClone(rows[2]);dated.url='https://fixture.test/other-call';dated.content.hash='other-call';dated.content.facts.find(f=>f.location.endsWith('/DateOfCallForTranscriptsOfEarningsOrQuarterlyCalls')).value='2026-10-20';
const differentCalls=editorialEvents({},companies([rows[2],dated])).events;
assert.equal(differentCalls[0].variants.length,2,'Identical headings still retain both explicitly dated calls');
for(const date of ['2026-10-19','2026-10-20'])assert(JSON.stringify([differentCalls[0].sourceSummary,differentCalls[0].additionalReadings]).includes(date),'Both distinct call dates are visible inside the unique headline');
const invalidCall=structuredClone(rows[2]);invalidCall.content.facts.find(f=>f.location.endsWith('/DateOfCallForTranscriptsOfEarningsOrQuarterlyCalls')).value='2026-02-31';
assert.equal(supportingDocumentSummary(invalidCall),null,'Invalid native call dates cannot become factual prose or identity');
assert.equal(companyReadings([]).length,0);
const tradeA={...rows[0],kind:'trade',headline:'Insider purchase reported',dek:'Director Alpha bought 10 shares',url:'https://fixture.test/trade-a',content:null};
const tradeB={...tradeA,dek:'Director Beta bought 20 shares',at:tradeA.at+60000,url:'https://fixture.test/trade-b'};
const measurements=editorialEvents({},companies([tradeA,tradeB])).events;
assert.equal(measurements.length,1,'Identical trade headings print once');assert.equal(measurements[0].variants.length,2,'Separate measurements remain separate retained records');
assert(measurements[0].description.includes('Director Beta bought 20 shares'));assert(measurements[0].additionalReadings.some(r=>r.text.includes('Director Alpha bought 10 shares')&&r.at===tradeA.at),'Every distinct measurement keeps its details, date and exact source inside the shared heading');
assert.equal(aiItemsFor(companies([tradeA,tradeB])).length,0,'Trade observations consume no model allowance');
// A writer note is applied once to the conserved group, even when its strongest
// document is a different member from the stable group identity.
const canonical=hfcl[0].id,consolidated=editorialEvents({ai:{items:{[canonical]:{summary:'Consolidated HFCL source reading',impact:'',unknowns:''}}}},companies(rows));
assert.equal(consolidated.events.find(e=>e.id===canonical).summary,'Consolidated HFCL source reading');
const conflicting=structuredClone(hfcl[0].variants);conflicting[0].cluster.versionConflict=true;conflicting[0].summary=null;conflicting[0].sourceSummary='Captured versions conflict; chronology unconfirmed.';
const protectedReading=companyReadings(conflicting,{[canonical]:{summary:'Unsupported consolidated version selection'}})[0];
assert.notEqual(protectedReading.summary,'Unsupported consolidated version selection','Consolidated notes cannot override an existing source-version conflict guard');
assert(protectedReading.variants.some(v=>v.cluster.versionConflict),'Every conflicted source version remains retained');
const brief=fromRows(rows),before=JSON.stringify(brief),stats=briefStats(brief);
const options={brand:'Sattva Ventures',productName:'Research Central',dashboardUrl:'https://example.test',pdfUrl:'https://example.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000001'};
const messages=renderInvestorEmails(brief,options);assert(messages.length<=3);
assert.deepEqual(new Set(messages.flatMap(m=>m.keys)),new Set(briefStoryKeys(brief)));
const snapshot=editorialEvents(brief,stats.companies);
for(const compact of [false,true]){
 const html=renderBriefHtml(brief,{...options,stats,reading:snapshot,part:{investor:true,eventIds:snapshot.events.map(e=>e.id),index:1,total:1,compact,summaryChars:220,supplements:false}});
 assertBlocks([...html.matchAll(/data-company="([^"]+)"/g)].map(m=>m[1]));
 const headline='Sona Blw Precision Forgings Ltd Sept-Quarter Consol Net Profit 2.23 Billion Rupees';
 assert.equal(html.split(headline).length-1,1,'The user’s exact repeated headline appears once in each renderer');
 for(const name of ['Biocon Ltd','HFCL Limited','Sona BLW Precision Forgings Ltd'])assert.equal((html.match(new RegExp('>'+name+'(?:</strong>| <span)','g'))||[]).length,1,'One company heading in detailed and compact emails');
 for(const source of new Set(rows.map(r=>r.url)))assert(html.includes(source.replaceAll('&','&amp;')),'Every original link stays in the email');
 for(const label of ['Partial coverage:','Open dashboard','Coverage details (PDF)'])assert(!html.includes(label));
 for(const color of ['#eef2ff','#4f46e5','#0f172a'])assert(html.includes(color));
 mkdirSync('.cache/newsletter-company-ledger',{recursive:true});writeFileSync(`.cache/newsletter-company-ledger/${compact?'compact':'detailed'}.html`,html);
}
const pdf=renderBriefPdf(brief,options);writeFileSync('.cache/newsletter-company-ledger/replay.pdf',pdf);
assert.equal(JSON.stringify(brief),before,'Rendering never rewrites source evidence');
// Exercise company packing, not only single-company or single-part fixtures.
const dense=fromRows(Array.from({length:72},(_,i)=>({...base,ticker:'C'+Math.floor(i/6),company:'Company '+Math.floor(i/6),headline:`Distinct current update ${i} for company ${Math.floor(i/6)}`,url:`https://fixture.test/current/${i}`,keys:['dense:'+i],at:base.at+i*10000})));
const packed=renderInvestorEmails(dense,options,{maxBytes:20000,maxParts:3});assert(packed.length>1&&packed.length<=3);
assertBlocks(packed.flatMap(m=>[...m.html.matchAll(/data-company="([^"]+)"/g)].map(x=>x[1])));
const owners=new Map();for(const [i,message]of packed.entries())for(const match of message.html.matchAll(/data-company="([^"]+)"/g)){const ticker=match[1];assert(!owners.has(ticker)||owners.get(ticker)===i,'A company that fits stays in one email');owners.set(ticker,i);}
console.log(`PASS 27 October company ledger: Biocon merged before summary, HFCL transcript preferred, 3 SONACOMS headline pairs once, all ${rows.length} source records retained, changed terms/dates/corrections preserved, detailed/compact/company packing; external calls=0`);
