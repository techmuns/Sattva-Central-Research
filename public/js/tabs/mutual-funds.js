import {escapeHtml as esc} from '../core/dom.js';
import {scoreTable,openModal,closeModal} from '../ui/screener.js';
import * as feed from '../data/mutual-funds.js';
import {supplementStatus} from '../data/mutual-funds-supplement.js';
import * as coverage from '../data/coverage.js';
import {cachedPositionSizes,readPositionSizes,onPortfolioReady,onPortfolioInvalidation,portfolioConnectionState,unlockPortfolio} from '../research/portfolio-bridge.js';
export const meta={id:'mutual-funds',title:'Mutual Funds',subtitle:'Monthly mutual-fund ownership across your portfolio.',subviews:[]};
let ctx=null,disposeTable=null,table=null,offReady=null,offInvalid=null,offSession=null,timer=null,sequence=0,dialog=0,sort='holdings',busy=false,lastRead=0;
const num=n=>Number.isFinite(n)?n.toLocaleString('en-IN',{maximumFractionDigits:0}):'—';
const pct=n=>Number.isFinite(n)?`${n.toLocaleString('en-IN',{maximumFractionDigits:2})}%`:'—';
const signed=n=>Number.isFinite(n)?`${n>0?'+':n<0?'−':''}${num(Math.abs(n))}`:'—';
const monthLabel=m=>m?new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN',{month:'short',year:'numeric',timeZone:'UTC'}):'Pending';
const tone=n=>n>0?'text-emerald-700':n<0?'text-rose-700':'text-slate-500';
const span=n=>`<span class="${tone(n)} tabular-nums">${signed(n)}</span>`;
const ownershipValue=r=>`${r.denominator?.kind==='estimate'&&Number.isFinite(r.companyPct)?'≈':''}${pct(r.companyPct)}`;
function ownershipNote(r) {
  const d=r.denominator,reason={
    'missing-mf-shares':'MF share quantities are not available.',
    'missing-share-count':'Company shares outstanding are not verified.',
    'stale-share-count':'The last share-count check or source quote is over seven days old or invalid. Percentage withheld.',
    'inconsistent-share-count':'Reported MF shares exceed the verified company share count. Percentage withheld.'
  }[r.ownershipUnavailable];
  return ['MF shares held ÷ company shares outstanding × 100.',
    'Uses the displayed month’s captured MF holdings and the latest available company share count; coverage may be partial.',
    reason,
    d?`${d.kind==='estimate'?'Estimated':'Reported'} shares outstanding: ${num(d.shares)}. Source: ${d.sourceName||d.source}. Checked ${checked(d)}. ${d.quoteAt?`Source quote: ${checked({checkedAt:d.quoteAt})}. Share-count effective date not supplied.`:''} ${d.method||''}`:'Company shares outstanding are not verified.',
    r.shareCountCheck?.state==='unavailable'?`Latest share-count attempt unavailable (${checked({checkedAt:r.shareCountCheck.lastAttemptAt})}); retained source date unchanged.`:null
  ].filter(Boolean).join(' ');
}
const checked=m=>m.checkedAt?new Date(m.checkedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'})+' IST':'Not checked';
export function render(context) {
  cleanup();ctx=context;sequence++;
  ctx.root.innerHTML=`<section class="mf-module"><div class="mf-toolbar"><label>Sort <select data-mf-sort aria-label="Sort mutual funds"><option value="holdings">Largest holdings</option><option value="newest">Newest</option></select></label><span data-mf-status class="text-xs text-slate-500">Checking disclosures…</span><button data-mf-coverage class="text-xs text-indigo-600">Coverage</button></div><p data-mf-sizes class="text-xs text-slate-500"></p><div data-mf-table></div></section>`;
  ctx.root.querySelector('[data-mf-sort]').value=sort;
  ctx.root.querySelector('[data-mf-sort]').onchange=e=>{sort=e.target.value;if(table)table.view.sort=null;paint();};
  ctx.root.querySelector('[data-mf-coverage]').onclick=showCoverage;
  offReady=onPortfolioReady(()=>paint());offInvalid=onPortfolioInvalidation(()=>paint());
  offSession=feed.onSessionChange(()=>{sequence++;dialog++;activeCompany=null;detailData=null;closeModal();paint();refresh();});
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
      {label:'MF ownership',align:'right',sortValue:r=>r.companyPct??-1,html:true,get:r=>`<span title="${esc(ownershipNote(r))}">${ownershipValue(r)}</span>`},
      {label:'Added / reduced',html:true,get:r=>`<span class="${tone(r.netChange)}">${esc(r.direction||'Pending')}</span><div class="text-xs text-slate-500">${r.comparableFunds?`${r.addedFunds} added · ${r.reducedFunds} reduced`:'Awaiting comparison'}</div>`},
      {label:'Net monthly shares',align:'right',sortValue:r=>r.netChange??-Infinity,html:true,get:r=>span(r.netChange)},
      {label:'Insight summary',html:true,get:r=>`<div class="mf-insight">${esc(r.insight||'No matched mutual-fund disclosure yet.')}${r.pendingFunds?` <span class="text-slate-500">${r.pendingFunds} funds awaiting comparable reports.</span>`:''}</div>`}
    ]});
  const host=ctx.root.querySelector('[data-mf-table]');host.innerHTML=table.html;disposeTable=table.wire(host);
  paintStatus();
}
function paintStatus() {
  if(!ctx)return;
  const m=feed.meta();
  ctx.root.querySelector('[data-mf-status]').textContent=[`${feed.health()} · Checked ${checked(m)}`,supplementStatus(m)].filter(Boolean).join(' · ');
  const sizeNode=ctx.root.querySelector('[data-mf-sizes]'),sizes=cachedPositionSizes();
  sizeNode.innerHTML=sort==='holdings'&&ctx.scope==='portfolio'&&!sizes?.sizes?.complete
    ? portfolioConnectionState()==='locked'?'<button data-mf-unlock class="text-indigo-600">Unlock portfolio for Largest holdings</button> · Newest shown while sizes are unavailable.' : 'Portfolio sizes unavailable · Newest shown.' : '';
  sizeNode.querySelector('[data-mf-unlock]')?.addEventListener('click',()=>unlockPortfolio());
}
let activeCompany=null,detailData=null,selectedMonth=null,detailSort={key:'change',dir:'desc'};
async function openCompany(row) {
  activeCompany=row;detailData=null;selectedMonth=null;detailSort={key:'change',dir:'desc'};const mine=++dialog;
  openModal(`<div class="p-6"><button data-modal-close class="float-right text-2xl" aria-label="Close">×</button><h2 class="text-xl font-bold">${esc(row.name)}</h2><p class="mt-4 text-slate-500">Loading fund disclosures…</p></div>`,{size:'magazine',onClose:()=>{dialog++;activeCompany=null;}});
  try{const data=await feed.detail(row.isin);if(mine===dialog&&activeCompany){detailData=data;paintDetail();}}
  catch {if(mine===dialog&&activeCompany)document.querySelector('#modal-content').innerHTML=`<div class="p-6"><button data-modal-close class="float-right text-2xl" aria-label="Close">×</button><h2 class="text-xl font-bold">${esc(row.name)}</h2><p class="mt-4">Fund disclosures are unavailable. Please check back.</p></div>`;document.querySelector('#modal-content [data-modal-close]')?.addEventListener('click',closeModal);}
}
async function refreshOpenDetail(){const row=activeCompany,mine=dialog;try{const data=await feed.detail(row.isin,selectedMonth);if(mine===dialog&&activeCompany){detailData=data;paintDetail();}}catch{if(mine===dialog&&detailData){detailData.meta={...detailData.meta,readFailed:true};paintDetail();}}}
function paintDetail() {
  const company=detailData?.company;
  if(!company) {document.querySelector('#modal-content').innerHTML='<div class="p-6">No matched fund disclosure yet. <button data-modal-close>Close</button></div>';document.querySelector('#modal-content [data-modal-close]').onclick=closeModal;return;}
  const holder=document.querySelector('#modal-content'),oldSearch=holder.querySelector('[data-mf-fund-search]')?.value||'',oldScroll=holder.querySelector('.mf-detail-scroll')?.scrollLeft||0,oldAction=holder.querySelector('[data-mf-action]')?.value||'all';let page=Number(holder.querySelector('[data-mf-page]')?.dataset.mfPage)||0;
  const months=company.months,latest=company.month,earlier=months.filter(m=>m!==latest);
  const columns=[
    {key:'name',label:'MF',read:f=>f.name||''},
    {key:'valueCr',label:'AUM (Cr)',month:latest,title:'Stock position value in crores; not total fund AUM',read:f=>f.current?.valueCr},
    {key:'pctOfAum',label:'AUM %',month:latest,title:'Stock as a percentage of the fund’s NAV',read:f=>f.current?.pctOfAum},
    {key:'shares',label:'Shares Held',month:latest,read:f=>f.current?.shares},
    {key:'change',label:'Month Change',month:latest,read:f=>f.change},
    {key:'changePct',label:'Month Change %',month:latest,read:f=>f.action==='New'?null:f.changePct},
    ...earlier.flatMap((m,i)=>[
      {key:`shares:${i}`,label:'Shares Held',month:m,read:f=>f.months[m]?.shares},
      {key:`changePct:${i}`,label:'Month Change %',month:m,read:f=>f.months[m]?.action==='New'?null:f.months[m]?.changePct}
    ])
  ];
  if(!columns.some(c=>c.key===detailSort.key))detailSort={key:'change',dir:'desc'};
  const header=c=>`<th scope="col" ${c.key==='name'?'class="mf-identity" rowspan="2"':''} ${c.title?`title="${esc(c.title)}"`:''}><button type="button" class="mf-sort-header" data-column-drag-handle data-mf-fund-sort="${esc(c.key)}" data-sort-label="${esc(c.month?`${monthLabel(c.month)} ${c.label}`:c.label)}">${esc(c.label)} <span data-mf-sort-arrow aria-hidden="true"></span></button></th>`;
  holder.innerHTML=`<div class="p-6 mf-detail"><button data-modal-close class="float-right text-2xl" aria-label="Close">×</button><h2 class="text-xl font-bold">${esc(company.name)} · Mutual Funds</h2><p class="mt-2 text-sm text-slate-500">${esc(monthLabel(latest))} · MF ownership ${ownershipValue(company)} · ${company.addedFunds} funds added, ${company.reducedFunds} reduced · Net ${signed(company.netChange)} shares</p><div class="mf-toolbar mt-4">${company.availableMonths?.length?`<select data-mf-month aria-label="Disclosure month">${company.availableMonths.map(m=>`<option value="${esc(m)}" ${m===latest?'selected':''}>${esc(monthLabel(m))}</option>`).join('')}</select>`:''}<input data-mf-fund-search aria-label="Search mutual funds" placeholder="Search mutual funds" value="${esc(oldSearch)}"><select data-mf-action aria-label="Fund action"><option value="all">All funds</option><option value="added">Added</option><option value="reduced">Reduced</option><option value="pending">Pending</option></select><span class="text-xs text-slate-500">${company.funds.length} funds · ${company.pendingFunds} awaiting comparable reports</span></div><div class="mf-detail-scroll"><table data-column-layout="mutual-funds:1" class="mf-detail-table"><thead><tr>${header(columns[0])}<th scope="colgroup" colspan="5">${esc(monthLabel(latest))}</th>${earlier.map(m=>`<th scope="colgroup" colspan="2">${esc(monthLabel(m))}</th>`).join('')}</tr><tr>${columns.slice(1).map(header).join('')}</tr></thead><tbody></tbody></table></div><div class="mf-toolbar"><button data-mf-prev>Previous</button><span data-mf-page class="text-xs text-slate-500"></span><button data-mf-next>Next</button></div><div class="mf-insights-grid mt-4">${company.topBuyer?`<p class="mf-buyer">${esc(company.topBuyer.name)} was the largest buyer: ${signed(company.topBuyer.change)} shares.</p>`:''}${company.topSeller?`<p class="mf-seller">${esc(company.topSeller.name)} was the largest seller: ${signed(company.topSeller.change)} shares.</p>`:''}</div><p class="mt-3 text-xs text-slate-500">Shares reported by tracked schemes; monthly share changes can include corporate actions. — means not reported or not comparable; a confirmed nil holding is 0. New positions have no percentage base. ${esc(feed.health(detailData.meta))}. ${esc(supplementStatus(detailData.meta))}. ${esc(ownershipNote(company))}</p></div>`;
  holder.querySelector('[data-modal-close]').onclick=closeModal;
  const period=holder.querySelector('[data-mf-month]');if(period)period.onchange=()=>{selectedMonth=period.value;dialog++;refreshOpenDetail();};
  const fill=()=>{
    const query=holder.querySelector('[data-mf-fund-search]').value.toLowerCase(),action=holder.querySelector('[data-mf-action]').value;
    const funds=company.funds.filter(f=>`${f.name} ${f.amc}`.toLowerCase().includes(query)&&(action==='all'||action==='added'&&f.change>0||action==='reduced'&&f.change<0||action==='pending'&&f.change===null));
    const column=columns.find(c=>c.key===detailSort.key),direction=detailSort.dir==='asc'?1:-1;
    const values=new Map(funds.map(f=>{const value=column.read(f);return [f,column.key==='name'?value:Number.isFinite(value)?value:null];}));
    funds.sort((a,b)=>{
      const av=values.get(a),bv=values.get(b);
      // Missing reports and “New” percentages have no numeric base, in either direction.
      if(av===null&&bv!==null)return 1;if(bv===null&&av!==null)return -1;
      const order=av===bv?0:typeof av==='string'?av.localeCompare(bv,undefined,{sensitivity:'base',numeric:true}):av-bv;
      return order*direction||a.name.localeCompare(b.name)||String(a.id||'').localeCompare(String(b.id||''));
    });
    holder.querySelectorAll('[data-mf-fund-sort]').forEach(button=>{
      const active=button.dataset.mfFundSort===detailSort.key;
      button.closest('th').setAttribute('aria-sort',active?(detailSort.dir==='asc'?'ascending':'descending'):'none');
      const nextAscending=active?detailSort.dir==='desc':button.dataset.mfFundSort==='name';
      button.setAttribute('aria-label',`${button.dataset.sortLabel}: sort ${nextAscending?'ascending':'descending'}`);
      button.querySelector('[data-mf-sort-arrow]').textContent=active?(detailSort.dir==='asc'?'▴':'▾'):'↕';
    });
    page=Math.min(page,Math.max(0,Math.ceil(funds.length/50)-1));
    const pageNode=holder.querySelector('[data-mf-page]');pageNode.dataset.mfPage=page;pageNode.textContent=`${funds.length ? page*50+1 : 0}–${Math.min(funds.length,(page+1)*50)} of ${funds.length} funds`;
    holder.querySelector('[data-mf-prev]').disabled=page===0;holder.querySelector('[data-mf-next]').disabled=(page+1)*50>=funds.length;
    holder.querySelector('tbody').innerHTML=funds.slice(page*50,(page+1)*50).map(f=>`<tr><td class="mf-identity"><span>${esc(f.name)}</span>${f.current?.sourceUrl&&/^https:\/\//.test(f.current.sourceUrl)?`<a href="${esc(f.current.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="text-xs text-indigo-600">${f.current.source==='MF Scanner'?'MF Scanner':'Disclosure'} ↗</a>`:''}</td><td>${Number.isFinite(f.current?.valueCr)?f.current.valueCr.toLocaleString('en-IN',{maximumFractionDigits:2}):'—'}</td><td>${pct(f.current?.pctOfAum)}</td><td>${num(f.current?.shares)}</td><td>${span(f.change)}</td><td class="${tone(f.change)}">${f.action==='New'?'New':pct(f.changePct)}</td>${months.filter(m=>m!==latest).map(m=>`<td>${num(f.months[m]?.shares)}</td><td class="${tone(f.months[m]?.change)}">${f.months[m]?.action==='New'?'New':pct(f.months[m]?.changePct)}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${6+(months.length-1)*2}">No matching funds.</td></tr>`;
  };
  holder.querySelectorAll('[data-mf-fund-sort]').forEach(button=>{button.closest('th').onclick=()=>{
    const key=button.dataset.mfFundSort;
    detailSort={key,dir:detailSort.key===key?(detailSort.dir==='asc'?'desc':'asc'):(key==='name'?'asc':'desc')};
    page=0;fill();holder.querySelector('.mf-detail-scroll').scrollTop=0;
  };});
  holder.querySelector('[data-mf-action]').value=oldAction;holder.querySelector('[data-mf-fund-search]').oninput=()=>{page=0;fill();};holder.querySelector('[data-mf-action]').onchange=()=>{page=0;fill();};holder.querySelector('[data-mf-prev]').onclick=()=>{page--;fill();};holder.querySelector('[data-mf-next]').onclick=()=>{page++;fill();};fill();holder.querySelector('.mf-detail-scroll').scrollLeft=oldScroll;
}
function showCoverage(){const m=feed.meta();openModal(`<div class="p-6"><button data-modal-close class="float-right text-2xl" aria-label="Close">×</button><h2 class="text-xl font-bold">Mutual Fund coverage</h2><p class="mt-3 text-sm">${esc(feed.health())}. Checked ${esc(checked(m))}. Source disclosures are checked automatically with a 15-minute target; collection duration and source availability can delay delivery.</p>${m.supplement?`<p class="mt-2 text-sm">${esc(supplementStatus(m))}. Supplemental pages can still have unpublished or unmatched funds; this does not establish full AMC coverage. </p>`:''}<p class="mt-2 text-sm">MF ownership = captured MF shares ÷ company shares outstanding × 100. Share counts are checked daily, starting with the live portfolio, then the captured universe. NSE and Moneycontrol directly supplied counts take priority; ≈ marks a market-cap/price estimate. Values older than seven days are withheld. Hover a percentage or open the company for its source, dates and any failed check. Historical months use the latest share count, not a historical capital structure.</p><p class="mt-2 text-sm">All captured months are retained. Initial history varies by AMC; this is not an exhaustive industry archive. Changes use funds reporting both adjacent calendar months. Missing reports are never treated as sales.</p><p class="mt-2 text-sm">${esc(m.warnings?`${m.warnings} source validation findings; ambiguous observations are withheld and previously saved history is retained.`:'')}</p><div class="mf-detail-scroll mt-4"><table data-column-layout="mutual-funds:2" class="mf-detail-table"><thead><tr><th class="mf-identity">AMC</th><th>Latest month</th><th>State</th><th>Last checked</th></tr></thead><tbody>${(m.amcs||[]).map(a=>`<tr><td class="mf-identity">${esc(a.name||a.slug)}</td><td>${esc(monthLabel(a.month))}</td><td>${esc(a.status)}</td><td>${esc(a.checkedAt||'Not checked')}</td></tr>`).join('')}</tbody></table></div></div>`,{size:'wide'});}
function cleanup(){disposeTable?.();disposeTable=null;table=null;offReady?.();offInvalid?.();offSession?.();clearInterval(timer);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);}
export function destroy(){cleanup();sequence++;dialog++;ctx=null;activeCompany=null;}
