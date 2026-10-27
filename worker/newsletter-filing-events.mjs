import { financialPeriod, financialPeriodsIn, eventDate, fiscalPeriods, combineFiscalPeriods, compatibleFiscalPeriods, hasSourceChange } from './newsletter-event-identity.mjs';
import { readBoardNotice, administrativeNoticeFact, boardNoticeDate } from './newsletter-notice-events.mjs';
const normal = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const datePattern = '(20\\d{2}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?[ /-]+(?:\\d{1,2}|[A-Za-z]{3,9})[ /,-]+20\\d{2})';

/** This identifies an explicitly scheduled board meeting, never a board outcome.
 * Publication time is not its event date. Unknown agendas cannot invent decisions. */
export function scheduledBoardMeeting(item) {
  if (item.kind !== 'filing') return null;
  const title = normal(item.headline);
  const tags=new Map();
  if(item.content?.state==='ready'&&item.content.format==='xbrl')for(const fact of item.content.facts || []) {
    const tag=String(fact.location||'').split('/').at(-1);
    if(tags.has(tag)&&tags.get(tag)!==fact.value)return null;
    tags.set(tag,fact.value);
  }
  if(tags.has('TypeOfIntimation')&&!/^new$/i.test(tags.get('TypeOfIntimation')))return null;
  if(tags.has('TypeOfMeeting')&&!/^board meeting$/i.test(tags.get('TypeOfMeeting')))return null;
  const readNotice=readBoardNotice(item);
  if(item.content?.state==='ready'&&(item.content.facts||[]).some(f=>f.field==='date'&&hasSourceChange(f.value)))return null;
  if(item.content?.state==='ready'&&item.content.format!=='xbrl'&&(item.content.facts||[]).filter(f=>f.field==='status').some(f=>
    /\b(?:cancel\w*|reschedul\w*|postpon\w*|withdraw\w*|reject\w*|declin\w*|revok\w*|terminat\w*|approved|concluded|completed|held|not scheduled)\b/i.test(normal(f.value).replace(/not yet (?:approved|completed|held)/ig,''))))return null;
  const sourceDates=item.content?.state==='ready'&&item.content.format!=='xbrl'?(item.content.facts||[]).filter(f=>f.field==='date'&&/\bboard meeting\b/i.test(f.value)):[];
  const meetingDates=sourceDates.map(f=>boardNoticeDate(f.value));
  if(meetingDates.some(d=>!d||d!==meetingDates[0]))return null;
  const readDate=tags.get('DateOfProposedMeeting')||meetingDates[0]||readNotice?.date;
  if(readDate&&!eventDate(readDate))return null;
  const structured=/^board meeting$/i.test(tags.get('TypeOfMeeting')||'')&&/^new$/i.test(tags.get('TypeOfIntimation')||'')&&!!readDate;
  const match = new RegExp('(?:scheduled(?: to be held)? on|to be held on)\\s*' + datePattern, 'i').exec(title);
  if(!structured&&!readNotice&&(!match||!/\b(?:board meeting|meeting of (?:the )?board)\b/i.test(title)||
    /\b(?:outcome|reschedul\w*|postpon\w*|cancel\w*|revis\w*|corrigend\w*|withdraw\w*|approved|declared)\b/i.test(title)))return null;
  const date=eventDate(readDate||match?.[1]);if(!date)return null;
  const day=Number(date.slice(8,10)),month=Number(date.slice(5,7)),year=Number(date.slice(0,4)),at=new Date(Date.UTC(year,month-1,day));
  if (month < 1 || month > 12 || at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  const periodsIn=financialPeriodsIn;
  const readPeriodText=item.content?.state==='ready'?(item.content.facts||[]).filter(f=>['event','date'].includes(f.field)).map(f=>f.value).join(' '):'';
  const readPeriods=periodsIn(readPeriodText),readFiscal=fiscalPeriods(readPeriodText);
  if(tags.has('YearOfPeriodEnded')&&!/^20\d{2}(?: \[source unit: pure\])?$/.test(tags.get('YearOfPeriodEnded')))return null;
  const fiscalMarker=/\b(?:Q\d(?:\s*\/\s*H\d)?|H\d)\s*[- ]*FY/i;
  if(fiscalMarker.test(readPeriodText)&&!readFiscal.length)return null;
  const structuredPeriod=tags.get('MonthOfPeriodEnded')&&tags.get('YearOfPeriodEnded');
  const fiscalSources=readFiscal.length?readFiscal:readPeriods.length||structuredPeriod?[]:fiscalPeriods(title);
  const fiscal=combineFiscalPeriods(fiscalSources);if(fiscalSources.length&&!fiscal)return null;
  if(!readPeriods.length&&!readFiscal.length&&!structuredPeriod&&fiscalMarker.test(title)&&!fiscalSources.length)return null;
  const periods=tags.get('MonthOfPeriodEnded')&&tags.get('YearOfPeriodEnded')
    ? [`${tags.get('MonthOfPeriodEnded')} ${String(tags.get('YearOfPeriodEnded')).slice(0,4)}`,...readPeriods]
    : readPeriods.length?readPeriods:readFiscal.length?[]:periodsIn(title);
  if(periods.some(p=>!financialPeriod(p)||financialPeriod(p)!==financialPeriod(periods[0])))return null;
  const period=periods[0]||null;
  if(period&&!financialPeriod(period))return null;
  const readAgendas=[...tags].filter(([tag,value])=>/^Agenda\d+$/.test(tag)&&value&&!/^(?:true|false|none|not applicable|n\/?a)$/i.test(value)).map(([,value])=>normal(value));
  const agendaText=structured?readAgendas.join(' and '):readNotice?.purpose||title;
  const agendas = [
    ['results', /\b(?:financial results|quarterly results|half yearly.*results)\b/i],
    ['dividend', /\bdividend\b/i], ['fundraising', /\bfund.?rais\w*\b/i], ['QIP', /\bQIP\b/i],
    ['rights issue', /\brights issue\b/i], ['preferential issue', /\bpreferential issue\b/i],
    ['buyback', /\bbuyback\b/i], ['acquisition', /\bacquisition\b/i], ['merger', /\bmerger\b/i], ['divestment', /\bdivest\w*\b/i],
    ['appointment', /\bappointment\b/i], ['resignation', /\bresignation\b/i],
  ].filter(([, pattern]) => pattern.test(agendaText)).map(([name]) => name);
  const purpose = structured?readAgendas.join(' and ')||null:readNotice?.purpose||/\bto consider(?: and approve)?\s+(.+)$/i.exec(title)?.[1];
  const generic = !structured&&!readNotice&&!agendas.length && (purpose ? /^(?:intimation of )?(?:the )?board meeting[ .…]*$/i.test(purpose)
    : /^[ .…]*$/.test(title.slice(match.index + match[0].length)));
  const plainResults='unaudited financial results',plainBuyback='a proposal for buyback of fully paid-up equity shares';
  const simpleReadAgendas=new Set((readNotice?.agendas||[]).flatMap(value=>{
    const v=normal(value).toLowerCase();return v===`${plainResults} and ${plainBuyback}`||v===`${plainBuyback} and ${plainResults}`?[plainResults,plainBuyback]:[v];
  }));
  const simpleBuyback=structured?readAgendas.length>=2&&readAgendas.every(v=>/^(?:Financial results|Buyback|Other business)$/i.test(v))&&
    !(item.content.facts||[]).some(f=>['amount','ownership','conditions','counterparty','reason'].includes(f.field)&&!administrativeNoticeFact(f)):
    !!readNotice&&!readNotice.extras.length&&simpleReadAgendas.size===2&&simpleReadAgendas.has(plainResults)&&simpleReadAgendas.has(plainBuyback);
  const materialExtras=item.content?.state==='ready'&&(item.content.facts||[]).some(f=>['amount','ownership','conditions','counterparty','reason'].includes(f.field)&&!administrativeNoticeFact(f));
  let residual=normal(purpose).toLowerCase();
  for(const p of periodsIn(purpose))residual=residual.replace(p.toLowerCase(),'');
  for(const p of fiscalPeriods(purpose))if(p.raw)residual=residual.replace(p.raw.toLowerCase(),'');
  residual=residual.replace(/\b(?:un-audited|unaudited|audited|standalone|consolidated|half yearly|half[- ]year(?:ly)?|quarterly|annual|financial results|quarterly results|dividend|interim|final|special|other business|the|of|company|for|period|quarter|year|ended|and)\b/g,'').replace(/[\s.,…&()/-]/g,'');
  const unreadPurpose=item.content?.state!=='ready';
  const readUnknown=!structured&&!readNotice&&!unreadPurpose&&(item.content.facts||[]).some(f=>f.field==='event');
  const unknownPurpose=readUnknown||!generic&&!simpleBuyback&&(!purpose||!!residual);
  return { simpleBuyback, materialExtras, unknownPurpose, date: at.toISOString().slice(0,10), label: `${day} ${months[month - 1][0].toUpperCase() + months[month - 1].slice(1)} ${year}`, period, fiscal, agendas, generic, purpose };
}

export function sameScheduledBoardMeeting(a, b) {
  const x = scheduledBoardMeeting(a), y = scheduledBoardMeeting(b);
  if (!x || !y || a.ticker !== b.ticker || x.date !== y.date || Math.abs(a.at - b.at) > 3600000) return false;
  if(x.materialExtras||y.materialExtras||x.unknownPurpose||y.unknownPurpose)return false;
  if (x.period && y.period && financialPeriod(x.period) !== financialPeriod(y.period)) return false;
  if(x.fiscal&&y.fiscal&&!compatibleFiscalPeriods(x.fiscal,y.fiscal))return false;
  // Quarter labels cannot be converted to calendar months without this issuer's
  // explicit fiscal calendar. Preserve both known but incomparable periods.
  if(x.fiscal&&!x.period&&y.period&&!y.fiscal||y.fiscal&&!y.period&&x.period&&!x.fiscal)return false;
  // The exact generic exchange wrapper may accompany a detailed notice. Unknown
  // prose is not generic, and two capital-action proposals can share a meeting date.
  if (x.generic || y.generic) return true;
  if(x.simpleBuyback&&y.simpleBuyback&&x.agendas.includes('results')&&y.agendas.includes('results')&&x.agendas.includes('buyback')&&y.agendas.includes('buyback'))return true;
  return x.agendas.includes('results') && y.agendas.includes('results') &&
    [...x.agendas,...y.agendas].every(value => value === 'results' || value === 'dividend');
}

export function scheduledBoardMeetingSummary(item) {
  const meeting = scheduledBoardMeeting(item);
  if (!meeting) return null;
  if (meeting.generic) return `Board meeting ${meeting.label}; agenda not specified in the captured notice.`;
  if (!meeting.purpose) return null;
  // Retain the stated purpose, including counterparties, amounts and qualifications.
  // Removing exchange boilerplate must not replace it with an inferred agenda label.
  const purpose = meeting.purpose.replace(/^the\s+/i, '').replace(/\bof the Company\b/gi, '')
    .replace(/\bHalf Yearly\b/gi, 'half-year').replace(/\bUnaudited Financial results\b/gi, 'unaudited financial results')
    .replace(/\bDividend\b/gi, 'dividend').replace(/\s+/g, ' ').replace(/[ .…]+$/, '');
  if (/\b(?:and|or|standalone|consolidated|unaudited|audited)$/i.test(purpose))
    return `Board meeting ${meeting.label}; captured agenda is incomplete.`;
  return `Board meeting ${meeting.label}: to consider ${purpose}.`;
}
