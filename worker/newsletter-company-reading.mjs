// Deterministic company/headline ledger over retained source events. No I/O or model work.
import { eventDate, eventDates, financialPeriod, financialPeriodsIn, hasSourceChange } from './newsletter-event-identity.mjs';
import { scheduledBoardMeeting } from './newsletter-filing-events.mjs';
import { noticeTags } from './newsletter-notice-events.mjs';
const clean=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim();
export const headlineKey=value=>clean(value).toLowerCase().replace(/[’‘]/g,"'").replace(/[“”]/g,'"').replace(/[.!…]+$/,'').trim();
const facts=item=>['ready','partial'].includes(item.content?.state)?item.content.facts||[]:[];
const material=item=>facts(item).filter(f=>['event','amount','ownership','conditions','counterparty','status','reason'].includes(f.field));
const versionTerms=item=>[...material(item),...facts(item).filter(f=>f.field==='date'||/\/(?:DateOfCallForTranscriptsOfEarningsOrQuarterlyCalls|TypeOfAnnouncement|TypeOfIntimation)$/.test(f.location||''))];
const sameIssuer=(a,b)=>a.ticker===b.ticker&&!!a.related===!!b.related;

/** Mixed board/call documents still identify the same scheduled results meeting.
 * Extra agendas/facts remain in the consolidated evidence; they are never discarded.
 * Only explicit source dates/periods establish identity, never the generated note. */
export function boardDisclosure(item) {
  const scheduled=scheduledBoardMeeting(item);
  if(scheduled&&!scheduled.unknownPurpose&&!scheduled.materialExtras)return scheduled;
  if(item.kind!=='filing'||item.content?.state!=='ready'||item.content.format==='xbrl')return null;
  const rows=facts(item),events=rows.filter(f=>f.field==='event').map(f=>clean(f.value));
  const board=events.filter(value=>/\bboard(?: of directors)? meeting\b/i.test(value)&&/\b(?:scheduled|to (?:consider|approve)|for approval)\b/i.test(value)&&/\bfinancial results\b/i.test(value));
  if(rows.some(f=>['amount','ownership'].includes(f.field)||/\b(?:fund.?rais\w*|acquisition|buyback|preferential|rights issue|merger|QIP)\b/i.test(f.value)))return null;
  if(events.some(value=>!board.includes(value)&&!/\b(?:trading window|earnings conference call|earnings call|conference call for analysts)\b/i.test(value)))return null;
  if(!board.length||rows.some(f=>['event','status','date'].includes(f.field)&&hasSourceChange(f.value)))return null;
  // A second proposal embedded in the board sentence is not routine notice prose.
  for(const value of board){
    let residual=value;for(const period of financialPeriodsIn(value))residual=residual.replace(period,'');
    residual=residual.replace(/\b(?:board|of|directors|meeting|scheduled|to|consider|and|approve|for|approval|un-audited|unaudited|audited|standalone|consolidated|financial|results|the|quarter|quarterly|half|year|yearly|ended)\b/gi,'').replace(/[\s.,:;()/-]/g,'');
    if(residual)return null;
  }
  const dates=rows.filter(f=>f.field==='date'&&/^board meeting (?:date:|scheduled for)/i.test(clean(f.value))).flatMap(f=>eventDates(f.value));
  const periods=board.flatMap(financialPeriodsIn).map(financialPeriod);
  if(!dates.length||dates.some(d=>!d||d!==dates[0])||!periods.length||periods.some(p=>!p||p!==periods[0]))return null;
  if(rows.some(f=>f.field==='status'&&/\b(?:approved|completed|concluded|cancelled|withdrawn)\b/i.test(f.value.replace(/not yet (?:approved|completed|held)/ig,''))))return null;
  return {date:dates[0],period:periods[0],agendas:['results'],mixed:true};
}
export function sameBoardDisclosure(a,b) {
  if(!sameIssuer(a,b)||!Number.isFinite(a.at)||!Number.isFinite(b.at)||Math.abs(a.at-b.at)>3600000)return false;
  const x=boardDisclosure(a),y=boardDisclosure(b);
  // Leave the existing strict matcher authoritative for ordinary notices.
  if(!x||!y||!x.mixed&&!y.mixed||!x.period||!y.period)return false;
  const period=value=>/^20\d{2}-\d{2}$/.test(value)?value:financialPeriod(value);
  return x.date===y.date&&period(x.period)===period(y.period);
}

function supportingDocument(item) {
  if(item.kind!=='filing')return null;
  const tags=noticeTags(item),value=clean([item.headline,item.type,tags.get('PurposeOfDisclosure'),...facts(item).filter(f=>f.field==='event').map(f=>f.value)].join(' '));
  if(hasSourceChange(value))return null;
  const type=/\btranscripts?\b/i.test(value)?'transcript':/\binvestor presentation\b/i.test(value)?'presentation':null;
  if(!type)return null;
  const callDate=tags.get('DateOfCallForTranscriptsOfEarningsOrQuarterlyCalls');
  const sourceDates=facts(item).filter(f=>f.field==='date'&&/^(?:earnings |conference )?call (?:date:|held on)/i.test(clean(f.value))).flatMap(f=>eventDates(f.value));
  if(callDate)sourceDates.push(eventDate(callDate));
  if(sourceDates.some(d=>!d||d!==sourceDates[0]))return null;
  return {type,date:sourceDates[0]||null,periods:financialPeriodsIn(value).map(financialPeriod)};
}
// Red and green carry one meaning in the brief, as on the dashboard: the direction a stated rule
// gives a filing, a trade or a move, or a tracked risk topic. A publisher's headline never receives
// a direction of ours; its risk keyword is what can turn it red, and its TROUBLE tag says why.
// A notice that a board WILL consider results or a dividend has declared nothing yet, so it
// carries no direction however its subject reads.
const NOTICE=/\b(?:to consider|will consider|to be held|proposal to consider)\b|\bintimation of (?:the )?board meeting\b|^board meeting \d/i;
export const updateDirection=s=>s?.kind==='filing'&&NOTICE.test(s.headline||'')?null:s?.mood?.id==='good'?'good':s?.mood?.id==='watch'?'watch':null;
export const updateTone=s=>updateDirection(s)||(s?.topic?.id==='trouble'?'watch':null);
const toneRank=event=>({watch:2,good:1})[updateTone(event.lead)]||0;
// Materiality first, then what needs attention (risk before positive), then recency.
const compare=(a,b)=>b.rank-a.rank||toneRank(b)-toneRank(a)||Number(b.lead.kind==='filing')-Number(a.lead.kind==='filing')||b.at-a.at||a.id.localeCompare(b.id);
const quality=event=>Number(event.lead.content?.state==='ready')*10000+material(event.lead).length*100+Number(event.lead.kind==='filing');
const signature=f=>`${f.field}:${headlineKey(f.value)}`;
const description=event=>event.summary||event.sourceSummary||event.description||event.lead.headline;

/** A headline is printed once even when unverified or conflicting source versions
 * cannot safely become one economic event. Such versions remain separate readings
 * inside that headline group. Supporting transcript/presentation notices share a
 * reading group, not a claim that their bytes or previously unknown facts are equal. */
export function companyReadings(events,notes={}) {
  const companies=new Map();
  for(const event of events){
    if(!companies.has(event.ticker))companies.set(event.ticker,[]);
    companies.get(event.ticker).push(event);
  }
  const blocks=[];
  for(const [ticker,rows] of companies){
    const groups=[];
    for(const event of [...rows].sort(compare)){
      const title=headlineKey(event.lead.headline),support=supportingDocument(event.lead);
      const group=groups.find(g=>!!title&&g.variants.some(v=>headlineKey(v.lead.headline)===title)||support&&g.variants.every(v=>{
        const other=supportingDocument(v.lead);
        return other&&sameIssuer(v.lead,event.lead)&&other.type===support.type&&Math.abs(v.at-event.at)<=3600000&&
          (!other.date||!support.date||other.date===support.date)&&(!other.periods.length||!support.periods.length||JSON.stringify(other.periods)===JSON.stringify(support.periods));
      }));
      // A supporting copy can join one group while its own headline already heads another: NSE files
      // an original and a revised presentation under one generic subject. A headline is printed once,
      // so the two groups become one; their variants keep separate readings.
      const titled=group&&title&&!group.variants.some(v=>headlineKey(v.lead.headline)===title)?groups.find(g=>g!==group&&g.variants.some(v=>headlineKey(v.lead.headline)===title)):null;
      if(titled){group.variants.push(...titled.variants);groups.splice(groups.indexOf(titled),1);}
      if(group)group.variants.push(event);else groups.push({variants:[event]});
    }
    const readings=groups.map(({variants})=>{
      const ranked=[...variants].sort((a,b)=>quality(b)-quality(a)||compare(a,b)),lead=ranked[0];
      const known=new Set(facts(lead.lead).map(signature)),additionalReadings=[];
      for(const variant of ranked.slice(1)){
        const novel=versionTerms(variant.lead).filter(f=>(f.field!=='source'||lead.lead.content?.format==='xbrl')&&!known.has(signature(f)));
        const measurement=['trade','move'].includes(variant.lead.kind);
        if(novel.length||measurement){
          const value=description(variant);
          // Unverified identical headlines cannot erase genuinely different read terms.
          const reading=measurement?variant.lead.dek||'Separate source observation':headlineKey(value)===headlineKey(variant.lead.headline)||headlineKey(value)===headlineKey(description(lead))?novel.map(f=>`${f.name||f.field}: ${clean(f.value)}`).join('; '):value;
          if(measurement||headlineKey(reading)!==headlineKey(description(lead))&&!additionalReadings.some(r=>headlineKey(r.text)===headlineKey(reading)))additionalReadings.push({text:reading,source:variant.sources[0],...(measurement?{at:variant.lead.at,dayOnly:variant.lead.dayOnly}:{})});
          facts(variant.lead).forEach(f=>known.add(signature(f)));
        }
      }
      const separateSummaries=variants.filter(v=>material(v.lead).length>0).length>1;
      const id=variants.length>1?`reading:${variants[0].id}`:variants[0].id;
      const consolidated=variants.length>1&&!separateSummaries&&!variants.some(v=>v.cluster.versionConflict)?notes[id]:null;
      return {...lead,...(consolidated?{note:consolidated,summary:consolidated.summary}:{}),id,variants,additionalReadings,separateSummaries,rank:Math.max(...variants.map(v=>v.rank)),at:Math.max(...variants.map(v=>v.at)),
        sources:[...new Set(variants.flatMap(v=>v.sources))],read:variants.reduce((n,v)=>n+v.read,0),total:variants.reduce((n,v)=>n+v.total,0),sourceCount:variants.reduce((n,v)=>n+v.sourceCount,0),relatedSources:variants.filter(v=>v.lead.related).length};
    }).sort(compare);
    // Across companies only risk lifts a block: a positive tone is mostly a routine dividend filing,
    // which must not outrank another company's results at the same materiality.
    blocks.push({ticker,events:readings,rank:Math.max(...rows.map(r=>r.rank)),tone:rows.some(r=>updateTone(r.lead)==='watch')?1:0,at:Math.max(...rows.map(r=>r.at))});
  }
  blocks.sort((a,b)=>b.rank-a.rank||b.tone-a.tone||b.at-a.at||a.ticker.localeCompare(b.ticker));
  const result=blocks.flatMap(block=>block.events);
  // Fail closed if a future grouping edit loses a source event or an exact URL.
  const ids=result.flatMap(r=>r.variants.map(v=>v.id));
  if(ids.length!==events.length||new Set(ids).size!==events.length||events.some(e=>!ids.includes(e.id)))throw Error('Company reading event conservation failed');
  const closed=new Set(),headlines=new Map();let previous=null;
  for(const row of result){
    if(row.ticker!==previous){if(closed.has(row.ticker))throw Error('Company reading order failed');if(previous)closed.add(previous);previous=row.ticker;}
    for(const variant of row.variants){const title=headlineKey(variant.lead.headline);if(!title)continue;const key=`${row.ticker}|${title}`;
      if(headlines.has(key)&&headlines.get(key)!==row.id)throw Error('Repeated company headline');headlines.set(key,row.id);}
  }
  for(const row of result)if(row.variants.some(v=>v.sources.some(url=>!row.sources.includes(url))))throw Error('Company reading source conservation failed');
  return result;
}

export function supportingDocumentSummary(item) {
  const source=supportingDocument(item);
  if(source?.type!=='transcript'||item.content?.format!=='xbrl'||!source.date)return null;
  return `Transcript available for the earnings call on ${source.date}.`;
}

// A repeated generic title must not squeeze several independently read business
// transactions into one bounded model response. Their readings share a heading only.
export const summaryReadings=events=>events.flatMap(event=>event.separateSummaries?event.variants:event);
