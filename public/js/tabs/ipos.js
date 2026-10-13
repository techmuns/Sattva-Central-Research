import { TAB_META } from './catalog.js';
import * as refreshRegistry from '../core/refresh.js';
import { escapeHtml as e } from '../core/dom.js';
import { scoreTable, sectionHead } from '../ui/screener.js';
import { pill } from '../ui/components.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import * as feed from '../data/ipo-filings.js';
import { ipoKey, ipoDisplayDay } from '../data/ipo-filings-shared.js';
import { directoryTable } from './ipo-directory.js';

export const meta = TAB_META['ipos'];
let dispose = null;
let readView = () => ({});
export function getSavedView() { return readView(); }
const when = (day) => day ? new Date(`${day}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : 'Date not supplied';
const stamp = (at) => at ? new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : 'not yet checked';
export function render(ctx) {
  dispose?.();
  let dead = false, tableDispose = null, view = ctx.params?.company ? { q: ctx.params.company } : null;
  // Ordinary visits open on the recent week. Explicit company links from research must still
  // reveal older evidence, rather than silently hiding it behind the default reading window.
  let history = ctx.params?.company ? 'all' : '7', busy = !feed.meta().loaded;
  // Retain explicit issuer-directory links and saved readings without a second view picker.
  let mode = ctx.params?.view === 'directory' ? 'directory' : 'filings';
  const extras = ctx.savedView?.reading.extras || {};
  if (['all','7','30','90','365','undated'].includes(extras.ipoHistory)) history = extras.ipoHistory;
  if (extras.ipoMode === 'directory') mode = 'directory';
  readView = () => ({ ipoHistory: history, ipoMode: mode });
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
    const status = busy ? 'Checking sources…' : m.liveFailed ? 'Live sources unavailable · retained captures shown' : m.degraded ? 'Partial / dated coverage' : 'Sources checked';
    const options = (key, label) => ({ label, options: [{ value: 'all', label: `All ${label.toLowerCase()}` }, ...[...new Set(feed.rows().map((r) => r[key] || 'Not supplied'))].sort().map((v) => ({ value: v, label: v }))], match: (r, v) => (r[key] || 'Not supplied') === v });
    const table = mode === 'directory' ? directoryTable(feed.companies(), view) : scoreTable({
      rows, key: ipoKey, watchKey: (r) => r.ticker || null, watchName: (r) => r.company,
      name: (r) => r.company, sub: (r) => r.ticker || r.isin || (r.board ? `${r.board} public issue` : 'Public issue filing'),
      showRank: false, showWatchFilter: false, nameAfter: 1, dense: true, nameMaxPx: 280,
      stickyHead: 'max(320px, calc(100vh - 310px))', fillMode: 'auto',
      columns: [
        { label: 'Filed / document date', get: (r) => `${when(ipoDisplayDay(r))}${!r.filingDate && r.documentDate ? ' · document date' : ''}`, sortValue: (r) => ipoDisplayDay(r) || '', align: 'left' },
        { label: 'Filing', get: (r) => `<span class="whitespace-normal text-xs text-slate-700" title="${e(r.title)}">${e(r.filingType)}</span>`, html: true, sortValue: (r) => r.filingType },
        { label: 'Source', get: (r) => `${r.source === 'NSE' && r.board ? `NSE · ${r.board}` : r.source}${r.origin === 'imported' ? ' · archive' : r.origin === 'supplement' ? ' · supplement' : ''}` },
        { label: 'Document', get: (r) => r.url ? `<a href="${e(r.url)}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold text-indigo-600 hover:text-indigo-800">Open filing ↗</a>` : '<span class="text-xs text-slate-400">Not supplied</span>', html: true, sortable: false, align: 'right' },
      ],
      filters: [options('filingType', 'Filings'), options('board', 'Boards'), options('source', 'Sources')],
      filterGroup: {
        label: 'Board & source', indices: [1, 2],
        summary: (values) => values.slice(1).filter((value) => value !== 'all').join(' · ') || 'Board & source',
      },
      toolbarControls: { html: `<label class="ipo-history-control" title="Date range · Indian Standard Time">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/></svg>
        <select data-ipo-history aria-label="History range">${[['all', 'All captured'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year'], ['undated', 'Date not supplied']].map(([v, title]) => `<option value="${v}"${history === v ? ' selected' : ''}>${title}</option>`).join('')}</select>
      </label>` },
      searchable: (r) => `${r.company} ${r.title} ${r.isin || ''} ${r.ticker || ''} ${(r.aliases || []).join(' ')}`,
      initialSort: { key: 'Filed / document date', dir: 'desc' }, initialView: view,
      countNoun: 'filings', exportName: 'sattva-ipo-filings',
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
    ctx.root.innerHTML = `<section data-ipo-filings data-ipo-mode="${mode}" data-ipo-loading="${busy}">
      ${sectionHead({ title: mode === 'directory' ? 'IPO Directory' : 'IPO Filings', description: mode === 'directory' ? 'IPOPlatform issuer catalogue. Status and dates are publisher-reported as of the observation, not exchange confirmations. Includes upcoming, open, closed, listed and DRHP-filed issuers.' : 'DRHPs, red herring prospectuses, final prospectuses and related public-issue documents. All issuers, including unlisted companies; Portfolio / Watchlist scope does not filter this tab.', meta: pill({ label: mode === 'directory' ? `${m.companyCount.toLocaleString('en-IN')} captured issuers` : `${m.count.toLocaleString('en-IN')} captured filings`, tone: 'brand' }) })}
      <p data-ipo-export-status role="status" class="mb-2 text-xs text-amber-700"></p>${table.html}
    </section>`;
    tableDispose = table.wire(ctx.root);
    // Keep the search usable when the source/status filters wrap on a phone.
    ctx.root.querySelector('[data-table-search]').parentElement.style.minWidth = 'min(100%, 180px)';
    const period = ctx.root.querySelector('.ipo-history-control');
    if (period) period.parentElement.insertBefore(period, ctx.root.querySelector('[data-table-filter="0"]'));
    // The shared table normalizes its query for matching; preserve the reader's typed casing.
    if (searchText !== undefined) ctx.root.querySelector('[data-table-search]').value = searchText;
    if (selection) { const search = ctx.root.querySelector('[data-table-search]'); search.focus({ preventScroll: true }); search.setSelectionRange(...selection); }
    ctx.root.querySelector('[data-ipo-history]')?.addEventListener('change', (event) => {
      history = event.target.value; paint();
      ctx.root.querySelector('[data-ipo-history]').focus({ preventScroll: true });
    });
  }
  async function refresh() {
    busy = true; paint();
    try { await feed.refresh(); } finally { busy = false; paint(); }
  }
  const offRefresh = refreshRegistry.register('ipo-filings', { label: 'IPO filings', refresh: async () => {
    await refresh();
    return { checked: 1, failed: feed.meta().liveFailed ? 1 : 0, partial: feed.meta().degraded };
  } });
  const unsubscribe = feed.onChange(paint);
  dispose = () => { offRefresh(); dead = true; unsubscribe(); tableDispose?.(); if (ctx.live) feed.stopLive(ctx.live); };
  paint();
  // A return visit uses the feed already in memory. `load()` restores the
  // retained device snapshot on a cold visit; only the poll cadence or the
  // shared header Refresh performs a later revalidation.
  void feed.load().finally(() => {
    if (dead) return;
    busy = false;
    paint();
    if (ctx.live) feed.startLive(ctx.live);
  });
}
export function destroy() { dispose?.(); dispose = null; }
