import { escapeHtml as esc } from '../core/dom.js';
import * as coverage from '../data/coverage.js';
import { portfolioCatalog, manualSearchUrl, X_LABEL } from '../data/x-chatter-shared.js';
import { recordStatus } from '../data/x-chatter-status.js';

const labels = {
  'free-only': 'Free data only · automatic X search is off',
  'setup-required': 'X API connection is not set up yet', 'not-started': 'Collection has not started',
  collecting: 'Scheduled collection enabled', paused: 'Collection paused', 'daily-limit': 'Daily collection allowance reached',
  'access-required': 'X access or credits need attention', 'rate-limited': 'Waiting for X’s rate limit to reset',
  unavailable: 'X could not be reached', 'request-rejected': 'X rejected the search request',
  'invalid-response': 'X returned an unreadable response', 'partial-response': 'X returned an incomplete response',
  'not-checked': 'Not checked yet', expired: 'Capture expired', limited: 'Result limit / incomplete response',
  checked: 'Checked', 'no-matches': 'No matches in the sampled search', checking: 'Checking now',
};
const date = (value) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST'
  : 'Not checked yet';
const control = 'rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700';

// Mount independently of the forum feed. Text lives only in this view's memory, never IndexedDB.
export function mountXChatter(root) {
  let destroyed = false, requestNumber = 0, controller, timer, debounce;
  let payload = null, offset = 0, company = '', q = '', hours = '24', pageSize = 50;
  const catalog = portfolioCatalog(coverage.holdings());
  const keys = new Set(catalog.map((c) => c.key));
  root.innerHTML = `
    <div class="mb-4 text-sm leading-relaxed text-slate-600">
      <h3 class="mb-1 text-lg font-bold text-slate-900">X Chatter</h3>
      Public posts matching the names and symbols of your <strong>${catalog.length} portfolio holdings</strong>, including individual accounts.
      This view always follows your portfolio. A search match is a research lead, not a verified company announcement.
    </div>
    <div data-x-status class="mb-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-600" role="status">Reading the shared X capture…</div>
    <div class="rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
      <div class="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
        <input type="search" data-x-search aria-label="Search X posts and authors" placeholder="Search posts or @authors…" class="${control} min-w-0 flex-1" maxlength="200">
        <select data-x-company aria-label="X company" class="${control} max-w-full">
          <option value="">All portfolio companies (${catalog.length})</option>
          ${catalog.map((c) => `<option value="${esc(c.key)}">${esc(c.name)}</option>`).join('')}
        </select>
        <select data-x-period aria-label="X post date" class="${control}">
          <option value="24">Posted in last 24 hours</option><option value="72">Posted in last 3 days</option><option value="168">Posted in last 7 days</option>
        </select>
        <button type="button" data-x-refresh class="${control} font-semibold">Refresh view</button>
      </div>
      <div data-x-results aria-live="polite"></div>
    </div>
    <details class="mt-4 rounded-xl bg-white p-4 ring-1 ring-slate-100" data-x-coverage>
      <summary class="cursor-pointer text-sm font-semibold text-slate-700">Company coverage and searches (${catalog.length})</summary>
      <div data-x-company-status class="mt-3 max-h-96 overflow-auto"></div>
    </details>
    <p class="mt-4 text-xs leading-relaxed text-slate-500">Latest first by the post’s publication date, which may differ from the event date.
      Searches cover at most seven days and a capped sample per company; they cannot guarantee every important update.
      Posts can contain errors, promotions or old information. Open the original and check the company’s filings before relying on a claim.
      Refresh view reads the shared capture and does not buy more X data.</p>`;

  function companyRows() {
    const records = new Map((payload?.companies || []).map((c) => [c.key, c]));
    return catalog.map((c) => {
      const recorded = records.get(c.key);
      const state = recorded?.status || 'not-checked';
      return `<div class="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 py-3 text-xs" data-x-company-row>
        <div class="min-w-0 flex-1"><strong class="text-slate-800">${esc(c.name)}</strong>
          <p class="mt-1 text-slate-500">${esc(labels[state] || state)} · ${esc(date(recorded?.checkedAt))}</p>
          <details class="mt-1 text-slate-500"><summary class="cursor-pointer">Search terms</summary><p class="mt-1 break-words">${esc(recorded?.query || c.query || 'Company name needs review')}</p></details>
        </div>
        <div class="flex gap-3"><a href="${esc(manualSearchUrl(c))}" target="_blank" rel="noopener noreferrer" class="font-semibold text-indigo-600">Latest on X ↗</a>
          <a href="${esc(manualSearchUrl(c, false))}" target="_blank" rel="noopener noreferrer" class="text-slate-600">Top on X ↗</a></div>
      </div>`;
    }).join('');
  }

  function paint(error = '') {
    recordStatus(error ? null : payload);
    const status = root.querySelector('[data-x-status]');
    const result = root.querySelector('[data-x-results]');
    const records = (payload?.companies || []).filter((c) => keys.has(c.key));
    const checked = records.filter((c) => ['checked', 'no-matches', 'limited'].includes(c.status)).length;
    const limited = records.filter((c) => c.partial).length;
    const total = payload?.total || 0;
    const posts = (payload?.posts || []).filter((p) => p.companies?.some((c) => keys.has(c.key)) && Date.parse(p.expiresAt) > Date.now());
    const mainStatus = labels[payload?.status] || 'X capture unavailable';
    status.innerHTML = `<p class="font-semibold text-slate-800">${esc(error || mainStatus)}</p>
      <p class="mt-1 text-xs">${checked} of ${catalog.length} holdings checked with a current capture · ${catalog.length - checked} not checked, expired or needing attention${limited ? ` · ${limited} searches were limited` : ''}.</p>
      <p class="mt-1 text-xs">${payload?.status === 'free-only'
        ? 'Use Latest on X or Top on X in the company list below. These open X for you to read; they do not automatically import posts. No paid X service is enabled.'
        : payload?.status === 'setup-required' || !payload
        ? 'An official X API connection and an agreed spending allowance are needed. You can already open the company searches below.'
        : `Up to ${esc(String(payload.perCompany))} recent matches per company per check · planned every ${esc(String(payload.intervalHours))} hours · last successful company check: ${esc(date(payload.lastSuccessAt))}.`}</p>`;
    root.querySelector('[data-x-company-status]').innerHTML = companyRows();
    if (error) {
      result.innerHTML = '<p class="p-8 text-center text-sm text-slate-500">The X capture could not be confirmed. Try Refresh view. This does not mean there are no posts.</p>';
      return;
    }
    const selected = records.find((c) => c.key === company);
    result.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 text-xs text-slate-500">
        <span data-x-count>${total ? `${offset + 1}–${Math.min(offset + pageSize, total)} of ${total}` : '0'} cached matches for these filters · latest first</span>
        <span>${company ? '10 posts per page' : '50 posts per page'} · ${X_LABEL}</span>
      </div>
      ${selected?.partial ? '<p class="border-b border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-800">This company’s search was capped or incomplete. More posts may exist on X.</p>' : ''}
      ${posts.length ? posts.map(postCard).join('') : `<p class="p-8 text-center text-sm text-slate-500">${payload?.status === 'free-only'
        ? 'Open Company coverage and searches below to read posts on X. Automatic company-wide collection requires paid X access and is disabled.'
        : payload?.status === 'setup-required' || !records.length
        ? 'Company searches are ready. Posts will appear after the official API is connected and collection starts.'
        : 'No cached posts match these filters. Try a wider date range and check company coverage below; an unread or limited search is not proof of no activity.'}</p>`}
      ${total > pageSize ? `<div class="flex items-center justify-between gap-2 border-t border-slate-100 p-4">
        <button type="button" data-x-page="prev" ${offset ? '' : 'disabled'} class="${control} disabled:opacity-40">Previous</button>
        <button type="button" data-x-page="next" ${payload.hasMore ? '' : 'disabled'} class="${control} disabled:opacity-40">Next posts</button>
      </div>` : ''}`;
  }

  async function load() {
    const request = ++requestNumber;
    controller?.abort(); const currentController = new AbortController(); controller = currentController;
    const url = new URL('/api/x-chatter', location.origin);
    for (const [key, value] of Object.entries({ company, q, hours, offset, limit: pageSize, keys: [...keys].join(',') })) url.searchParams.set(key, value);
    const timeout = setTimeout(() => currentController.abort(), 12000);
    try {
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: currentController.signal });
      if (destroyed || request !== requestNumber) return;
      if (response.status === 404) {
        payload = { status: 'free-only', companies: [], posts: [], total: 0 };
      } else {
        if (!response.ok) throw new Error('unavailable');
        const next = await response.json();
        if (!Array.isArray(next.posts) || !Array.isArray(next.companies) || next.source !== 'X API') throw new Error('invalid-response');
        if (request !== requestNumber || destroyed) return;
        // An updated capture changes paging. Restart so moving results cannot quietly skip a page.
        if (offset && payload && next.version !== payload.version) { offset = 0; payload = next; return load(); }
        payload = next;
      }
      if (!destroyed && request === requestNumber) paint();
    } catch {
      if (!destroyed && request === requestNumber) { payload = null; paint('The shared X capture is unavailable'); }
    } finally { clearTimeout(timeout); }
  }
  function onChange(event) {
    if (event.target.matches('[data-x-company]')) { company = event.target.value; pageSize = company ? 10 : 50; }
    else if (event.target.matches('[data-x-period]')) hours = event.target.value;
    else return;
    offset = 0; load();
  }
  function onInput(event) {
    if (!event.target.matches('[data-x-search]')) return;
    q = event.target.value; offset = 0; clearTimeout(debounce); debounce = setTimeout(load, 250);
  }
  function onClick(event) {
    if (event.target.closest('[data-x-refresh]')) { offset = 0; load(); }
    const page = event.target.closest('[data-x-page]');
    if (page && !page.disabled) { offset = Math.max(0, offset + (page.dataset.xPage === 'next' ? pageSize : -pageSize)); load(); }
  }
  root.addEventListener('change', onChange); root.addEventListener('input', onInput); root.addEventListener('click', onClick);
  // Poll only the private shared cache. Also removes expired/withdrawn posts on an already-open view.
  timer = setInterval(load, 60000); load();
  return () => {
    destroyed = true; requestNumber++; controller?.abort(); clearInterval(timer); clearTimeout(debounce); payload = null;
    root.removeEventListener('change', onChange); root.removeEventListener('input', onInput); root.removeEventListener('click', onClick);
  };
}

function postCard(post) {
  // Rebuild original links from validated IDs, rather than trusting a feed-supplied href.
  if (!/^\d{1,25}$/.test(post.id) || !/^[A-Za-z0-9_]{1,15}$/.test(post.author?.username || '')) return '';
  const original = `https://x.com/${post.author.username}/status/${post.id}`;
  const text = String(post.text || '');
  const body = text.length > 700
    ? `<details><summary class="cursor-pointer"><span class="whitespace-pre-wrap break-words">${esc(text.slice(0, 700))}…</span><span class="mt-2 block text-xs font-semibold text-indigo-600">Read full post</span></summary><p class="mt-3 whitespace-pre-wrap break-words">${esc(text)}</p></details>`
    : `<p class="whitespace-pre-wrap break-words">${esc(text)}</p>`;
  return `<article class="border-b border-slate-100 p-4 sm:p-5" data-x-post="${esc(post.id)}">
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class="rounded-md bg-slate-950 px-2 py-1 font-bold text-white" data-x-label>${X_LABEL}</span>
      <a href="https://x.com/${esc(post.author.username)}" target="_blank" rel="noopener noreferrer" class="font-semibold text-slate-800">${esc(post.author.name)} <span class="font-normal text-slate-500">@${esc(post.author.username)}</span></a>
      <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-800">Unverified social post</span>
    </div>
    <p class="mt-2 text-xs text-slate-500">${esc(post.companies.map((c) => c.name).join(' · '))} · Posted ${esc(date(post.createdAt))}</p>
    <div class="mt-3 text-sm leading-relaxed text-slate-800">${body}</div>
    <div class="mt-3 flex flex-wrap gap-3">${(post.images || []).map((m) => {
      let u; try { u = new URL(m.url); } catch { return ''; }
      if (u.protocol !== 'https:' || u.hostname !== 'pbs.twimg.com') return '';
      return `<a href="${original}" target="_blank" rel="noopener noreferrer" aria-label="Open attached media on X"><img src="${esc(u.href)}" alt="${esc(m.alt || 'Media attached to the X post') }" loading="lazy" referrerpolicy="no-referrer" class="h-40 max-w-full rounded-lg border border-slate-100 object-contain"></a>`;
    }).join('')}</div>
    <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
      <a href="${original}" target="_blank" rel="noopener noreferrer" class="font-semibold text-indigo-600">Open original on X ↗</a>
      <span class="text-slate-400">Captured ${esc(date(post.capturedAt))}</span>
    </div>
  </article>`;
}
