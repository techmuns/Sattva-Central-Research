// Deterministic event evidence. No lookup, model, source mutation or company-name guessing.
const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const fullMonths=['january','february','march','april','may','june','july','august','september','october','november','december'];
const monthNumber=value=>/^\d+$/.test(value)?Number(value):months.findIndex((m,i)=>value.toLowerCase()===m||value.toLowerCase()===fullMonths[i]||i===8&&value.toLowerCase()==='sept')+1;
const dateText = '(?:20\\d{2}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?[ /-]+(?:[A-Za-z]+|\\d{1,2})[ ,/-]+20\\d{2}|[A-Za-z]+ +\\d{1,2}(?:st|nd|rd|th)?,? +20\\d{2})';
export function eventDate(value) {
  const text = clean(value).replace(/(\d)(?:st|nd|rd|th)\b/gi,'$1');
  let day,month,year, m;
  if ((m=/^(20\d{2})-(\d{2})-(\d{2})$/.exec(text))) [,year,month,day]=m;
  else if ((m=/^(\d{1,2})[ /-]+(\d{1,2}|[A-Za-z]+)[ ,/-]+(20\d{2})$/.exec(text))) [,day,month,year]=m;
  else if ((m=/^([A-Za-z]+) +(\d{1,2}),? +(20\d{2})$/.exec(text))) [,month,day,year]=m;
  else return null;
  month=monthNumber(month);
  const at=new Date(Date.UTC(+year,month-1,+day));
  return month>0&&month<=12&&at.getUTCMonth()===month-1&&at.getUTCDate()===+day?at.toISOString().slice(0,10):null;
}
export const eventDates = value => [...String(value || '').matchAll(new RegExp(dateText,'g'))].map(match=>eventDate(match[0]));
export const hasSourceChange=value=>/\b(?:reschedul\w*|postpon\w*|cancel\w*|revis\w*|correct\w*|withdraw\w*)\b/i.test(value);
export const financialPeriodsIn=value=>[...clean(value).matchAll(new RegExp('\\b(?:period|quarter|half[- ]year|year) ended\\s+('+dateText+'|[A-Za-z]+ +20\\d{2})','ig'))].map(m=>m[1]);
export function fiscalPeriods(value) {
  return [...clean(value).matchAll(/\b(Q[1-4](?:\s*\/\s*H[12])?|H[12])\s*[- ]*FY\s*(\d+)(?:\s*[-–/]\s*(\d+))?(?!\d|\s*[-–/])/ig)].map(m=>{
    if(![2,4].includes(m[2].length)||m[3]&&![2,4].includes(m[3].length))return {invalid:true};
    const start=Number(m[2].length===2?'20'+m[2]:m[2]);let ending=start;
    if(m[3]){
      ending=m[3].length===2?Math.floor(start/100)*100+Number(m[3]):Number(m[3]);
      if(m[3].length===2&&ending<=start)ending+=100;
      if(ending!==start+1)return {invalid:true};
    }
    const year=String(ending),quarter=/Q[1-4]/i.exec(m[1])?.[0].toUpperCase()||null,half=/H[12]/i.exec(m[1])?.[0].toUpperCase()||null;
    return {year,quarter,half,raw:m[0],label:[quarter,half].filter(Boolean).join('/')+'FY'+(year.startsWith('20')?year.slice(-2):year)};
  });
}
export function compatibleFiscalPeriods(a,b) {
  if(!a||!b||a.invalid||b.invalid)return false;
  return a.year===b.year&&(!a.quarter||!b.quarter||a.quarter===b.quarter)&&(!a.half||!b.half||a.half===b.half)&&
    !!(a.quarter&&b.quarter||a.half&&b.half);
}
export function combineFiscalPeriods(periods) {
  if(!periods.length||!periods.every(a=>periods.every(b=>compatibleFiscalPeriods(a,b))))return null;
  const year=periods[0].year,quarter=periods.find(p=>p.quarter)?.quarter,half=periods.find(p=>p.half)?.half;
  return {year,quarter,half,label:[quarter,half].filter(Boolean).join('/')+'FY'+(year.startsWith('20')?year.slice(-2):year)};
}
export function financialPeriod(value) {
  const text=clean(value),full=eventDate(text);
  if(full){
    const date=new Date(full+'T00:00:00Z'),last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
    return date.getUTCDate()===last?full.slice(0,7):full;
  }
  const m=/^([A-Za-z]+)[ ,/-]+(20\d{2})$/.exec(text);
  const month=m?monthNumber(m[1]):0;
  return month?`${m[2]}-${String(month).padStart(2,'0')}`:null;
}
const factsFor=item=>['ready','partial'].includes(item.content?.state)?item.content.facts||[]:[];
const eventText=item=>[item.headline,...factsFor(item).filter(f=>f.field==='event').map(f=>f.value)].join(' ');
const revisionPattern=/\b(?:revised|revision|correct(?:ed|ion|ing)|corrigendum)\b/i;
export function explicitEvent(item) {
  if(!['filing','news'].includes(item.kind)||!item.ticker||item.related)return null;
  const text=clean(eventText(item));
  // Only the meeting's own date. Letter, record, remote-voting and publication dates
  // are deliberately excluded; generated summaries never supply an identity.
  const egm=new RegExp('(?:EGM|Extraordinary General Meeting)(?: \\(EGM\\))? (?:held|conducted)(?: on)? +('+dateText+')','ig');
  const egmDates=[...text.matchAll(egm)].map(m=>eventDate(m[1]));
  if(/\bvot(?:ing|es)|scrutiniz|resolutions?|shareholders? approv/i.test(text)&&egmDates.length&&egmDates.every(d=>d&&d===egmDates[0])) {
    const condition=factsFor(item).find(f=>f.field==='conditions'&&revisionPattern.test(f.value));
    return {type:'egm-voting',key:`egm-voting:${egmDates[0]}`,date:egmDates[0],revised:revisionPattern.test(text)||!!condition};
  }
  // An explicitly named regulator + site + inspection stage identifies this source
  // event within one source day. A changed observation count remains a development.
  if(/\b(?:FDA|USFDA)\b/i.test(text)&&/\binspection|form[ -]?483\b/i.test(text)) {
    const site=/\b(Goa|Pithampur|Mandideep|Indore|Tarapur|Nagpur|Aurangabad|Somerset|Visakhapatnam)\b/i.exec(text)?.[1]?.toLowerCase();
    const count=/\b(\d+|no|zero|one|two|three|four|five|six|seven|eight|nine|ten) observations?\b/i.exec(text)?.[1]?.toLowerCase();
    const stage=/\b(?:warning letter|OAI|VAI|NAI|EIR|clears?|cleared|resolved|compliant|cancelled|closed down|shutdown|reinspect\w*)\b/i.exec(text)?.[0]?.toLowerCase()||'inspection';
    if(site)return {type:'fda-inspection',key:`fda:${site}:${stage}`,count:count?String(({no:0,zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10})[count]??count):null};
  }
  // Named person and role, not an arbitrary management-change category.
  const appointment=/\bappoints?\s+(.+?)\s+(?:as\s+)?((?:president|chief|director|ceo|cfo|cmo|chairman)\b.+)/i.exec(clean(item.headline));
  if(appointment) {
    const role=appointment[2].toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\bas\b/g,'').trim();
    if(/^[A-Za-z]+(?: [A-Za-z]+){1,3}$/.test(appointment[1])&&/\b(?:officer|president|director|ceo|cfo|cmo|chairman)\b/.test(role))return {type:'appointment',key:`appointment:${appointment[1].toLowerCase()}:${role}`};
  }
  if(item.kind==='news'&&item.company) {
    const own=clean(item.company).replace(/\s+(?:limited|ltd)\.?$/i,'');
    const headline=clean(item.headline),prefix=headline.slice(0,own.length);
    if(prefix.toLowerCase()===own.toLowerCase()) {
      const action=headline.slice(own.length).trim();
      // Identical, specific named acquisition objects can identify the repeat
      // report. Partial objects do not match a more detailed, different object.
      const acquisition=/^(?:acquires?|buys?) +([^;]+)(?:;|$)/i.exec(action)?.[1];
      if(acquisition&&/^[A-Z]/.test(acquisition)&&/\b(?:suite|business|stake|division|unit|company|limited|ltd)\b/i.test(acquisition))
        return {type:'acquisition',key:'acquisition:'+acquisition.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()};
      const partner=/^(?:partners(?: with)?|signs? (?:a )?deal with) +([A-Z][A-Za-z0-9]+)\b/.exec(action);
      if(partner&&/\blegacy (?:apps|applications|software)\b/i.test(action)&&/\b(?:upgrade|modernis\w*|moderniz\w*)\b/i.test(action))
        return {type:'partnership',key:`partnership:${partner[1].toLowerCase()}:legacy-software-modernization`};
    }
  }
  return null;
}
// A company's periodic results for one stated period are one development whatever each filing is
// called: the results, the press or media release, the investor presentation or update, standalone
// and consolidated versions, each exchange's copy. Only the filing's own words name the period. A
// notice to consider results, an earnings call, a transcript, a voting result, a subsidiary's results
// or a revised, corrected or resubmitted version never takes this identity, and neither does an
// outcome that also names a transaction (27 October: Sona's results outcome carried the Escorts
// Kubota acquisition and the DENSO joint ventures, which must stay their own development).
const RESULTS_DOCUMENT=/\b(?:financial results?|results? (?:of|for)\b|(?:investor|earnings) (?:presentation|update))/i;
const NOT_RESULTS_DOCUMENT=/\b(?:to consider|will consider|to approve|for consideration|intimation of (?:the )?board meeting|board meeting (?:is )?(?:scheduled|to be held|will be held)|prior intimation|trading window|conference call|earnings call|con[- ]?call|analysts?|investors? meet|transcripts?|audio|video|recording|webcast|resubmi\w*|e?-?voting|postal ballot|ballot|scrutini[sz]\w*|AGM|EGM|general meeting|results? of (?:its |the )?(?:material |wholly[- ]owned |step[- ]down )?subsidiar\w*)\b/i;
const TRANSACTION=/\b(?:acqui\w+|agreements?|joint ventures?|JVs?|merger|amalgamat\w*|demerg\w*|slump sale|divest\w*|fund ?rais\w*|QIP|preferential|rights issue|buy-?back|orders?|contracts?|stake|scheme of arrangement|allot\w*)\b/i;
const FISCAL_END={Q1:[-1,'06'],Q2:[-1,'09'],Q3:[-1,'12'],Q4:[0,'03'],H1:[-1,'09'],H2:[0,'03']};
export function resultsPeriod(item) {
  if(item.kind!=='filing'||!item.ticker||item.related)return null;
  const text=clean([item.headline,item.dek,...factsFor(item).filter(f=>f.field==='event').map(f=>f.value)].join(' '))
    .replace(/\bended\s+on\b/gi,'ended').replace(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/g,'$1-$2-$3');
  if(!RESULTS_DOCUMENT.test(text)||NOT_RESULTS_DOCUMENT.test(text)||TRANSACTION.test(text)||hasSourceChange(text))return null;
  const periods=[...financialPeriodsIn(text),...[...text.matchAll(new RegExp('\\bresults? for (?:the )?('+dateText+')','ig'))].map(m=>m[1])].map(financialPeriod);
  for(const period of fiscalPeriods(text)){
    if(period.invalid)return null;
    const [offset,month]=FISCAL_END[period.quarter||period.half]||[];
    if(month)periods.push(`${Number(period.year)+offset}-${month}`);
  }
  return periods.length&&periods.every(p=>p&&/^20\d{2}-\d{2}$/.test(p)&&p===periods[0])?periods[0]:null;
}
export function sameResultsFiling(a,b) {
  if(a.ticker!==b.ticker||!Number.isFinite(a.at)||!Number.isFinite(b.at)||Math.abs(a.at-b.at)>86400000)return false;
  const x=resultsPeriod(a);
  return !!x&&x===resultsPeriod(b);
}
export function sameExplicitEvent(a,b) {
  if(a.ticker!==b.ticker||!!a.related!==!!b.related||!Number.isFinite(a.at)||!Number.isFinite(b.at))return false;
  if(a.kind==='news'&&b.kind==='news'&&(a.eventId||b.eventId)&&a.eventId!==b.eventId)return false;
  const x=explicitEvent(a),y=explicitEvent(b);
  if(!x||!y||x.key!==y.key)return false;
  const window=x.type==='egm-voting'?7*86400000:86400000;
  if(Math.abs(a.at-b.at)>window)return false;
  if(x.type!=='egm-voting') {
    const captured=s=>`${s.headline||''} ${s.dek||''}`;
    const numbers=s=>(captured(s).replace(/(\d),(?=\d)/g,'$1').match(/\d+(?:\.\d+)?/g)||[]).sort().join('|');
    const nx=numbers(a),ny=numbers(b);if(nx&&ny&&nx!==ny)return false;
    const denied=/\b(?:denies|denied|rejects|rejected|revoked|cancelled|canceled|terminated)\b/i;
    if(denied.test(captured(a))!==denied.test(captured(b)))return false;
    // Normalized identity cannot erase contradictory read terms or a new stage.
    for(const field of ['amount','counterparty','ownership','status','conditions']) {
      const values=s=>factsFor(s).filter(f=>f.field===field).map(f=>clean(f.value).toLowerCase()).sort().join('|');
      const va=values(a),vb=values(b);if(va&&vb&&va!==vb)return false;
    }
  }
  if(x.type==='fda-inspection') {
    if(x.count&&y.count&&x.count!==y.count)return false;
    // Different dated inspections at the same site must never merge.
    const dates=s=>[...eventText(s).matchAll(new RegExp(dateText,'g'))].map(m=>eventDate(m[0])).filter(Boolean).sort().join('|');
    const dx=dates(a),dy=dates(b);if(dx&&dy&&dx!==dy)return false;
  }
  if(!['egm-voting','fda-inspection'].includes(x.type)) {
    const numbers=s=>(eventText(s).match(/\d+(?:[,.]\d+)*/g)||[]).sort().join('|');
    const nx=numbers(a),ny=numbers(b);if(nx&&ny&&nx!==ny)return false;
  }
  return true;
}
