import {TAB_META} from './catalog.js';
import * as feed from '../data/ai-recommendations.js';
import {sectionHead,scoreTable,openDrill,openModal} from '../ui/screener.js';
import {escapeHtml as esc} from '../core/dom.js';
import * as refreshRegistry from '../core/refresh.js';
import {scopePossessive} from '../data/scope.js';
import {readableFilingUrl} from '../data/nse-xbrl-shared.js';

export const meta=TAB_META['ai-recommendations'];
let ctxRef=null,table=null,view=null,offTable=null,paintedScope=null,disposers=[];
const time=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'})+' IST':'Not yet confirmed';
const price=value=>Number(value).toLocaleString('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2});
const fieldLabel=value=>value.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,s=>s.toUpperCase());
function sourceLink(url) {
  try { const u=new URL(url);if(u.protocol==='https:'&&['nsearchives.nseindia.com','archives.nseindia.com','www.bseindia.com'].includes(u.hostname)) return `<a class="text-brand-600 hover:underline" href="${esc(readableFilingUrl(u.href))}" target="_blank" rel="noopener noreferrer">Original filing ↗</a>`; } catch {}
  return '';
}
function details(row) {
  const d=row.details||{};
  openDrill({name:row.company,sub:row.modelName,beforeGroupsHtml:`<p class="text-sm">${esc(row.catalyst)}</p>
    <p class="mt-3 text-sm">Evidence score: ${esc(row.score)}/100. This is a research ranking; investment performance is not yet established.</p>
    <p class="mt-3 text-sm">${esc((d.reasons||[]).join('. '))}</p>
    <p class="mt-3 text-sm">Statement basis: ${esc(d.basis||'Unavailable')}. Reporting period: ${esc(d.quarter?.slice(0,2).join(' to ')||'Unavailable')}.</p>
    <p class="mt-3 text-sm">Price: ${esc(price(row.price))}, official close on ${esc(row.priceAsOf)}. Price captured: ${esc(time(row.priceCheckedAt))}.</p>
    <p class="mt-3 text-sm">First idea recorded: ${esc(time(row.issuedAt))}. Document date: ${esc(row.evidenceDate)}. ${sourceLink(row.sourceUrl)}</p>
    <p class="mt-3 text-sm">Valuation: ${esc(d.valuation?.pe ? Number(d.valuation.pe).toFixed(1)+'× '+d.valuation.period+' diluted EPS' : 'Not verified')}.</p>
    ${Object.entries(d.fieldEvidence||{}).map(([key,f])=>`<p class="mt-3 text-sm"><strong>${esc(fieldLabel(key))}</strong> · page ${esc(f.page)}<br>${esc(f.quote)}</p>`).join('')}
    <p class="mt-4 text-xs text-slate-500">No target price or probability of profit is inferred. Contract economics, complete project history, sector-specific risks and investment-size liquidity still require research. New adverse evidence or failed eligibility removes a name from the active list; the original decision remains in the outcome ledger.</p>`});
}
function coverage() {
  const m=feed.meta(), c=m.coverage||{};
  const outcome=(model,horizon)=>{const r=m.backtest?.models?.[model]?.[horizon];return !r?'No observations yet':`${r.measured} of ${r.signals} outcomes measured${r.medianNetReturnPct!=null?' · median return after assumed costs '+Number(r.medianNetReturnPct).toFixed(1)+'%':' · waiting for outcomes'}`;};
  openModal(`<h2 class="font-display text-lg font-bold text-slate-900">Recommendation evidence</h2>
    <p class="mt-3 text-sm">Three fixed catalyst models run on GitHub Actions every six hours using original free exchange sources. The browser reads their prepared output and checks for updates every five minutes while visible and on return.</p>
    <p class="mt-3 text-sm">Prepared: ${esc(time(m.generatedAt))}. Browser publication check: ${esc(time(m.browserCheckedAt))}. Coverage remains partial. ${esc(m.error||'')}</p>
    <p class="mt-3 text-sm">${esc(c.financialCompanies??0)} companies with captured financial periods; ${esc(c.assessments??0)} catalyst assessments in this run; ${esc(c.pendingDocuments??0)} documents awaiting reading; ${esc(c.failedDocuments??0)} failed or oversized documents.</p>
    <p class="mt-3 text-sm">Performance validation: Not yet established. Three- and six-month outcomes use actual first-observed signals, the next session’s opening price, a 50 bps round-trip cost assumption and the Nifty 500 price index. Missing prices and corporate actions remain unresolved outcomes. No historical recommendation is invented from a filing collected later.</p>
    <details class="mt-4"><summary>Model outcomes and evidence gaps</summary>${[['earnings','Improving earnings'],['orders','Material new business'],['capacity','Productive new capacity']].map(([id,label])=>`<p class="mt-3 text-sm"><strong>${label}</strong><br>Three months: ${esc(outcome(id,'63'))}<br>Six months: ${esc(outcome(id,'126'))}</p>`).join('')}
    ${Object.entries(c.missingRequirements||{}).map(([reason,n])=>`<p class="mt-2 text-xs">${esc(reason)} · ${esc(n)} assessments</p>`).join('')}
    ${(c.limitations||[]).map(limit=>`<p class="mt-3 text-xs">${esc(limit)}</p>`).join('')}</details>
    <details class="mt-4"><summary>Actual source checks</summary><div class="text-xs" style="max-height:300px;overflow:auto">${(c.sourceChecks||[]).map(s=>`<p class="mt-2">${esc(s.key)} · successful read ${esc(time(s.success_at))}${s.error?' · '+esc(s.error):''}</p>`).join('')}</div></details>`,{size:'wide'});
}
function paint() {
  if(!ctxRef)return;
  const root=ctxRef.root,m=feed.meta(),rows=feed.forScope(ctxRef.scope);
  const status=m.error?'Latest publication could not be confirmed.'+(m.generatedAt?' Retained results remain visible.':' No verified list is available yet.'):!m.generatedAt?'Checking prepared recommendations…':(m.stale?'Capture overdue · ':'Partial coverage · ')+'Prepared '+time(m.generatedAt);
  if(table&&paintedScope===ctxRef.scope&&root.querySelector('[data-recommendation-status]')){
    root.querySelector('[data-recommendation-status]').textContent=status;table.updateData(rows);return;
  }
  const focus=root.contains(document.activeElement)&&document.activeElement?.matches('input')?{start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:null;
  const scroll=root.querySelector('[data-table-scroll]'),position=scroll?{top:scroll.scrollTop,left:scroll.scrollLeft}:null;
  view=table?.view||view;offTable?.();
  const possessive=scopePossessive(ctxRef.scope);
  table=scoreTable({rows,key:r=>r.id,watchKey:r=>r.ticker,name:r=>r.company,sub:r=>r.ticker,showRank:false,showAvatar:false,showBookmarks:false,
    showScore:false,showSignals:false,nameWrap:true,nameMaxPx:260,showWatchFilter:false,
    columns:[{label:'Current market price',html:true,get:r=>`<span>${esc(price(r.price))}</span><br><span class="text-xs text-slate-500">Close · ${esc(r.priceAsOf)}</span>`,sortValue:r=>Number(r.price),align:'right'},
      {label:'Catalyst',html:true,get:r=>`<div style="max-width:620px;white-space:normal;overflow-wrap:anywhere">${esc(r.catalyst)}</div>`,sortable:false}],
    initialView:view,onRowClick:details,rowActionLabel:r=>'Read recommendation evidence for '+r.company,
    searchable:r=>[r.company,r.ticker,r.catalyst,r.modelName].join(' '),exportName:'ai-recommendations',
    emptyMessage:()=>!feed.meta().generatedAt?'Recommendations will appear after background preparation passes its checks.':feed.rows().length?`No recommendations match ${possessive||'this view'}.`:'No companies currently pass the evidence and price checks. Financial history and catalyst verification continue in the background.'});
  root.innerHTML=sectionHead({title:'AI Recommendations',description:'Research candidates · performance validation pending',meta:'<button class="text-sm text-brand-600 hover:underline" data-recommendation-coverage>Evidence & outcomes</button>'})+
    `<p data-recommendation-status class="mb-4 text-xs text-slate-500">${esc(status)}</p>`+table.html;
  paintedScope=ctxRef.scope;
  offTable=table.wire(root);root.querySelector('[data-recommendation-coverage]')?.addEventListener('click',coverage);
  if(position){const next=root.querySelector('[data-table-scroll]');if(next){next.scrollTop=position.top;next.scrollLeft=position.left;}}
  if(focus){const input=root.querySelector('[data-table-search]');input?.focus({preventScroll:true});input?.setSelectionRange(focus.start,focus.end);}
}
export function render(ctx) {
  ctxRef=ctx;
  if(!disposers.length){
    disposers.push(feed.onChange(paint),refreshRegistry.register('ai-recommendations',{label:'AI Recommendations',refresh:feed.refresh}));
    const resume=()=>{if(ctxRef&&document.visibilityState!=='hidden')void feed.refresh();};
    const timer=setInterval(resume,feed.POLL_MS);
    document.addEventListener('visibilitychange',resume);window.addEventListener('focus',resume);window.addEventListener('online',resume);
    disposers.push(()=>{clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);});
  }
  paint();void feed.refresh();
}
export function destroy(){ctxRef=null;offTable?.();offTable=null;view=table?.view||view;table=null;paintedScope=null;for(const off of disposers.splice(0))off();}
