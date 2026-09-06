import * as refreshRegistry from '../core/refresh.js';
// One caller-private company lookup, placed beside each related exchange/analysis view.
// It does not fan out over the universe or mingle user read flags with public feed caches.
import { escapeHtml } from '../core/dom.js';
import { hostToken, hostTicker, onHostContext } from '../core/host-context.js';
import { searchCompanies } from '../data/stock-search.js';
import { FORM_LABELS, documentUrl } from '../data/combined-filings-shared.js';
import { scopeAllowsTicker, scopeLabel } from '../data/scope.js';
import * as coverage from '../data/coverage.js';
import * as watchlist from '../core/watchlist.js';
import { scoreTable, sectionHead } from './screener.js';
import { mountDrhpDocuments } from './drhp-documents.js';
import { recordDocuments } from '../data/alert-records.js';

const e = escapeHtml;
const buttonClass = 'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white';
const inputClass = 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm';
const day = (time) => new Date(time + 19800000).toISOString().slice(0, 10);

export function withCompanyDocuments(tab, options) {
  let dispose = null;
  let mode = 'feed';
  return {
    render(ctx) {
      dispose?.(); dispose = null;
      // Scope changes remount this wrapper; keep the chosen view but never old account results.
      ctx.root.innerHTML = `<div class="mb-4 flex flex-wrap gap-2" data-document-tabs>
        <button type="button" data-doc-mode="feed" class="${inputClass}">${e(options.feedLabel)}</button>
        <button type="button" data-doc-mode="documents" class="${inputClass}">${e(options.label)}</button>
        ${options.drhp ? `<button type="button" data-doc-mode="drhp" class="${inputClass}">IPO / DRHP filings</button>` : ''}
      </div><div data-document-content></div>`;
      const root = ctx.root.querySelector('[data-document-content]');
      const show = (next) => {
        dispose?.(); dispose = null;
        tab.destroy();
        mode = next;
        ctx.root.querySelectorAll('[data-doc-mode]').forEach((button) => {
          button.setAttribute('aria-pressed', String(button.dataset.docMode === mode));
          button.classList.toggle('text-indigo-700', button.dataset.docMode === mode);
        });
        if (mode === 'documents') dispose = mountCompanyDocuments({ ...ctx, root }, options);
        else if (mode === 'drhp' && options.drhp) dispose = mountDrhpDocuments({ ...ctx, root });
        else tab.render({ ...ctx, root });
      };
      ctx.root.querySelectorAll('[data-doc-mode]').forEach((button) => button.addEventListener('click', () => show(button.dataset.docMode)));
      show(mode);
    },
    destroy() { dispose?.(); dispose = null; tab.destroy(); mode = 'feed'; },
  };
}

export function mountCompanyDocuments(ctx, options) {
  let controller = null;
  let generation = 0;
  let disposed = false;
  let tableView = null;
  let tableOff = null;
  const book = coverage.holdings();
  const candidates = new Map();
  const entries = ctx.scope === 'watchlist' ? watchlist.all() : ctx.scope === 'portfolio' ? book : [...(ctx.data?.universe || []), ...book];
  for (const item of entries) {
    const ticker = String(item.ticker || '').toUpperCase();
    if (ticker && scopeAllowsTicker(ctx.scope, ticker, book)) candidates.set(ticker, { ticker, name: item.name || ticker });
  }
  const initial = String(ctx.params?.company || hostTicker() || '').toUpperCase();
  const selected = candidates.get(initial)?.ticker || '';
  const forms = options.form === 'all' ? ['all', 'annual_report', 'earnings_report', 'concalls'] : [options.form];
  ctx.root.innerHTML = `${sectionHead({ title: options.label, description: 'Company-specific documents via Muns. Choose a company and date range; this is not a market-wide monitor or a complete exchange archive.' })}
    <form data-doc-form class="mb-4 rounded-2xl bg-white p-4 ring-1 ring-slate-100">
      <div class="flex flex-wrap items-end gap-3">
        <label class="text-xs font-semibold text-slate-600">Company in ${e(scopeLabel(ctx.scope))}
          <input data-doc-company aria-label="Document company" list="document-companies-${e(options.form)}" autocomplete="off" class="${inputClass} mt-1 block" placeholder="Company name or ticker" value="${e(selected)}" required>
          <datalist id="document-companies-${e(options.form)}">${[...candidates.values()].map((item) => `<option value="${e(item.ticker)}">${e(item.name)}</option>`).join('')}</datalist>
        </label>
        <label class="text-xs font-semibold text-slate-600">Document type
          <select data-doc-form-type aria-label="Document type" class="${inputClass} mt-1 block">${forms.map((form) => `<option value="${form}">${e(FORM_LABELS[form])}</option>`).join('')}</select>
        </label>
        <label class="text-xs font-semibold text-slate-600">From <input type="date" data-doc-from aria-label="Documents from" class="${inputClass} mt-1 block" value="${day(Date.now() - 365 * 86400000)}" required></label>
        <label class="text-xs font-semibold text-slate-600">To <input type="date" data-doc-to aria-label="Documents to" class="${inputClass} mt-1 block" value="${day(Date.now())}" max="${day(Date.now())}" required></label>
        <button data-doc-load class="${buttonClass}" type="submit">Load documents</button>
      </div>
      <p class="mt-2 text-xs text-slate-500">India · one company per request · up to one year.${options.source === 'NSE' ? ' Only documents identified as NSE are shown here.' : ' Source labels distinguish BSE, NSE, DRHP and Screener documents.'} Read status is supplied by your session; opening a link does not change it here.</p>
      <div data-doc-suggestions class="mt-2 flex flex-wrap gap-2"></div>
    </form>
    <p data-doc-status role="status" class="mb-3 text-sm text-slate-600"></p><div data-doc-results></div>`;
  const root = ctx.root;
  const input = root.querySelector('[data-doc-company]');
  const status = root.querySelector('[data-doc-status]');
  const results = root.querySelector('[data-doc-results]');
  const loadButton = root.querySelector('[data-doc-load]');
  const suggestions = root.querySelector('[data-doc-suggestions]');
  const say = (message) => { status.textContent = message; };
  say(hostToken() ? 'Choose a company to load its document history.' : 'Sign in through Munshot to load documents. The exchange feeds remain available.');

  const clear = () => {
    generation++; controller?.abort(); controller = null;
    results.innerHTML = ''; suggestions.innerHTML = ''; tableView = null;
    loadButton.disabled = false;
    say(hostToken() ? 'Session changed. Load the company again for your read status.' : 'Sign in through Munshot to load documents.');
  };
  const unsubscribe = onHostContext((_, changed) => { if (changed?.session) clear(); });
  const cancelSelection = () => {
    generation++; controller?.abort(); results.innerHTML = ''; suggestions.innerHTML = ''; tableView = null;
    loadButton.disabled = false; say('Load documents for the selected company, type and dates.');
  };
  root.querySelectorAll('input, select').forEach((element) => element.addEventListener('input', cancelSelection));

  let pendingRead = null;
  function submit(event) {
    event?.preventDefault();
    const key = JSON.stringify([...root.querySelectorAll('input, select')].map((el) => el.value));
    if (pendingRead?.key === key) return pendingRead.promise;
    const promise = readDocuments().finally(() => { if (pendingRead?.promise === promise) pendingRead = null; });
    pendingRead = { key, promise };
    return promise;
  }
  async function readDocuments() {
    const token = hostToken();
    if (!token) { clear(); return { failed: 1, error: 'Sign in to refresh documents.' }; }
    const mine = ++generation;
    controller?.abort(); controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    const current = () => !disposed && mine === generation && hostToken() === token;
    loadButton.disabled = true;
    suggestions.innerHTML = '';
    try {
      const query = input.value.trim();
      let company = candidates.get(query.toUpperCase()) || [...candidates.values()].find((item) => item.name.toLowerCase() === query.toLowerCase());
      if (!company) {
        say('Finding matching companies…');
        const found = await searchCompanies(query, { signal });
        if (!current()) return;
        const allowed = found.filter((item) => /^india$/i.test(item.country || '') && item.validTicker !== false && /^[A-Z][A-Z0-9&.\-]{0,29}$/.test(item.ticker || '') && scopeAllowsTicker(ctx.scope, item.ticker, book));
        if (!allowed.length) { say(`No matching company in ${scopeLabel(ctx.scope)}. Check the name${ctx.scope === 'universe' ? '' : ' or switch to Universe'}.`); return; }
        // Do not silently select an ambiguous company name or treat it as a ticker.
        for (const item of allowed.slice(0, 20)) {
          candidates.set(item.ticker, item);
          const button = document.createElement('button');
          button.type = 'button'; button.className = inputClass;
          button.textContent = `${item.name} (${item.ticker})`;
          button.addEventListener('click', () => { input.value = item.ticker; void submit(); });
          suggestions.append(button);
        }
        say('Select the intended company below.'); return;
      }
      say(`Loading ${company.name} documents…`);
      const body = { ticker: company.ticker, country: 'India', form: [root.querySelector('[data-doc-form-type]').value],
        start_date: root.querySelector('[data-doc-from]').value, end_date: root.querySelector('[data-doc-to]').value };
      const response = await fetch('api/combined-filings', { method: 'POST', cache: 'no-store', signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!current()) return;
      if (!response.ok || payload?.ok !== true || !Array.isArray(payload.rows)) throw new Error(payload?.message || 'The company document history could not be loaded.');
      recordDocuments('company-documents', payload, company);
      const matching = payload.rows.filter((row) => row.ticker === company.ticker && (!row.date || (row.date >= body.start_date && row.date <= body.end_date)));
      const rows = matching.filter((row) => !options.source || row.sourceTags?.includes(options.source));
      const hidden = payload.rows.length - rows.length;
      const undated = rows.filter((row) => !row.date).length;
      say(`${rows.length} ${rows.length === 1 ? 'document' : 'documents'} for ${company.name} · ${body.start_date} to ${body.end_date}.${undated ? ` Includes ${undated} without a usable date.` : ''}${hidden ? ` ${hidden} returned record(s) are outside this company/source/date view.` : ''}${payload.unmapped ? ` Warning: ${payload.unmapped} record(s) have an unrecognised format; coverage may be incomplete.` : ''} These are the service’s results, not a completeness guarantee.`);
      const table = scoreTable({ rows, key: (row) => row.key, watchKey: (row) => row.ticker, watchName: () => company.name, name: (row) => row.title, nameLabel: 'Document',
        sub: (row) => [row.ticker, row.form].filter(Boolean).join(' · '), showRank: false, showAvatar: false, dense: true,
        columns: [
          { label: 'Date', get: (row) => row.date || 'Date not supplied', sortValue: (row) => row.date || '' },
          { label: 'Source', get: (row) => row.sources?.join(' · ') || 'Source not supplied' },
          { label: 'Read status', get: (row) => row.isRead === true ? 'Read' : row.isRead === false ? 'Unread' : 'Not supplied / conflicting' },
        ], filters: options.source ? [] : [{ label: 'Source', options: [{ value: 'all', label: 'All sources' }, ...['NSE', 'BSE', 'DRHP', 'Screener', 'SEC'].map((source) => ({ value: source, label: source }))], match: (row, value) => row.sourceTags?.includes(value) }],
        searchable: (row) => `${row.title} ${row.ticker} ${row.summary || ''} ${(row.sources || []).join(' ')}`,
        link: (row) => documentUrl(row.url), countNoun: 'documents', initialSort: { key: 'Date', dir: 'desc' }, initialView: tableView,
        emptyMessage: 'No matching documents were returned for this company, source and date range. This does not prove no filing exists.',
      });
      tableOff?.();
      tableView = table.view; results.innerHTML = table.html; tableOff = table.wire(results);
      results.querySelector('[data-table-search]').placeholder = 'Search documents…';
      return { checked: 1, partial: !!payload.unmapped };
    } catch (error) { if (current()) say(signal.aborted ? 'The document request timed out. Retained documents remain visible; retry or narrow the range.' : error.message || 'Documents could not be loaded.'); return { failed: 1, error: error.message }; }
    finally { if (current()) loadButton.disabled = false; }
  }
  const offRefresh = refreshRegistry.register('company-documents', { label: 'Company documents', refresh: async () => {
    if (!input.value.trim()) return { skipped: true };
    return await submit() || { skipped: true };
  } });
  root.querySelector('[data-doc-form]').addEventListener('submit', submit);
  return () => { tableOff?.(); offRefresh(); disposed = true; generation++; controller?.abort(); unsubscribe(); };
}
