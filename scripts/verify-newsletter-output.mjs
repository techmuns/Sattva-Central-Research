// Exact readings and original links from the customer's 202-page PDF. No network,
// model requests, email or provider credentials, including Munshot stock search.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {clusterStories,briefStats,aiItemsFor,renderBriefHtml} from '../worker/newsletter-brief.mjs';
import {explicitEvent,eventDate,financialPeriod} from '../worker/newsletter-event-identity.mjs';
import {scheduledBoardMeetingSummary} from '../worker/newsletter-filing-events.mjs';
import {editorialEvents,referenceReason} from '../worker/newsletter-editorial.mjs';
import {scheduledEarningsCall} from '../worker/newsletter-notice-events.mjs';
import {investorSourceSummary,xbrlBoardMeetingNote} from '../worker/newsletter-source-notes.mjs';
import {pdfFixture} from './verify-newsletter-pdf.mjs';
import {renderInvestorEmails} from '../worker/newsletter-email.mjs';
import {renderBriefPdf} from '../worker/newsletter-pdf.mjs';
const input=JSON.parse(readFileSync(new URL('./fixtures/newsletter/output-2026-10-26.json',import.meta.url)));
const tickers={'Aurobindo Pharma Ltd':'AUROPHARMA','Varroc Engineering Limited':'VARROC','Bharat Parenteral':'BPLPHARMA','Lupin Ltd':'LUPIN','Tech Mahindra Ltd':'TECHM'};
const rows=input.events.map((x,i)=>{
 const clock=/(\d+) Oct, (\d\d):(\d\d) IST/.exec(x.status);
 return {kind:x.kind==='Corporate announcement'?'filing':'news',ticker:tickers[x.company],company:x.company,
  headline:x.description,url:x.url,at:Date.parse(`2026-10-${clock[1]}T${clock[2]}:${clock[3]}:00+05:30`),
  score:1,source:'Captured source',keys:[`pdf:${i}`],content:{state:'pending'}};
});
const company=name=>rows.filter(r=>r.company===name);
for(const name of ['Aurobindo Pharma Ltd','Varroc Engineering Limited']) {
 const notices=company(name).filter(r=>/board (?:meeting|of directors)/i.test(r.headline));
 assert.equal(notices.length,2);
 assert.equal(clusterStories(notices).length,1,`${name}: NSE/BSE date/period normalization`);
 const textNotice=notices[0],numeric={...textNotice,url:'https://fixture.test/numeric-period',headline:textNotice.headline.replace('September 2026','30/09/2026')};
 assert.equal(clusterStories([textNotice,numeric]).length,1,'Month name and quarter-end numeric date identify the same period');
 assert.equal(clusterStories([textNotice,{...numeric,headline:textNotice.headline.replace('September 2026','2026-09-30')}]).length,1,'ISO financial periods identify the same quarter');
 assert.equal(clusterStories([textNotice,{...numeric,headline:textNotice.headline.replace('September 2026','2026-06-30')}]).length,2,'Different ISO financial periods cannot merge');
 assert.equal(clusterStories([textNotice,{...numeric,headline:numeric.headline.replace('30/09/2026','30/06/2026')}]).length,2,'Different financial periods stay separate');
}
assert.equal(eventDate('31 November 2026'),null);assert.equal(eventDate('November 4, 2026'),'2026-11-04');
assert.equal(financialPeriod('30th September 2026'),'2026-09');
const auroNotices=company('Aurobindo Pharma Ltd');
const genericRead={...auroNotices[0],headline:'Intimation',content:{state:'ready',format:'xbrl',hash:'verified-source-fields',facts:[
 ['TypeOfMeeting','Board Meeting'],['TypeOfIntimation','New'],['DateOfProposedMeeting','2026-11-04'],
 ['MonthOfPeriodEnded','September'],['YearOfPeriodEnded','2026'],['Agenda1','Financial results'],['Agenda2','Dividend']
].map(([tag,value])=>({field:'source',value,location:`Main/${tag}`}))}};
assert.equal(clusterStories([genericRead,auroNotices[1]]).length,1,'Read event fields identify a filing even when the headline supplies no date or type');
const changedRead=structuredClone(genericRead);changedRead.content.facts.find(f=>f.location.endsWith('DateOfProposedMeeting')).value='2026-11-05';
assert.equal(clusterStories([changedRead,auroNotices[1]]).length,2,'The source meeting date overrides a stale captured date');
const otherPeriod=structuredClone(genericRead);otherPeriod.url='https://fixture.test/other-read-period';otherPeriod.content.hash='different-quarter';otherPeriod.content.facts.find(f=>f.location.endsWith('MonthOfPeriodEnded')).value='June';
assert.equal(clusterStories([genericRead,otherPeriod]).length,2,'Read periods remain authoritative with generic headlines');
const b=company('Bharat Parenteral'),voting=b.filter(r=>/EGM held|Extraordinary General Meeting/i.test(r.headline));
const votingGroups=clusterStories(voting);
assert.equal(votingGroups.length,1,'The dated original, revised and scrutinizer reports share one EGM event');
assert.equal(votingGroups[0].items,5,'Every original source row survives consolidation');
assert(explicitEvent(votingGroups[0].main).revised,'The correction leads, not the superseded original');
assert.equal(new Set(votingGroups[0].documents.map(d=>d.main.url)).size,3);
assert.equal(clusterStories([...voting,{...voting[4],url:'https://fixture.test/other-egm',headline:'Voting Results of EGM held on October 24, 2026'}]).length,2);
// Source equality wins before conflicting paraphrased extraction fields.
const exact=structuredClone(voting.slice(0,2));
exact.forEach((r,i)=>r.content={state:'ready',hash:'verified-identical-bytes',facts:[{field:'conditions',value:i?'Revision only relates to shareholder classification/category, not votes cast or outcome':'Revision is limited to shareholder classification and does not change votes cast or resolution outcomes'}]});
assert.equal(clusterStories(exact).length,1);
assert.equal(clusterStories(exact)[0].documents.length,1);
const changed=structuredClone(exact[1]);changed.content.hash='new-version';changed.content.facts[0].value='Voting outcome corrected; resolution rejected';
const changedGroup=clusterStories([exact[0],changed]);assert.equal(changedGroup.length,1);
assert.equal(changedGroup[0].documents.length,2,'A correction is a retained document version, never discarded as a copy');
const lupin=company('Lupin Ltd'),inspection=lupin.filter(r=>/FDA|Form-483/.test(r.headline));
assert.equal(inspection.length,3);assert.equal(clusterStories(inspection).length,1,'Filing and publisher accounts of the Goa inspection share one event');
assert.equal(clusterStories([...inspection,{...inspection[1],url:'https://fixture.test/changed-observations',headline:inspection[1].headline.replace('one observation','two observations')}]).length,2,'A changed FDA observation count stays visible');
assert.equal(clusterStories([inspection[1],{...inspection[1],url:'https://fixture.test/other-site',headline:inspection[1].headline.replace('Goa','Nagpur')}]).length,2);
assert.equal(clusterStories([inspection[1],{...inspection[1],url:'https://fixture.test/cleared',headline:'US FDA clears Goa facility following inspection'}]).length,2,'A later regulatory clearance remains a genuine new development');
const appointments=lupin.filter(r=>/Brian Savage/.test(r.headline));assert.equal(clusterStories(appointments).length,1,'The identical person/role is one appointment');
assert.equal(clusterStories([appointments[0],{...appointments[1],headline:appointments[1].headline.replace('Brian Savage','Brian Jones')}]).length,2);
assert.equal(clusterStories([{...appointments[0],eventId:'checked-event-1'},{...appointments[1],eventId:'checked-event-2'}]).length,2,'A checked distinct news development overrides an unverified headline profile');
const tech=company('Tech Mahindra Ltd'),acquisition=tech.filter(r=>/buys Finastra suite/.test(r.headline));
assert.equal(clusterStories(acquisition).length,1,'The identical named acquisition object is not repeated by discovery route');
const partnership=tech.filter(r=>/SpaceXSI/.test(r.headline));assert.equal(clusterStories(partnership).length,1);
for(const r of tech.filter(r=>/stock price, news|slides Friday/.test(r.headline)))assert(referenceReason(r));
for(const headline of ['Smartworks Coworking Spaces Ltd Downgraded to Sell Amid Technical and Valuation Concerns','Fusion Finance Ltd Downgraded to Sell Amid Mixed Financials and Bearish Technicals','Time Technoplast Ltd. Forms Death Cross, Signalling Potential Bearish Trend','Ather Energy Share Price Today, Ather Energy Stock Price Live NSE/BSE Updates'])assert(referenceReason({kind:'news',headline}));
assert.equal(referenceReason({kind:'news',headline:'CRISIL downgraded Company credit rating following a debt default'}),null);
assert.equal(referenceReason({kind:'news',headline:'Company cuts revenue guidance ahead of results next week'}),null,'A material change cannot be hidden by calendar wording');
for(const headline of ['Company is Rated Sell by UBS after a revenue-guidance cut','Company Downgraded to Sell Amid Valuation Concerns by UBS','Company Forms Death Cross after a profit warning','Q2 results this week: Company revenue grows 20%'])assert.equal(referenceReason({kind:'news',headline}),null,'Attribution and material business facts cannot be filtered as a template');
assert(referenceReason({kind:'news',headline:'Q2 results this week: Ather Energy, IndiGo, L&T, Paytm, Maruti, Mazagon Dock, Adani Enterprises, Vedanta, among others in focus'}),'The repeated weekly calendar roundup stays in the full source register');
assert.equal(scheduledBoardMeetingSummary(b.find(r=>/standalone and/.test(r.headline))),'Board meeting 29 Oct 2026; captured agenda is incomplete.');
const facts=[{field:'event',value:'Submission of revised voting results of EGM held on 23 October 2026, correcting shareholder categorisation error'},
 {field:'event',value:'Resolution 1: Issuance of equity shares on preferential basis passed as Special Resolution'},
 {field:'event',value:'Resolution 2: Approval for making investments, giving loans, guarantees and providing security in excess of Section 186(2) limits, passed as Special Resolution'},
 {field:'conditions',value:'Revision is limited to shareholder classification and does not change votes cast or resolution outcomes'},
 ...Array.from({length:25},(_,i)=>({field:'date',value:`Administrative date ${i}`}))];
const read={...voting[0],content:{state:'ready',hash:'verified-revision',facts}};
const concise=investorSourceSummary(read);assert(concise.includes('Submission of revised voting results'));
assert(!concise.includes('Administrative date'));
const brief=pdfFixture();brief.edition='morning';brief.day='2026-10-26';brief.at=Date.parse('2026-10-26T08:00:00+05:30');
brief.builtAt=Date.parse('2026-10-26T12:24:00+05:30');brief.window={from:Date.parse('2026-10-23T16:00:00+05:30'),to:brief.builtAt};brief.onDemand=true;
brief.news.groups=[];brief.announcements.groups=[{ticker:read.ticker,company:read.company,items:[read,...voting.slice(1)].map(r=>({...r,exchanges:['BSE'],keywords:[],subject:'Voting results',direction:'neutral'}))}];
brief.ai={ok:false,items:{}};
const before=JSON.stringify(brief),stats=briefStats(brief),events=editorialEvents(brief,stats.companies).events;
assert.equal(events.length,1);assert.equal(events[0].sources.length,3);
const ai=aiItemsFor(stats.companies);assert.equal(ai.length,1,'Summary writer sees one consolidated event');
assert.equal(ai[0].SOURCE_EVIDENCE.length,3,'Repeated document is supplied once to the writer, with all distinct versions retained');
const email=renderInvestorEmails(brief,{dashboardUrl:'https://fixture.test',pdfUrl:'https://fixture.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000001'})[0];
for(const url of events[0].sources)assert(email.html.includes(url),'Every constituent report has an exact source link in the email');
assert(!email.html.includes('Administrative date'));
for(const summaryChars of [100,140,220]) {
 const dense=renderBriefHtml(brief,{dashboardUrl:'https://fixture.test',stats,part:{investor:true,eventIds:events.map(e=>e.id),compact:true,summaryChars,index:1,total:1,supplements:false}});
 assert(dense.includes('votes and resolution outcomes unchanged.'),'The substantive correction qualification cannot be truncated by dense packing');
 assert(dense.includes('preferential equity issue')&&dense.includes('Section 186(2)'),'Original capital approvals remain alongside the correction');
}
const modelCopy=structuredClone(brief);modelCopy.ai={ok:true,items:{[events[0].id]:{summary:'All resolution outcomes changed.',impact:'An unsupported implication.'}}};
const checkedModelCopy=renderInvestorEmails(modelCopy,{dashboardUrl:'https://fixture.test',pdfUrl:'https://fixture.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000001'})[0].html;
assert(checkedModelCopy.includes('votes and resolution outcomes unchanged.')&&!checkedModelCopy.includes('All resolution outcomes changed.'),'The verified bounded source note takes priority over generic model wording');
assert.equal(JSON.stringify(brief),before,'Consolidation and render cannot rewrite source history');
const metadataOnly=structuredClone(brief);
metadataOnly.announcements.groups[0].items=[{...metadataOnly.announcements.groups[0].items[0],headline:'Captured corporate notice',content:{state:'ready',facts:[{field:'conditions',name:'Administrative approval field',value:'true'}]}}];
const metadataEmail=renderInvestorEmails(metadataOnly,{dashboardUrl:'https://fixture.test',pdfUrl:'https://fixture.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000001'})[0].html;
assert(!metadataEmail.includes('Administrative approval field'),'No raw metadata array can become the final email fallback');
assert(metadataEmail.includes('factual summary unavailable'),'A read without a substantive event does not masquerade as source prose');
mkdirSync('.cache/newsletter-audit/full-pdf-review',{recursive:true});
writeFileSync('.cache/newsletter-audit/full-pdf-review/corrected-example.html',email.html);
writeFileSync('.cache/newsletter-audit/full-pdf-review/corrected-example.pdf',renderBriefPdf(brief));
console.log(`PASS full-output PDF: ${input.events.length} exact readings, issuer/date/period/event grouping, document-first evidence, corrections, concise prose, all report links; network/model/mail calls=0`);

// Read-only live-release findings, 26 October: DCW's buyback notice and the
// customer's original Bharat call invitation. All dates/terms are saved facts.
const cleanNotice=(ticker,company,sourceFacts)=>{
 const sample=pdfFixture();sample.news.groups=[];sample.ai={ok:false,items:{}};
 sample.announcements.groups=[{ticker,company,items:[{...sample.announcements.groups[0].items[0],headline:'Captured corporate notice',content:{state:'ready',format:'pdf',facts:sourceFacts.map(([field,value])=>({field,value,quote:value,location:'page 1'}))}}]}];
 return sample;
};
const dcw=cleanNotice('DCW','Dcw Limited',[
 ['event','Board meeting scheduled to consider and approve unaudited financial results'],
 ['event','Board meeting scheduled to consider a proposal for buyback of fully paid-up equity shares'],
 ['status','Proposed/scheduled for board consideration, not yet approved'],
 ['date','Board meeting date: October 29, 2026'],['date','Letter date: October 26, 2026'],
 ['conditions','Trading window closed ahead of board meeting and reopening timeline'],
 ['counterparty','Recipients of the intimation: National Stock Exchange of India Ltd. and BSE Limited'],
]);
const dcwStats=briefStats(dcw),dcwEvents=editorialEvents(dcw,dcwStats.companies).events;
const dcwDense=renderBriefHtml(dcw,{dashboardUrl:'https://fixture.test',stats:dcwStats,part:{investor:true,eventIds:dcwEvents.map(e=>e.id),compact:true,summaryChars:100,index:1,total:1,supplements:false}});
assert(dcwDense.includes('Board meeting 29 Oct 2026: to consider unaudited financial results and a proposal for buyback of fully paid-up equity shares.'));
assert(!dcwDense.includes('Trading window')&&!dcwDense.includes('Recipients of the intimation'));
const dcwPdf=Buffer.from(renderBriefPdf(dcw)).toString('latin1');
assert.equal((dcwPdf.match(/Trading window closed/g)||[]).length,1,'The administrative source field remains in the complete register, not the investment reading');
const conditional=structuredClone(dcw);conditional.announcements.groups[0].items[0].content.facts.push({field:'conditions',value:'Buyback is subject to shareholder approval'});
const conditionalEvents=editorialEvents(conditional,briefStats(conditional).companies).events;
assert(conditionalEvents[0].sourceSummary.includes('subject to shareholder approval'),'A business condition cannot be mistaken for filing boilerplate');
const cancelledBoard=structuredClone(dcw);cancelledBoard.announcements.groups[0].items[0].content.facts.find(f=>f.field==='status').value='Not scheduled';
assert(!editorialEvents(cancelledBoard,briefStats(cancelledBoard).companies).events[0].completeSourceSummary,'An opposing status cannot become a planned meeting');
const call=cleanNotice('BPLPHARMA','Bharat Parenteral',[
 ['event','Intimation of Q2FY27 Earnings Conference Call'],['date','Letter dated October 24, 2026'],
 ['date','Conference call scheduled for Friday, October 30, 2026 at 4:00 P.M. IST'],
 ['conditions','Disclosure made pursuant to Regulation 30 of SEBI LODR Regulations, 2015'],
 ['counterparty','BSE Limited (recipient of intimation)'],
 ['counterparty','PhillipCapital (India) Private Limited is organizing/hosting the earnings call'],
 ['status','Conference call scheduled (proposed/upcoming event, not yet completed)'],
 ['ownership','Scrip Code and ISIN identifiers for Bharat Parenterals Limited'],
]);
const callStats=briefStats(call),callEvents=editorialEvents(call,callStats.companies).events;
const callDense=renderBriefHtml(call,{dashboardUrl:'https://fixture.test',stats:callStats,part:{investor:true,eventIds:callEvents.map(e=>e.id),compact:true,summaryChars:100,index:1,total:1,supplements:false}});
assert(callDense.includes('Q2FY27: Conference call scheduled for Friday, October 30, 2026 at 4:00 P.M. IST'));
for(const noise of ['Regulation 30','Scrip Code','recipient of intimation'])assert(!callDense.includes(noise));
const cancelledCall=structuredClone(call);cancelledCall.announcements.groups[0].items[0].content.facts.find(f=>f.field==='status').value='Call cancelled';
assert(!editorialEvents(cancelledCall,briefStats(cancelledCall).companies).events[0].completeSourceSummary,'A cancellation cannot use the old invitation as a current schedule');
const noTime=structuredClone(call);noTime.announcements.groups[0].items[0].content.facts=noTime.announcements.groups[0].items[0].content.facts.filter(f=>!f.value.includes('4:00'));
assert(!editorialEvents(noTime,briefStats(noTime).companies).events[0].completeSourceSummary,'Never invent a missing call time');
const businessParty=structuredClone(call);businessParty.announcements.groups[0].items[0].content.facts.push({field:'counterparty',value:'A new venture partner'});
assert(!editorialEvents(businessParty,briefStats(businessParty).companies).events[0].completeSourceSummary,'A business counterparty cannot be silently treated as an IR attendee');
const appointmentCall=structuredClone(call);appointmentCall.announcements.groups[0].items[0].content.facts.push({field:'event',value:'Company appointed a new CFO to present the call'});
assert(!editorialEvents(appointmentCall,briefStats(appointmentCall).companies).events[0].completeSourceSummary,'A named business development cannot disappear inside a routine call note');
for(const value of ['Company announces a new CFO who will present the call','The call announced a cost-cutting strategy']){
 const materialCall=structuredClone(call);materialCall.announcements.groups[0].items[0].content.facts.push({field:'event',value});
 assert(!editorialEvents(materialCall,briefStats(materialCall).companies).events[0].completeSourceSummary,'Qualitative business updates cannot be mistaken for invitation metadata');
}
for(const [from,to]of [['October 30','November 31'],['4:00 P.M.','25:99']]){
 const invalid=structuredClone(call);invalid.announcements.groups[0].items[0].content.facts.find(f=>f.value.includes('4:00')).value=invalid.announcements.groups[0].items[0].content.facts.find(f=>f.value.includes('4:00')).value.replace(from,to);
 assert(!editorialEvents(invalid,briefStats(invalid).companies).events[0].completeSourceSummary,'Invalid source dates/times cannot certify a call schedule');
}
const unrelated=cleanNotice('TEST','Test issuer',[
 ['event','Company signed a customer contract'],['amount','INR 100 crore'],
 ['conditions','Subject to regulatory approval'],['counterparty','Customer Alpha'],
 ['ownership','Promoter ownership increased to 45%'],
]);
const economic=editorialEvents(unrelated,briefStats(unrelated).companies).events[0].sourceSummary;
for(const material of ['INR 100 crore','Subject to regulatory approval','Customer Alpha','45%'])assert(economic.includes(material));
assert(referenceReason({kind:'news',ticker:'ICICIBANK',headline:'ICICI Bank Ltd (ICBA.HA) stock price, news, quote and history - Yahoo Finance'}),'The actual live Yahoo quote-page suffix is still a reference page');
assert.equal(referenceReason({kind:'news',headline:'Company launches stock price, news, quote and history API'}),null,'An actual business announcement cannot be hidden by quote-page vocabulary');
console.log('PASS read notice prose: complete buyback agenda/date, complete earnings-call time, administrative appendix, substantive conditions/ownership, cancelled/unknown guards; model/search/mail calls=0');

// The post-release register exposed a read PDF and exchange form for each DCW
// event. Reuse those captured values, not live source/model/API calls.
const readDcw={...briefStats(dcw).companies[0].stories[0],at:Date.parse('2026-10-26T20:12:00+05:30'),keys:['dcw-pdf'],url:'https://www.bseindia.com/xml-data/corpfiling/AttachLive/6741673a-dfc9-4bdb-8c07-8a8e909edbe7.pdf'};
const xbrlNotice=(base,values,url)=>({...base,url,keys:[url],content:{state:'ready',format:'xbrl',facts:values.map(([tag,value])=>({field:'source',value,quote:value,location:'Main/'+tag}))}});
const readDcwXml=xbrlNotice({...readDcw,headline:'DCW LIMITED has informed the Exchange about Board Meeting to be held on 29-Oct-2026 to consider and approve the Half Yearly Unaudited Financial results of the Company for the period ended September 2026 and Buyback/Other business.',at:readDcw.at+37*60000},[
 ['TypeOfMeeting','Board Meeting'],['TypeOfIntimation','New'],['DateOfProposedMeeting','2026-10-29'],
 ['MonthOfPeriodEnded','September'],['YearOfPeriodEnded','2026 [source unit: pure]'],['Agenda1','Financial results'],['Agenda2','Buyback'],['Agenda3','Other business'],
], 'https://nsearchives.nseindia.com/corporate/xbrl/PRIOR_INTIMATION_1239_WebXMLFile_20261026_204954772.xml');
assert.equal(clusterStories([readDcw,readDcwXml]).length,1,'The read DCW PDF and exchange form identify one dated results/buyback meeting');
for(const fact of [{field:'amount',value:'INR 20 crore'},{field:'conditions',value:'Buyback is subject to shareholder approval'},{field:'counterparty',value:'Investor Alpha'}]){
 const changed=structuredClone(readDcw);changed.content.facts.push(fact);
 assert.equal(clusterStories([changed,readDcwXml]).length,2,'Unmatched capital terms cannot disappear inside an exchange wrapper');
}
for(const [tag,value]of [['DateOfProposedMeeting','2026-10-30'],['Agenda2','Acquisition']]){
 const changed=structuredClone(readDcwXml);changed.content.facts.find(f=>f.location.endsWith('/'+tag)).value=value;
 assert.equal(clusterStories([readDcw,changed]).length,2,'A different meeting or proposal remains separate');
}
const dcwCallFacts=[['event','Intimation of proposed schedule of Earnings Conference Call for Investor(s)/Analyst(s) under Regulation 30 of SEBI LODR Regulations, 2015'],
 ['event','Conference call scheduled to discuss Unaudited Financial Results for Q2-FY27'],['date','Letter dated October 26, 2026'],
 ['date','Earnings conference call scheduled for Friday, October 30, 2026 at 02:00 P.M (IST)'],['status','Schedule is proposed and subject to change'],
 ['counterparty','Filed with National Stock Exchange of India Ltd.'],['counterparty','Filed with BSE Limited'],
 ['counterparty','Valorem Advisors is organizing/inviting to the conference call'],['conditions','Call accessible via universal dial-in and international toll-free numbers'],
 ['event','Management representatives named for the call']];
const dcwCall=cleanNotice('DCW','Dcw Limited',dcwCallFacts),readDcwCall={...briefStats(dcwCall).companies[0].stories[0],at:readDcw.at+43*60000,url:'https://fixture.test/dcw-call-pdf',keys:['dcw-call-pdf']};
const callValues=[['TypeOfAnnouncement','New'],['StageOfMeetingOrCallOrConferenceOrEvent','Intimation'],['TypeOfMeetingForWhichIntimationIsGiven','Earning/Quarterly Calls'],
 ['DateOfMeetingOrCallOrConferenceOrEventForIntimation','2026-10-30'],['TimeOfCommencementOfMeetingOrCallOrConferenceOrEventForIntimation','14:00:00'],
 ['NameOfMeetingOrCallOrConferenceOrEventForIntimation','Q2/H1-FY27 Earnings Call']];
const dcwCallXml=xbrlNotice({...readDcwCall,at:readDcwCall.at+6*60000,headline:'DCW LIMITED has informed the Exchange about Schedule of Analysts or Institutional Investors Meet'},callValues,'https://fixture.test/dcw-call-xbrl');
assert.equal(clusterStories([readDcwCall,dcwCallXml]).length,1,'PDF 02:00 P.M and XBRL 14:00 identify the same dated Q2 call');
assert(scheduledEarningsCall(dcwCallXml).reading.includes('timezone not stated'),'Never infer a timezone absent from the structured fields');
for(const [tag,value]of [['DateOfMeetingOrCallOrConferenceOrEventForIntimation','2026-11-02'],['TimeOfCommencementOfMeetingOrCallOrConferenceOrEventForIntimation','15:00:00'],['NameOfMeetingOrCallOrConferenceOrEventForIntimation','Q3-FY27 Earnings Call'],['StageOfMeetingOrCallOrConferenceOrEvent','Outcome'],['TypeOfAnnouncement','Revised']]){
 const changed=structuredClone(dcwCallXml);changed.content.facts.find(f=>f.location.endsWith('/'+tag)).value=value;
 assert.equal(clusterStories([readDcwCall,changed]).length,2,'New call date/time/period/stage remains a separate development');
}
const otherZone=structuredClone(readDcwCall);otherZone.url='https://fixture.test/other-zone';otherZone.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value=otherZone.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value.replace('(IST)','(UTC)');
assert.equal(clusterStories([readDcwCall,otherZone]).length,2,'Conflicting explicit timezones remain separate');
const dcwAll=structuredClone(dcwCall);dcwAll.announcements.groups[0].items=[readDcwCall,dcwCallXml];
const mergedCall=editorialEvents(dcwAll,[{ticker:'DCW',company:'Dcw Limited',stories:[readDcwCall,dcwCallXml],clusters:clusterStories([readDcwCall,dcwCallXml]).map((c,i)=>({...c,id:`DCW#${i+1}`}))}]).events;
assert.equal(mergedCall.length,1);assert.deepEqual(new Set(mergedCall[0].sources),new Set([readDcwCall.url,dcwCallXml.url,...readDcwCall.sourceUrls,...dcwCallXml.sourceUrls]),'Every attached original survives call consolidation');
assert(mergedCall[0].sourceSummary.includes('02:00 P.M (IST)')&&mergedCall[0].sourceSummary.includes('subject to change'),'The consolidated reading uses the explicit timezone and preserves the proposed status');
assert(mergedCall[0].completeSourceSummary);
console.log('PASS read notice identity: DCW PDF/XBRL board and call consolidation; distinct terms/date/time/period/status/timezone guards; both original links retained');

for(const suffix of [' and 25:99 GMT',' and 11:30 GMT']){
 const multiClock=structuredClone(call);multiClock.announcements.groups[0].items[0].content.facts.find(f=>f.field==='date'&&/4:00/.test(f.value)).value+=suffix;
 assert(!editorialEvents(multiClock,briefStats(multiClock).companies).events[0].completeSourceSummary,'A multi-clock sentence requires full validation and cannot be certified from its first clock');
}
const rescheduledBoard=structuredClone(dcw);rescheduledBoard.announcements.groups[0].items[0].content.facts.push({field:'date',value:'Board meeting rescheduled to October 30, 2026'});
assert(!editorialEvents(rescheduledBoard,briefStats(rescheduledBoard).companies).events[0].completeSourceSummary,'A separately captured reschedule cannot be discarded as an unrelated date');
assert.equal(clusterStories([{...readDcw,content:rescheduledBoard.announcements.groups[0].items[0].content},readDcwXml]).length,2,'An unresolved source reschedule cannot identify the old board date');
for(const value of ['Filed with BSE that the company appointed Jane Doe as CFO','Addressed to NSE announcing the closure of the Chennai plant']){
 assert(investorSourceSummary({content:{state:'ready',facts:[{field:'event',value}]}}).includes(value),'Filing-address vocabulary cannot erase a substantive event');
}
const extraCallDate=structuredClone(call);extraCallDate.announcements.groups[0].items[0].content.facts.push({field:'date',value:'Call rescheduled to October 31, 2026'});
assert(!editorialEvents(extraCallDate,briefStats(extraCallDate).companies).events[0].completeSourceSummary,'An additional call date cannot be ignored');
console.log('PASS automated review regressions: all clock values, separate rescheduled dates and substantive events with filing-address prefixes');

const mixedAdmin=structuredClone(call);mixedAdmin.announcements.groups[0].items[0].content.facts.push({field:'conditions',value:'Call proceedings will be recorded and management will provide FY27 guidance'});
const mixedEvent=editorialEvents(mixedAdmin,briefStats(mixedAdmin).companies).events[0];
assert(!mixedEvent.completeSourceSummary&&mixedEvent.sourceSummary.includes('FY27 guidance'),'A material suffix cannot be discarded with administrative boilerplate');
const sparseCall=structuredClone(call);sparseCall.announcements.groups[0].items[0].content.facts=sparseCall.announcements.groups[0].items[0].content.facts.filter(f=>!['conditions','ownership'].includes(f.field));
const sparseEvents=editorialEvents(sparseCall,briefStats(sparseCall).companies).events;
assert.equal(sparseEvents.length,1);assert(sparseEvents[0].sourceSummary.includes('4:00 P.M. IST'),'A validated sparse invitation cannot disappear into the calendar exclusion');
const agendaCall=structuredClone(dcwCallXml);agendaCall.content.facts.find(f=>f.location.endsWith('/NameOfMeetingOrCallOrConferenceOrEventForIntimation')).value='Earnings Call';
agendaCall.content.facts.push({field:'source',value:'Discuss the Unaudited Financial Results for Q2-FY27',location:'Main/AgendaOrReasonForMeetingOrCallOrConferenceOrEventForIntimation'});
assert.equal(scheduledEarningsCall(agendaCall).period,'Q2FY27');assert(scheduledEarningsCall(agendaCall).reading.includes('Q2FY27'),'The structured agenda supplies a missing name period');
const contradictoryPeriod=structuredClone(agendaCall);contradictoryPeriod.content.facts.find(f=>f.location.endsWith('/NameOfMeetingOrCallOrConferenceOrEventForIntimation')).value='Q3-FY27 Earnings Call';
assert.equal(scheduledEarningsCall(contradictoryPeriod),null,'Conflicting name/agenda periods cannot be certified');
const periodlessPdf=structuredClone(readDcwCall);periodlessPdf.content.facts=periodlessPdf.content.facts.filter(f=>f.field!=='event');periodlessPdf.content.facts.push({field:'event',value:'Intimation of Earnings Conference Call'});
const across=editorialEvents(dcwCall,[{ticker:'DCW',company:'Dcw Limited',stories:[periodlessPdf,agendaCall],clusters:clusterStories([periodlessPdf,agendaCall]).map((c,i)=>({...c,id:`DCW#${i+1}`}))}]).events;
assert.equal(across.length,1);assert(across[0].sourceSummary.includes('Q2FY27')&&across[0].sourceSummary.includes('02:00 P.M (IST)'),'The final reading combines the compatible known period and explicit timezone across reports');
const fullZone=structuredClone(periodlessPdf);fullZone.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value=fullZone.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value.replace('02:00 P.M (IST)','04:00 P.M Indian Standard Time');
const utcZone=structuredClone(fullZone);utcZone.url='https://fixture.test/utc-zone';utcZone.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value=utcZone.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value.replace('Indian Standard Time','UTC');
assert.equal(scheduledEarningsCall(fullZone).zone,'IST');assert.equal(clusterStories([fullZone,utcZone]).length,2,'An explicitly stated full timezone name cannot act as an unknown-zone wildcard');
const unknownZone=structuredClone(fullZone);unknownZone.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value=unknownZone.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value.replace('Indian Standard Time','Unknown Local Time');
assert.equal(scheduledEarningsCall(unknownZone),null,'Unknown timezone text cannot be silently interpreted as absent');
console.log('PASS call review regressions: mixed administrative/business facts, sparse invitations, agenda/combined periods, full and unknown timezones');

const periodRead=structuredClone(readDcw);periodRead.content.facts=periodRead.content.facts.filter(f=>f.field!=='event');
periodRead.content.facts.push({field:'event',value:'Board meeting scheduled to consider and approve unaudited financial results for the period ended June 2026'});
periodRead.headline='Intimation';
const resultsForm=structuredClone(readDcwXml);resultsForm.content.facts=resultsForm.content.facts.filter(f=>!f.location.endsWith('/Agenda2')&&!f.location.endsWith('/Agenda3'));
assert.equal(clusterStories([periodRead,resultsForm]).length,2,'A read PDF June period cannot wildcard-match a September exchange form');
periodRead.headline=readDcwXml.headline;
assert.equal(clusterStories([periodRead,resultsForm]).length,2,'Read source periods override stale detailed headlines as well');
for(const period of ['September 2026','30/09/2026','2026-09-30']){
 const same=structuredClone(periodRead);same.content.facts.find(f=>f.field==='event').value=same.content.facts.find(f=>f.field==='event').value.replace('June 2026',period);
 assert.equal(clusterStories([same,resultsForm]).length,1,'Equivalent PDF/form financial periods normalize before matching');
}
const inconsistentPeriod=structuredClone(periodRead);inconsistentPeriod.content.facts.push({field:'event',value:'Board meeting scheduled to consider financial results for the period ended September 2026'});
assert.equal(clusterStories([inconsistentPeriod,resultsForm]).length,2,'Conflicting source periods cannot be silently selected');
const hiddenDate=structuredClone(call);hiddenDate.announcements.groups[0].items[0].content.facts.find(f=>f.field==='date'&&/^Letter/.test(f.value)).value+='; call rescheduled to October 31, 2026';
assert(!editorialEvents(hiddenDate,briefStats(hiddenDate).companies).events[0].completeSourceSummary,'A mixed correction cannot hide behind a letter-date prefix');
console.log('PASS source period regressions: read PDF/form conflicts, stale headlines, normalized equivalents and mixed letter-date corrections');

const missingReadPeriod=structuredClone(readDcw);missingReadPeriod.content.facts=missingReadPeriod.content.facts.filter(f=>f.field!=='event');missingReadPeriod.content.facts.push({field:'event',value:'Board meeting scheduled to consider and approve unaudited financial results'});
missingReadPeriod.headline='Board Meeting to be held on 29-Oct-2026 to consider financial results for the period ended June 2026';
assert.equal(clusterStories([missingReadPeriod,resultsForm]).length,2,'An omitted read period cannot discard an explicit captured-headline period');
const genericReschedule=structuredClone(readDcw);genericReschedule.headline='Board Meeting to be held on 29-Oct-2026 to consider Intimation of Board Meeting';genericReschedule.content.facts.push({field:'date',value:'Board meeting rescheduled to October 30, 2026'});
assert.equal(clusterStories([genericReschedule,resultsForm]).length,2,'A generic headline cannot override a separately read meeting reschedule');
console.log('PASS identity fallback regressions: preserve known headline periods and veto source reschedules before generic-wrapper matching');

const genericCancelled=structuredClone(genericReschedule);genericCancelled.content.facts=genericCancelled.content.facts.filter(f=>!/rescheduled to/.test(f.value));genericCancelled.content.facts.find(f=>f.field==='status').value='Board meeting cancelled';
assert.equal(clusterStories([genericCancelled,resultsForm]).length,2,'An old generic headline cannot override the read cancellation status');
const genericChangedDate=structuredClone(genericCancelled);genericChangedDate.content.facts.find(f=>f.field==='status').value='Scheduled';genericChangedDate.content.facts.find(f=>/^Board meeting date:/.test(f.value)).value='Board meeting date: October 30, 2026';
assert.equal(clusterStories([genericChangedDate,resultsForm]).length,2,'A read PDF meeting date overrides a stale generic headline');

const reversedAgendas=structuredClone(readDcw);const agendaFacts=reversedAgendas.content.facts.filter(f=>f.field==='event').reverse();reversedAgendas.content.facts=[...agendaFacts,...reversedAgendas.content.facts.filter(f=>f.field!=='event')];
assert.equal(clusterStories([reversedAgendas,readDcwXml]).length,1,'The PDF agenda order cannot split one results/buyback meeting');
const changedHalf=structuredClone(dcwCallXml);changedHalf.url='https://fixture.test/changed-half';changedHalf.content.facts.find(f=>f.location.endsWith('/NameOfMeetingOrCallOrConferenceOrEventForIntimation')).value='Q2/H2-FY27 Earnings Call';
assert.equal(scheduledEarningsCall(dcwCallXml).period,'Q2/H1FY27');
assert.equal(clusterStories([dcwCallXml,changedHalf]).length,2,'A changed explicit half-year is not discarded from call identity');
assert(mergedCall[0].sourceSummary.includes('Q2/H1FY27'),'A compatible half-year known from the form remains in the PDF-led reading');
const fiscalBoard=(period,url)=>{const row=structuredClone(periodRead);row.url=url;row.headline='Captured corporate notice';row.content.facts=row.content.facts.filter(f=>f.field!=='event');row.content.facts.push({field:'event',value:'Board meeting scheduled to consider and approve unaudited financial results for '+period});return row;};
const q1Board=fiscalBoard('Q1 FY27','https://fixture.test/q1'),q2Board=fiscalBoard('Q2 FY27','https://fixture.test/q2');
assert.equal(clusterStories([q1Board,q2Board]).length,2,'Explicit fiscal quarters cannot become missing-period wildcards');
assert.equal(clusterStories([q1Board,fiscalBoard('Q1 FY2027','https://fixture.test/q1-four-digit')]).length,1,'Two- and four-digit labels identify the same stated fiscal year');
assert.equal(clusterStories([q1Board,fiscalBoard('Q5 FY27','https://fixture.test/invalid-quarter')]).length,2,'Unsupported explicit fiscal labels cannot act as missing periods');
for(const status of ['Proposed','Proposed/upcoming event, not yet completed','Conference call scheduled (proposed/upcoming event, not yet completed)','Scheduled, not yet completed']){
 const proposedCall=structuredClone(call);proposedCall.announcements.groups[0].items[0].content.facts.find(f=>f.field==='status').value=status;
 const reading=editorialEvents(proposedCall,briefStats(proposedCall).companies).events[0].sourceSummary;
 if(/proposed/i.test(status))assert(reading.includes('(proposed'),'Every accepted tentative source status remains in the complete reading');
 if(/not yet completed/i.test(status))assert(reading.includes('not yet completed'));
 assert(!reading.includes('subject to change'),'Do not add a condition absent from the source');
}
console.log('PASS final review regressions: agenda permutations, fiscal quarters/half-years, compatible period union and every accepted proposed status');

const materialResults=structuredClone(periodRead);materialResults.headline='Captured corporate notice';materialResults.content.facts=materialResults.content.facts.filter(f=>f.field!=='event');materialResults.content.facts.push({field:'event',value:'Board meeting scheduled to consider and approve unaudited financial results for the period ended September 2026'},{field:'amount',value:'INR 100 crore fundraising proposal'});
assert.equal(clusterStories([materialResults,resultsForm]).length,2,'A results-only form cannot hide a separately read material fundraising term');
const genericResults={...resultsForm,content:{state:'pending'},headline:'Board Meeting to be held on 29-Oct-2026 to consider Intimation of Board Meeting'};
assert.equal(clusterStories([materialResults,genericResults]).length,2,'The material-extra guard also applies before generic-wrapper matching');
const xbrlMaterial=structuredClone(resultsForm);xbrlMaterial.content.facts.push({field:'amount',value:'INR 100 crore fundraising proposal',location:'Main/SizeOfOrder'});
assert(xbrlBoardMeetingNote(xbrlMaterial).includes('INR 100 crore fundraising proposal'),'A standalone structured reading also retains separately typed material fields');
const rangeBoard=fiscalBoard('Q2 FY2026-27','https://fixture.test/range-year');
assert.equal(clusterStories([rangeBoard,fiscalBoard('Q2 FY26','https://fixture.test/prior-fy')]).length,2,'A ranged FY label uses its ending year, not its starting year');
for(const label of ['Q2 FY27','Q2 FY2027','Q2 FY2026-2027','Q2 FY2026/27'])assert.equal(clusterStories([rangeBoard,fiscalBoard(label,'https://fixture.test/range-'+encodeURIComponent(label))]).length,1,'Equivalent fiscal year endings normalize together');
assert.equal(clusterStories([rangeBoard,fiscalBoard('Q2 FY2026-29','https://fixture.test/invalid-range')]).length,2,'An unsupported multi-year range cannot become a wildcard');
const rangedCall=structuredClone(dcwCallXml);rangedCall.url='https://fixture.test/ranged-call';rangedCall.content.facts.find(f=>f.location.endsWith('/NameOfMeetingOrCallOrConferenceOrEventForIntimation')).value='Q2/H1-FY2026-27 Earnings Call';
assert.equal(clusterStories([dcwCallXml,rangedCall]).length,1,'Call year ranges preserve the half-year and normalize to the ending year');
for(const status of ['Proposal rejected','Approval revoked','Board meeting completed']){
 const opposing=structuredClone(genericCancelled);opposing.content.facts.find(f=>f.field==='status').value=status;
 assert.equal(clusterStories([opposing,resultsForm]).length,2,'A completed or rejected source status cannot become a prospective meeting');
}
console.log('PASS material/range regressions: every merge branch preserves material extras, structured terms remain visible, fiscal range endings and opposing statuses');

const unclassifiedAgenda=structuredClone(periodRead);unclassifiedAgenda.headline='Captured corporate notice';unclassifiedAgenda.content.facts=unclassifiedAgenda.content.facts.filter(f=>f.field!=='event');unclassifiedAgenda.content.facts.push({field:'event',value:'Board meeting scheduled to consider and approve unaudited financial results and employee stock option plan'});
for(const wrapper of [resultsForm,genericResults])assert.equal(clusterStories([unclassifiedAgenda,wrapper]).length,2,'Unclassified agenda text cannot disappear behind a results-only or generic form');
const nativeUnknown=structuredClone(resultsForm);nativeUnknown.url='https://fixture.test/native-unknown-agenda';nativeUnknown.content.facts.find(f=>f.location.endsWith('/Agenda1')).value='Financial results and employee stock option plan';
assert.equal(clusterStories([nativeUnknown,resultsForm]).length,2,'Structured free-form agendas require the same residual-text guard');
assert(xbrlBoardMeetingNote(nativeUnknown).includes('employee stock option plan'),'The separate reading retains the entire free-form agenda');
const dottedInvitation=structuredClone(sparseCall);dottedInvitation.announcements.groups[0].items[0].content.facts.find(f=>f.field==='date'&&/^Letter/.test(f.value)).value+='.';
const dottedEvents=editorialEvents(dottedInvitation,briefStats(dottedInvitation).companies).events;
assert.equal(dottedEvents.length,1);assert(dottedEvents[0].completeSourceSummary&&dottedEvents[0].sourceSummary.includes('4:00 P.M. IST'),'Normal terminal punctuation cannot exclude a valid sparse call');
const dottedBoard=structuredClone(readDcw);for(const fact of dottedBoard.content.facts.filter(f=>f.field==='date'))fact.value+='.';
assert.equal(clusterStories([dottedBoard,readDcwXml]).length,1,'Ordinary punctuation is normalized on read board/letter dates as well');
const punctuatedCorrection=structuredClone(dottedInvitation);punctuatedCorrection.announcements.groups[0].items[0].content.facts.find(f=>f.field==='date'&&/^Letter/.test(f.value)).value+=' Call rescheduled to October 31, 2026.';
assert(!editorialEvents(punctuatedCorrection,briefStats(punctuatedCorrection).companies).events[0].completeSourceSummary,'Punctuation removal cannot erase a mixed correction suffix');
console.log('PASS residual/punctuation regressions: unmatched proposals preserved across every wrapper, whole native agendas, sparse invitations and mixed-correction guards');

assert(editorialEvents(punctuatedCorrection,briefStats(punctuatedCorrection).companies).events[0].sourceSummary.includes('Call rescheduled to October 31'),'A source reschedule remains visible even when the whole notice cannot be certified');
const cancelledSparse=structuredClone(sparseCall);cancelledSparse.announcements.groups[0].items[0].content.facts.find(f=>f.field==='status').value='Call cancelled';
const cancelReading=editorialEvents(cancelledSparse,briefStats(cancelledSparse).companies).events;
assert.equal(cancelReading.length,1);assert(cancelReading[0].sourceSummary.startsWith('Call cancelled'),'A sparse cancellation cannot disappear into the calendar filter or behind its old invitation');
assert(investorSourceSummary({content:{state:'ready',facts:[{field:'date',value:'Call rescheduled to October 31, 2026 at 5:00 P.M. IST'}]}}).startsWith('Call rescheduled'),'An explicit date-only schedule change is a substantive source update');
const speakerCall=structuredClone(call);speakerCall.announcements.groups[0].items[0].content.facts.push({field:'counterparty',value:'Speaker for the call: Mr. Bhahim Desai, Director (Strategy & Investor Relations)'},{field:'counterparty',value:'Call leaders: Mr. Srisurya Kalagarla and Ms. Samruddhi Shinde'});
assert(editorialEvents(speakerCall,briefStats(speakerCall).companies).events[0].completeSourceSummary,'The actual named IR speaker and call leaders remain routine metadata');
for(const fact of [{field:'reason',value:'Management will provide FY27 guidance'},{field:'counterparty',value:'PhillipCapital is hosting the call and management will provide FY27 guidance'}]){
 const mixed=structuredClone(call);mixed.announcements.groups[0].items[0].content.facts.push(fact);
 const event=editorialEvents(mixed,briefStats(mixed).companies).events[0];assert(!event.completeSourceSummary&&event.sourceSummary.includes('FY27 guidance'),'A business rationale or participant suffix cannot hide inside a routine call');
}
const reasonBoard=structuredClone(readDcw);reasonBoard.content.facts.push({field:'reason',value:'The buyback will use proceeds from an asset sale'});
assert.equal(clusterStories([reasonBoard,readDcwXml]).length,2,'A separately read business rationale cannot disappear into an exchange wrapper');
console.log('PASS source-change/schema regressions: sparse cancellations and reschedules, actual IR roles, business reasons and mixed role suffixes');

const bareReschedule=structuredClone(readDcw);bareReschedule.headline='Board Meeting to be held on 29-Oct-2026 to consider financial results';bareReschedule.content.facts=[{field:'date',value:'Rescheduled to October 30, 2026'}];
assert.equal(clusterStories([bareReschedule,resultsForm]).length,2,'An explicit date correction needs no repeated board-meeting prefix to veto stale identity');
const resultsPdf=structuredClone(periodRead);resultsPdf.content.facts=resultsPdf.content.facts.filter(f=>f.field!=='event');resultsPdf.content.facts.push({field:'event',value:'Board meeting scheduled to consider financial results'});resultsPdf.headline='Long captured exchange wrapper '.repeat(30);resultsPdf.score=1;
const dividendForm=structuredClone(resultsForm);dividendForm.score=1;dividendForm.content.facts.push({field:'source',value:'Dividend',location:'Main/Agenda2'});
const boardRows=[resultsPdf,dividendForm],boardClusters=clusterStories(boardRows).map((c,i)=>({...c,id:`DCW#${i+1}`}));assert.equal(boardClusters.length,1);
const unionReading=editorialEvents(dcw,[{ticker:'DCW',company:'Dcw Limited',stories:boardRows,clusters:boardClusters}]).events[0];
assert(unionReading.completeSourceSummary&&unionReading.sourceSummary.includes('dividend')&&unionReading.sourceSummary.includes('September 2026'),'The complete board reading covers the secondary source agenda and period');
assert.equal(unionReading.lead.url,dividendForm.url,'Its primary source is the document supplying the complete reading');
const complementaryPdf=structuredClone(resultsPdf);complementaryPdf.content.facts.find(f=>f.field==='event').value='Board meeting scheduled to consider unaudited financial results';
const complementaryRows=[complementaryPdf,dividendForm],complementaryClusters=clusterStories(complementaryRows).map((c,i)=>({...c,id:`DCW#${i+1}`}));
const supportedAi={...dcw,ai:{ok:true,items:{'DCW#1':{summary:'Unaudited results and dividend will be considered for the September 2026 period.'}}}};
const complementaryEvent=editorialEvents(supportedAi,[{ticker:'DCW',company:'Dcw Limited',stories:complementaryRows,clusters:complementaryClusters}]).events[0];
assert(!complementaryEvent.completeSourceSummary&&complementaryEvent.summary.includes('dividend'),'Complementary facts cannot be overridden by an incomplete lead-only source note');
const utcCall=structuredClone(readDcwCall);utcCall.url='https://fixture.test/utc-equivalent';utcCall.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value='Earnings conference call scheduled for Friday, October 30, 2026 at 08:30 UTC';
assert.equal(clusterStories([readDcwCall,utcCall]).length,1,'14:00 IST and 08:30 UTC are the same call instant');
const indiaMidnight=structuredClone(readDcwCall),utcPrevious=structuredClone(utcCall);indiaMidnight.url='https://fixture.test/india-midnight';utcPrevious.url='https://fixture.test/utc-previous';
indiaMidnight.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value='Earnings conference call scheduled for Saturday, October 31, 2026 at 12:30 A.M. IST';
utcPrevious.content.facts.find(f=>f.field==='date'&&/UTC/.test(f.value)).value='Earnings conference call scheduled for Friday, October 30, 2026 at 19:00 UTC';
assert.equal(clusterStories([indiaMidnight,utcPrevious]).length,1,'Equivalent instants also match across a calendar-day boundary');
assert.equal(financialPeriod('15 September 2026'),'2026-09-15');
const midPeriod=structuredClone(periodRead);midPeriod.content.facts.find(f=>f.field==='event').value='Board meeting scheduled to consider financial results for the period ended 15 September 2026';
assert.equal(clusterStories([midPeriod,resultsForm]).length,2,'A distinct intra-month financial period cannot become a month-end wildcard');
const hashBase={...readDcw,headline:'Specific contract disclosure',content:{state:'ready',format:'pdf',hash:'document-A',facts:[['event','Customer contract secured'],['counterparty','Customer Alpha'],['amount','INR 100 crore'],['status','Awarded'],['date','October 26, 2026']].map(([field,value])=>({field,value,quote:value,location:'page 1'}))}};
const distinctDoc={...hashBase,url:'https://fixture.test/document-B',keys:['document-B'],content:{...hashBase.content,hash:'document-B'}};
const factsOnlyGroup=clusterStories([hashBase,distinctDoc]);assert.equal(factsOnlyGroup[0].documents.length,2,'Matching generated facts cannot establish a verified document copy');
const mirroredPdf={...hashBase,kind:'news',url:'https://fixture.test/mirrored-pdf',keys:['mirror']};
assert.equal(clusterStories([hashBase,mirroredPdf])[0].documents.length,1,'A verified byte copy remains one document across source kinds');
console.log('PASS final evidence regressions: generic corrections, whole-board source coverage, preserved consolidated AI, timezone instants, exact periods and hash-only document copies');

assert.equal(eventDate('29 Octoberish 2026'),null,'An unknown month word cannot be guessed from its first three letters');
assert.equal(financialPeriod('Septemberish 2026'),null);assert.equal(eventDate('30 Sept 2026'),'2026-09-30');
await import('./verify-newsletter-investments.mjs');

// An abbreviation is retained literally; it cannot assert an unstated geographic offset.
const zonedCall=(label,id)=>{const item=structuredClone(readDcwCall);item.url='https://fixture.test/'+id;item.keys=[id];item.content.facts.find(f=>f.field==='date'&&/P.M/.test(f.value)).value='Earnings conference call scheduled for Friday, October 30, 2026 at '+label;return item;};
for(const [abbr,full,india] of [['EST','Eastern Standard Time','19:00'],['EDT','Eastern Daylight Time','18:00'],['CST','Central Standard Time','20:00'],['CDT','Central Daylight Time','19:00'],['PST','Pacific Standard Time','22:00'],['PDT','Pacific Daylight Time','21:00']]){
 const ambiguous=zonedCall('08:30 '+abbr,'ambiguous-'+abbr),known=zonedCall('08:30 '+full,'explicit-'+abbr),indian=zonedCall(india+' IST','india-'+abbr);
 assert.equal(scheduledEarningsCall(ambiguous).instant,null,'A bare nonlocal abbreviation cannot invent a geographic offset');
 assert.equal(clusterStories([ambiguous,indian]).length,2,'An unresolved timezone must not hide a potentially different call');
 assert.equal(clusterStories([known,indian]).length,1,'The explicitly expanded supported zone matches the same instant in India');
}
console.log('PASS timezone ambiguity regressions: literal abbreviations preserve evidence; explicitly expanded zones match equivalent instants');
