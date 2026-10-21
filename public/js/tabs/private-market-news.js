import { TAB_META } from './catalog.js';
import * as feed from '../data/private-market-news.js';
import { sectionHead, scoreTable, openDrill, openModal } from '../ui/screener.js';
import { escapeHtml as esc } from '../core/dom.js';
import { exportRows } from '../ui/export.js';
import * as refreshRegistry from '../core/refresh.js';

export const meta = TAB_META['private-market-news'];
let ctxRef = null, table = null, view = null, offTable = null, disposers = [];
const fields = [['date','Funding date'],['company','Company'],['sector','Sector'],['subsector','Subsector'],['businessModel','Business model'],['amount','Round size'],['round','Round type'],['investors','Investors'],['leadInvestor','Lead investor']];
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' }) + ' IST' : 'Not yet confirmed';
const safeUrl = value => { try { const u = new URL(value); return u.origin === 'https://inc42.com' ? u.href : 'https://inc42.com/tag/funding-galore/'; } catch { return 'https://inc42.com/tag/funding-galore/'; } };
const link = row => `<a data-norow href="${esc(safeUrl(row.sourceUrl || row.url))}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">Inc42 ↗</a>`;
const publicationYear = row => String(row.publishedAt || '').match(/^(20\d{2})-/)?.[1] || '';
const cell = value => `<div style="max-width:260px;white-space:normal;overflow-wrap:anywhere">${esc(value || '—')}</div>`;
function details(row) {
  const article = feed.meta().articles?.find(a => a.url === row.sourceUrl);
  const readings = row.sourceFields && Object.keys(row.sourceFields).length ? Object.entries(row.sourceFields) : fields.map(([key,label]) => [label,row[key]]);
  openDrill({ name: row.company, sub: 'Funding reported by Inc42', beforeGroupsHtml: `${readings.map(([label,value]) => `<p class="mt-3 text-sm"><strong>${esc(label)}</strong><br>${esc(value || 'Not provided')}</p>`).join('')}
    <p class="mt-4 text-xs text-slate-500">${esc(article?.notes?.join('\n') || '')}</p>
    <p class="mt-3 text-xs text-slate-500">Roundup published: ${esc(time(row.publishedAt))}. First captured: ${esc(time(row.firstSeenAt))}.</p>
    ${row.sourceMissing ? '<p class="mt-3 text-sm">Retained observation: this row is absent from the latest successful read of its article.</p>' : ''}
    ${row.revisions?.length ? `<details class="mt-3 text-xs"><summary>${row.revisions.length} earlier source version(s)</summary>${row.revisions.map(v => `<p class="mt-3"><strong>Captured ${esc(time(v.capturedAt))}</strong><br>${Object.entries(v.sourceFields || {}).map(([label,value]) => `${esc(label)}: ${esc(value)}`).join('<br>')}</p>`).join('')}</details>` : ''}<p class="mt-4">${link(row)} · ${esc(row.sourceTitle)}</p>` });
}
function coverage() {
  const m = feed.meta(), h = feed.health();
  if (!m.generatedAt) { openModal(`<h2 class="font-display text-lg font-bold text-slate-900">Private Market coverage</h2><p class="mt-3 text-sm">No verified capture is loaded yet. ${esc(m.readError || 'The published capture is being checked automatically.')}</p>`, { size:'wide' }); return; }
  openModal(`<h2 class="font-display text-lg font-bold text-slate-900">Private Market coverage</h2>
    <p class="mt-3 text-sm">Inc42 Funding Galore covers Indian startup funding reported in weekly roundups. It is a discovery source, not an exhaustive record of every VC or PE transaction. Rounds may include debt or undisclosed amounts; source wording and footnotes are retained.</p>
    <p class="mt-3 text-sm">Source listing checked: ${esc(time(m.sourceCheckedAt))}. Collection attempt: ${esc(time(m.attemptedAt))}. Capture prepared: ${esc(time(m.generatedAt))}. Browser checked publication: ${esc(time(m.browserCheckedAt))}.</p>
    <p class="mt-3 text-sm">${m.deals?.length || 0} retained rows across ${m.articles?.length || 0} discovered roundups. ${h.pending} awaiting capture; ${h.unavailable} failed or without a supported public table. Archive listing ${m.archive?.complete ? 'traversal complete' : `backfill in progress (next page ${m.archive?.nextPage || 2})`}. Previously captured rows are retained without an age cutoff. Repeated mentions in different roundups remain separate source observations; counts are not unique transaction totals.</p>
    <p class="mt-3 text-sm">GitHub checks every six hours, with sequential requests at least three seconds apart and at most 32 requests per run. Access refusals pause collection for at least 24 hours. Scheduled runs reconcile recent roundups and resume older work. This browser checks published captures every five minutes while visible and on return.</p>
    ${m.cooldownUntil ? `<p class="mt-3 text-sm">Source cooldown until ${esc(time(m.cooldownUntil))}.</p>` : ''}
    ${m.error || m.readError ? `<p class="mt-3 text-sm">Latest problem: ${esc(m.error || m.readError)}. Saved rows remain readable.</p>` : ''}
    <p class="mt-3 text-xs text-slate-500">${esc((m.articles || []).find(a => a.notes?.length)?.notes.join('\n') || '')}</p>
    <details class="mt-4"><summary>Roundup capture history</summary><div style="max-height:340px;overflow:auto">${(m.articles || []).map(a => `<p class="mt-2 text-xs">${link(a)} · ${esc(a.title)} · ${esc(a.status)}${a.rows != null ? ` · ${a.rows} rows` : ''}${a.error ? ` · ${esc(a.error)}` : ''}</p>`).join('')}</div></details>`, { size:'wide' });
}
function paint() {
  if (!ctxRef) return;
  const root = ctxRef.root, m = feed.meta(), rows = feed.rows(), h = feed.health();
  const searchText = root.querySelector('input')?.value;
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const input = focused?.matches('input') ? { value:focused.value, start:focused.selectionStart, end:focused.selectionEnd } : null;
  const selected = focused?.matches('select') ? focused.getAttribute('aria-label') : null;
  view = table?.view || view;
  const scroll = root.querySelector('[data-table-scroll]');
  const position = scroll ? { top:scroll.scrollTop, left:scroll.scrollLeft } : null;
  offTable?.(); offTable = null;
  const latestArticle = [...(m.articles || [])].filter(a => a.status === 'ok').sort((a,b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))[0];
  const latest = latestArticle?.url;
  const options = (key, label) => ({ label, options:[{ value:'all', label:`All ${label.toLowerCase()}` }, ...[...new Set(rows.map(r => r[key]).filter(v => v && !/^[-–—_]$/.test(v)))].sort().map(value => ({ value,label:value }))], match:(r,v) => v === 'all' || !v || r[key] === v });
  table = scoreTable({ rows, key:r => r.id, name:r => r.company, watchKey:() => null, showWatchFilter:false,
    showRank:false, showAvatar:false, nameWrap:true, nameMaxPx:210, dense:true, wrapHeads:true, nameAfter:1,
    sub:r => r.sourceMissing ? 'Retained · removed from source' : '',
    searchPlaceholder:'Search company, investor, sector or round...', searchable:r => fields.map(([key]) => r[key]).join(' '),
    columns: fields.filter(([key]) => key !== 'company').map(([key,label]) => ({ label, get:r => cell(r[key]), html:true, sortable:key !== 'amount', sortValue:r => key === 'date' ? r.dateISO || '' : r[key] })),
    initialSort:{ key:'Funding date', dir:'desc' }, initialView:view,
    filters:[{ label:'Funding period', value:'latest', options:[{ value:'latest',label:'Latest captured week' }, { value:'all',label:'All captured history' }, ...[...new Set(rows.map(publicationYear).filter(Boolean))].sort().reverse().map(value => ({ value,label:`${value} roundups` }))], match:(r,v) => v === 'all' || !v ? true : v === 'latest' ? r.sourceUrl === latest : publicationYear(r) === v }, options('sector','Sectors'), options('round','Round types'), options('businessModel','Business models')],
    loading:!m.generatedAt && !m.readError,
    emptyMessage:rows.length ? 'No funding deals match these filters.' : 'Funding collection has not published readable rows yet. Coverage shows the latest attempt.',
    countNoun:'funding records', fillMode:'windowed', stickyHead:'max(320px, calc(100vh - 340px))', onRowClick:details,
    bookmarkDate:r => r.dateISO, bookmarkSource:() => 'Inc42 Funding Galore', link:r => safeUrl(r.sourceUrl), exportName:'sattva-private-market-news',
    onExport:visible => exportRows({ filename:'sattva-private-market-news', sheetName:'Private market funding', rows:visible,
      columns:[...fields.map(([key,header]) => ({ key,header,get:r => r[key],width:key === 'investors' ? 70 : 24 })), ...['sourceUrl','sourceTitle','publishedAt','firstSeenAt','updatedAt','sourceMissing'].map(key => ({ key,header:key,get:r => String(r[key] ?? '') })),
        { key:'notes',header:'Source footnotes',get:r => (m.articles || []).find(a => a.url === r.sourceUrl)?.notes?.join('\n') || '' }, { key:'sourceFields',header:'All original source fields',get:r => JSON.stringify(r.sourceFields) }, { key:'revisions',header:'Prior source versions',get:r => JSON.stringify(r.revisions || []) }] }),
  });
  root.innerHTML = `${sectionHead({ title:'Private Market', description:'Weekly Indian startup funding reported by Inc42 · Across the source universe, independent of listed-company scopes.', meta:`<span class="text-xs text-slate-500">${esc(h.label)}</span>` })}
    ${table.html}<p class="mt-3 text-xs text-slate-500">Latest roundup published ${esc(time(latestArticle?.publishedAt))} · Source listing checked ${esc(time(m.sourceCheckedAt))} · <button type="button" data-private-market-coverage class="text-brand-600 hover:underline">Coverage & source notes</button></p>`;
  offTable = table.wire(root); root.querySelector('[data-private-market-coverage]').onclick = coverage;
  const next = root.querySelector('[data-table-scroll]'); if (position && next) { next.scrollTop = position.top; next.scrollLeft = position.left; }
  const search = root.querySelector('input'); if (search && searchText != null) search.value = searchText;
  if (input) { const field = root.querySelector('input'); if (field && field.value === input.value) { field.focus({ preventScroll:true }); field.setSelectionRange(input.start, input.end); } }
  if (selected) [...root.querySelectorAll('select')].find(s => s.getAttribute('aria-label') === selected)?.focus({ preventScroll:true });
}
export function render(ctx) {
  ctxRef = ctx;
  if (!disposers.length) disposers = [feed.onChange(paint), feed.bindLifecycle(), refreshRegistry.register('private-market-news', { label:'Private Market', refresh:feed.refresh })];
  paint(); void feed.load();
}
export function destroy() { ctxRef = null; view = table?.view || view; offTable?.(); offTable = null; table = null; disposers.forEach(fn => fn()); disposers = []; }
