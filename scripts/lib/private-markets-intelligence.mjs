import {fundMatches,investorName} from '../../public/js/data/private-market-funds.js';
import {createHash} from 'node:crypto';
import {PRIVATE_MARKETS_TITLE as TITLE, WEEK, privateMarketsSlot} from '../../public/js/data/private-markets-shared.js';
import {FIELDS,validateCapture} from './private-market-news.mjs';
import {NEWSLETTER_STYLE} from '../../worker/newsletter-style.mjs';
const {INK,PAPER,CREAM,RULE,META,BODY,BODY2,GOLD,GOLD_LIGHT,SERIF,SANS}=NEWSLETTER_STYLE;
export const title = TITLE;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const fingerprint = (row, notes=[]) => createHash('sha256').update(JSON.stringify([FIELDS.map(k=>row[k]), row.sourceFields, !!row.sourceMissing, row.publishedAt, notes])).digest('hex');
const clock = v => Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'})+' IST' : 'Unavailable';
const deskBrand = url => {const host=new URL(url).hostname;return host.startsWith('glow-')?'Glow Research Central':host.startsWith('sattva-')?'Sattva Research Central':'Research Central';};
const sourceUrl = raw => {try {const u=new URL(raw);return u.origin==='https://inc42.com'&&u.protocol==='https:'?u.href:'https://inc42.com/tag/funding-galore/';}catch{return 'https://inc42.com/tag/funding-galore/';}};
export function validRoster(value) {
 if(value?.ok!==true||value.version!==1||!Array.isArray(value.funds)||value.funds.length>1000||!value.funds.every(f=>typeof f.name==='string'&&f.name.trim()&&f.name.length<=300)||!Number.isFinite(Date.parse(value.checkedAt))) throw Error('Invested fund roster unavailable');
 return value;
}
export function buildIntelligence({capture,roster,at=Date.now(),slot=privateMarketsSlot(at),pending=[],pendingMatches=[],quarantined=[]}={}) {
 validateCapture(capture);
 const from=slot.at-WEEK,through=Math.min(at,slot.at),startDay=new Date(from+19800000).toISOString().slice(0,10),endDay=new Date(through+19800000).toISOString().slice(0,10);
 const queued=new Map(pending.map(r=>[r.id,r])),matchQueue=new Map(pendingMatches.map(r=>[r.id,r.hash])),held=new Map(quarantined.map(r=>[r.id,r.hash]));
 const rows=capture.deals.flatMap(r=>{
  const hash=fingerprint(r,capture.articles.find(a=>a.url===r.sourceUrl)?.notes||[]);
  if(held.get(r.id)===hash)return [];
  const published=Date.parse(r.publishedAt),date=r.dateISO;
  const universe=!!(published>=from&&published<through || date&&date>=startDay&&date<endDay || queued.has(r.id)),matches=fundMatches(r,roster);
  if(!universe&&!(matchQueue.get(r.id)===hash&&matches.length))return [];
  return [{...r,universe,change:queued.get(r.id)?.change||(!universe?'Fund-directory recovery':null),matches}];
 }).sort((a,b)=>String(b.dateISO||b.publishedAt||'').localeCompare(String(a.dateISO||a.publishedAt||''))||a.company.localeCompare(b.company));
 const seen=new Map(),groups=[];
 // Combine only identical complete source facts, retaining every linked observation.
 for(const row of rows){const notes=capture.articles.find(a=>a.url===row.sourceUrl)?.notes||[];const key=JSON.stringify([FIELDS.map(k=>row[k]),!!row.sourceMissing,notes]);const candidates=seen.get(key)||[];let group=candidates.find(g=>!g.observations.some(o=>o.url===row.sourceUrl));if(!group){group={...row,observations:[]};candidates.push(group);seen.set(key,candidates);groups.push(group);}group.universe ||= row.universe;group.observations.push({id:row.id,hash:fingerprint(row,notes),url:sourceUrl(row.sourceUrl),title:row.sourceTitle});}
 const unavailable=capture.articles.filter(a=>a.status!=='ok').length;
 const sourceAge=at-Date.parse(capture.sourceCheckedAt||'');
 return {title:TITLE,day:slot.day,key:slot.key,from:new Date(from).toISOString(),through:new Date(through).toISOString(),builtAt:new Date(at).toISOString(),rows:groups.filter(r=>r.universe),
  matched:groups.filter(r=>r.matches.length),roster:roster?.ok===true?roster:{ok:false,reason:'Fund roster unavailable; matches cannot be verified.'},
  coverage:{sourceCheckedAt:capture.sourceCheckedAt,attemptedAt:capture.attemptedAt,capturedAt:capture.generatedAt,error:capture.error||null,cooldownUntil:capture.cooldownUntil||null,stale:!Number.isFinite(sourceAge)||sourceAge < -10*60000 || sourceAge>12*3600000,unavailable,roundups:capture.articles.length,observations:rows.filter(r=>r.universe).length},
  notes:capture.articles.filter(a=>groups.some(r=>r.observations.some(o=>o.url===a.url))).flatMap(a=>(a.notes||[]).map(note=>({url:a.url,note})))};
}
const link = (url,label,color=GOLD) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:${color};text-decoration:none">${esc(label)}</a>`;
const heading = label => `<h2 style="margin:26px 0 8px;padding-bottom:6px;border-bottom:3px solid ${GOLD_LIGHT};font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${INK}">${esc(label)}</h2>`;
const rowHtml = (row, showMatches=false) => `<tr><td style="padding:20px 0 14px;border-bottom:1px solid ${RULE};overflow-wrap:anywhere;word-break:break-word">
<div style="padding-bottom:7px;margin-bottom:9px;border-bottom:2px solid ${INK};font-family:${SERIF};font-size:22px;line-height:1.25;color:${INK}"><strong>${esc(row.company)}</strong></div>
<div style="font-family:${SERIF};font-size:17px;line-height:1.4;color:${INK}"><strong>${esc(row.amount||'Amount undisclosed')}</strong> · ${esc(row.round||'Round not stated')}</div>
<div style="margin-top:6px;font-size:11px;color:${META}">${esc([row.date||'Funding date not stated',row.sector,row.subsector,row.businessModel].filter(Boolean).join(' · '))}</div>
<div style="margin-top:9px"><strong style="color:${BODY}">Investors:</strong> ${esc(row.investors||'Not stated')}</div>
<div style="margin-top:3px"><strong style="color:${BODY}">Lead investor:</strong> ${esc(row.leadInvestor||'Not stated')}</div>
${showMatches&&row.matches.length?`<div style="margin-top:9px;padding:9px 11px;background:${CREAM};font-size:12px;color:${BODY}"><strong>Our fund directory:</strong> ${row.matches.map(m=>esc(m.fund)+(m.closed?' (closed fund in workbook)':'')+(m.basis==='manager-match'?' (manager name match; specific vehicle unconfirmed)':' (reported name match; vehicle identity unverified)')).join('; ')}</div>`:''}
${row.change?`<div style="margin-top:7px;font-size:11px;color:${BODY}"><em>${esc(row.change)}</em></div>`:''}${row.sourceMissing?`<div style="margin-top:7px;font-size:11px;color:${BODY}"><em>Retained observation: absent from the latest source table.</em></div>`:''}
<div style="margin-top:9px;font-size:11px">${row.observations.map(o=>link(o.url,'Inc42 source ↗')).join(' · ')}</div>
</td></tr>`;
export function renderIntelligence(model,{dashboardUrl,part=1,parts=1,items=null}={}) {
 const sections=items||[{heading:'Whole universe',rows:model.rows},{heading:'Investments by funds where we have invested',rows:model.matched}];
 const brand=deskBrand(dashboardUrl),masthead=brand.replace(' Research Central',' Ventures');
 const c=model.coverage;
 const warning=[c.stale?'Source checks are overdue or the source clock could not be verified.':null,c.error?'The latest source attempt did not complete.':null,c.cooldownUntil?`Source collection cooldown until ${clock(c.cooldownUntil)}.`:null].filter(Boolean).join(' ');
 const roster=model.roster;
 const body=sections.map(section=>`${heading(section.heading)}${section.heading.startsWith('Investments')?`<p style="margin:9px 0;font-size:11px;color:${META}">${roster.ok?`Matched against ${new Set(roster.funds.map(f=>investorName(f.name))).size} fund names from ${esc(roster.source||'the desk fund directory')}, checked ${esc(clock(roster.checkedAt))}. ${roster.workbook?.saved?`Workbook saved ${esc(clock(roster.workbook.saved))}`:roster.asOf?`Statement period ${esc(roster.asOf)}`:'No fund valuation date stated'}. A manager-level match does not prove the specific vehicle invested.`:'The invested-fund directory could not be verified. This section is unavailable; it does not establish zero investments.'}</p>`:''}${section.rows.length?`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed">${section.rows.map(row=>rowHtml(row,section.heading.startsWith('Investments'))).join('')}</table>`:`<p style="margin:16px 0;color:${META}">${section.heading.startsWith('Investments')?(roster.ok?'No matching reported investments in this part. Unnamed investors and different source spellings can prevent a match.':'Matches will be reconciled after the fund directory becomes available.'):'No captured funding observations in this section.'}</p>`}`).join('');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${TITLE} · ${esc(model.day)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:${CREAM};-webkit-text-size-adjust:100%;font-family:${SANS};font-size:13px;line-height:1.6;color:${BODY2}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM}"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:${PAPER};border:1px solid ${RULE}">
<tr><td align="right" style="padding:18px 24px 0;font-size:12px">${link(dashboardUrl+'/#/research/private-market-news?scope=universe','Open Private Market →')}</td></tr>
<tr><td align="center" style="padding:30px 24px 0"><div style="font-family:${SERIF};font-size:30px;line-height:1.2;font-weight:bold;letter-spacing:3px;color:${INK}">${esc(masthead.toUpperCase())}</div><div style="border-top:3px double ${INK};margin:12px 0 7px;font-size:0;line-height:0">&nbsp;</div><div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:${META}">${esc(brand)}</div><h1 style="margin:16px 0 12px;font-family:${SERIF};font-size:27px;line-height:1.25;font-weight:bold;color:${INK}">${TITLE}</h1><div style="padding:7px 0;border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};font-size:11px;letter-spacing:1px;color:${META}">${esc(model.day)} · Weekly, Monday 9 am IST${parts>1?` · Part ${part} of ${parts}`:''}</div></td></tr>
<tr><td style="padding:0 24px 24px;overflow-wrap:anywhere;word-break:break-word">${body}
${heading('Coverage & sources')}<p style="font-size:11px;color:${META}">Reporting window ${esc(clock(model.from))} to ${esc(clock(model.through))}. ${warning?esc(warning)+' ':''}Source listing checked ${esc(clock(c.sourceCheckedAt))}. Last attempt ${esc(clock(c.attemptedAt))}. Capture ${esc(clock(c.capturedAt))}. ${c.unavailable} of ${c.roundups} archived roundups do not have a currently readable supported public table. Coverage is Inc42's Indian startup funding tables, including reported VC/PE and other financing; it is not an exhaustive private-market universe. Amounts and unknown dates remain as reported. Older arrivals and source corrections are labelled separately.</p>${model.notes.map(n=>`<p style="font-size:11px;color:${META}">${esc(n.note)} ${link(sourceUrl(n.url),'Source note ↗')}</p>`).join('')}
</td></tr><tr><td style="padding:18px 24px;background:${INK};color:#d8d0be;font-size:11px;line-height:1.65">Your weekly private markets bulletin. ${link(dashboardUrl+'/#/research/ask-research?newsletter=manage','Manage subscription / unsubscribe',GOLD_LIGHT)}<br><strong style="color:${GOLD_LIGHT};letter-spacing:1px">${esc(masthead)}</strong> · Research Central · Automated by Munshot<br><span style="color:${GOLD_LIGHT};font-size:10px">This separate weekly bulletin uses the existing newsletter's active recipient list. Built ${esc(clock(model.builtAt))}.</span></td></tr>
</table></td></tr></table></body></html>`;
}
export function intelligenceEmails(model,options) {
 const entries=[...model.rows.map(row=>({heading:'Whole universe',row})),...model.matched.map(row=>({heading:'Investments by funds where we have invested',row}))];
 const chunks=[[]];
 const sections=chunk=>['Whole universe','Investments by funds where we have invested'].map(heading=>({heading,rows:chunk.filter(e=>e.heading===heading).map(e=>e.row)}));
 const render=chunk=>renderIntelligence(model,{...options,part:999,parts:999,items:sections(chunk)});
 for(const entry of entries){let chunk=chunks.at(-1);if(Buffer.byteLength(render([...chunk,entry]))>88000){if(!chunk.length)throw Error('Funding observation exceeds email budget');chunks.push([]);chunk=chunks.at(-1);}chunk.push(entry);if(Buffer.byteLength(render(chunk))>88000)throw Error('Funding observation exceeds email budget');}
 return chunks.map((chunk,i)=>({html:renderIntelligence(model,{...options,part:i+1,parts:chunks.length,items:sections(chunk)}),subject:`${TITLE} — ${deskBrand(options.dashboardUrl)} — ${model.day}`,part:i+1,parts:chunks.length,observations:chunk.flatMap(e=>e.row.observations)}));
}
