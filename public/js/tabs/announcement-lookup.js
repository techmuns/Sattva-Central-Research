import { captureCoverageHtml } from '../ui/capture-coverage.js';
import { filingHistoryControls } from './filing-history-controls.js';
import { escapeHtml } from '../core/dom.js';
import * as coverage from '../data/coverage.js';
import { filterByScope } from '../data/scope.js';
import { announcementRange } from '../data/announcements-shared.js';

export function announcementLookupControls(feed) {
  const history = filingHistoryControls(feed);
  const day = (date) => date.toISOString().slice(0, 10);
  let draft = null, validation = '';
  function companies(ctx) {
    const list = [...coverage.holdings(), ...(ctx.data?.universe || []), ...feed.rows().map((r) => ({ ticker: r.ticker, name: r.company }))];
    const unique = new Map();
    for (const row of list) if (row.ticker && !unique.has(row.ticker)) unique.set(row.ticker, row);
    return filterByScope([...unique.values()], ctx.scope, coverage.holdings());
  }
  function html(ctx, meta) {
    const extra = meta.supplement;
    if (!draft) draft = { ticker: ctx.params?.company || extra.last?.ticker || '', fromDate: extra.last?.from || day(new Date(Date.now() - 365 * 86400000)), toDate: extra.last?.to || day(new Date()) };
    const last = extra.last;
    const status = validation || (extra.pending ? 'Reading additional announcements…' : last
      ? `${last.ticker} · ${last.from} to ${last.to}: ` + (last.error ? `Refresh failed: ${last.error} Saved announcements remain in the table.` : `${last.count} returned${last.fetchedAt ? ` · checked ${new Date(last.fetchedAt).toLocaleString()}` : ''}.`) + (last.skipped ? ` ${last.skipped} entries could not be read; coverage is incomplete.` : '')
      : 'Scheduled captures add company announcements automatically. Use this form for an immediate source check.');
    return `${captureCoverageHtml('announcements', ctx.scope === 'universe' ? null : companies(ctx).map((c) => c.ticker))}${history.html(ctx, meta)}<div class="mb-4 rounded-xl bg-white p-4 ring-1 ring-slate-200">
      <form data-announcement-lookup class="flex flex-wrap items-end gap-3">
        <label class="text-xs font-semibold text-slate-600">Additional sources — company
          <input name="ticker" list="announcement-companies" required maxlength="80" value="${escapeHtml(draft.ticker)}" placeholder="e.g. RELIANCE" class="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <datalist id="announcement-companies">${companies(ctx).filter((c) => /^[A-Z0-9&._-]{1,80}$/i.test(c.ticker)).map((c) => `<option value="${escapeHtml(c.ticker)}">${escapeHtml(c.name || c.ticker)}</option>`).join('')}</datalist>
        </label>
        <label class="text-xs font-semibold text-slate-600">From<input name="fromDate" type="date" required value="${escapeHtml(draft.fromDate)}" class="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm"></label>
        <label class="text-xs font-semibold text-slate-600">To<input name="toDate" type="date" required value="${escapeHtml(draft.toDate)}" class="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm"></label>
        <button type="submit" ${extra.pending ? 'disabled' : ''} class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Fetch additional announcements</button>
      </form>
      <p data-announcement-lookup-status role="status" aria-live="polite" class="mt-2 text-xs text-slate-500">${escapeHtml(status)}</p>
    </div>`;
  }
  function wire(root, ctx) {
    const disposeHistory = history.wire(root);
    const form = root.querySelector('[data-announcement-lookup]');
    if (!form) return;
    const capture = () => { draft = Object.fromEntries(new FormData(form)); };
    const submit = async (event) => {
      event.preventDefault(); capture(); validation = '';
      const ticker = draft.ticker.trim().toUpperCase();
      const company = companies(ctx).find((c) => c.ticker.toUpperCase() === ticker);
      try {
        if (!/^[A-Z0-9&._-]{1,80}$/.test(ticker)) throw new Error('Choose a valid company ticker.');
        if (ctx.scope !== 'universe' && !company) throw new Error('Choose a company in this scope, or switch to Universe.');
        announcementRange(draft.fromDate, draft.toDate);
        draft.ticker = ticker;
        ctx.setParams?.({ ...ctx.params, company: ticker });
        await feed.lookup({ ...draft, name: company?.name || null });
      } catch (error) {
        validation = error.message;
        const status = root.querySelector('[data-announcement-lookup-status]');
        if (status) status.textContent = validation;
      }
    };
    form.addEventListener('input', capture);
    form.addEventListener('submit', submit);
    return () => { disposeHistory?.(); form.removeEventListener('input', capture); form.removeEventListener('submit', submit); };
  }
  return { html, wire };
}
