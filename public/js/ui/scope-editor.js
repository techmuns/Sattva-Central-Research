// ui/scope-editor.js — edit the company list behind the active scope.

import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';
import { openModal } from './screener.js';
import { scopeLabel } from '../data/scope.js';
import { searchCompanies } from '../data/stock-search.js';
import * as coverage from '../data/coverage.js';
import * as technicals from '../data/technicals.js';
import * as watchlist from '../core/watchlist.js';
import { askContributor } from './watchlist-attribution.js';
import { attributionLabel } from '../data/watchlist-shared.js';
import * as scopeLists from '../core/scope-lists.js';
import { portfolioConnectionState, onPortfolioConnection, unlockPortfolio } from '../research/portfolio-bridge.js';
import { refreshFamilySession } from '../data/family-session.js';

const SEARCH_DELAY_MS = 250;

const clean = (v) => String(v ?? '').trim();
const upper = (v) => clean(v).toUpperCase();

function universeBase() {
  const seen = new Set();
  const out = [];
  for (const row of technicals.all()) {
    const c = row.company || {};
    const ticker = upper(c.ticker);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, name: c.name || ticker, sector: c.sector || c.industry || null, industry: c.industry || null, country: 'India' });
  }
  for (const h of coverage.holdings()) {
    const ticker = upper(h.ticker);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ...h, ticker, country: h.country || 'India' });
  }
  return out;
}

function editorHtml(scope) {
  return `
    <div data-scope-editor="${escapeHtml(scope)}">
      <div class="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
        <div>
          <div class="text-[11px] font-bold uppercase tracking-wider text-indigo-500">${scope === 'portfolio' ? 'Family Office' : 'Scope list'}</div>
          <h2 class="font-display mt-1 text-xl font-extrabold text-slate-900">${scope === 'portfolio' ? 'View' : 'Edit'} ${escapeHtml(scopeLabel(scope))}</h2>
          <p class="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">
            ${scope === 'portfolio'
              ? 'Your holdings from Sattva Family Office. Additions and exits update automatically.'
              : scope === 'watchlist'
                ? 'One watchlist for everyone, on every device. Search by company name or ticker, then add or remove it — an addition is recorded with the name of whoever made it.'
                : 'Search by company name or ticker, then add or remove it. Changes are kept on this device.'}
          </p>
        </div>
        <button type="button" data-modal-close aria-label="Close scope editor" class="text-2xl leading-none text-slate-400 hover:text-slate-700">×</button>
      </div>

      <div class="px-6 py-5">
        <div>
          <label for="scope-company-search" class="sr-only">Search company name, ticker or ISIN</label>
          <div class="flex items-center gap-2 rounded-xl bg-white px-3 ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-indigo-300">
            <svg class="h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5"></circle><path d="m13 13 4 4"></path>
            </svg>
            <input id="scope-company-search" data-scope-search type="search" autocomplete="off"
              placeholder="Search company name, ticker or ISIN…"
              class="min-w-0 flex-1 bg-transparent py-3 text-sm text-slate-800 outline-none placeholder:text-slate-400" />
          </div>
          <!-- IN FLOW, NOT FLOATING, AND THAT IS THE FIX RATHER THAN THE STYLE.
               (No backticks in here: this comment lives inside a template literal.)
               It used to be positioned absolute, so it hung over the member list immediately below —
               which is the list the same keystrokes had just filtered. Typing IIFL narrowed the
               list to IIFL Finance and then covered its Remove button by about 16px, so the
               reader's first click was swallowed dismissing the panel and only the second one
               removed anything. A control that needs two clicks to do what it says once is broken,
               and the mitigation further down (collapsing the panel inside the member click
               handler) could never fire, because the click it depends on is the one being eaten.
               In flow, the list is pushed down instead of hidden, both halves of the answer are on
               screen at once — what the search found, and what is already on the list — and there
               is no overlap left to time a dismissal around. -->
          <div data-scope-search-results class="mt-2 hidden max-h-72 overflow-y-auto rounded-2xl bg-white p-1.5 ring-1 ring-slate-200"></div>
        </div>

        <div data-scope-loading class="py-12 text-center text-sm text-slate-400">Reading the ${escapeHtml(scopeLabel(scope).toLowerCase())} list…</div>
        <div data-scope-list-panel class="mt-5 hidden">
          <div class="mb-2 flex items-center justify-between gap-3">
            <div class="text-xs font-bold uppercase tracking-wider text-slate-400"><span data-scope-count>0</span> ${scope === 'portfolio' ? 'holdings' : 'companies'}</div>
            ${scope !== 'universe' ? '' : '<button type="button" data-scope-reset class="text-xs font-semibold text-slate-400 transition hover:text-rose-600">Restore default</button>'}
          </div>
          ${scope === 'portfolio' ? '<p data-portfolio-status role="status" class="mb-3 text-xs leading-relaxed text-slate-500"></p>' : ''}
          ${scope === 'watchlist' ? '<p data-watchlist-status role="status" class="mb-3 text-xs leading-relaxed text-slate-500"></p>' : ''}
          <div data-scope-members class="scrollbar-thin max-h-[44vh] divide-y divide-slate-100 overflow-y-auto rounded-2xl border border-slate-100 bg-slate-50/60 px-3"></div>
          <p data-scope-empty-filter class="hidden py-8 text-center text-sm text-slate-400">No current company matches this search.</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-6 py-4">
        <p class="max-w-xl text-xs leading-relaxed text-slate-500">
          ${scope === 'universe'
            ? 'Universe edits filter every ticker-based feed. A newly added company appears wherever that feed has data for it.'
            : scope === 'portfolio'
              ? 'Manage holdings in Family Office. Keep companies you want to follow in Watchlist.'
              : 'This is the same list controlled by the ☆ beside company rows, and the same list everyone else sees.'}
        </p>
        <button type="button" data-modal-close class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">Done</button>
      </div>
    </div>`;
}

function memberHtml(entry, readOnly = false, { showAttribution = false } = {}) {
  const ticker = upper(entry.ticker);
  const key = readOnly ? entry.isin || scopeLists.keyFor(entry) : scopeLists.keyFor(entry);
  // WHO PUT THIS HERE is the question a shared list creates and a private one never had. A row
  // nothing ever recorded a name for says so in those words rather than showing a blank that reads
  // like a rendering fault — the same rule as an em dash that has to say which absence it is.
  const credit = showAttribution ? attributionLabel(entry) : '';
  return `
    <div class="flex items-center gap-3 py-2.5" data-scope-member="${escapeHtml(key)}">
      <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-[10px] font-extrabold text-indigo-600">${escapeHtml((ticker || entry.name || '?').slice(0, 2))}</div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold text-slate-800">${escapeHtml(entry.name || ticker || 'Unnamed company')}</div>
        <div class="truncate text-[11px] text-slate-400">${escapeHtml([ticker || 'No NSE research symbol', entry.industry || entry.sector, credit].filter(Boolean).join(' · '))}</div>
      </div>
      ${readOnly ? `<div class="shrink-0 text-right"><span class="text-xs font-semibold text-emerald-700">Owned</span>${Number.isFinite(entry.weightPct) ? `<div class="mt-1 text-[11px] text-slate-500">${entry.weightPct.toLocaleString('en-IN', { maximumFractionDigits: 2 })}% of listed portfolio</div>` : ''}</div>` : `<button type="button" data-scope-remove="${escapeHtml(key)}" aria-label="Remove ${escapeHtml(entry.name || ticker)}"
        class="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50">Remove</button>`}
    </div>`;
}

function searchResultsHtml(results, current, loading, error) {
  if (loading) return '<div class="px-3 py-4 text-center text-sm text-slate-400">Searching Muns…</div>';
  if (error) return `<div class="px-3 py-4 text-sm text-rose-600">${escapeHtml(error)}</div>`;
  if (!results.length) return '<div class="px-3 py-4 text-center text-sm text-slate-400">No matching Indian companies.</div>';
  const memberKeys = new Set(current.map(scopeLists.keyFor));
  return results
    .map((entry, index) => {
      const key = scopeLists.keyFor(entry);
      const active = memberKeys.has(key);
      const supported = entry.validTicker !== false && (!entry.country || /^india$/i.test(entry.country));
      return `
        <button type="button" data-scope-result="${index}" ${supported ? '' : 'disabled'}
          class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${supported ? 'hover:bg-slate-50' : 'cursor-not-allowed opacity-45'}">
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm font-semibold text-slate-800">${escapeHtml(entry.name || entry.ticker)}</span>
              <span class="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">${escapeHtml(entry.ticker)}</span>
            </div>
            <div class="mt-0.5 truncate text-[11px] text-slate-400">${escapeHtml([entry.country, entry.industry, entry.validTicker === false ? 'no usable ticker' : null].filter(Boolean).join(' · '))}</div>
          </div>
          <span class="shrink-0 text-xs font-bold ${active ? 'text-rose-600' : 'text-indigo-600'}">${active ? 'Remove' : 'Add'}</span>
        </button>`;
    })
    .join('');
}

export function openScopeEditor({ scope, onChanged = null } = {}) {
  if (scope === 'portfolio') return openPortfolioView({ onChanged });
  let base = [];
  let changed = false;
  let searchResults = [];
  let searchTimer = null;
  let searchAbort = null;
  let offWatchlist = null;

  openModal(editorHtml(scope), {
    size: 'wide',
    onClose: () => {
      clearTimeout(searchTimer);
      searchAbort?.abort();
      offWatchlist?.();
      if (changed) onChanged?.();
    },
  });

  const root = document.querySelector(`[data-scope-editor="${scope}"]`);
  if (!root) return;
  const input = root.querySelector('[data-scope-search]');
  const resultBox = root.querySelector('[data-scope-search-results]');
  const membersBox = root.querySelector('[data-scope-members]');
  const panel = root.querySelector('[data-scope-list-panel]');
  const loading = root.querySelector('[data-scope-loading]');

  const current = () => {
    if (scope === 'watchlist') return watchlist.all();
    return scopeLists.apply(scope, base);
  };

  // WHAT THE READER IS OWED ABOUT A LIST THEY SHARE: whether what is on screen is the shared list,
  // or this device's copy of it, or their own edit that has not landed yet. Those are three
  // different claims and one "synced" over all of them would be wrong two thirds of the time —
  // the same reason the header carries an origin rather than a green light. `pending` is not a
  // failure: an edit is saved here and on its way.
  function watchlistStatusText() {
    const m = watchlist.meta();
    if (m.error) return m.error;
    if (m.pending) return `${m.pending} change${m.pending === 1 ? '' : 's'} saved on this device and being sent to the shared list.`;
    if (m.origin === 'live') return 'This is the shared watchlist, confirmed just now. Everyone on the dashboard sees these companies.';
    return 'Showing this device\u2019s copy of the shared watchlist. It has not been confirmed against the server yet.';
  }

  function paintStatus() {
    const el = root.querySelector('[data-watchlist-status]');
    if (el) el.textContent = watchlistStatusText();
  }

  function paintMembers() {
    const query = clean(input.value).toLowerCase();
    const entries = current();
    const filtered = query
      ? entries.filter((entry) => `${entry.ticker || ''} ${entry.name || ''} ${entry.industry || entry.sector || ''}`.toLowerCase().includes(query))
      : entries;
    root.querySelector('[data-scope-count]').textContent = formatNumber(entries.length);
    membersBox.innerHTML = filtered.map((entry) => memberHtml(entry, false, { showAttribution: scope === 'watchlist' })).join('');
    root.querySelector('[data-scope-empty-filter]').classList.toggle('hidden', filtered.length > 0 || !query);
    membersBox.classList.toggle('hidden', filtered.length === 0 && !!query);
  }

  function paintSearch({ busy = false, error = '' } = {}) {
    const open = clean(input.value).length >= 2;
    resultBox.classList.toggle('hidden', !open);
    if (open) resultBox.innerHTML = searchResultsHtml(searchResults, current(), busy, error);
  }

  function markChanged() {
    changed = true;
    paintMembers();
    paintStatus();
    paintSearch();
  }

  async function add(entry) {
    if (scope === 'watchlist') {
      // The same question the star asks, for the same reason: this list is shared, so an addition
      // carries the name of whoever made it. Backing out adds nothing — see toggleWatched().
      const by = await askContributor({ ticker: entry.ticker, company: entry.name });
      if (!by) return;
      watchlist.add(entry.ticker, entry.name, by);
    } else {
      scopeLists.add(scope, { ...entry, source: 'muns-search' }, base);
    }
    markChanged();
  }

  function remove(entry) {
    if (scope === 'watchlist') watchlist.remove(entry.ticker);
    else scopeLists.remove(scope, entry, base);
    markChanged();
  }

  input.addEventListener('input', () => {
    paintMembers();
    clearTimeout(searchTimer);
    searchAbort?.abort();
    searchResults = [];
    const query = clean(input.value);
    if (query.length < 2) {
      paintSearch();
      return;
    }
    paintSearch({ busy: true });
    searchTimer = setTimeout(async () => {
      searchAbort = new AbortController();
      try {
        searchResults = await searchCompanies(query, { signal: searchAbort.signal });
        if (query === clean(input.value)) paintSearch();
      } catch (err) {
        if (err?.name !== 'AbortError' && query === clean(input.value)) paintSearch({ error: err?.message || 'Search failed.' });
      }
    }, SEARCH_DELAY_MS);
  });

  resultBox.addEventListener('click', (event) => {
    const button = event.target.closest('[data-scope-result]');
    if (!button || button.disabled) return;
    const entry = searchResults[Number(button.dataset.scopeResult)];
    if (!entry) return;
    if (current().some((item) => scopeLists.keyFor(item) === scopeLists.keyFor(entry))) remove(entry);
    else void add(entry);
  });

  membersBox.addEventListener('click', (event) => {
    const button = event.target.closest('[data-scope-remove]');
    if (!button) return;
    const entry = current().find((item) => scopeLists.keyFor(item) === button.dataset.scopeRemove);
    if (entry) {
      remove(entry);
      // A member-row action means the reader has moved from autocomplete to the list, so the
      // suggestions have served their purpose. This used to be load-bearing — the panel floated
      // over the list and had to be dismissed — and it could not work, because the click it runs
      // from was the one the panel was intercepting. The panel is in flow now and covers nothing;
      // this simply tidies it away once the reader is plainly working on the list instead.
      resultBox.classList.add('hidden');
    }
  });

  root.querySelector('[data-scope-reset]')?.addEventListener('click', () => {
    scopeLists.reset(scope);
    changed = true;
    paintMembers();
    paintSearch();
  });

  if (scope === 'watchlist') {
    const off = watchlist.onChange(() => {
      if (!document.body.contains(root)) return off();
      paintMembers();
      paintStatus();
    });
    offWatchlist = off;
    void watchlist.syncNow({ force: true });
  }

  Promise.resolve(scope === 'universe' ? technicals.load() : null)
    .then(() => {
      if (!document.body.contains(root)) return;
      if (scope === 'universe') base = universeBase();
      loading.classList.add('hidden');
      panel.classList.remove('hidden');
      paintMembers();
      paintStatus();
      input.focus();
    })
    .catch((err) => {
      if (!document.body.contains(root)) return;
      loading.innerHTML = `<span class="text-rose-600">Could not read this list: ${escapeHtml(err?.message || err)}</span>`;
    });
}

/** The existing scope window, now a live read-only view of the same book used
 * by every research feed. Search never creates a second ownership list. */
function openPortfolioView({ onChanged }) {
  let offBook, offConnection;
  let changed = false;
  openModal(editorHtml('portfolio'), {
    size: 'wide',
    onClose: () => { offBook?.(); offConnection?.(); if (changed) onChanged?.(); },
  });
  const root = document.querySelector('[data-scope-editor="portfolio"]');
  const input = root.querySelector('[data-scope-search]');
  const paint = () => {
    const entries = coverage.holdings();
    const query = clean(input.value).toLowerCase();
    const matches = entries.filter(h => [h.name, h.bookName, h.ticker, h.isin, h.sector].join(' ').toLowerCase().includes(query));
    root.querySelector('[data-scope-loading]').classList.add('hidden');
    root.querySelector('[data-scope-list-panel]').classList.remove('hidden');
    root.querySelector('[data-scope-count]').textContent = formatNumber(entries.length);
    root.querySelector('[data-scope-members]').innerHTML = matches.map(h => memberHtml(h, true)).join('');
    const empty = root.querySelector('[data-scope-empty-filter]');
    empty.classList.toggle('hidden', matches.length > 0);
    empty.textContent = query ? 'No holding matches this search.' : 'No holdings available from Family Office.';
    const m = coverage.meta();
    const active = ['family-session', 'live'].includes(m.syncStatus);
    const day = m.asOf ? ` · Book ${m.asOf}` : '';
    const status = root.querySelector('[data-portfolio-status]');
    status.textContent = active ? `From Family Office${day}. Holdings without research coverage are included.`
      : `${m.syncStatus === 'family-checking' ? 'Last verified Family Office portfolio' : 'Saved Family Office portfolio'}${day} · ${m.syncStatus === 'unavailable' ? 'Unable to check for changes.' : 'Checking for changes…'}`;
    if (portfolioConnectionState() === 'locked') {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'ml-2 font-semibold text-indigo-700 hover:underline';
      button.textContent = 'Unlock portfolio'; button.onclick = unlockPortfolio;
      status.append(button);
    }
  };
  offBook = coverage.onChange(event => { changed ||= event.changed; paint(); });
  offConnection = onPortfolioConnection(paint);
  input.addEventListener('input', paint);
  paint(); input.focus();
  void refreshFamilySession();
}
