import {fundMatches,investorName} from '../../public/js/data/private-market-funds.js';
import {createHash} from 'node:crypto';
import {PRIVATE_MARKETS_TITLE as TITLE, WEEK, privateMarketsSlot} from '../../public/js/data/private-markets-shared.js';
import {FIELDS,validateCapture} from './private-market-news.mjs';
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
const rowHtml = (row, showMatches=false) => `<tr><td style="padding:14px 0;border-bottom:1px solid #ddd;overflow-wrap:anywhere"><strong>${esc(row.company)}</strong> · ${esc(row.amount||'Amount undisclosed')} · ${esc(row.round||'Round not stated')}<br><span style="color:#475569">${esc([row.date||'Funding date not stated',row.sector,row.subsector,row.businessModel].filter(Boolean).join(' · '))}</span><br>Investors: ${esc(row.investors||'Not stated')}<br>Lead investor: ${esc(row.leadInvestor||'Not stated')}${showMatches&&row.matches.length?`<br>Our fund directory: ${row.matches.map(m=>esc(m.fund)+(m.closed?' (closed fund in workbook)':'')+(m.basis==='manager-match'?' (manager name match; specific vehicle unconfirmed)':' (reported name match; vehicle identity unverified)')).join('; ')}`:''}${row.change?`<br><em>${esc(row.change)}</em>`:''}${row.sourceMissing?'<br><em>Retained observation: absent from the latest source table.</em>':''}<br>${row.observations.map(o=>`<a href="${esc(o.url)}" style="color:#5146c6">Inc42 source ↗</a>`).join(' · ')}</td></tr>`;
export function renderIntelligence(model,{dashboardUrl,part=1,parts=1,items=null}={}) {
 const sections=items||[{heading:'Whole universe',rows:model.rows},{heading:'Investments by funds where we have invested',rows:model.matched}];
 const brand=deskBrand(dashboardUrl);
 const c=model.coverage;
 const warning=[c.stale?'Source checks are overdue or the source clock could not be verified.':null,c.error?'The latest source attempt did not complete.':null,c.cooldownUntil?`Source collection cooldown until ${clock(c.cooldownUntil)}.`:null].filter(Boolean).join(' ');
 const roster=model.roster;
 const body=sections.map(section=>`<h2 style="font-size:19px;margin:28px 0 8px">${esc(section.heading)}</h2>${section.heading.startsWith('Investments')?`<p>${roster.ok?`Matched against ${new Set(roster.funds.map(f=>investorName(f.name))).size} fund names from ${esc(roster.source||'the desk fund directory')}, checked ${esc(clock(roster.checkedAt))}. ${roster.workbook?.saved?`Workbook saved ${esc(clock(roster.workbook.saved))}`:roster.asOf?`Statement period ${esc(roster.asOf)}`:'No fund valuation date stated'}. A manager-level match does not prove the specific vehicle invested.`:'The invested-fund directory could not be verified. This section is unavailable; it does not establish zero investments.'}</p>`:''}${section.rows.length?`<table role="presentation" width="100%" style="border-collapse:collapse;table-layout:fixed">${section.rows.map(row=>rowHtml(row,section.heading.startsWith('Investments'))).join('')}</table>`:`<p>${section.heading.startsWith('Investments')&&roster.ok?'No matching reported investments in this edition. Unnamed investors and different source spellings can prevent a match.':'No captured funding observations in this section.'}</p>`}`).join('');
 return `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE} · ${esc(model.day)}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f4f8;color:#182033;font:14px/1.6 Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:24px;background:#fff"><p style="color:#5146c6">${esc(brand)}</p><h1 style="font-size:27px;line-height:1.2">${TITLE}</h1><p>${esc(model.day)} · Weekly, Monday 9 am IST${parts>1?` · Part ${part} of ${parts}`:''}</p><p>Reporting window ${esc(clock(model.from))} to ${esc(clock(model.through))}. ${model.rows.length} reported funding entries (${c.observations} source observations); ${roster.ok?`${model.matched.length} match a fund in our directory or its manager.`:'Invested-fund matching is unavailable.'} Repeated identical facts share their source links; these are not independently verified transaction totals.</p>${warning?`<p style="background:#fff3cd;padding:12px">${esc(warning)}</p>`:''}${body}<h2 style="font-size:19px;margin-top:28px">Coverage & sources</h2><p>Source listing checked ${esc(clock(c.sourceCheckedAt))}. Last attempt ${esc(clock(c.attemptedAt))}. Capture ${esc(clock(c.capturedAt))}. ${c.unavailable} of ${c.roundups} archived roundups do not have a currently readable supported public table. Coverage is Inc42's Indian startup funding tables, including reported VC/PE and other financing; it is not an exhaustive private-market universe. Amounts and unknown dates remain as reported. Older arrivals and source corrections are labelled separately.</p>${model.notes.map(n=>`<p>${esc(n.note)} <a href="${esc(sourceUrl(n.url))}">Source note ↗</a></p>`).join('')}<p><a href="${esc(dashboardUrl)}/#/research/private-market-news?scope=universe">Open Private Market</a> · <a href="${esc(dashboardUrl)}/#/research/ask-research?newsletter=manage">Manage subscription / unsubscribe</a></p><p style="color:#64748b">This separate weekly bulletin uses the existing newsletter's active recipient list. Automated by Munshot</p></div></body></html>`;
}
export function intelligenceEmails(model,options) {
 const entries=[...model.rows.map(row=>({heading:'Whole universe',row})),...model.matched.map(row=>({heading:'Investments by funds where we have invested',row}))];
 const chunks=[[]];
 const sections=chunk=>['Whole universe','Investments by funds where we have invested'].map(heading=>({heading,rows:chunk.filter(e=>e.heading===heading).map(e=>e.row)}));
 const render=chunk=>renderIntelligence(model,{...options,part:999,parts:999,items:sections(chunk)});
 for(const entry of entries){let chunk=chunks.at(-1);if(Buffer.byteLength(render([...chunk,entry]))>88000){if(!chunk.length)throw Error('Funding observation exceeds email budget');chunks.push([]);chunk=chunks.at(-1);}chunk.push(entry);if(Buffer.byteLength(render(chunk))>88000)throw Error('Funding observation exceeds email budget');}
 return chunks.map((chunk,i)=>({html:renderIntelligence(model,{...options,part:i+1,parts:chunks.length,items:sections(chunk)}),subject:`${TITLE} — ${deskBrand(options.dashboardUrl)} — ${model.day}`,part:i+1,parts:chunks.length,observations:chunk.flatMap(e=>e.row.observations)}));
}
