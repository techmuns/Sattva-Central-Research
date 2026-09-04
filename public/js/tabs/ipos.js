import { escapeHtml as e } from '../core/dom.js';
import { scoreTable, sectionHead } from '../ui/screener.js';
import { pill } from '../ui/components.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import * as feed from '../data/ipo-filings.js';
import { ipoKey, ipoDisplayDay } from '../data/ipo-filings-shared.js';
import { directoryTable } from './ipo-directory.js';
import { openBeacon } from '../ui/source-beacon.js';

export const meta = { id: 'ipos', title: 'IPOs', subtitle: 'Official public-issue filings, including unlisted issuers. Newest filings first.', allowEmptyScope: true, subviews: [] };
let dispose = null;
const when = (day) => day ? new Date(`${day}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : 'Date not supplied';
const stamp = (at) => at ? new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : 'not yet checked';
export function render(ctx) {
  dispose?.();
  let dead = false, tableDispose = null, view = ctx.params?.company ? { q: ctx.params.company } : null;
  let history = 'all', busy = !feed.meta().loaded, mode = 'filings';
  const filtered = () => {
    if (history === 'all') return feed.rows();
    if (history === 'undated') return feed.rows().filter((r) => !ipoDisplayDay(r));
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const from = new Date(Date.parse(today) - (Number(history) - 1) * 86400000).toISOString().slice(0, 10);
    return feed.rows().filter((r) => ipoDisplayDay(r) && ipoDisplayDay(r) >= from && ipoDisplayDay(r) <= today);
  };
  function paint() {
    if (dead) return;
    const previous = ctx.root.querySelector('[data-table-search]');
    const searchText = previous?.value;
    const selection = previous && document.activeElement === previous ? [previous.selectionStart, previous.selectionEnd] : null;
    tableDispose?.();
    const m = feed.meta(), rows = filtered();
    const sourcesOk = m.sources.filter((s) => s.status === 'ok').length;
    const status = busy ? 'Checking sources…' : m.liveFailed ? 'Live sources unavailable · retained captures shown' : m.degraded ? 'Partial / dated coverage' : 'Sources checked';
    const options = (key, label) => ({ label, options: [{ value: 'all', label: `All ${label.toLowerCase()}` }, ...[...new Set(feed.rows().map((r) => r[key] || 'Not supplied'))].sort().map((v) => ({ value: v, label: v }))], match: (r, v) => (r[key] || 'Not supplied') === v });
    const table = mode === 'directory' ? directoryTable(feed.companies(), view) : scoreTable({
      rows, key: ipoKey, watchKey: (r) => r.ticker || null, watchName: (r) => r.company,
      name: (r) => r.company, sub: (r) => r.ticker || r.isin || (r.board ? `${r.board} public issue` : 'Public issue filing'),
      showRank: false, nameAfter: 1, dense: true, nameMaxPx: 280,
      stickyHead: 'max(320px, calc(100vh - 310px))', fillMode: 'scroll',
      columns: [
        { label: 'Filed / document date', get: (r) => `${when(ipoDisplayDay(r))}${!r.filingDate && r.documentDate ? ' · document date' : ''}`, sortValue: (r) => ipoDisplayDay(r) || '', align: 'left' },
        { label: 'Filing', get: (r) => `<span class="whitespace-normal text-xs text-slate-700" title="${e(r.title)}">${e(r.filingType)}</span>`, html: true, sortValue: (r) => r.filingType },
        { label: 'Source', get: (r) => `${r.source === 'NSE' && r.board ? `NSE · ${r.board}` : r.source}${r.origin === 'imported' ? ' · archive' : r.origin === 'supplement' ? ' · supplement' : ''}` },
        { label: 'Document', get: (r) => r.url ? `<a href="${e(r.url)}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold text-indigo-600 hover:text-indigo-800">Open filing ↗</a>` : '<span class="text-xs text-slate-400">Not supplied</span>', html: true, sortable: false, align: 'right' },
      ],
      filters: [options('filingType', 'Filings'), options('board', 'Boards'), options('source', 'Sources')],
      searchable: (r) => `${r.company} ${r.title} ${r.isin || ''} ${r.ticker || ''} ${(r.aliases || []).join(' ')}`,
      initialSort: { key: 'Filed / document date', dir: 'desc' }, initialView: view,
      link: (r) => r.url, countNoun: 'filings', exportName: 'sattva-ipo-filings',
      emptyMessage: 'No captured filings match these filters. This is not proof that no IPO or filing exists. Try All captured or another search.',
      onExport: async (visible, filename) => {
        const success = await exportSheets({ filename: `${filename}-${todayStamp()}`, banner: `${status}. Source check: ${stamp(m.checkedAt)}. Captured public-issue documents, not a complete IPO universe or confirmation an offer is open.`, sheets: [{ name: 'IPO filings', rows: visible, columns: [
          { header: 'Filed (IST)', key: 'date', get: (r) => r.filingDate || 'Date not supplied', width: 18 },
          { header: 'Publisher document date (not filing date)', key: 'documentDate', get: (r) => r.documentDate || 'Not supplied', width: 26 },
          { header: 'Company', key: 'company', get: (r) => r.company, width: 40 },
          { header: 'Filing', key: 'filing', get: (r) => r.filingType, width: 26 },
          { header: 'Source title', key: 'title', get: (r) => r.title, width: 55 },
          { header: 'Board', key: 'board', get: (r) => r.board || 'Not supplied' },
          { header: 'Source', key: 'source', get: (r) => r.source },
          { header: 'Document URL', key: 'url', get: (r) => r.url || 'Not supplied', width: 60 },
          { header: 'Observed at', key: 'observed', get: (r) => r.observedAt, width: 28 },
        ] }, { name: 'Coverage', rows: m.sources, columns: [
          { header: 'Source', key: 'source', get: (s) => s.label, width: 24 },
          { header: 'Read status', key: 'status', get: (s) => s.status },
          { header: 'Checked at', key: 'checked', get: (s) => s.checkedAt, width: 28 },
          { header: 'Coverage limitations', key: 'note', get: (s) => s.note, width: 100 },
        ] }] });
        if (!success && !dead) ctx.root.querySelector('[data-ipo-export-status]').textContent = 'Excel export failed. Check your connection and retry.';
      },
    });
    view = table.view;
    ctx.root.innerHTML = `<section data-ipo-filings>
      ${sectionHead({ title: mode === 'directory' ? 'IPO Directory' : 'IPO Filings', description: mode === 'directory' ? 'IPOPlatform issuer catalogue. Status and dates are publisher-reported as of the observation, not exchange confirmations. Includes upcoming, open, closed, listed and DRHP-filed issuers.' : 'DRHPs, red herring prospectuses, final prospectuses and related public-issue documents. All issuers, including unlisted companies; Portfolio / Watchlist scope does not filter this tab.', meta: pill({ label: mode === 'directory' ? `${m.companyCount.toLocaleString('en-IN')} captured issuers` : `${m.count.toLocaleString('en-IN')} captured filings`, tone: 'brand' }) })}
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <label class="text-xs font-semibold text-slate-600">View <select data-ipo-view aria-label="IPO view" class="ml-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><option value="filings"${mode === 'filings' ? ' selected' : ''}>Filings</option><option value="directory"${mode === 'directory' ? ' selected' : ''}>Issuer directory</option></select></label>
        ${mode === 'filings' ? `<label class="text-xs font-semibold text-slate-600">History range <select data-ipo-history aria-label="History range" class="ml-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">${[['all', 'All captured'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year'], ['undated', 'Date not supplied']].map(([v, title]) => `<option value="${v}"${history === v ? ' selected' : ''}>${title}</option>`).join('')}</select></label>` : ''}
        <button data-ipo-refresh class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600"${busy ? ' disabled' : ''}>${busy ? 'Checking…' : 'Refresh'}</button>
        <span data-ipo-freshness role="status" class="text-xs ${m.degraded && !busy ? 'text-amber-700' : 'text-slate-500'}">${e(status)} · ${sourcesOk}/${m.sources.length || 7} sources · ${e(stamp(m.checkedAt))}</span>
        <button type="button" data-ipo-sources class="text-xs font-semibold text-indigo-600 hover:text-indigo-800" aria-controls="source-beacon-panel">Source details</button>
      </div>
      <p data-ipo-export-status role="status" class="mb-2 text-xs text-amber-700"></p>${table.html}
    </section>`;
    tableDispose = table.wire(ctx.root);
    // Keep the search usable when the source/status filters wrap on a phone.
    ctx.root.querySelector('[data-table-search]').parentElement.style.minWidth = 'min(100%, 180px)';
    // The shared table normalizes its query for matching; preserve the reader's typed casing.
    if (searchText !== undefined) ctx.root.querySelector('[data-table-search]').value = searchText;
    if (selection) { const search = ctx.root.querySelector('[data-table-search]'); search.focus({ preventScroll: true }); search.setSelectionRange(...selection); }
    ctx.root.querySelector('[data-ipo-history]')?.addEventListener('change', (event) => { history = event.target.value; paint(); });
    ctx.root.querySelector('[data-ipo-view]').addEventListener('change', (event) => { mode = event.target.value; view = null; paint(); });
    ctx.root.querySelector('[data-ipo-sources]').addEventListener('click', () => openBeacon({ group: 'ipo-filings' }));
    ctx.root.querySelector('[data-ipo-refresh]').addEventListener('click', () => { void refresh(); });
  }
  async function refresh() {
    busy = true; paint();
    try { await feed.refresh(); } finally { busy = false; paint(); }
  }
  const unsubscribe = feed.onChange(paint);
  dispose = () => { dead = true; unsubscribe(); tableDispose?.(); if (ctx.live) feed.stopLive(ctx.live); };
  paint();
  // A return visit uses the feed already in memory. `load()` restores the
  // retained device snapshot on a cold visit; only the poll cadence or the
  // explicit Refresh button performs a later revalidation.
  void feed.load().finally(() => {
    if (dead) return;
    busy = false;
    paint();
    if (ctx.live) feed.startLive(ctx.live);
  });
}
export function destroy() { dispose?.(); dispose = null; }
