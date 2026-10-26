// Actual saved 27 October preview cases. Never call a source, search or model.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {xbrlFacts} from '../worker/newsletter-content.mjs';
import {clusterStories,briefStats,renderBriefHtml,aiItemsFor} from '../worker/newsletter-brief.mjs';
import {editorialEvents} from '../worker/newsletter-editorial.mjs';
import {investmentProfiles,sameInvestmentEvent,investmentReading,investmentMoney} from '../worker/newsletter-investment-events.mjs';
import {pdfFixture} from './verify-newsletter-pdf.mjs';
import {printable} from '../worker/newsletter-pdf-layout.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/newsletter/live-investments-2026-10-27.json',import.meta.url)));
const names={VARROC:'Varroc Engineering Limited',SHOPERSTOP:'Shoppers Stop Ltd',PURVA:'Puravankara Limited',KSB:'KSB Ltd'};
const files={VARROC:'varroc-investment-update.xml',SHOPERSTOP:'shoppers-stop-investment-update.xml',PURVA:'puravankara-board-notice.xml',KSB:'ksb-board-notice.xml'};
const all=new Map();
for(const c of fixture.cases){
 const rows=c.rows.flatMap((r,index)=>{
  const native=r.urls[0].includes('/xbrl/'),news=/Reported development/.test(r.text),clock=/(\d+) Oct, (\d\d):(\d\d) IST/.exec(r.text);
  return r.urls.map((url,i)=>({ticker:c.ticker,company:names[c.ticker],kind:news?'news':'filing',headline:r.description,
   at:Date.parse(`2026-10-${clock[1]}T${clock[2]}:${clock[3]}:00+05:30`),url,keys:[`${c.ticker}:${index}:${i}`],score:1,source:'Saved original',topic:{label:'Deals'},mood:{label:'Neutral'},
   content:news?{state:'pending'}:{state:'ready',format:native?'xbrl':'pdf',hash:`document:${url}`,facts:native?xbrlFacts(readFileSync(new URL('./fixtures/newsletter/'+files[c.ticker],import.meta.url),'utf8'),c.ticker):c.sourceFacts.map(f=>({...f,quote:f.value,location:'Saved PDF source register'}))}}));
 });
 all.set(c.ticker,rows);
 const groups=clusterStories(rows,{company:names[c.ticker]});
 assert.equal(groups.length,1,`${c.ticker}: every demonstrated filing/news copy represents one event`);
 assert.equal(groups[0].items,rows.length,'No captured source row is discarded');
 const brief=pdfFixture();brief.ai={ok:false,items:{}};brief.news.groups=[];brief.announcements.groups=[];
 const clusters=groups.map((g,i)=>({...g,id:`${c.ticker}#${i+1}`}));
 const companies=[{ticker:c.ticker,company:names[c.ticker],stories:rows,clusters}];
 assert.equal(aiItemsFor(companies).length,1,'The consolidated event is offered to the final writer once');
 const event=editorialEvents(brief,companies).events[0];
 assert(event.completeSourceSummary,`${c.ticker}: a whole factual reading survives the smallest packing tier`);
 assert.deepEqual(new Set(event.sources),new Set(rows.map(r=>r.url)));
 if(c.ticker==='VARROC')for(const term of ['€4.5 million','45%','80,380 OCPRS','Completion pending','Conditions precedent','December 31, 2026'])assert(event.sourceSummary.includes(term),term);
 if(c.ticker==='SHOPERSTOP')for(const term of ['₹10 crore','second tranche','GSSBBL','completed','₹135 crore','15 working days','Related-party'])assert(event.sourceSummary.includes(term),term);
 if(c.ticker==='PURVA'){assert(event.sourceSummary.includes('2 Nov 2026'));assert(/quarter and half year ended September 30, 2026/i.test(event.sourceSummary));assert(!/Trading window|Filed with|regulatory basis/i.test(event.sourceSummary));}
 if(c.ticker==='KSB'){assert(event.sourceSummary.includes('3 Nov 2026'));assert(/unaudited standalone and consolidated quarterly financial results for the period ended September 2026/i.test(event.sourceSummary));assert(!/Trading window|Directors\/Officers/i.test(event.sourceSummary));}
 const stats={...briefStats(brief),companies};
 const html=renderBriefHtml(brief,{stats,dashboardUrl:'https://fixture.test',part:{investor:true,eventIds:clusters.map(c=>c.id),compact:true,summaryChars:100,index:1,total:1,supplements:false}});
 assert(html.replaceAll('&#39;',"'").replaceAll('&amp;','&').includes(event.sourceSummary),'The key terms are never cut by the 100-character packing tier');
 if(c.ticker==='PURVA'){
  const original=rows.find(r=>r.content.format==='pdf');
  const mirror={...original,kind:'news',url:'https://fixture.test/verified-document-mirror',headline:'Mirror of the same announcement',content:{...original.content,facts:[{field:'event',value:'An alternate extraction of the same verified bytes'}]}};
  const mirrorRows=[...rows,mirror],mirrorClusters=clusterStories(mirrorRows).map((g,i)=>({...g,id:`${c.ticker}#${i+1}`}));
  assert.equal(mirrorClusters.length,1);
  const mirrorEvent=editorialEvents(brief,[{...companies[0],stories:mirrorRows,clusters:mirrorClusters}]).events[0];
  assert(mirrorEvent.completeSourceSummary&&mirrorEvent.sourceSummary.includes('half year ended September 30, 2026'),'A verified document mirror cannot veto the complete original reading or erase the financial period');
 }
 if(['VARROC','SHOPERSTOP'].includes(c.ticker)){
  const anchor=rows.find(r=>r.kind==='filing'&&r.content.format==='pdf'),native=rows.find(r=>r.content.format==='xbrl'),news=rows.find(r=>r.kind==='news');
  const changed=structuredClone(anchor);changed.url='https://fixture.test/changed-price';changed.content.hash='changed-price';changed.content.facts.find(f=>f.field==='amount').value=changed.content.facts.find(f=>f.field==='amount').value.replace(/10|4\.5/,c.ticker==='VARROC'?'5.5':'20');
  const p=investmentProfiles([anchor,changed]);assert(!sameInvestmentEvent(anchor,changed,p),'Changed consideration is a distinct development');
  const later=structuredClone(native);later.url='https://fixture.test/later-date';later.content.facts.find(f=>f.location.endsWith('/DateOfOccurrenceOfEvent')).value='2026-10-27';
  assert.equal(clusterStories([anchor,later]).length,2,'Explicit later dates cannot merge');
  const revised=structuredClone(news);revised.url='https://fixture.test/revised';revised.headline+='; revised terms subject to regulatory approval';
  assert.equal(clusterStories([anchor,revised]).length,2,'New substantive conditions cannot hide in an old transaction');
  assert(investmentReading(rows));
 }
}
assert.equal(investmentMoney('Rs. 10 Cr')[0].key,investmentMoney('INR 10,00,00,000')[0].key);
assert.notEqual(investmentMoney('€4.5 million')[0].key,investmentMoney('INR 4.5 million')[0].key);
const varroc=all.get('VARROC'),anchor=varroc.find(r=>r.content.format==='pdf'),native=varroc.find(r=>r.content.format==='xbrl');
const completed=structuredClone(anchor);completed.url='https://fixture.test/closed';completed.content.hash='closed';completed.content.facts.find(f=>f.field==='status').value='Acquisition completed';
assert.equal(clusterStories([anchor,completed]).length,2,'Signing and closing remain separate developments');
const differentStake=structuredClone(anchor);differentStake.url='https://fixture.test/46';differentStake.content.hash='46';differentStake.content.facts.find(f=>f.field==='ownership').value=differentStake.content.facts.find(f=>f.field==='ownership').value.replace('45%','46%');
assert.equal(clusterStories([anchor,differentStake]).length,2,'Changed ownership remains distinct');
const otherLegalEntity=structuredClone(anchor);otherLegalEntity.url='https://fixture.test/public-target';otherLegalEntity.content.hash='public-target';for(const f of otherLegalEntity.content.facts)f.value=f.value.replaceAll('Forsee Power India Private Limited','Forsee Power India Limited');
assert.equal(clusterStories([anchor,otherLegalEntity]).length,2,'A private/public legal-name difference cannot be erased from target identity');
const shoppers=all.get('SHOPERSTOP'),beautyNews=shoppers.find(r=>r.kind==='news'&&/Beauty Unit/.test(r.headline)),shopAnchor=shoppers.find(r=>r.content.format==='pdf');
const ambiguous=structuredClone(shopAnchor);ambiguous.url='https://fixture.test/other-beauty';ambiguous.content.hash='other-beauty';for(const f of ambiguous.content.facts)f.value=f.value.replaceAll('Global SS Beauty Brands Limited','Other Beauty Brands Limited').replaceAll('GSSBBL','OBBL');
const ambiguity=investmentProfiles([shopAnchor,ambiguous,beautyNews]);assert(!sameInvestmentEvent(shopAnchor,beautyNews,ambiguity),'A generic beauty subsidiary cannot select between two same-price targets');
const thirdTranche=structuredClone(shopAnchor);thirdTranche.url='https://fixture.test/tranche-3';thirdTranche.content.hash='tranche-3';for(const f of thirdTranche.content.facts)f.value=f.value.replaceAll('Second tranche','Third tranche').replaceAll('second tranche','third tranche');
assert.equal(clusterStories([shopAnchor,thirdTranche]).length,2,'Two same-price tranches on one day remain distinct');
const trancheAmbiguity=investmentProfiles([shopAnchor,thirdTranche,beautyNews]);assert(!sameInvestmentEvent(shopAnchor,beautyNews,trancheAmbiguity),'An unqualified publisher report cannot choose between two known tranches');
const changedTotal=structuredClone(shoppers.find(r=>r.content.format==='xbrl'));changedTotal.url='https://fixture.test/new-total';changedTotal.content.hash='new-total';changedTotal.content.facts.find(f=>f.location.endsWith('/AnyOtherBriefSignificantInformationForAnnouncementUpdate')).value=changedTotal.content.facts.find(f=>f.location.endsWith('/AnyOtherBriefSignificantInformationForAnnouncementUpdate')).value.replace('135 Crores','136 Crores');
assert.equal(clusterStories([shopAnchor,changedTotal]).length,2,'A changed cumulative investment is retained');
const denied={...varroc.find(r=>r.kind==='news'),url:'https://fixture.test/denial',headline:'Varroc Engineering denies acquisition of Forsee Power India for €4.5 million'};
assert.equal(clusterStories([anchor,denied]).length,2,'A denial cannot be consolidated as confirmation');
const wrongCurrency={...denied,url:'https://fixture.test/currency',headline:'Varroc Engineering acquires Forsee Power India for USD 4.5 million'};
assert.equal(clusterStories([anchor,wrongCurrency]).length,2,'An unsupported explicit currency cannot act as a missing price');
const changedCondition=structuredClone(anchor);changedCondition.url='https://fixture.test/new-condition';changedCondition.content.hash='new-condition';changedCondition.content.facts.find(f=>f.field==='conditions').value='Completion is subject to RBI approval';
assert.equal(clusterStories([anchor,changedCondition]).length,2,'Different saved business conditions remain distinct');
const cashSuffix=structuredClone(shopAnchor);cashSuffix.content.facts.find(f=>f.field==='conditions'&&/^Nature/.test(f.value)).value='Nature of consideration is cash and completion is subject to RBI approval';
assert(investmentReading([cashSuffix]).note.includes('subject to RBI approval'),'A cash prefix cannot suppress a material condition');
assert.equal(investmentMoney('INR 10 thousand').length,0,'Unsupported amount units are unresolved');
assert.equal(printable('€4.5 million / ₹10 crore'),'EUR 4.5 million / INR 10 crore','PDF currency remains readable in the existing base fonts');
const readPublisher={...varroc.find(r=>r.kind==='news'),url:'https://fixture.test/read-publisher',content:{state:'ready',format:'article',facts:[{field:'event',value:'Agreements executed for investment in Forsee Power India Private Limited'},{field:'amount',value:'Consideration of EUR 4.5 million'},{field:'status',value:'Agreements executed; completion still pending'},{field:'ownership',value:'A 45% equity stake'}]}};
assert.equal(clusterStories([anchor,readPublisher]).length,1,'Reading a publisher cannot re-split one source-established event merely because its fact wording differs');
assert(investmentReading([anchor,readPublisher]),'The concise reading remains attributable to the original announcement');
const readCondition=structuredClone(readPublisher);readCondition.content.facts.push({field:'conditions',value:'Completion subject to conditions precedent'});
assert.equal(clusterStories([anchor,native,readCondition]).length,1,'The explicit known condition can normalize across source phrasing without requiring an omitted update-form field');
readCondition.content.facts.at(-1).value='Completion subject to RBI approval';
assert.equal(clusterStories([anchor,readCondition]).length,2,'A newly read publisher qualification cannot be hidden by the older announcement');
const readChanged=structuredClone(readPublisher);readChanged.url='https://fixture.test/read-new-price';readChanged.content.facts.find(f=>f.field==='amount').value='Consideration of EUR 5.5 million';
assert.equal(clusterStories([anchor,readChanged]).length,2,'An explicitly read amount overrides an older headline figure');
const readForeign=structuredClone(readPublisher);readForeign.url='https://fixture.test/read-foreign-currency';readForeign.content.facts.find(f=>f.field==='amount').value='Consideration of USD 5.5 million';
assert.equal(clusterStories([anchor,readForeign]).length,2,'An unsupported read currency cannot become a wildcard behind an older EUR headline');
const staleCurrency=structuredClone(readPublisher);staleCurrency.url='https://fixture.test/stale-headline-currency';staleCurrency.headline='Varroc Engineering acquires Forsee Power India for USD 5.5 million';
assert.equal(clusterStories([anchor,staleCurrency]).length,1,'Explicit supported source consideration takes precedence over a stale headline currency');
const purva=all.get('PURVA'),badDay=structuredClone(purva.find(r=>r.content.format==='pdf'));badDay.url='https://fixture.test/wrong-weekday';badDay.content.hash='wrong-weekday';badDay.content.facts.find(f=>/^Board meeting date:/.test(f.value)).value='Board meeting date: Friday, November 02, 2026';
assert.equal(clusterStories([purva.find(r=>r.content.format==='xbrl'),badDay]).length,2,'An inconsistent weekday/date is not silently normalized');
console.log('PASS live investment/notice regressions: native update fields, named targets, exact prices/currencies/dates/stages, ambiguous subsidiaries, all source links and complete concise terms; network/model/mail calls=0');

const pendingPublisher={...beautyNews,url:'https://fixture.test/pending-investment',headline:'Shoppers Stop announces investment in Global SS Beauty Brands Limited for INR 10 crore; completion still pending'};
const pendingProfiles=investmentProfiles([shopAnchor,pendingPublisher]);
assert(pendingProfiles.get(pendingPublisher)?.pending&&pendingProfiles.get(pendingPublisher)?.stage===null,'Exercise the explicit-pending/no-stage profile');
assert.equal(clusterStories([shopAnchor,pendingPublisher]).length,2,'A pending acquisition cannot absorb its completion update');
