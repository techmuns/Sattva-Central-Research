// A continuous, scoped stream of source announcements. BSE date captures, live NSE
// filings and retained Muns company documents share one table and keep their source labels.
//
// SERVED A PAGE AT A TIME. The table asks the Worker's announcement index for one ranked page of the
// question on screen (period, scope, categories, market cap, search, one company) and receives the
// total and the facet counts with it (data/announcement-query.js). Nothing on this tab downloads the
// ~190,000-filing history any more. Where the index cannot be read, the same question is answered in
// this browser over the captures, exactly as the tab always could, and the provenance says which.
//
// RANKED, NEVER FILTERED BY RANK. Newest day first; within a day the filing a buy-side analyst would
// read first comes first (data/relevance.js — category, size, the size of any stated amount against
// the company's market cap, sector, governance and direction, plus the desk's shared Important / Not
// important feedback). No High/Medium/Low label is printed and no filing is hidden by its score.
//
// THE SUBJECT IS THE EXCHANGE'S OWN, EXACTLY AS FILED. Category tags (the editable master list in
// data/announcement-categories.js), market cap and "N related filings" (data/event-stitching.js) sit
// beside it. Clicking a filing opens the AI Read popup — the only place a generated reading appears.

import { escapeHtml } from '../core/dom.js';
import { formatDate, formatNumber } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { corporateAnnouncements as identityFeed } from '../data/corporate-announcements.js';
import { announcementSources, announcementSourceUrls } from '../data/announcements-shared.js';
import { captureCoverageHtml } from '../ui/capture-coverage.js';
import { announcementCoverage } from '../data/announcement-coverage.js';
import { announcementSearch } from '../ui/announcement-search.js';
import * as coverage from '../data/coverage.js';
import * as watchlist from '../core/watchlist.js';
import { scopeLabel } from '../data/scope.js';
import { newsDay } from '../data/news-window.js';
import { createAnnouncementQuery, EXPORT_MAX } from '../data/announcement-query.js';
import { ANNOUNCEMENT_PERIODS } from '../data/announcement-index-shared.js';
import { ANNOUNCEMENT_CATEGORIES, CATEGORY_GROUPS, categoryLabel } from '../data/announcement-categories.js';
import { MCAP_BANDS, MCAP_UNKNOWN, formatMarketCap, parseMcapRange, mcapRangeLabel } from '../data/company-profile.js';
import * as localEngine from '../data/announcement-query-local.js';
import { categoryChips } from '../ui/category-chips.js';
import { openAnnouncementRead } from '../ui/announcement-read.js';
import { loadModel } from '../data/relevance-feedback.js';

const DEFAULT_PERIOD = 'all';
// The periods this tab has always offered; the index answers any of ANNOUNCEMENT_PERIODS.
const TAB_PERIODS = ['today', '3', '7', 'month', 'all'].map((value) => ANNOUNCEMENT_PERIODS.find((p) => p.value === value));
const FILTERS_KEY = 'sattva:announcement-filters:v1';
const POLL_ID = 'corporate-announcements-index';
const POLL_MS = 90_000;

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

// Existing committed captures may predate the upstream normaliser fix. Clean on read as well so a
// deploy repairs visible `<BR><BR>` immediately, without waiting for the next scheduled capture.
export const cleanFilingText = (value) => String(value || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Category and market-cap choices outlive the tab and the page: a reader who works on mid caps
// should not pick it again on every visit. This browser only; nothing is shared.
const readFilters = () => {
  try {
    const value = JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}');
    const known = new Set(ANNOUNCEMENT_CATEGORIES.map((c) => c.id));
    return { categories: (Array.isArray(value.categories) ? value.categories : []).filter((c) => known.has(c)), mcap: parseMcapRange(value.mcap).kind === 'all' ? 'all' : String(value.mcap) };
  } catch { return { categories: [], mcap: 'all' }; }
};
const filters = readFilters();
const saveFilters = () => { try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch { /* this session still filters */ } };

const query = createAnnouncementQuery({ pageSize: 200 });
let currentCtx = null;
let searchTimer = null;
// What the reader is asking, held here rather than read off the table's view: the first render has
// no view yet, and a search typed between paints must not wait for one.
const asked = { q: '', period: DEFAULT_PERIOD, state: null };

const scopeCompanies = (scope) => (scope === 'portfolio'
  ? coverage.holdings().map((h) => ({ ticker: h.ticker || null, isin: h.isin || null, bseCode: h.bseCode || h.scripCode || null, name: h.name || null }))
  : scope === 'watchlist' ? watchlist.all().map((w) => ({ ticker: w.ticker, name: w.name || w.ticker })) : []);

function adopt(view) {
  if (!view) return;
  if (typeof view.q === 'string') asked.q = view.q;
  if (view.filters?.[0]) asked.period = view.filters[0];
  if (view.searchState) asked.state = view.searchState;
}

function questionFor(ctx) {
  const selected = asked.state?.selected;
  return {
    period: asked.period,
    scope: ctx.scope,
    companies: scopeCompanies(ctx.scope),
    categories: filters.categories,
    mcap: filters.mcap,
    q: asked.q || '',
    company: selected ? { ticker: selected.ticker || null, isin: selected.isin || null, bseCode: selected.bseCode || selected.scripCode || null, name: selected.name || null } : null,
  };
}

/** Re-ask the question on screen; re-render only when it actually changed. */
function requery() {
  if (!currentCtx) return;
  if (query.setQuery(questionFor(currentCtx))) tab.render(currentCtx);
}

// The feed interface makeFilingsTab reads, over the paged query.
const feed = {
  rows: () => query.rows(),
  isLoaded: () => query.isLoaded(),
  load: () => query.load(),
  refresh: () => query.refresh(),
  onChange: (fn) => query.onChange(fn),
  setWanted() {},
  wasAskedEmpty: () => false,
  failureFor: () => null,
  meta: () => metaOf(),
};

function metaOf() {
  const qm = query.meta();
  const index = qm.index;
  const base = (index?.local ? index.meta : index?.meta) || {};
  const live = index?.live || {};
  return {
    ...base,
    kind: 'announcements',
    nse: { ...(base.nse || {}), capturedAt: live.at || base.nse?.capturedAt || null, error: live.error || base.nse?.error || null },
    reason: qm.state === 'failed' && !qm.loaded ? (qm.error?.reason === 'rate-limited' ? 'rate-limited' : 'unreachable') : null,
    message: qm.state === 'failed' ? qm.error?.message || null : null,
    query: qm,
    rowCount: qm.total ?? 0,
    covered: qm.companies ?? 0,
    windowDays: base.windowDays ?? 0,
  };
}

const feedbackItem = (row) => ({ surface: 'announcements', itemKey: row.id, eventKey: row.event?.id || null, features: row.keys || [],
  label: cleanFilingText(row.title).slice(0, 300), company: row.company || row.ticker || null, categories: row.categories || [] });

const mcapCell = (r) => {
  const text = formatMarketCap(r.mcapCr);
  if (!text) return dash('No market cap is known for this company. Its filings stay visible; the range filter lists it under "Not available".');
  const title = `Market cap ${text}${r.mcapAsOf ? ` as of ${String(r.mcapAsOf).slice(0, 10)}` : ''}${r.mcapSource ? ` · ${r.mcapSource}` : ''}`;
  return `<span class="tabular-nums text-slate-700" title="${escapeHtml(title)}">${escapeHtml(text.replace(/^₹/, '₹ '))}</span>`;
};

// "N related filings": an expandable list right under the subject, read on demand (data-norow keeps
// it from opening the AI Read popup).
const relatedHtml = (r) => {
  if (!r.event || r.event.size < 2) return '';
  const others = r.event.size - 1;
  return `<details class="ca-related" data-norow data-ca-related="${escapeHtml(r.event.id)}" data-first="${escapeHtml(r.event.first || '')}" data-last="${escapeHtml(r.event.last || '')}" data-row="${escapeHtml(r.id)}">
    <summary>${others} related ${others === 1 ? 'filing' : 'filings'}</summary><div data-ca-related-list class="ca-related-list" aria-live="polite"></div></details>`;
};

function relatedListHtml(event, rowId) {
  const members = (event?.members || []).filter((m) => m.id !== rowId);
  if (!members.length) return '<p class="ca-related-empty">No other filing is linked to this one.</p>';
  return `<ol>${members.map((m) => {
    const link = m.url || m.referenceUrl;
    return `<li><span class="ca-related-date">${escapeHtml(m.date ? formatDate(m.date) : '—')}${m.time ? ` ${escapeHtml(String(m.time).slice(0, 5))}` : ''}</span>
      ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cleanFilingText(m.title) || '(no subject)')} ↗</a>` : `<span>${escapeHtml(cleanFilingText(m.title) || '(no subject)')}</span>`}
      <small>${escapeHtml([(m.sources || []).join(' / '), m.subCategory].filter(Boolean).join(' · '))}</small></li>`;
  }).join('')}</ol>${event?.local ? '<p class="ca-related-empty">Linked within the selected period on this copy.</p>' : ''}`;
}

// ---- toolbar: categories (multi-select) and market-cap range -----------------------------------

let popover = null;
let popoverDispose = null;
function closePopover() { popoverDispose?.(); popoverDispose = null; popover?.remove(); popover = null; }

function categoryPanel(facets) {
  const counts = facets?.categories || {};
  const chosen = new Set(filters.categories);
  return `<div class="ca-popover-head"><strong>Categories</strong><span>Tick any number. A filing appears when it carries any ticked category.</span></div>
    <div class="ca-popover-body">${CATEGORY_GROUPS.map((g) => {
      const list = ANNOUNCEMENT_CATEGORIES.filter((c) => c.group === g.id);
      if (!list.length) return '';
      return `<fieldset><legend>${escapeHtml(g.label)}</legend>${list.map((c) => `<label title="${escapeHtml(c.hint || '')}">
        <input type="checkbox" value="${escapeHtml(c.id)}" ${chosen.has(c.id) ? 'checked' : ''}>
        <span>${escapeHtml(c.label)}</span><small>${counts[c.id] == null ? '' : escapeHtml(formatNumber(counts[c.id]))}</small></label>`).join('')}</fieldset>`;
    }).join('')}</div>
    <div class="ca-popover-foot"><button type="button" data-ca-clear>Clear</button><button type="button" data-ca-apply class="is-primary">Apply</button></div>`;
}

function mcapPanel(facets) {
  const counts = facets?.bands || {};
  const range = parseMcapRange(filters.mcap);
  const option = (value, label, count) => `<label><input type="radio" name="ca-mcap" value="${escapeHtml(value)}" ${filters.mcap === value ? 'checked' : ''}>
    <span>${escapeHtml(label)}</span><small>${count == null ? '' : escapeHtml(formatNumber(count))}</small></label>`;
  return `<div class="ca-popover-head"><strong>Market cap</strong><span>Latest captured market cap. Filings with none known stay listed under “Not available”.</span></div>
    <div class="ca-popover-body">
      ${option('all', 'All market caps', null)}
      ${MCAP_BANDS.map((b) => option(b.id, `${b.short} · ${b.label}`, counts[b.id])).join('')}
      ${option(MCAP_UNKNOWN, 'Not available', counts[MCAP_UNKNOWN])}
      <fieldset class="ca-mcap-custom"><legend>Custom range (₹ crore)</legend>
        <input type="number" min="0" step="any" inputmode="decimal" data-ca-min placeholder="From" aria-label="Minimum market cap in crore" value="${range.custom && range.min ? escapeHtml(range.min) : ''}">
        <span>to</span>
        <input type="number" min="0" step="any" inputmode="decimal" data-ca-max placeholder="To" aria-label="Maximum market cap in crore" value="${range.custom && Number.isFinite(range.max) ? escapeHtml(range.max) : ''}">
      </fieldset>
      <p data-ca-error class="ca-popover-error" role="alert" hidden></p>
    </div>
    <div class="ca-popover-foot"><button type="button" data-ca-clear>Clear</button><button type="button" data-ca-apply class="is-primary">Apply</button></div>`;
}

function openPopover(button, kind) {
  closePopover();
  const facets = query.meta().facets;
  popover = document.createElement('div');
  popover.className = 'ca-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', kind === 'categories' ? 'Filter by category' : 'Filter by market cap');
  popover.innerHTML = kind === 'categories' ? categoryPanel(facets) : mcapPanel(facets);
  document.body.append(popover);
  const r = button.getBoundingClientRect();
  const width = Math.min(kind === 'categories' ? 560 : 360, innerWidth - 16);
  popover.style.width = `${width}px`;
  popover.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
  popover.style.top = `${Math.min(r.bottom + 6, Math.max(8, innerHeight - 120))}px`;
  popover.style.maxHeight = `${Math.max(220, innerHeight - r.bottom - 20)}px`;
  button.setAttribute('aria-expanded', 'true');
  popover.querySelector('input')?.focus();
  const apply = () => {
    if (kind === 'categories') {
      filters.categories = [...popover.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
    } else {
      const min = popover.querySelector('[data-ca-min]').value.trim(), max = popover.querySelector('[data-ca-max]').value.trim();
      if (min || max) {
        const value = `${min}-${max}`;
        if (parseMcapRange(value).kind !== 'range') {
          const error = popover.querySelector('[data-ca-error]');
          error.hidden = false;
          error.textContent = 'Enter a range whose lower bound is not above its upper bound.';
          return;
        }
        filters.mcap = value;
      } else filters.mcap = popover.querySelector('input[name="ca-mcap"]:checked')?.value || 'all';
    }
    saveFilters();
    closePopover();
    requery();
  };
  const onClick = (event) => {
    if (event.target.closest('[data-ca-apply]')) apply();
    else if (event.target.closest('[data-ca-clear]')) {
      if (kind === 'categories') filters.categories = []; else filters.mcap = 'all';
      saveFilters(); closePopover(); requery();
    }
  };
  // A typed range and a picked band are alternatives: using one clears the other.
  const onInput = (event) => {
    if (kind !== 'mcap') return;
    if (event.target.matches('[data-ca-min], [data-ca-max]')) popover.querySelectorAll('input[name="ca-mcap"]').forEach((i) => { i.checked = false; });
    if (event.target.matches('input[name="ca-mcap"]')) popover.querySelectorAll('[data-ca-min], [data-ca-max]').forEach((i) => { i.value = ''; });
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { closePopover(); button.focus(); }
    if (event.key === 'Enter' && event.target.matches('input')) { event.preventDefault(); apply(); }
  };
  const onDown = (event) => { if (popover && !popover.contains(event.target) && !button.contains(event.target)) closePopover(); };
  popover.addEventListener('click', onClick);
  popover.addEventListener('input', onInput);
  popover.addEventListener('change', onInput);
  popover.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  popoverDispose = () => {
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDown, true);
  };
}

function toolbarControls() {
  const categoryText = filters.categories.length === 0 ? 'All' : filters.categories.length === 1 ? categoryLabel(filters.categories[0]) : `${filters.categories.length} selected`;
  const mcapText = filters.mcap === 'all' ? 'All' : mcapRangeLabel(filters.mcap);
  return {
    html: `<button type="button" class="ca-filter-button${filters.categories.length ? ' is-active' : ''}" data-ca-open="categories" aria-haspopup="dialog" aria-expanded="false"
        title="${escapeHtml(filters.categories.length ? `Categories: ${filters.categories.map(categoryLabel).join(', ')}` : 'Filter by category')}">
        Category: <strong>${escapeHtml(categoryText)}</strong> ▾</button>
      <button type="button" class="ca-filter-button${filters.mcap !== 'all' ? ' is-active' : ''}" data-ca-open="mcap" aria-haspopup="dialog" aria-expanded="false" title="Filter by market cap">
        Market cap: <strong>${escapeHtml(mcapText)}</strong> ▾</button>`,
    wire(host) {
      const onClick = (event) => {
        const button = event.target.closest('[data-ca-open]');
        if (!button || !host.contains(button)) return;
        if (popover && button.getAttribute('aria-expanded') === 'true') { closePopover(); return; }
        openPopover(button, button.dataset.caOpen);
      };
      host.addEventListener('click', onClick);
      return () => { host.removeEventListener('click', onClick); closePopover(); };
    },
  };
}

// ---- the table under the rows: load more, and how the list is ordered -------------------------

function belowTable() {
  const qm = query.meta();
  const loaded = qm.loaded, total = qm.total;
  const progress = qm.progress;
  const preparing = qm.mode === 'local' && progress && qm.state === 'loading'
    ? `<p class="ca-progress" role="status">Preparing ${escapeHtml(formatNumber(progress.total))} announcements in this browser… ${Math.round((progress.share || 0) * 100)}%</p>` : '';
  if (total == null) return preparing;
  return `${preparing}<div class="ca-more" data-ca-more>
    <p>${escapeHtml(formatNumber(loaded))} of ${escapeHtml(formatNumber(total))} shown · newest day first, the most relevant filings first within each day.
      ${qm.state === 'more' ? ' Loading more…' : ''}</p>
    ${qm.nextOffset !== null ? `<button type="button" data-ca-load-more ${qm.state === 'more' ? 'disabled' : ''}>Load ${escapeHtml(formatNumber(Math.min(query.pageSize, total - loaded)))} more</button>` : ''}
  </div>`;
}

function wireBelowTable(root) {
  const disposers = [];
  const more = root.querySelector('[data-ca-load-more]');
  const onMore = () => { void query.loadMore(); };
  more?.addEventListener('click', onMore);
  disposers.push(() => more?.removeEventListener('click', onMore));
  // Scrolling to the end of the loaded rows asks for the next page; the button stays for keyboards.
  const scroller = root.querySelector('[data-table-scroll]');
  const onScroll = () => {
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 400) void query.loadMore();
  };
  scroller?.addEventListener('scroll', onScroll, { passive: true });
  disposers.push(() => scroller?.removeEventListener('scroll', onScroll));
  // Related filings: read the event the first time its list is opened.
  const onToggle = (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.matches('[data-ca-related]') || !details.open) return;
    const list = details.querySelector('[data-ca-related-list]');
    if (list.dataset.loaded) return;
    list.dataset.loaded = '1';
    list.innerHTML = '<p class="ca-related-empty">Loading the related filings…</p>';
    query.event(details.dataset.caRelated, { first: details.dataset.first, last: details.dataset.last })
      .then((event) => { list.innerHTML = relatedListHtml(event, details.dataset.row); })
      .catch(() => { delete list.dataset.loaded; list.innerHTML = '<p class="ca-related-empty">The related filings could not be read just now. Close and open to try again.</p>'; });
  };
  root.addEventListener('toggle', onToggle, true);
  disposers.push(() => root.removeEventListener('toggle', onToggle, true));
  return () => disposers.forEach((d) => d());
}

// ---- the search: the same company picker, answered by the index ------------------------------

function searchControl({ ctx, rows, view }) {
  const inner = announcementSearch({
    companies: [...coverage.holdings(), ...watchlist.all(), ...rows],
    companyKey: identityFeed.companyKey,
    resolveCompany: identityFeed.companyIdentity,
    allowsCompany: (company) => ctx.scope === 'universe' || identityFeed.filterByScope([company], ctx.scope, coverage.holdings()).length > 0,
    scopeLabel: scopeLabel(ctx.scope),
    searchable: () => '',
    q: asked.q,
    state: asked.state || view?.searchState,
  });
  asked.state = inner.state;
  return {
    html: inner.html,
    state: inner.state,
    // The index already answered the search; the loaded rows all match it.
    matches: () => true,
    wire(host, handlers) {
      return inner.wire(host, {
        ...handlers,
        onQuery(q) {
          handlers.onQuery(q);
          asked.q = q;
          clearTimeout(searchTimer);
          searchTimer = setTimeout(requery, 350);
        },
      });
    },
  };
}

const tab = makeFilingsTab({
  id: 'corp-announcements',
  title: 'Corp Announcements',
  subtitle: 'Company announcements from BSE, NSE and captured filings — newest day first, the most relevant first within each day.',
  feed,
  filterByScope: (list) => list,
  keyFor: (r) => r.id,
  countLabel: () => {
    const qm = query.meta();
    if (qm.total == null) return qm.state === 'loading' ? 'Loading…' : '';
    const companies = qm.companies;
    return `${formatNumber(qm.total)} ${qm.total === 1 ? 'announcement' : 'announcements'}${companies != null ? ` · ${formatNumber(companies)} ${companies === 1 ? 'company' : 'companies'} with filings` : ''}`;
  },
  showWatchFilter: false,
  fillMode: 'auto',
  preserveReadingPosition: true,
  initialSort: null,
  allowSort: false,
  loading: () => query.meta().state === 'loading',
  searchControl,
  prepareView(ctx, view) {
    currentCtx = ctx;
    adopt(view);
    query.setQuery(questionFor(ctx));
    void loadModel();
    return view;
  },
  prepareReading(view) {
    adopt(view);
    return query.setQuery(questionFor(currentCtx));
  },
  renderRevision: () => {
    const qm = query.meta();
    // The exchange identity directory's revision repaints the company picker with its newer names.
    return `${newsDay()}:${qm.state}:${qm.total}:${qm.mode}:${qm.index?.meta?.identity?.revision || 0}:${filters.categories.join(',')}:${filters.mcap}:${Math.round((qm.progress?.share || 0) * 25)}`;
  },
  filters: () => [{ label: 'Announcement period (IST)', value: DEFAULT_PERIOD, options: TAB_PERIODS, match: () => true }],
  toolbarControls,
  belowTable,
  wireBelowTable,
  status: (m) => {
    const status = announcementCoverage(m);
    const qm = m.query || {};
    const extra = [
      qm.mode === 'local' ? 'Prepared in this browser from the captures: the server index could not be read.' : null,
      qm.index?.stale ? `The latest index check failed (${qm.index.error}); the last good build is shown.` : null,
    ].filter(Boolean).join(' ');
    const asked = query.query();
    return `<span data-filings-info data-ca-mode="${escapeHtml(qm.mode || 'unknown')}" data-ca-state="${escapeHtml(qm.state || '')}" data-ca-q="${escapeHtml(asked.q || '')}" data-ca-period="${escapeHtml(asked.period)}" class="text-xs font-semibold ${status.incomplete ? 'text-amber-700' : 'text-slate-500'}" title="${escapeHtml(`${status.detail}${extra ? ` ${extra}` : ''}`)}">${escapeHtml(status.label)}</span>`;
  },
  emptyMessage: () => (query.meta().state === 'loading' ? 'Loading announcements…' : 'No announcements match this scope, period, category, market cap or search.'),
  stickyHead: 'max(320px, calc(100vh - 260px))',
  noun: 'announcements',
  nameLabel: 'Subject',
  nameMaxPx: 560,
  // The subject is the exchange's own words, exactly as filed.
  rowName: (r) => cleanFilingText(r.title || r.headline) || '(no subject)',
  // The company name leads, because a date-indexed feed covers companies this dashboard has no
  // ticker for and a bare scrip code identifies nothing to a reader.
  rowSub: (r) => [r.company, r.ticker, r.category && r.category !== r.subCategory ? r.category : null, r.subCategory, r.documentUnavailable ? 'Source supplied no document link' : null].filter(Boolean).join(' · '),
  afterSub: relatedHtml,
  link: (r) => r.url || r.referenceUrl || null,
  onRowClick: (row) => openAnnouncementRead(row, { loadEvent: (event) => query.event(event.id, event), item: feedbackItem(row) }),
  searchable: () => '',
  columns: () => [
    {
      label: 'Date',
      get: (r) => (r.date
        ? `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(formatDate(r.date))}${r.time ? `<span class="ml-1 text-[10px] text-slate-400">${escapeHtml(String(r.time).slice(0, 5))}</span>` : ''}</span>`
        : dash('the filing carried no readable date')),
      html: true,
      sortable: false,
    },
    { label: 'Categories', get: (r) => categoryChips(r.categories || [], { weak: r.weakCategories || [], max: 2, empty: dash('No category matched') }), html: true, sortable: false },
    { label: 'Market cap', get: mcapCell, html: true, align: 'right', sortable: false },
    { label: 'Source', get: (r) => announcementSources(r).join(' / ') || 'Not specified', sortable: false },
  ],
  provenance: (m) => {
    const qm = m.query || {};
    const index = qm.index || {};
    const built = index.builtAt ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(index.builtAt)) + ' IST' : 'unavailable';
    return `<div class="px-7 py-6">
    <div class="mb-3 flex items-start justify-between gap-4">
      <h2 class="font-display text-xl font-bold text-slate-900">Corporate announcements</h2>
      <button data-modal-close class="text-2xl text-slate-400">&times;</button>
    </div>
    <div class="space-y-3 text-sm leading-relaxed text-slate-600">
      <p><strong>How this list is served:</strong> ${qm.mode === 'server'
        ? `the server index (built ${escapeHtml(built)} from the committed captures, with NSE's live feed read again every two minutes) answers one ranked page at a time.`
        : 'the server index could not be read, so this browser prepared the list from the captures, as the tab always could. Related filings are linked within the selected period only on this copy.'}</p>
      <p><strong>Order:</strong> newest day first. Within a day, filings are ordered by relevance to an investor — what the filing is about
        (results, orders, deals, capital raises, governance, legal and regulatory action…), the company's size, the size of any amount it states
        against the company's market cap, whether the desk's sector KPI ontology says this kind of event moves this sector, and the direction
        of governance or credit events — plus the desk's shared Important / Not important votes. Routine notices sink within their day.
        No filing is hidden by its rank, and no rank label is printed.</p>
      <p><strong>Categories</strong> come from one editable master list read from the exchange's own label, the subject and NSE's
        description. A filing can carry several. A tag says what a filing is about, never whether it is good or bad.</p>
      <p><strong>Related filings</strong> are other filings by the same company about the same underlying event — the board intimation,
        the outcome, the results, the presentation, the call; or an approval, an allotment and a listing — joined by category family,
        time and shared words. Every filing stays its own row.</p>
      <p><strong>Market cap</strong> is the latest captured figure (Screener's, or Moneycontrol's shares × last price), with its date in the
        cell's tooltip. A company with no known figure shows “—” and is never treated as small or zero.</p>
      <p><strong>AI Read</strong> opens only when you click a filing: it reads that one document in full and keeps the reading so the next
        reader pays nothing. The list never shows a generated headline or summary; subjects are the exchange's own.</p>
      <p><strong>BSE:</strong> exchange-wide announcements are captured every two hours, with retained monthly history.
        Latest capture: ${escapeHtml(m.capturedAt || 'unavailable')}.</p>
      <p><strong>Backup announcements:</strong> Screener’s All announcements index is checked every two hours, across companies.
        Original exchange documents join this table; generated summaries are not imported.
        Last page checked: ${escapeHtml(m.recovery?.lastPageAt || 'unavailable')}. ${escapeHtml(m.recovery?.error || '')}
        ${m.recovery?.pendingCount ? `${escapeHtml(m.recovery.pendingCount)} date interval(s) still being recovered.` : ''}
        Saved coverage starts ${escapeHtml(m.recovery?.captureStart || 'when the first capture completes')}.
        This backup does not certify complete exchange coverage.</p>
      <p><strong>NSE:</strong> the live exchange feed and up to 90 days of retained captures join this table.
        Latest NSE read: ${escapeHtml(m.nse?.capturedAt || 'unavailable')}. ${escapeHtml(m.nse?.error || m.nse?.degraded || '')}</p>
      <p><strong>Company history:</strong> scheduled direct BSE company captures, Muns BSE/NSE/DRHP captures and earlier saved lookups
        join the same stream. One source failing does not erase rows or advance the other source's coverage.</p>
      <p>Time filters use source publication dates in IST. All time includes every retained filing, including undated records.
        Filtering never deletes history. BSE and NSE rows merge only when the captured documents match; separate or unreadable documents
        remain separate rows. Every retained exchange document link is included in the export.</p>
      <p>Portfolio matching uses exchange ISINs and BSE scrip codes as well as ticker aliases.
        Exchange identities checked: ${escapeHtml(m.identity?.capturedAt || 'unavailable')}. ${escapeHtml(m.identity?.error || '')}</p>
      ${m.archive?.error ? `<p>${escapeHtml(m.archive.error)}</p>` : ''}
      ${captureCoverageHtml('announcements')}
      ${qm.mode === 'local' ? coverageBlock({ ...m, rowCount: qm.total ?? 0, covered: qm.companies ?? 0 }) : ''}
    </div>
  </div>`;
  },
  onExport: async (_visible, m) => {
    const { rows, total } = await query.all();
    const truncated = total > rows.length;
    await exportRows({
      filename: 'sattva-corp-announcements',
      sheetName: 'Announcements',
      columns: [
        {
          header: 'Date',
          key: 'd',
          width: 14,
          get: (r) =>
            r.__banner
              ? `SOURCE DISCLOSURES. BSE exchange-wide capture ${m.capturedAt || 'at an unknown time'}; live NSE announcements, retained NSE history and company captures are merged. ` +
                `Coverage is limited to successful source reads. Subjects and exchange categories are the sources' own words; Categories are the dashboard's master-list tags. ` +
                `Rows are ordered newest day first and by the dashboard's relevance reading within each day. No document contents are summarized in this sheet. ` +
                `${truncated ? `This sheet holds the first ${rows.length} of ${total} matching announcements in that order — narrow the period to export the rest. ` : ''}Exported ${new Date().toISOString()}.`
              : r.date || '',
        },
        { header: 'Time', key: 'tm', width: 10, get: (r) => (r.__banner ? '' : r.time || '') },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'BSE scrip code', key: 'sc', width: 14, get: (r) => (r.__banner ? '' : r.scripCode || '') },
        { header: 'Company (as filed)', key: 'co', width: 38, get: (r) => (r.__banner ? '' : r.company || '') },
        { header: 'Subject (as filed)', key: 'h', width: 70, get: (r) => (r.__banner ? '' : cleanFilingText(r.title || r.headline)) },
        { header: 'Categories (dashboard)', key: 'cat', width: 40, get: (r) => (r.__banner ? '' : (r.categories || []).map(categoryLabel).join('; ')) },
        { header: 'Market cap (₹ Cr)', key: 'mc', width: 16, get: (r) => (r.__banner ? '' : Number.isFinite(r.mcapCr) ? Math.round(r.mcapCr) : '') },
        { header: 'Market cap as of', key: 'mca', width: 14, get: (r) => (r.__banner ? '' : r.mcapAsOf ? String(r.mcapAsOf).slice(0, 10) : '') },
        { header: 'Related filings (same event)', key: 'rel', width: 14, get: (r) => (r.__banner ? '' : r.event?.size > 1 ? r.event.size - 1 : 0) },
        { header: 'Category (as filed)', key: 'c', width: 22, get: (r) => (r.__banner ? '' : r.category || '') },
        { header: 'Sub-category (as filed)', key: 'sb', width: 30, get: (r) => (r.__banner ? '' : r.subCategory || '') },
        { header: 'Source', key: 'src', width: 20, get: (r) => (r.__banner ? '' : announcementSources(r).join(' / ')) },
        { header: 'Retrieved through', key: 'via', width: 35, get: (r) => (r.__banner ? '' : (r.providers || []).join(' / ')) },
        { header: 'Document URL', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.url || '') },
        { header: 'Source reference page (no document)', key: 'ref', width: 60, get: (r) => (r.__banner ? '' : r.referenceUrl || '') },
        { header: 'All source document URLs', key: 'su', width: 80, get: (r) => (r.__banner ? '' : announcementSourceUrls(r).map(({ source, url }) => `${source}: ${url}`).join('\n')) },
      ],
      rows: [{ __banner: true }, ...rows],
    });
  },
});

export const meta = tab.meta;
/** The paged query behind the table — for diagnostics and the browser checks. */
export const announcementQuery = query;
let liveRef = null;
export function render(ctx) {
  currentCtx = ctx;
  tab.render(ctx);
  if (ctx.live && !liveRef) {
    liveRef = ctx.live;
    // Every 90 seconds while visible: the index object re-reads NSE's live feed itself, so a re-ask
    // brings new filings; the local engine re-reads the captures first.
    liveRef.register(POLL_ID, {
      intervalMs: POLL_MS,
      fetcher: async () => {
        if (query.mode() === 'local') await localEngine.refresh().catch(() => {});
        await query.refresh();
        return Date.now();
      },
    });
    liveRef.start(POLL_ID, { fresh: true });
  }
}
export function destroy() {
  clearTimeout(searchTimer);
  closePopover();
  if (liveRef) liveRef.stop(POLL_ID);
  liveRef = null;
  currentCtx = null;
  tab.destroy();
}
