import {escapeHtml as esc} from '../core/dom.js';
import {scoreTable,openModal,closeModal} from '../ui/screener.js';
import * as feed from '../data/mutual-funds.js';
import * as coverage from '../data/coverage.js';
import {cachedPositionSizes,readPositionSizes,onPortfolioReady,onPortfolioInvalidation,portfolioConnectionState,unlockPortfolio} from '../research/portfolio-bridge.js';
export const meta={id:'mutual-funds',title:'Mutual Funds',subtitle:'Monthly mutual-fund ownership across your portfolio.',subviews:[]};
let ctx=null,disposeTable=null,table=null,offReady=null,offInvalid=null,timer=null,sequence=0,dialog=0,sort='holdings',busy=false,lastRead=0;
const num=n=>Number.isFinite(n)?n.toLocaleString('en-IN',{maximumFractionDigits:0}):'—';
const pct=n=>Number.isFinite(n)?`${n.toLocaleString('en-IN',{maximumFractionDigits:2})}%`:'—';
const signed=n=>Number.isFinite(n)?`${n>0?'+':n<0?'−':''}${num(Math.abs(n))}`:'—';
const monthLabel=m=>m?new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN',{month:'short',year:'numeric',timeZone:'UTC'}):'Pending';
const tone=n=>n>0?'text-emerald-700':n<0?'text-rose-700':'text-slate-500';
const span=n=>`<span class="${tone(n)} tabular-nums">${signed(n)}</span>`;
const checked=m=>m.checkedAt?new Date(m.checkedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'})+' IST':'Not checked';
export function render(context) {
  cleanup();ctx=context;sequence++;
  ctx.root.innerHTML=`<section class="mf-module"><div class="mf-toolbar"><label>Sort <select data-mf-sort aria-label="Sort mutual funds"><option value="holdings">Largest holdings</option><option value="newest">Newest</option></select></label><span data-mf-status class="text-xs text-slate-500">Checking disclosures…</span><button data-mf-coverage class="text-xs text-indigo-600">Coverage</button></div><p data-mf-sizes class="text-xs text-slate-500"></p><div data-mf-table></div></section>`;
  ctx.root.querySelector('[data-mf-sort]').value=sort;
  ctx.root.querySelector('[data-mf-sort]').onchange=e=>{sort=e.target.value;if(table)table.view.sort=null;paint();};
  ctx.root.querySelector('[data-mf-coverage]').onclick=showCoverage;
  offReady=onPortfolioReady(()=>paint());offInvalid=onPortfolioInvalidation(()=>paint());
  window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
  timer=setInterval(()=>{if(!document.hidden)refresh();},60000);
  paint(true);refresh();
  if(ctx.scope==='portfolio')readPositionSizes().then(()=>{if(ctx)paint();}).catch(()=>{if(ctx)paint();});
}
function resume(){if(ctx&&!document.hidden&&Date.now()-lastRead>30000)refresh();}
async function refresh() {
  if(!ctx||busy)return;busy=true;const mine=sequence,scope=ctx.scope;
  try{await feed.load(scope);}catch{/* Keep the last readable rows. */}finally{busy=false;lastRead=Date.now();if(ctx&&mine===sequence){paint();if(activeCompany)refreshOpenDetail();}else if(ctx)queueMicrotask(refresh);}
}
function orderedRows() {
  const snapshot=cachedPositionSizes(),weights=new Map(snapshot?.sizes?.complete?snapshot.holdings.map(h=>[h.isin,h.weightPct]):[]);
  return feed.scopedRows(ctx.scope).map(r=>({...r,weight:weights.get(r.isin)??null})).sort((a,b)=>(sort==='holdings'&&ctx.scope==='portfolio'?(b.weight??-1)-(a.weight??-1):0)||String(b.month||'').localeCompare(String(a.month||''))||String(b.disclosureCheckedAt||'').localeCompare(String(a.disclosureCheckedAt||''))||a.name.localeCompare(b.name));
}
function paint(loading=false) {
  if(!ctx)return;
  const rows=orderedRows(),view=table?.view;
  if(table){table.updateData(rows,undefined,{loading:loading&&!feed.all().length});paintStatus();return;}
  table=scoreTable({rows,key:r=>r.isin||r.ticker||r.name,watchKey:r=>r.ticker,name:r=>r.name,sub:r=>r.ticker||r.isin||'',nameLabel:'Company',showAvatar:false,showRank:false,showWatchFilter:false,link:null,
    nameMaxPx:230,dense:true,wrapHeads:true,fillMode:'windowed',stickyHead:'max(320px, calc(100vh - 310px))',loading:loading&&!feed.all().length,
    initialView:view?{...view,sort:null}:null,countLabel:list=>`${list.length} companies`,searchable:r=>`${r.name} ${r.ticker||''} ${r.insight||''}`,onRowClick:r=>openCompany(r),
    columns:[
      {label:'Month',sortValue:r=>r.month||'',html:true,get:r=>esc(monthLabel(r.month))},
      {label:'MF shares held',align:'right',sortValue:r=>r.totalShares??-1,html:true,get:r=>num(r.totalShares)},
      {label:'% of company',align:'right',sortValue:r=>r.companyPct??-1,html:true,get:r=>`<span title="${esc(r.denominator?`Shares outstanding${r.denominator.kind==='estimate'?' (estimate)':''}: ${num(r.denominator.shares)}; ${r.denominator.source}; checked ${r.denominator.checkedAt}`:'Shares outstanding not verified')}">${r.denominator?.kind==='estimate'&&Number.isFinite(r.companyPct)?'≈':''}${pct(r.companyPct)}</span>`},
      {label:'Added / reduced',html:true,get:r=>`<span class="${tone(r.netChange)}">${esc(r.direction||'Pending')}</span><div class="text-xs text-slate-500">${r.comparableFunds?`${r.addedFunds} added · ${r.reducedFunds} reduced`:'Awaiting comparison'}</div>`},
      {label:'Net monthly shares',align:'right',sortValue:r=>r.netChange??-Infinity,html:true,get:r=>span(r.netChange)},
      {label:'Insight summary',html:true,get:r=>`<div class="mf-insight">${esc(r.insight||'No matched mutual-fund disclosure yet.')}${r.pendingFunds?` <span class="text-slate-500">${r.pendingFunds} funds awaiting comparable reports.</span>`:''}</div>`}
    ]});
  const host=ctx.root.querySelector('[data-mf-table]');host.innerHTML=table.html;disposeTable=table.wire(host);
  paintStatus();
}
function paintStatus() {
  if(!ctx)return;
  ctx.root.querySelector('[data-mf-status]').textContent=`${feed.health()} · Checked ${checked(feed.meta())}`;
  const sizeNode=ctx.root.querySelector('[data-mf-sizes]'),sizes=cachedPositionSizes();
  sizeNode.innerHTML=sort==='holdings'&&ctx.scope==='portfolio'&&!sizes?.sizes?.complete
    ? portfolioConnectionState()==='locked'?'<button data-mf-unlock class="text-indigo-600">Unlock portfolio for Largest holdings</button> · Newest shown while sizes are unavailable.' : 'Portfolio sizes unavailable · Newest shown.' : '';
  sizeNode.querySelector('[data-mf-unlock]')?.addEventListener('click',()=>unlockPortfolio());
}
let activeCompany=null,detailData=null;
async function openCompany(row) {
  activeCompany=row;detailData=null;const mine=++dialog;
  openModal(`<div class="p-6"><button data-modal-close class="float-right text-2xl" aria-label="Close">×</button><h2 class="text-xl font-bold">${esc(row.name)}</h2><p class="mt-4 text-slate-500">Loading fund disclosures…</p></div>`,{size:'magazine',onClose:()=>{dialog++;activeCompany=null;}});
  try{const data=await feed.detail(row.isin);if(mine===dialog&&activeCompany){detailData=data;paintDetail();}}
  catch {if(mine===dialog&&activeCompany)document.querySelector('#modal-content').innerHTML=`<div class="p-6"><button data-modal-close class="float-right text-2xl" aria-label="Close">×</button><h2 class="text-xl font-bold">${esc(row.name)}</h2><p class="mt-4">Fund disclosures are unavailable. Please check back.</p></div>`;document.querySelector('#modal-content [data-modal-close]')?.addEventListener('click',closeModal);}
}
async function refreshOpenDetail(){const row=activeCompany,mine=dialog;try{const data=await feed.detail(row.isin);if(mine===dialog&&activeCompany){detailData=data;paintDetail();}}catch{if(mine===dialog&&detailData){detailData.meta={...detailData.meta,readFailed:true};paintDetail();}}}
function paintDetail() {
  const company=detailData?.company;
  if(!company) {document.querySelector('#modal-content').innerHTML='<div class="p-6">No matched fund disclosure yet. <button data-modal-close>Close</button></div>';document.querySelector('#modal-content [data-modal-close]').onclick=closeModal;return;}
  const holder=document.querySelector('#modal-content'),oldSearch=holder.querySelector('[data-mf-fund-search]')?.value||'',oldScroll=holder.querySelector('.mf-detail-scroll')?.scrollLeft||0,oldAction=holder.querySelector('[data-mf-action]')?.value||'all';let page=Number(holder.querySelector('[data-mf-page]')?.dataset.mfPage)||0;
  const months=company.months,latest=company.month;
  holder.innerHTML=`<div class="p-6 mf-detail"><button data-modal-close class="float-right text-2xl" aria-label="Close">×</button><h2 class="text-xl font-bold">${esc(company.name)} · Mutual Funds</h2><p class="mt-2 text-sm text-slate-500">${esc(monthLabel(latest))} · ${company.addedFunds} funds added, ${company.reducedFunds} reduced · Net ${signed(company.netChange)} shares</p><div class="mf-toolbar mt-4"><input data-mf-fund-search aria-label="Search mutual funds" placeholder="Search mutual funds" value="${esc(oldSearch)}"><select data-mf-action aria-label="Fund action"><option value="all">All funds</option><option value="added">Added</option><option value="reduced">Reduced</option><option value="pending">Pending</option></select><span class="text-xs text-slate-500">${company.funds.length} funds · ${company.pendingFunds} awaiting comparable reports</span></div><div class="mf-detail-scroll"><table class="mf-detail-table"><thead><tr><th rowspan="2">MF</th><th colspan="5">${esc(monthLabel(latest))}</th>${months.filter(m=>m!==latest).map(m=>`<th colspan="2">${esc(monthLabel(m))}</th>`).join('')}</tr><tr><th title="Stock position value in crores; not total fund AUM">AUM (Cr)</th><th title="Stock as a percentage of the fund’s NAV">AUM %</th><th>Shares Held</th><th>Month Change</th><th>Month Change %</th>${months.filter(m=>m!==latest).map(()=>'<th>Shares Held</th><th>Month Change %</th>').join('')}</tr></thead><tbody></tbody></table></div><div class="mf-toolbar"><button data-mf-prev>Previous</button><span data-mf-page class="text-xs text-slate-500"></span><button data-mf-next>Next</button></div><div class="mf-insights-grid mt-4">${company.topBuyer?`<p class="mf-buyer">${esc(company.topBuyer.name)} was the largest buyer: ${signed(company.topBuyer.change)} shares.</p>`:''}${company.topSeller?`<p class="mf-seller">${esc(company.topSeller.name)} was the largest seller: ${signed(company.topSeller.change)} shares.</p>`:''}</div><p class="mt-3 text-xs text-slate-500">Shares reported by tracked schemes; monthly share changes can include corporate actions. — means not reported or not comparable; a confirmed nil holding is 0. New positions have no percentage base. ${esc(feed.health(detailData.meta))}. ${company.denominator?`Shares outstanding: ${num(company.denominator.shares)} · checked ${esc(company.denominator.checkedAt)}.`:'Company shares outstanding not verified.'}</p></div>`;
  holder.querySelector('[data-modal-close]').onclick=closeModal;
  const fill=()=>{
    const query=holder.querySelector('[data-mf-fund-search]').value.toLowerCase(),action=holder.querySelector('[data-mf-action]').value;
    const funds=company.funds.filter(f=>`${f.name} ${f.amc}`.toLowerCase().includes(query)&&(action==='all'||action==='added'&&f.change>0||action==='reduced'&&f.change<0||action==='pending'&&f.change===null)).sort((a,b)=>(b.change??-Infinity)-(a.change??-Infinity)||a.name.localeCompare(b.name));
    page=Math.min(page,Math.max(0,Math.ceil(funds.length/50)-1));
    const pageNode=holder.querySelector('[data-mf-page]');pageNode.dataset.mfPage=page;pageNode.textContent=`${funds.length ? page*50+1 : 0}–${Math.min(funds.length,(page+1)*50)} of ${funds.length} funds`;
    holder.querySelector('[data-mf-prev]').disabled=page===0;holder.querySelector('[data-mf-next]').disabled=(page+1)*50>=funds.length;
    holder.querySelector('tbody').innerHTML=funds.slice(page*50,(page+1)*50).map(f=>`<tr><td><span>${esc(f.name)}</span>${f.current?.sourceUrl&&/^https:\/\//.test(f.current.sourceUrl)?`<a href="${esc(f.current.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="text-xs text-indigo-600">Disclosure ↗</a>`:''}</td><td>${Number.isFinite(f.current?.valueCr)?f.current.valueCr.toLocaleString('en-IN',{maximumFractionDigits:2}):'—'}</td><td>${pct(f.current?.pctOfAum)}</td><td>${num(f.current?.shares)}</td><td>${span(f.change)}</td><td class="${tone(f.change)}">${f.action==='New'?'New':pct(f.changePct)}</td>${months.filter(m=>m!==latest).map(m=>`<td>${num(f.months[m]?.shares)}</td><td class="${tone(f.months[m]?.change)}">${f.months[m]?.action==='New'?'New':pct(f.months[m]?.changePct)}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${6+(months.length-1)*2}">No matching funds.</td></tr>`;
  };
  holder.querySelector('[data-mf-action]').value=oldAction;holder.querySelector('[data-mf-fund-search]').oninput=()=>{page=0;fill();};holder.querySelector('[data-mf-action]').onchange=()=>{page=0;fill();};holder.querySelector('[data-mf-prev]').onclick=()=>{page--;fill();};holder.querySelector('[data-mf-next]').onclick=()=>{page++;fill();};fill();holder.querySelector('.mf-detail-scroll').scrollLeft=oldScroll;
}
function showCoverage(){const m=feed.meta();openModal(`<div class="p-6"><button data-modal-close class="float-right text-2xl" aria-label="Close">×</button><h2 class="text-xl font-bold">Mutual Fund coverage</h2><p class="mt-3 text-sm">${esc(feed.health())}. Checked ${esc(checked(m))}. Source disclosures are checked automatically with a 15-minute target; collection duration and source availability can delay delivery.</p><p class="mt-2 text-sm">All captured months are retained. Initial history varies by AMC; this is not an exhaustive industry archive. Changes use funds reporting both adjacent calendar months. Missing reports are never treated as sales.</p><p class="mt-2 text-sm">${esc(m.warnings?`${m.warnings} source validation findings; ambiguous observations are withheld and previously saved history is retained.`:'')}</p><div class="mf-detail-scroll mt-4"><table class="mf-detail-table"><thead><tr><th>AMC</th><th>Latest month</th><th>State</th><th>Last checked</th></tr></thead><tbody>${(m.amcs||[]).map(a=>`<tr><td>${esc(a.name||a.slug)}</td><td>${esc(monthLabel(a.month))}</td><td>${esc(a.status)}</td><td>${esc(a.checkedAt||'Not checked')}</td></tr>`).join('')}</tbody></table></div></div>`,{size:'wide'});}
function cleanup(){disposeTable?.();disposeTable=null;table=null;offReady?.();offInvalid?.();clearInterval(timer);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);}
export function destroy(){cleanup();sequence++;dialog++;ctx=null;activeCompany=null;}
