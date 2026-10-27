import { editorialEvents, editorialText } from './newsletter-editorial.mjs';
import { istLabel, istDateLong, EDITIONS } from '../public/js/data/newsletter-shared.js';
import { formatLast, formatPct, asOfLabel, NEWSLETTER_STYLE, TAGLINES } from './newsletter-brief.mjs';
import { priceReasonText } from './newsletter-price-reasons.mjs';
import { newsletterSourceUrl } from './newsletter-source-links.mjs';
import { emailSourceUrl } from './newsletter-source-shortcuts.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Only the inbox description is abbreviated. Original records and links remain in the report.
const short = (value, max) => { const s=editorialText(value); return s.length>max ? s.slice(0,max-1).replace(/\s+\S*$/,'')+'…' : s; };
const link = (url,label,color=NEWSLETTER_STYLE.GOLD,className=null) => {
  try { if (!['https:','http:'].includes(new URL(url).protocol)) return esc(label); }
  catch { return esc(label); }
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" ${className?`class="${className}"`:`style="color:${color};text-decoration:none"`}>${esc(label)}</a>`;
};
const cell = (value, extra='') => `<td style="padding:7px 5px;border-bottom:1px solid ${NEWSLETTER_STYLE.RULE};vertical-align:top;${extra}">${value}</td>`;
export const investorSubject = (brief, brand, stats, reading=editorialEvents(brief,stats.companies)) => {
  return `${brand} · ${reading.events.length} development${reading.events.length===1?'':'s'} · ${brief.day} · ${brief.edition === 'morning'?'Morning':'Evening'}`;
};

export function renderInvestorEmail(brief, {dashboardUrl,recipient,productName,brand,pdfUrl,part,preview,stats,sourceLinks,settings,reading: suppliedReading}) {
  const {INK,PAPER,CREAM,RULE,META,BODY,BODY2,GOLD,GOLD_LIGHT,SERIF,SANS}=NEWSLETTER_STYLE;
  const reading=suppliedReading||editorialEvents(brief,stats.companies);
  const chosen=new Set(part.eventIds), events=reading.byId?part.eventIds.map(id=>reading.byId.get(id)).filter(Boolean):reading.events.filter(e=>chosen.has(e.id));
  const compact=!!part.compact;
  const summaryChars=compact&&[100,140].includes(part.summaryChars)?part.summaryChars:compact?220:340;
  // Standard email CSS classes avoid repeating identical styles hundreds of times.
  // Preserve the original appearance while reserving body bytes for exact source URLs.
  const compactStyles=compact?`<style type="text/css">td.gve{padding:8px 0;border-bottom:1px solid ${RULE}}strong.gvc{font-family:${SERIF};color:${INK}}span.gvm{font-size:10px;color:${META}}a.gvl{color:${GOLD};text-decoration:none}</style>`:'';
  const reportUrl=pdfUrl || `${dashboardUrl}/api/newsletter/preview?edition=${brief.edition}&format=pdf`;
  const cards=events.map((event,index)=>{
    const s=event.lead;
    const summary=event.summary || event.sourceSummary || event.description || (s.kind==='move'?`${s.headline}. Why it moved: ${priceReasonText(s.why)}`:s.headline);
    const source=emailSourceUrl(newsletterSourceUrl(s),sourceLinks,dashboardUrl);
    const sourceLabel=s.kind==='filing'?'Announcement →':s.kind==='news'?'News report →':'Source →';
    const sameCompany=index>0&&events[index-1].ticker===event.ticker;
    const continued=index===0&&part.continuedCompany===event.ticker?' (continued)':'';
    const additional=(event.additionalReadings||[]).map(r=>`<div style="margin-top:5px"><strong>${link(emailSourceUrl(r.source,sourceLinks,dashboardUrl),'Additional source →',GOLD,compact?'gvl':null)}</strong>${r.at?` · ${esc(r.dayOnly?istDateLong(r.at):istLabel(r.at))}`:''} ${esc(short(r.text,summaryChars))}</div>`).join('');
    const type=s.kind==='filing'?'Corporate announcement':s.kind==='trade'?'Ownership disclosure':s.kind==='move'?'Price context':'Reported development';
    // One description per event. Never repeat its headline above an equivalent AI summary.
    // Keep the bounded structured meeting note intact, including a later agenda
    // such as dividend. Other excerpts can shorten on unusually dense editions.
    const description=esc(event.sourceSummary===summary&&event.completeSourceSummary?summary:short(summary,summaryChars));
    const evidence=event.summary?'AI summary':event.sourceSummary?s.content?.state==='partial'?'Partial source facts':'Source facts':event.evidence;
    const incomplete=event.read>0&&event.read<event.total?' · Some sources unread':'';
    const extraSources=event.sources.filter(url=>url!==newsletterSourceUrl(s)).map((url,i)=>
      ' · '+link(emailSourceUrl(url,sourceLinks,dashboardUrl),`[${i+2}]`,GOLD,compact?'gvl':null)).join('');
    if(compact)return `<tr><td class="gve" data-company="${esc(event.ticker)}">${sameCompany?'':`<strong class="gvc">${esc(event.company)}${continued}</strong><br>`}${description}${additional}<br><span class="gvm">${esc(evidence)}${incomplete}${event.relatedSources?' · Related source; exposure unconfirmed':''} · ${esc(istLabel(s.at))} · ${source?link(source,sourceLabel,GOLD,'gvl'):'Source link unavailable'}${extraSources}</span></td></tr>`;
    return `<tr><td data-company="${esc(event.ticker)}" style="padding:${sameCompany?'10px':'22px'} 0 12px;border-bottom:1px solid ${RULE}">
${sameCompany?'':`<div style="padding-bottom:7px;margin-bottom:8px;border-bottom:2px solid ${INK};font-family:${SERIF};font-size:${compact?18:22}px;line-height:1.2;font-weight:bold;color:${INK}">${esc(event.company)}${continued} <span style="font-family:${SANS};font-size:10px;font-weight:normal;color:${META}">${esc(event.ticker)}</span></div>`}
<div style="font-family:${SERIF};font-size:${compact?14:15}px;line-height:1.45;color:${INK};font-weight:bold">${description}</div>${additional}
${!compact&&event.summary&&event.note?.impact?`<div style="margin-top:5px"><strong>Why it matters:</strong> ${esc(short(event.note.impact,180))}</div>`:''}
${!compact&&event.summary&&event.note?.unknowns?`<div style="margin-top:4px"><strong>Watch next:</strong> ${esc(short(event.note.unknowns,140))}</div>`:''}
${event.relatedSources?`<div style="margin-top:4px;color:${META};font-size:11px">Related entity; exposure unconfirmed.</div>`:''}
<div style="margin-top:6px;font-size:11px;color:${META}">${type} · ${esc(evidence)}${incomplete} · ${esc(istLabel(s.at))} · ${source?link(source,sourceLabel):'Source link unavailable'}${extraSources}</div>
</td></tr>`;
  }).join('');
  // Edition-wide coverage diagnostics stay in the complete report. Per-event
  // source states and exact original links remain beside each inbox reading.
  const first=part.index===1;
  const calendar=first?(brief.calendar?.rows || []).map(r=>
    `<tr>${cell(`<span style="white-space:nowrap">${esc(r.date)}</span>`+(r.time?`<br>${esc(r.time)} IST`:''))}${cell(esc(r.company),'font-family:'+SERIF+';font-weight:bold')}${cell(link(r.url,r.label))}</tr>`).join(''):'';
  const actionRows=first?(brief.actions?.rows || []).map(r=>`<tr>${cell(esc(r.dates.map(d=>`${d.label} ${d.date}`).join(' · ')))}${cell(esc(r.company),'font-family:'+SERIF+';font-weight:bold')}${cell(link(r.url,r.purpose))}</tr>`).join(''):'';
  const markets=first?brief.markets.rows.map(r=>
    `<tr>${cell(`${esc(r.label)}<br><span style="font-size:10px;color:${META}">${esc(asOfLabel(r))}</span>`)}${cell(`${esc(formatLast(r)||'Unavailable')}<br><span style="color:${META}">${esc(formatPct(r)||'Change unavailable')}</span>`,'text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums')}</tr>`).join(''):'';
  const heading=title=>`<div style="margin:22px 0 7px;padding-bottom:5px;border-bottom:3px solid ${GOLD_LIGHT};font-size:11px;font-weight:bold;letter-spacing:2px;color:${INK}">${title}</div>`;
  const table=rows=>`<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;overflow-wrap:anywhere">${rows}</table>`;
  const companies=reading.companyCount??new Set(reading.events.map(e=>e.ticker)).size;
  const subscription=recipient?.test?'Requested test copy.':`Weekdays ${settings?.[brief.edition]?.time||EDITIONS[brief.edition].defaultTime} IST.${recipient?.addedBy?' Added by '+recipient.addedBy+'.':''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(investorSubject(brief,brand,stats,reading))}</title>${compactStyles}</head>
<body style="margin:0;padding:0;background:${CREAM};-webkit-text-size-adjust:100%;font-family:${SANS};font-size:13px;line-height:1.5;color:${BODY2}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM}"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:${PAPER};border:1px solid ${RULE}">
<tr><td align="right" style="padding:18px 24px 0"><a href="${esc(reportUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 16px;background:${GOLD};border-radius:4px;color:#ffffff;font-size:12px;font-weight:bold;text-decoration:none">Download PDF ↓</a></td></tr>
<tr><td align="center" style="padding:30px 24px 0"><div style="font-family:${SERIF};font-size:30px;line-height:1.2;font-weight:bold;letter-spacing:3px;color:${INK}">${esc(brand.toUpperCase())}</div><div style="border-top:3px double ${INK};margin:12px 0 7px;font-size:0;line-height:0">&nbsp;</div><div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:${META}">${esc(productName)} — ${esc(TAGLINES[brief.edition])}</div><div style="margin-top:10px;padding:7px 0;border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};font-size:11px;letter-spacing:1px;color:${META}">${esc(istDateLong(brief.at))} · ${esc(istLabel(brief.window.from))} → ${esc(istLabel(brief.window.to))}</div></td></tr>
<tr><td style="padding:14px 24px 22px"><div style="color:${BODY};font-size:12px"><strong>${reading.events.length} portfolio update${reading.events.length===1?'':'s'}</strong> · ${companies} compan${companies===1?'y':'ies'}${part.total>1?` · Part ${part.index} of ${part.total}`:''}</div>
${preview?`<div style="font-size:11px;color:${META};margin-top:5px">Preview · saved readings</div>`:''}
${heading('YOUR PORTFOLIO COMPANIES')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;overflow-wrap:anywhere">${cards||(part.packing?'':`<tr><td style="padding:18px 0;color:${META}">No new developments identified in the available readings.</td></tr>`)}</table>
${first&&part.supplements?`${calendar?heading('UPCOMING RESULTS & CALLS')+table(calendar):''}${actionRows?heading('CORPORATE ACTION DATES')+table(actionRows):''}${markets?heading('MARKET CONTEXT')+table(markets):''}`:''}
${first&&!part.supplements?`<p style="font-size:12px">${brief.calendar?.rows?.length||0} results/calls · ${brief.actions?.rows?.length||0} corporate actions · ${link(reportUrl,'Dates and markets (PDF) →')}</p>`:''}
</td></tr><tr><td style="padding:18px 24px;background:${INK};color:#d8d0be;font-size:11px;line-height:1.65">${esc(subscription)} ${link(dashboardUrl+'/#/research/ask-research?newsletter=manage','Unsubscribe',GOLD_LIGHT)}<br><strong style="color:${GOLD_LIGHT};letter-spacing:1px">${esc(brand)}</strong> · ${esc(productName)} · Automated by Munshot<br><span style="color:${GOLD_LIGHT};font-size:10px">AI impacts are interpretations. Informational, not investment advice. Built ${esc(istLabel(brief.builtAt,{year:true}))}.</span></td></tr>
</table></td></tr></table></body></html>`;
}
