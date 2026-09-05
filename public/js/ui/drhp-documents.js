import * as refreshRegistry from '../core/refresh.js';
import { escapeHtml as e } from '../core/dom.js';
import { hostToken, onHostContext } from '../core/host-context.js';
import { validateDrhpCompany } from '../data/drhp-shared.js';
import { documentUrl } from '../data/combined-filings-shared.js';
import { sectionHead } from './screener.js';
import { recordDocuments } from '../data/alert-records.js';

export function mountDrhpDocuments({ root }) {
  let controller = null;
  let generation = 0;
  let disposed = false;
  root.innerHTML = `${sectionHead({ title: 'IPO / DRHP filings', description: 'Find draft prospectuses and related filings by ticker or exact company name, including companies without a listed ticker.' })}
    <form data-drhp-form class="mb-4 rounded-2xl bg-white p-4 ring-1 ring-slate-100">
      <div class="flex flex-wrap items-end gap-3">
        <label class="block min-w-0 flex-1 text-xs font-semibold text-slate-600">Ticker or exact company name
          <input data-drhp-company aria-label="IPO company" class="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" placeholder="PAYTM or exact issuer name" autocomplete="off" maxlength="200" required>
        </label>
        <button data-drhp-load class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white" type="submit">Load IPO filings</button>
      </div>
      <p class="mt-2 text-xs text-slate-500">Any company, independent of Portfolio / Watchlist scope. Up to 50 filings per lookup. No changes to your portfolio.</p>
      <p class="mt-2 text-xs text-slate-500">A DRHP filing is not confirmation of an upcoming IPO, approval, an offer date or an open subscription. This lookup does not discover every IPO or monitor market buzz.</p>
    </form>
    <p data-drhp-status role="status" class="mb-3 text-sm text-slate-600"></p>
    <div data-drhp-results class="space-y-3"></div>`;
  const status = root.querySelector('[data-drhp-status]');
  const results = root.querySelector('[data-drhp-results]');
  const input = root.querySelector('[data-drhp-company]');
  const button = root.querySelector('[data-drhp-load]');
  const say = (message) => { status.textContent = message; };
  const clear = () => {
    generation++; controller?.abort(); controller = null;
    results.innerHTML = ''; button.disabled = false;
    say(hostToken() ? 'Enter a ticker or exact company name to load filings.' : 'Sign in through Munshot to load IPO / DRHP filings.');
  };
  clear();
  input.addEventListener('input', clear);
  const unsubscribe = onHostContext((_, changed) => { if (changed?.session) clear(); });
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
    let company;
    try { company = validateDrhpCompany(input.value); }
    catch (error) { say(error.message); return; }
    const mine = ++generation;
    controller?.abort(); controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    const current = () => !disposed && mine === generation && hostToken() === token;
    button.disabled = true; say(`Loading IPO / DRHP filings for ${company}…`);
    try {
      const response = await fetch('api/drhp-filings', { method: 'POST', cache: 'no-store', signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ company }) });
      const payload = await response.json();
      if (!current()) return;
      if (!response.ok || payload?.ok !== true || !Array.isArray(payload.rows)) throw new Error(payload?.message || 'The IPO / DRHP lookup could not be loaded.');
      recordDocuments('drhp-documents', payload);
      const rows = payload.rows;
      const documentCount = rows.reduce((count, row) => count + row.documents.length, 0);
      say(`${rows.length} filings · ${documentCount} document links returned for “${company}”. Check the returned company identity below.${payload.limitReached ? ' The 50-filing limit was reached; this may not be the full history.' : ''}${payload.omittedRows ? ` ${payload.omittedRows} additional records exceed the display limit.` : ''}${payload.unmapped || payload.unmappedDocuments ? ` Warning: ${payload.unmapped || 0} filing record(s) and ${payload.unmappedDocuments || 0} document entry/entries could not be mapped; coverage may be incomplete.` : ''}`);
      if (!rows.length) {
        results.innerHTML = `<p class="rounded-2xl bg-white p-4 text-sm text-slate-600">${payload.unmapped ? 'The service returned unrecognised records. A usable filing history could not be displayed.' : 'No filings were returned. Check the ticker or exact company name; this does not prove that no prospectus or IPO exists.'}</p>`;
        return { checked: 1, partial: !!payload.unmapped };
      }
      results.innerHTML = rows.map((row) => `<article data-drhp-filing class="min-w-0 rounded-2xl bg-white p-4 ring-1 ring-slate-100">
        <h3 class="break-words font-semibold text-slate-800">${e(row.company || 'Company name not supplied')}</h3>
        <p class="mt-1 break-words text-sm text-slate-600">${e(row.symbol || 'Symbol not supplied')} · ${e(row.form || 'Form not supplied')} · ${e(row.date || 'Date not supplied')}</p>
        <p class="mt-1 break-words text-xs text-slate-500">Source: ${e(row.source || 'Not supplied')}</p>
        ${row.documents.length ? `<ul class="mt-3 space-y-2">${row.documents.map((doc) => { const url = documentUrl(doc.url); return url ? `<li><a class="break-words text-sm text-indigo-600 hover:underline" href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(doc.label)} ↗</a></li>` : ''; }).join('')}</ul>` : '<p class="mt-3 text-sm text-slate-500">No usable document links supplied.</p>'}
      </article>`).join('');
      return { checked: 1, partial: !!(payload.limitReached || payload.omittedRows || payload.unmapped || payload.unmappedDocuments) };
    } catch (error) { if (current()) say(signal.aborted ? 'The IPO / DRHP lookup timed out. Retry later.' : error.message || 'The IPO / DRHP lookup failed.'); return { failed: 1, error: error.message }; }
    finally { if (current()) button.disabled = false; }
  }
  const offRefresh = refreshRegistry.register('drhp-documents', { label: 'IPO documents', refresh: async () => {
    if (!input.value.trim()) return { skipped: true };
    return await submit() || { skipped: true };
  } });
  root.querySelector('[data-drhp-form]').addEventListener('submit', submit);
  return () => { offRefresh(); disposed = true; generation++; controller?.abort(); unsubscribe(); };
}
