import { sectionHead, scoreTable } from '../ui/screener.js';
import { exportRows } from '../ui/export.js';
import { escapeHtml } from '../core/dom.js';
import { whenDeferredData } from '../core/state.js';
import * as coverage from '../data/coverage.js';
import { filterByScope } from '../data/scope.js';
import { loadCompanyCaptureIndex } from '../data/company-captures.js';
import { captureCoverageHtml } from '../ui/capture-coverage.js';
import { loadDomesticFilings, loadCapturedDomesticFilings } from '../data/domestic-filings.js';
import { DOMESTIC_FORMS } from '../data/domestic-filings-shared.js';

/** Document lookup owns its request lifetime; navigation must not paint a late response. */
export function renderCompanyFilings(ctx, { controls = '', wireControls = () => {} } = {}) {
  let disposed = false;
  let controller = null;
  let tableDispose = null;
  let shownKey = null;
  let companies = [];
  ctx.root.innerHTML = `${sectionHead({ title: 'Company Filings', description: 'Annual reports, earnings reports and concall transcripts from Screener.in.', controls })}
    <div class="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      <form data-document-search class="flex flex-wrap items-end gap-3">
        <label class="text-xs font-semibold text-slate-600">Company ticker
          <input name="ticker" list="filing-companies" required maxlength="80" placeholder="e.g. RELIANCE"
            class="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" value="${escapeHtml(ctx.params?.company || '')}">
          <datalist id="filing-companies"></datalist>
        </label>
        <label class="text-xs font-semibold text-slate-600">Document type
          <select name="form" class="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm">
            ${Object.entries(DOMESTIC_FORMS).map(([key, label]) => `<option value="${key}" ${ctx.params?.form === key ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <button type="submit" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">Show captured filings</button>
        <button type="button" data-refresh-documents class="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold">Check source now</button>
      </form>
      <p class="mt-3 text-xs text-slate-500">Choose a company in the selected scope. Scheduled captures preserve documents automatically. Choose a company to show its captured history; check the source for an immediate update.</p>
    </div>
    <div data-document-coverage></div>
    <div data-document-status role="status" aria-live="polite" class="my-4 text-sm text-slate-600">Choose a company to read its filings.</div>
    <div data-document-table></div>`;
  wireControls(ctx.root, ctx);
  const form = ctx.root.querySelector('[data-document-search]');
  const status = ctx.root.querySelector('[data-document-status]');
  const target = ctx.root.querySelector('[data-document-table]');

  async function fetchDocuments({ live = false } = {}) {
    controller?.abort();
    const active = new AbortController();
    controller = active;
    const ticker = form.elements.ticker.value.trim().toUpperCase();
    const type = form.elements.form.value;
    if (shownKey !== `${ticker}|${type}`) { tableDispose?.(); target.innerHTML = ''; }
    if (ctx.scope !== 'universe' && !companies.some((c) => c.ticker === ticker)) {
      status.textContent = 'Choose a company in this scope, or switch to Universe.';
      return;
    }
    ctx.setParamsQuiet?.({ ...ctx.params, view: 'filings', company: ticker, form: type });
    status.textContent = `Reading ${DOMESTIC_FORMS[type].toLowerCase()} for ${ticker}…`;
    const timer = setTimeout(() => active.abort(), 25000);
    try {
      let result;
      if (!live) {
        try { result = await loadCapturedDomesticFilings(ticker, type); } catch { /* An explicit company lookup may read the source if not captured yet. */ }
      }
      if (!result) result = await loadDomesticFilings(ticker, type, { signal: active.signal });
      if (disposed || active !== controller) return;
      status.textContent = `${result.documents.length} retained documents for ${ticker}. ` +
        (result.stale ? `Showing the saved copy. Refresh failed: ${result.error}` : result.fetchedAt ? `Source checked ${new Date(result.fetchedAt).toLocaleString()}.` : 'Source check time unavailable.') +
        (result.skipped ? ` ${result.skipped} entries could not be read; this response may be incomplete.` : '') +
        (result.unavailableLinks ? ` The source lists ${result.unavailableLinks} unavailable document links.` : '');
      const table = scoreTable({
        rows: result.documents, key: (r) => `${r.form}|${r.url}`, name: (r) => r.title, nameLabel: 'Document',
        watchKey: (r) => r.ticker, watchName: (r) => companies.find((c) => c.ticker === r.ticker)?.name || r.ticker,
        sub: (r) => r.ticker, link: (r) => r.url, showScore: false, showRank: false,
        searchable: (r) => `${r.title} ${r.date || ''} ${DOMESTIC_FORMS[r.form] || ''}`,
        columns: [
          { label: 'Type', get: (r) => DOMESTIC_FORMS[r.form] || 'Not specified' },
          { label: 'Date / period', get: (r) => r.date || '—' },
          { label: 'Source', get: () => 'Screener.in via Muns' },
        ],
        emptyMessage: `The source returned no ${DOMESTIC_FORMS[type].toLowerCase()} for ${ticker}.`,
        exportName: `sattva-filings-${ticker}`,
        onExport: (rows, filename) => exportRows({ filename, sheetName: 'Company filings', rows, columns: [
          { header: 'Ticker', key: 'ticker', get: (r) => r.ticker },
          { header: 'Document', key: 'title', width: 45, get: (r) => r.title },
          { header: 'Type', key: 'form', width: 25, get: (r) => DOMESTIC_FORMS[r.form] || 'Not specified' },
          { header: 'Date / period', key: 'date', get: (r) => r.date || '' },
          { header: 'Source', key: 'source', width: 25, get: () => 'Screener.in via Muns' },
          { header: 'Document URL', key: 'url', width: 70, get: (r) => r.url },
        ] }),
      });
      tableDispose?.();
      shownKey = `${ticker}|${type}`;
      target.innerHTML = table.html;
      tableDispose = table.wire(target);
    } catch (err) {
      if (disposed || active !== controller) return;
      status.textContent = err.name === 'AbortError' ? 'The document request timed out. Please try again.' : err.message;
    } finally { clearTimeout(timer); }
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); void fetchDocuments(); });
  form.querySelector('[data-refresh-documents]').addEventListener('click', () => { if (form.reportValidity()) void fetchDocuments({ live: true }); });
  void Promise.all([whenDeferredData(), loadCompanyCaptureIndex()]).then(() => {
    if (disposed) return;
    const unique = new Map([...coverage.holdings(), ...(ctx.data?.universe || [])].filter((c) => c.ticker).map((c) => [c.ticker.toUpperCase(), { ...c, ticker: c.ticker.toUpperCase() }]));
    companies = filterByScope([...unique.values()], ctx.scope, coverage.holdings());
    form.querySelector('datalist').innerHTML = companies.map((c) => `<option value="${escapeHtml(c.ticker)}">${escapeHtml(c.name || c.ticker)}</option>`).join('');
    ctx.root.querySelector('[data-document-coverage]').innerHTML = captureCoverageHtml('domestic', companies.map((c) => c.ticker));
    if (ctx.params?.company) void fetchDocuments();
  });
  return () => { disposed = true; controller?.abort(); tableDispose?.(); };
}
