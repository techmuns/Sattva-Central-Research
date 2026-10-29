import { editorialEvents, editorialText } from './newsletter-editorial.mjs';
import { istLabel, istParts, istDateLong, EDITIONS } from '../public/js/data/newsletter-shared.js';
import { formatLast, formatPct, asOfLabel, NEWSLETTER_STYLE, TAGLINES, MOODS } from './newsletter-brief.mjs';
import { priceReasonText } from './newsletter-price-reasons.mjs';
import { newsletterSourceUrl } from './newsletter-source-links.mjs';
import { emailSourceUrl } from './newsletter-source-shortcuts.mjs';
import { updateTone, updateDirection } from './newsletter-company-reading.mjs';
import { isTypeOnly, sourceStatement } from '../public/js/data/alert-claims.js';

// The exchange's lead-in names the company its heading already names ("X has informed the
// Exchange regarding …", "X has submitted to the Exchange, …"); the filing's own words follow it.
// The untouched title stays in the linked filing and the complete report.
const LEAD_IN = /\bhas\s+(?:informed|submitted\s+to)\s+the\s+Exchanges?\b|^\s*the\s+Exchanges?\s+(?:has|have)\s+received\b/i;
const filingWords = text => !LEAD_IN.test(text) ? text : sourceStatement(text).replace(/^.{0,90}?\bhas\s+submitted\s+to\s+the\s+Exchanges?\s*,?\s*/i, '').replace(/^[a-z](?=[a-z]*\s)/, c => c.toUpperCase());
// The lede carries the weight: the first sentence or clause bold, its detail in body type.
// Abbreviations ("Rs.", "Ltd.") never end a lede.
const ledeOf = text => { const m = /^([\s\S]{24,180}?(?<!\b(?:[A-Za-z]|[Rr]s|Ltd|Co|No|Mr|Ms|Dr|vs|Inc|[Aa]pprox|Pvt|St|Bln|Mn|Cr))[.;])(\s[\s\S]+)$/.exec(text); return m ? [m[1], m[2]] : [text, '']; };

// A title that only cites the rule it is filed under ("Intimation under Regulation 30 and 51 of
// SEBI (LODR) Regulations, 2015") names no event, exactly like "Updates".
const citationOnly = text => /\bregulations?\b/i.test(text) && !String(text).replace(/\b(?:intimations?|disclosures?|submissions?|compliances?|announcements?|under|pursuant|to|as|per|in|terms|of|the|and|sebi|lodr|listing|obligations|disclosure|requirements|regulations?|reg|para|sub|clause|read|with)\b|\d+|[(),.&\/\s-]/gi, '');
// "Approvals & IP" is a regulator's word. A board approving its own dividend is not one.
const REGULATOR = /\b(?:FDA|USFDA|EMA|MHRA|DCGI|CDSCO|SEBI|RBI|IRDAI|NCLT|CCI|NHA|MoEF\w*|ministry|regulator\w*|government|patents?|licen[cs]e\w*|clearance|tribunal|court)\b/i;
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Only the inbox description is abbreviated. Original records and links remain in the report.
const short = (value, max) => { const s=editorialText(value); return s.length>max ? s.slice(0,max-1).replace(/\s+\S*$/,'')+'…' : s; };
const link = (url,label,color=NEWSLETTER_STYLE.GOLD,className=null) => {
  try { if (!['https:','http:'].includes(new URL(url).protocol)) return esc(label); }
  catch { return esc(label); }
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" ${className?`class="${className}"`:`style="color:${color};text-decoration:none"`}>${esc(label)}</a>`;
};
// "28 Oct 20:30": the masthead states the IST window once, so a digest line drops the weekday.
const digestTime = ms => { const p=istParts(ms); return `${istLabel(ms,{time:false}).replace(/^\S+ /,'')} ${String(p.hh).padStart(2,'0')}:${String(p.mm).padStart(2,'0')}`; };
// The digest tier's link: still a new tab, with noreferrer (which implies noopener in the HTML
// standard) and the constant tokens unquoted. Only the URL is variable, and it stays quoted.
const digestLink = (url,label) => {
  try { if (!['https:','http:'].includes(new URL(url).protocol)) return esc(label); }
  catch { return esc(label); }
  return `<a href="${esc(url)}" target=_blank rel=noreferrer class=gvl>${esc(label)}</a>`;
};
export const investorSubject = (brief, brand, stats, reading=editorialEvents(brief,stats.companies)) => {
  return `${brand} · ${reading.events.length} development${reading.events.length===1?'':'s'} · ${brief.day} · ${brief.edition === 'morning'?'Morning':'Evening'}`;
};

export function renderInvestorEmail(brief, {dashboardUrl,recipient,productName,brand,pdfUrl,part,preview,stats,sourceLinks,settings,reading: suppliedReading}) {
  const {INK,PAPER,CREAM,RULE,META,BODY,BODY2,GOLD,GOLD_LIGHT,SERIF,SANS,POSITIVE,NEGATIVE}=NEWSLETTER_STYLE;
  const reading=suppliedReading||editorialEvents(brief,stats.companies);
  const chosen=new Set(part.eventIds), events=reading.byId?part.eventIds.map(id=>reading.byId.get(id)).filter(Boolean):reading.events.filter(e=>chosen.has(e.id));
  const compact=!!part.compact;
  // The last tier before refusal: one row per company, one line per update. Every update,
  // its source state and every exact source link stay in the inbox; only the markup shrinks.
  // If even that cannot fit, the final tier links each update's leading source and counts the
  // rest, which every part's Download PDF carries in full.
  const digest=compact&&part.digest===true, inlineExtras=!digest||part.extraSources!==false;
  const summaryChars=compact&&[100,140].includes(part.summaryChars)?part.summaryChars:compact?220:340;
  // Standard email CSS classes avoid repeating identical styles hundreds of times.
  // Preserve the original appearance while reserving body bytes for exact source URLs.
  const numericStyle='text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums';
  // Emphasis scales with the tier. The detailed and first compact tiers (an ordinary busy day) carry
  // every tag, the ruled company line and its count; the flood tiers keep what decides the reading —
  // the coloured rule, the bold lede with its ▲/▼ and the risk tag — so 500 updates still fit.
  const rich=!compact||(summaryChars>=220&&!digest), lean=compact&&!rich&&!digest;
  // Every update sits behind a 3px rule: green for a positive direction, red for a negative one or
  // a tracked risk topic, paper-white otherwise so every lede starts on the same line. A lean tier
  // draws it on the row's own cell, which costs no extra element per update.
  const rules=lean?`td.gve,td.gvg,td.gvw{padding:9px 0 9px 9px;border-bottom:1px solid ${RULE};border-left:3px solid ${PAPER}}td.gvg{border-left-color:${POSITIVE}}td.gvw{border-left-color:${NEGATIVE}}td.gve b,td.gvg b,td.gvw b{color:${INK}}`
    :`td.gve{padding:9px 0;border-bottom:1px solid ${RULE}}div.gvu,div.gvg,div.gvw{margin-top:5px;padding-left:9px;border-left:3px solid ${PAPER}}div.gvg{border-left-color:${POSITIVE}}div.gvw{border-left-color:${NEGATIVE}}div.gvu b,div.gvg b,div.gvw b{color:${INK}}`;
  const compactStyles=compact?`<style type="text/css">${rules}td.gvt{padding:7px 5px;border-bottom:1px solid ${RULE};vertical-align:top}td.gvr{${numericStyle}}${rich?`div.gvh{padding:2px 0 5px;border-bottom:2px solid ${INK}}`:''}strong.gvc{font-family:${SERIF};font-size:17px;color:${INK}}span.gvm{font-size:10px;color:${META}}a.gvl{color:${GOLD};text-decoration:none}span.gvq{color:${META}}span.gvm b{font-size:10px;letter-spacing:1px}span.gvm b.gvk{color:${GOLD}}span.gvm b.gvr,span.gvm b.gvx{color:${NEGATIVE}}span.gvm b.gvp{color:${POSITIVE}}${digest?'span.gvn{white-space:nowrap}':''}</style>`:'';
  // Inline equivalents for the detailed tier, which carries no style block.
  const toneColor={good:POSITIVE,watch:NEGATIVE};
  const tag=(cls,text)=>compact?`<b class=${cls}>${text}</b> · `:`<b style="font-size:10px;letter-spacing:1px;color:${({gvk:GOLD,gvp:POSITIVE})[cls]||NEGATIVE}">${text}</b> · `;
  const marks=(s)=>{
    const topic=s.topic&&s.topic.id!=='other'&&(rich||s.topic.id==='trouble')&&(s.topic.id!=='approvals'||REGULATOR.test(s.headline||''))?tag(s.topic.id==='trouble'?'gvr':'gvk',esc(s.topic.label.toUpperCase())):'';
    const direction=rich?({good:tag('gvp','▲ POSITIVE'),watch:tag('gvx','▼ NEGATIVE')})[updateDirection(s)]||'':'';
    return topic+direction;
  };
  // How many updates point each way, for the edition line and each company heading.
  const tally=list=>{const t={watch:0,good:0};for(const e of list){const tone=updateTone(e.lead);if(tone)t[tone]++;}return t;};
  const tallyHtml=(t,size)=>[t.watch?`<b style="color:${NEGATIVE}">▼ ${t.watch} to watch</b>`:'',t.good?`<b style="color:${POSITIVE}">▲ ${t.good} positive</b>`:''].filter(Boolean).map(x=>size?x.replace('<b style="',`<b style="font-size:${size}px;`):x).join(' · ');
  const byCompany=new Map();for(const e of reading.events){if(!byCompany.has(e.ticker))byCompany.set(e.ticker,[]);byCompany.get(e.ticker).push(e);}
  const cell=(value,extra='',numeric=false)=>compact?`<td class="gvt${numeric?' gvr':''}"${extra?` style="${extra}"`:''}>${value}</td>`:
    `<td style="padding:7px 5px;border-bottom:1px solid ${RULE};vertical-align:top;${extra}${numeric?numericStyle:''}">${value}</td>`;
  const reportUrl=pdfUrl || `${dashboardUrl}/api/newsletter/preview?edition=${brief.edition}&format=pdf`;
  const cards=events.map((event,index)=>{
    const s=event.lead;
    const summary=event.summary || event.sourceSummary || event.description || (s.kind==='move'?`${s.headline}. Why it moved: ${priceReasonText(s.why)}`:s.headline);
    const source=emailSourceUrl(newsletterSourceUrl(s),sourceLinks,dashboardUrl);
    const sourceLabel=s.kind==='filing'?'Announcement →':s.kind==='news'?'News report →':'Source →';
    const sameCompany=index>0&&events[index-1].ticker===event.ticker;
    const continued=index===0&&part.continuedCompany===event.ticker?' (continued)':'';
    const additional=(event.additionalReadings||[]).map(r=>`<div style="margin-top:5px"><strong>${digest?digestLink(emailSourceUrl(r.source,sourceLinks,dashboardUrl),'Additional source →'):link(emailSourceUrl(r.source,sourceLinks,dashboardUrl),'Additional source →',GOLD,compact?'gvl':null)}</strong>${r.at?` · ${esc(r.dayOnly?istDateLong(r.at):istLabel(r.at))}`:''} ${esc(short(r.text,summaryChars))}</div>`).join('');
    const type=s.kind==='filing'?'Corporate announcement':s.kind==='trade'?'Ownership disclosure':s.kind==='move'?'Price context':'Reported development';
    // One description per event. Never repeat its headline above an equivalent AI summary.
    // Keep the bounded structured meeting note intact, including a later agenda
    // such as dividend. Other excerpts can shorten on unusually dense editions.
    // A filing that only repeats its exchange title reads in the filing's own words, and a title
    // that names no event ("Updates", "Please refer the enclosed file") is shown as exactly that.
    const titleOnly=s.kind==='filing'&&summary===s.headline;
    const text=titleOnly?filingWords(s.headline)||s.headline:summary;
    const bare=titleOnly&&(isTypeOnly(text)||citationOnly(text));
    const [head,rest]=ledeOf(event.sourceSummary===summary&&event.completeSourceSummary?text:short(text,summaryChars));
    const description=bare?`<span ${compact?'class=gvq':`style="color:${META}"`}>Filing titled “${esc(text)}”; the title states no event</span>`
      :`<b${compact?'':` style="color:${INK}"`}>${rich?'':({good:'▲ ',watch:'▼ '})[updateDirection(s)]||''}${esc(head)}</b>${esc(rest)}`;
    const tone=updateTone(s), bar=tone==='good'?'gvg':tone==='watch'?'gvw':'gvu';
    // A company's count only when it has several updates; a single update's own label says it.
    const own=byCompany.get(event.ticker)||[], tallied=rich&&own.length>1?tallyHtml(tally(own),compact?10:11):'';
    const evidence=event.summary?'AI summary':event.sourceSummary?s.content?.state==='partial'?'Partial source facts':'Source facts':event.evidence;
    const incomplete=event.read>0&&event.read<event.total?' · Some sources unread':'';
    const extraSources=event.sources.filter(url=>url!==newsletterSourceUrl(s)).map((url,i)=>
      ' · '+link(emailSourceUrl(url,sourceLinks,dashboardUrl),`[${i+2}]`,GOLD,compact?'gvl':null)).join('');
    // Optional quotes can be omitted for these constant class tokens; variable
    // attributes (issuer IDs, URLs and text) remain quoted and escaped.
    if(digest){
      const related=event.relatedSources?' · Related source; exposure unconfirmed':'';
      const others=event.sources.filter(url=>url!==newsletterSourceUrl(s));
      const extras=!others.length?'':inlineExtras?others.map((url,i)=>' '+digestLink(emailSourceUrl(url,sourceLinks,dashboardUrl),`[${i+2}]`)).join(''):` · +${others.length} source${others.length===1?'':'s'} in PDF`;
      const closes=index===events.length-1||events[index+1].ticker!==event.ticker;
      return `${sameCompany?'':`<tr><td class=gve data-company="${esc(event.ticker)}"><strong class=gvc>${esc(event.company)}${continued}</strong>${tallied?` ${tallied}`:''}`}<div class=${bar}>${description}${additional} <span class=gvm>${marks(s)}${esc(evidence)}${incomplete}${related} · ${esc(digestTime(s.at))} · ${source?digestLink(source,sourceLabel):'Source link unavailable'}${extras}</span></div>${closes?'</td></tr>':''}`;
    }
    if(lean)return `<tr><td class=${({gvg:'gvg',gvw:'gvw'})[bar]||'gve'} data-company="${esc(event.ticker)}">${sameCompany?'':`<strong class=gvc>${esc(event.company)}${continued}</strong><br>`}${description}${additional}<br><span class=gvm>${marks(s)}${esc(evidence)}${incomplete}${event.relatedSources?' · Related source; exposure unconfirmed':''} · ${esc(istLabel(s.at))} · ${source?link(source,sourceLabel,GOLD,'gvl'):'Source link unavailable'}${extraSources}</span></td></tr>`;
    if(compact)return `<tr><td class=gve data-company="${esc(event.ticker)}">${sameCompany?'':rich?`<div class=gvh><strong class=gvc>${esc(event.company)}${continued}</strong>${tallied?` ${tallied}`:''}</div>`:`<strong class=gvc>${esc(event.company)}${continued}</strong>`}<div class=${bar}>${description}${additional}<br><span class=gvm>${marks(s)}${esc(evidence)}${incomplete}${event.relatedSources?' · Related source; exposure unconfirmed':''} · ${esc(istLabel(s.at))} · ${source?link(source,sourceLabel,GOLD,'gvl'):'Source link unavailable'}${extraSources}</span></div></td></tr>`;
    return `<tr><td data-company="${esc(event.ticker)}" style="padding:${sameCompany?'10px':'22px'} 0 12px;border-bottom:1px solid ${RULE}">
${sameCompany?'':`<div style="padding-bottom:7px;margin-bottom:9px;border-bottom:2px solid ${INK};font-family:${SERIF};font-size:22px;line-height:1.2;font-weight:bold;color:${INK}">${esc(event.company)}${continued} <span style="font-family:${SANS};font-size:10px;font-weight:normal;color:${META}">${esc(event.ticker)}</span>${tallied?` <span style="font-family:${SANS};font-weight:normal">${tallied}</span>`:''}</div>`}
<div style="padding-left:11px;border-left:3px solid ${toneColor[tone]||PAPER}">
<div style="font-family:${SERIF};font-size:15px;line-height:1.5;color:${BODY}">${description}</div>${additional}
${event.summary&&event.note?.impact?`<div style="margin-top:5px"><strong>Why it matters:</strong> ${esc(short(event.note.impact,180))}</div>`:''}
${event.summary&&event.note?.unknowns?`<div style="margin-top:4px"><strong>Watch next:</strong> ${esc(short(event.note.unknowns,140))}</div>`:''}
${event.relatedSources?`<div style="margin-top:4px;color:${META};font-size:11px">Related entity; exposure unconfirmed.</div>`:''}
<div style="margin-top:6px;font-size:11px;color:${META}">${marks(s)}${type} · ${esc(evidence)}${incomplete} · ${esc(istLabel(s.at))} · ${source?link(source,sourceLabel):'Source link unavailable'}${extraSources}</div>
</div>
</td></tr>`;
  }).join('');
  // Edition-wide coverage diagnostics stay in the complete report. Per-event
  // source states and exact original links remain beside each inbox reading.
  const last=part.index===part.total;
  // The digest keeps every closing row and link, styled by the same classes instead of inline.
  const company=name=>digest?cell(`<strong class=gvc>${esc(name)}</strong>`):cell(esc(name),'font-family:'+SERIF+';font-weight:bold');
  const rowLink=(url,label)=>digest?digestLink(url,label):link(url,label);
  const calendar=last?(brief.calendar?.rows || []).map(r=>
    `<tr>${cell((digest?`<span class=gvn>${esc(r.date)}</span>`:`<span style="white-space:nowrap">${esc(r.date)}</span>`)+(r.time?`<br>${esc(r.time)} IST`:''))}${company(r.company)}${cell(rowLink(r.url,r.label))}</tr>`).join(''):'';
  const actionRows=last?(brief.actions?.rows || []).map(r=>`<tr>${cell(esc(r.dates.map(d=>`${d.label} ${d.date}`).join(' · ')))}${company(r.company)}${cell(rowLink(r.url,r.purpose))}</tr>`).join(''):'';
  const markets=last?brief.markets.rows.map(r=>{
    const tone=r.changePct==null?META:r.changePct>0?MOODS.good.color:r.changePct<0?MOODS.watch.color:MOODS.neutral.color;
    return `<tr>${cell(`${esc(r.label)}<br>${digest?'<span class=gvm>':`<span style="font-size:10px;color:${META}">`}${esc(asOfLabel(r))}</span>`)}${cell(`${esc(formatLast(r)||'Unavailable')}<br><span style="color:${tone};font-weight:bold">${esc(formatPct(r)||'Change unavailable')}</span>`,'',true)}</tr>`;
  }).join(''):'';
  const heading=title=>`<div style="margin:22px 0 7px;padding-bottom:5px;border-bottom:3px solid ${GOLD_LIGHT};font-size:11px;font-weight:bold;letter-spacing:2px;color:${INK}">${title}</div>`;
  const table=rows=>`<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;overflow-wrap:anywhere">${rows}</table>`;
  const companies=reading.companyCount??new Set(reading.events.map(e=>e.ticker)).size;
  const editionTally=tallyHtml(tally(reading.events));
  const subscription=recipient?.test?'Requested test copy.':`Weekdays ${settings?.[brief.edition]?.time||EDITIONS[brief.edition].defaultTime} IST.${recipient?.addedBy?' Added by '+recipient.addedBy+'.':''}`;
  const unsubscribe=link(dashboardUrl+'/#/research/ask-research?newsletter=manage','Unsubscribe',last?GOLD_LIGHT:META);
  const footer=last?`<tr><td style="padding:18px 24px;background:${INK};color:#d8d0be;font-size:11px;line-height:1.65">${esc(subscription)} ${unsubscribe}<br><strong style="color:${GOLD_LIGHT};letter-spacing:1px">${esc(brand)}</strong> · ${esc(productName)} · Automated by Munshot<br><span style="color:${GOLD_LIGHT};font-size:10px">AI impacts are interpretations. Informational, not investment advice. Built ${esc(istLabel(brief.builtAt,{year:true}))}.</span></td></tr>`:
    `<tr><td style="padding:10px 24px 18px;border-top:1px solid ${RULE};color:${META};font-size:11px">Continued in Part ${part.index+1} of ${part.total}. ${unsubscribe}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(investorSubject(brief,brand,stats,reading))}</title>${compactStyles}</head>
<body style="margin:0;padding:0;background:${CREAM};-webkit-text-size-adjust:100%;font-family:${SANS};font-size:13px;line-height:1.5;color:${BODY2}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM}"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:${PAPER};border:1px solid ${RULE}">
<tr><td align="right" style="padding:18px 24px 0"><a href="${esc(reportUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 16px;background:${GOLD};border-radius:4px;color:#ffffff;font-size:12px;font-weight:bold;text-decoration:none">Download PDF ↓</a></td></tr>
<tr><td align="center" style="padding:30px 24px 0"><div style="font-family:${SERIF};font-size:30px;line-height:1.2;font-weight:bold;letter-spacing:3px;color:${INK}">${esc(brand.toUpperCase())}</div><div style="border-top:3px double ${INK};margin:12px 0 7px;font-size:0;line-height:0">&nbsp;</div><div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:${META}">${esc(productName)} — ${esc(TAGLINES[brief.edition])}</div><div style="margin-top:10px;padding:7px 0;border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};font-size:11px;letter-spacing:1px;color:${META}">${esc(istDateLong(brief.at))} · ${esc(istLabel(brief.window.from))} → ${esc(istLabel(brief.window.to))}</div></td></tr>
<tr><td style="padding:14px 24px 22px"><div style="color:${BODY};font-size:12px"><strong>${reading.events.length} portfolio update${reading.events.length===1?'':'s'}</strong> · ${companies} compan${companies===1?'y':'ies'}${editionTally?` · ${editionTally}`:''}${part.total>1?` · Part ${part.index} of ${part.total}`:''}</div>
${preview?`<div style="font-size:11px;color:${META};margin-top:5px">Preview · saved readings</div>`:''}
${events.length||!reading.events.length||part.packing?`${heading('YOUR PORTFOLIO COMPANIES')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;overflow-wrap:anywhere">${cards||(part.packing?'':`<tr><td style="padding:18px 0;color:${META}">No new developments identified in the available readings.</td></tr>`)}</table>`:''}
${last&&part.supplements?`${calendar?heading('UPCOMING RESULTS & CALLS')+table(calendar):''}${actionRows?heading('CORPORATE ACTION DATES')+table(actionRows):''}${markets?heading('MARKET CONTEXT')+table(markets):''}`:''}
${last&&!part.supplements?`<p style="font-size:12px">${brief.calendar?.rows?.length||0} results/calls · ${brief.actions?.rows?.length||0} corporate actions · ${link(reportUrl,'Dates and markets (PDF) →')}</p>`:''}
</td></tr>${footer}
</table></td></tr></table></body></html>`;
}
