// ui/screener.js — the screener kit. Five components every tab is assembled from.
//
//   statStrip(cards)      4-up KPI row; card 4 is always the gradient freshness hero
//   topCards(config)      the Top-N hero grid, click-through to the drill panel
//   scoreTable(config)    the workhorse table: search, filter, watchlist, sort, export
//   openDrill(config)     right-slide detail panel (singleton overlay in index.html)
//   openModal(html, opts) centred modal (singleton overlay in index.html)
//
// Every component returns `{ html, wire(root) }` unless noted. `wire()` returns a disposer
// when it registers anything global (document listeners), which the owning tab must call from
// destroy(). The two overlays are singletons — no tab mounts its own copy.
//
// Nothing here knows about any specific tab. Callers supply columns, accessors and formatters;
// the kit supplies the look. Score and Signals columns are opt-in, so tabs without a scoring
// model (all of them until prompt 3) render a clean table with no empty score furniture.

import { escapeHtml } from '../core/dom.js';
import * as store from '../core/watchlist.js';
import { avatarFor, scoreTier, scoreBadgeClass, tierLabel, tierColor, statusPill, signalDots } from './visual.js';

// ---------------------------------------------------------------------------------------
// Overlay focus management — shared by the drill, the modal and the workspace.
//
// Without this a keyboard user opening a drill panel is left with focus still on the table row
// behind it: Tab walks the page underneath, screen readers announce the page they cannot see,
// and closing the panel drops focus to <body> so the next Tab starts from the top of the
// document. All three overlays are visually modal, so they have to be modal to the keyboard too.
//
//   trapFocus(el)    -> disposer. Marks the element as a dialog, moves focus into it, keeps Tab
//                       inside it, and returns focus where it came from on dispose.
// ---------------------------------------------------------------------------------------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(el, { label } = {}) {
  if (!el) return () => {};
  const previous = document.activeElement;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  if (label) el.setAttribute('aria-label', label);
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');

  // Focus the first real control if there is one, else the container. Focusing the container
  // rather than nothing is what makes the screen reader announce the dialog at all.
  const first = el.querySelector(FOCUSABLE);
  (first || el).focus({ preventScroll: true });

  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) {
      e.preventDefault();
      el.focus({ preventScroll: true });
      return;
    }
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === firstItem || document.activeElement === el)) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  };
  el.addEventListener('keydown', onKey);

  return () => {
    el.removeEventListener('keydown', onKey);
    el.removeAttribute('aria-modal');
    // Restore focus only if it is still inside the overlay — if the user has already clicked
    // elsewhere, yanking it back would be the more surprising behaviour.
    const wasInside = el.contains(document.activeElement);
    if (!wasInside && document.activeElement !== document.body) return;
    if (previous?.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    // The opener is often a table row, which is not focusable, so the focus() above is a no-op
    // and focus would stay parked inside a panel the user can no longer see. Blur out of it so
    // the next Tab restarts from the document rather than from an invisible dialog.
    if (el.contains(document.activeElement)) document.activeElement.blur();
  };
}

// ---------------------------------------------------------------------------------------
// Watchlist — ONE SHARED SET OF COMPANIES across every tab.
//
// The store itself is `js/core/watchlist.js`, because the watchlist is no longer a property of
// this table: it is a scope. `?scope=watchlist` narrows every feed in the dashboard to it, so it
// has to be readable by `js/data/scope.js`, and a data module reaching into the UI layer for it
// would be backwards.
//
// WHAT CHANGED IN HERE IS THE KEY. `key(row)` identifies a ROW and is whatever the tab needs it to
// be — Moneycontrol's scID, `company|time|document`, a composite of the cells. `watchKey(row)`
// identifies the COMPANY, and defaults to `key(row)` because on a screener the two are the same
// ticker. Where they differ, three announcements from one company are three rows and one watched
// company, and starring any of them fills the star on all three.
// ---------------------------------------------------------------------------------------

/** The tracked companies as a Set of upper-case symbols — what every star and filter compares to. */
const loadWatchlist = () => store.tickers();

// Re-exported so the tabs and the verification suite keep one import path for this. The store is
// the authority; this is a name, not a second copy.
export const watchlist = store;

// ---------------------------------------------------------------------------------------
// (b) statStrip — the 4-up KPI row that opens every tab.
// ---------------------------------------------------------------------------------------

/**
 * statStrip(cards)
 * `cards` is up to 4 entries. Cards 1–3 are white surfaces:
 *   { label, value, note?, help?: { title, body } }
 * Card 4 is ALWAYS the gradient freshness hero, declared as:
 *   { hero: true, label: 'Last Refresh', value: '5h ago', note: 'Yahoo Finance EOD' }
 * If the caller omits a hero card the strip renders 3 cards and leaves the slot empty rather
 * than inventing a freshness claim.
 *
 * A card's optional `help` adds a small ? button that opens a modal explaining that metric.
 */
export function statStrip(cards = []) {
  const helpRegistry = [];

  // The grid is as wide as the strip, not always four. A three-card strip in a four-column grid
  // leaves a quarter of the row empty and reads as a card that failed to render.
  const cols = cards.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-4';

  const html = `
    <section class="mb-6 grid grid-cols-2 gap-3 ${cols}">
      ${cards
        .map((card, i) => {
          if (card.hero) {
            return `
              <div class="stat-card rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-4 text-white shadow-lg">
                <div class="text-xs font-medium uppercase tracking-wider opacity-90">${escapeHtml(card.label)}</div>
                <div class="mt-1 text-2xl font-bold">${escapeHtml(card.value)}</div>
                ${card.note ? `<div class="mt-0.5 text-xs opacity-90">${escapeHtml(card.note)}</div>` : ''}
              </div>`;
          }
          if (card.help) helpRegistry.push({ index: i, ...card.help });
          return `
            <div class="stat-card relative rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
              <div class="flex items-start justify-between gap-2">
                <div class="text-xs font-medium uppercase tracking-wider text-slate-500">${escapeHtml(card.label)}</div>
                ${
                  card.help
                    ? `<button type="button" data-stat-help="${i}" title="How this is measured"
                         class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-indigo-50 text-[11px] font-bold text-indigo-600 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-100 hover:text-indigo-700 hover:ring-indigo-300">?</button>`
                    : ''
                }
              </div>
              <div class="mt-1 text-2xl font-bold text-slate-900">${escapeHtml(card.value)}</div>
              ${card.note ? `<div class="mt-0.5 text-xs text-slate-500">${escapeHtml(card.note)}</div>` : ''}
            </div>`;
        })
        .join('')}
    </section>`;

  function wire(root) {
    root.querySelectorAll('[data-stat-help]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = helpRegistry.find((h) => String(h.index) === btn.dataset.statHelp);
        if (!entry) return;
        openModal(
          `<div class="px-7 py-6">
            <div class="mb-3 flex items-start justify-between gap-4">
              <h2 class="font-display text-xl font-bold text-slate-900">${escapeHtml(entry.title)}</h2>
              <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">×</button>
            </div>
            <div class="text-sm leading-relaxed text-slate-600">${entry.body}</div>
          </div>`,
          { size: 'default' }
        );
      });
    });
    return () => {};
  }

  return { html, wire };
}

// ---------------------------------------------------------------------------------------
// (c) topCards — the Top-N hero grid.
// ---------------------------------------------------------------------------------------

/**
 * topCards({ title, items, valueFormat, onSelect, limit })
 *
 *  title        e.g. "Top 10 by Earnings Surprise" (a 🏆 is prepended)
 *  items        [{ name, sub?, value, max?, tone?, warn?, payload? }]
 *  valueFormat  'score'  → renders `value/max` and colours by tier (needs `max`)
 *               'metric' → renders `value` verbatim, coloured by `tone`
 *  tone         for 'metric': 'positive' | 'negative' | 'caution' | 'neutral' | 'brand'
 *  onSelect     (item, index) => void — fired on card click, wire up the drill panel here
 *  limit        default 10
 */
const METRIC_TONE = {
  positive: 'text-emerald-600',
  negative: 'text-rose-600',
  caution: 'text-amber-600',
  brand: 'text-indigo-600',
  neutral: 'text-slate-700',
};

export function topCards({ title, items = [], valueFormat = 'metric', onSelect = null, limit = 10 }) {
  const shown = items.slice(0, limit);

  const html = `
    <section class="mb-8" data-top-cards>
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-display flex items-center gap-2 text-lg font-bold text-slate-900">
          <span class="text-amber-500">🏆</span> ${escapeHtml(title)}
        </h2>
      </div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        ${shown
          .map((item, i) => {
            const { color, initials } = avatarFor(item.name);
            const isScore = valueFormat === 'score';
            const tier = item.warn ? 'hardfail' : isScore ? scoreTier(item.max ? (item.value / item.max) * 100 : 0) : null;
            const valueClass = isScore ? tierColor(tier) : METRIC_TONE[item.tone] || METRIC_TONE.neutral;
            const valueHtml = isScore
              ? `${escapeHtml(item.value)}<span class="text-base text-slate-400">/${escapeHtml(item.max)}</span>`
              : escapeHtml(item.value);
            const caption = isScore ? tierLabel(tier) : item.caption || '';
            return `
              <button type="button" data-top-idx="${i}"
                class="group relative overflow-hidden rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-100 transition-all duration-200 hover:-translate-y-1 hover:shadow-xl">
                <div class="absolute right-3 top-3 text-xs font-bold text-slate-400">#${i + 1}</div>
                <div class="mb-3 flex items-center gap-3">
                  <div class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-sm font-bold text-white shadow-md">${escapeHtml(initials)}</div>
                  <div class="min-w-0 flex-1 pr-6">
                    <div class="truncate text-sm font-semibold text-slate-900">${escapeHtml(item.name)}</div>
                    ${item.sub ? `<div class="truncate text-xs text-slate-500">${escapeHtml(item.sub)}</div>` : ''}
                  </div>
                </div>
                <div class="flex items-end justify-between">
                  <div class="min-w-0">
                    <div class="truncate text-3xl font-bold tabular-nums ${valueClass}">${valueHtml}</div>
                    ${caption ? `<div class="mt-0.5 truncate text-xs text-slate-500">${escapeHtml(caption)}</div>` : ''}
                  </div>
                  ${item.warn ? `<div class="flex-shrink-0 text-xl text-rose-500" title="${escapeHtml(item.warn)}">⚠</div>` : ''}
                </div>
              </button>`;
          })
          .join('')}
      </div>
    </section>`;

  function wire(root) {
    const host = root.querySelector('[data-top-cards]');
    if (!host || !onSelect) return () => {};
    host.querySelectorAll('[data-top-idx]').forEach((el) => {
      el.addEventListener('click', () => onSelect(shown[Number(el.dataset.topIdx)], Number(el.dataset.topIdx)));
    });
    return () => {};
  }

  return { html, wire };
}

// ---------------------------------------------------------------------------------------
// (d) scoreTable — the workhorse.
// ---------------------------------------------------------------------------------------

/**
 * scoreTable(config)
 *
 *  rows          array of row objects (already scoped/filtered by the tab)
 *  key           (row) => stable string id, used for the watchlist. Defaults to row.ticker.
 *  name          (row) => company display name (drives the avatar)
 *  sub           (row) => the small grey line under the name (market cap, sector…)
 *  columns       [{ label, get(row), html?, align?, sortable?, sortValue?(row) }]
 *                `html: true` means get() returns trusted markup — escape inside it yourself.
 *  showScore     default false. When true, supply score(row) => { points, max, pct, redFlag? }
 *  showSignals   default false. When true, supply signals(row) => [{ label, status }]
 *  link          (row) => url for the right-aligned ↗, or null to omit the column
 *  onRowClick    (row) => void
 *  filters       { label, options: [{ value, label }], match(row, value), value? } — the <select>.
 *                Pass an ARRAY of these for several dropdowns; they AND together.
 *  searchable    (row) => haystack string. Defaults to name(row).
 *  initialSort   { key, dir } where key is a column label, 'name', or 'score'
 *  emptyMessage  string shown when nothing matches
 *  exportName    file stem used by the Export button (a stub until prompt 3)
 *  showRank      default true. false drops the leading rank column; the watchlist star moves
 *                inside the identity cell so the first column can be a real column.
 *  nameAfter     default 0. How many of `columns` render before the identity column.
 *  nameMaxPx     default null. Hard px cap on the identity column so long names/subs truncate
 *                instead of widening the table.
 *  dense         default false. true tightens horizontal cell padding for wide numeric tables.
 *
 * Sorting, search, watchlist-only and the filter select are all handled internally; the table
 * re-renders its own tbody without the tab getting involved.
 */
export function scoreTable(config) {
  const {
    rows = [],
    key = (r) => r.ticker,
    // WHICH COMPANY THE STAR MARKS, which is not always which row it sits on.
    //
    // Defaults to `key` because on a screener a row IS a company and the key is already the
    // ticker. A table whose rows are events — a filing, a result, a con-call — must pass the
    // ticker here, or the watchlist fills up with row ids and the Watchlist scope has nothing it
    // can narrow a feed by. A row with no company returns null and gets no star at all, which is
    // right: there is nothing to track.
    watchKey = null,
    // The name recorded alongside the ticker, so the Watchlist scope can print "Reliance
    // Industries" for a company whose feed has not loaded yet rather than echoing the symbol.
    watchName = null,
    name = (r) => r.name,
    nameLabel = 'Company', // header for the identity column — set it when rows aren't companies
    sub = () => '',
    columns = [],
    showScore = false,
    score = null,
    showSignals = false,
    signals = null,
    link = null,
    onRowClick = null,
    filters = null,
    searchable = null,
    initialSort = null,
    emptyMessage = 'No companies match your filters.',
    exportName = 'sattva-export',
    onExport = null, // (visibleRows, exportName) => void — see ui/export.js
    // Drop the leading rank column. The watchlist star does NOT go with it — the watchlist filter
    // needs a per-row control — it moves inside the identity cell, ahead of the avatar. That frees
    // the first column position for a real column instead of a counter.
    showRank = true,
    // How many of `columns` are rendered BEFORE the identity (avatar + name + sub) column.
    // Default 0 keeps identity first, which is right for a screener. A results table reads better
    // led by the date, so the Earnings Hub sets 1.
    nameAfter = 0,
    // Hard cap on the identity column, in px. A `<table>` in auto layout sizes a column to its
    // widest content, and `truncate` alone cannot stop that — the cell just gets wider. Capping
    // the inner block is what actually makes the ellipsis engage. Without it one long sub-line
    // ("Aluminium & Aluminium Products") takes 474px and pushes the numeric columns off-screen.
    nameMaxPx = null,
    // Tighter horizontal padding. For wide numeric tables where the alternative is a horizontal
    // scrollbar, which is worse than slightly closer columns.
    dense = false,
    wrapHeads = false,
    showAvatar = true,
    // Optional per-row tint, e.g. flagging a risk level. Returns Tailwind classes or ''.
    // Kept separate from the built-in red-flag tint, which belongs to the scoring models.
    rowClass = null,
    // Seed the search box, filters, watchlist-only and sort from a previous instance's `view`.
    // A tab that rebuilds its table when live data lands would otherwise throw away whatever the
    // reader had typed, filtered and sorted — every time a company reports.
    initialView = null,
    // A CSS length that makes the table body its own vertical scroller, e.g. 'calc(100vh - 300px)'.
    //
    // The <thead> has always carried `sticky top-0`, and on a long table it scrolled away anyway.
    // Sticky positions against the nearest SCROLLING ancestor, and `overflow-x: auto` on the
    // wrapper makes that wrapper the scroll container in both axes (CSS forces `overflow-y` off
    // `visible` when the other axis is not) — so the head was sticking to a box that never
    // scrolled, while the page scrolled underneath it. Giving the wrapper a height makes it
    // actually scroll, which is what makes the head stay put. The toolbar above stays visible too.
    stickyHead = null,
  } = config;

  // `watchKey` defaults to the row key, which is correct wherever a row is a company. `watchName`
  // defaults to the display name for the same reason.
  const watchKeyOf = (row) => {
    const raw = (watchKey || key)(row);
    return raw === null || raw === undefined || raw === '' ? null : String(raw).toUpperCase();
  };
  const watchNameOf = (row) => String((watchName || name)(row) ?? '') || null;

  // `filters` takes one config or several. Several render as several <select>s and AND together,
  // which is what lets "PAT grew" and "Consolidated only" be asked at the same time — folding both
  // into one dropdown would make them mutually exclusive for no reason.
  const filterDefs = filters ? (Array.isArray(filters) ? filters : [filters]) : [];

  // Internal view state — search text, one value per filter, watchlist-only, sort.
  const view = {
    q: '',
    filters: filterDefs.map((f) => f.value || 'all'),
    watchOnly: false,
    sort: initialSort ? { ...initialSort } : null,
  };
  if (initialView) {
    if (typeof initialView.q === 'string') view.q = initialView.q;
    if (typeof initialView.watchOnly === 'boolean') view.watchOnly = initialView.watchOnly;
    if (initialView.sort) view.sort = { ...initialView.sort };
    // Length-checked: a restored value only applies if the filter set still has that slot, so a
    // tab that changes its filters between paints cannot resurrect a filter that no longer exists.
    if (Array.isArray(initialView.filters)) {
      initialView.filters.forEach((v, i) => {
        if (i < view.filters.length && filterDefs[i].options.some((o) => o.value === v)) view.filters[i] = v;
      });
    }
  }

  const totalCount = rows.length;

  function haystack(row) {
    return (searchable ? searchable(row) : `${name(row)} ${key(row)}`).toLowerCase();
  }

  function sortValueFor(row, sortKey) {
    if (sortKey === 'name') return String(name(row)).toLowerCase();
    if (sortKey === 'score') return score ? score(row).pct : 0;
    const col = columns.find((c) => c.label === sortKey);
    if (!col) return 0;
    if (col.sortValue) return col.sortValue(row);
    const raw = col.get(row);
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
    return Number.isNaN(num) ? String(raw).toLowerCase() : num;
  }

  function visibleRows() {
    const watched = view.watchOnly ? loadWatchlist() : null;
    let out = rows.filter((row) => {
      if (view.q && !haystack(row).includes(view.q)) return false;
      if (watched) {
        const wk = watchKeyOf(row);
        if (!wk || !watched.has(wk)) return false;
      }
      for (let i = 0; i < filterDefs.length; i++) {
        if (view.filters[i] !== 'all' && !filterDefs[i].match(row, view.filters[i])) return false;
      }
      return true;
    });
    if (view.sort) {
      const { key: sk, dir } = view.sort;
      const mul = dir === 'asc' ? 1 : -1;
      out = out.slice().sort((a, b) => {
        const av = sortValueFor(a, sk);
        const bv = sortValueFor(b, sk);
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av > bv ? 1 : -1) * mul;
      });
    }
    return out;
  }

  // ---- markup -------------------------------------------------------------------------

  const colCount = (showRank ? 1 : 0) + 1 + (showScore ? 1 : 0) + (showSignals ? 1 : 0) + columns.length + (link ? 1 : 0);

  const PX = dense ? 'px-2' : 'px-4';
  // Letter-spacing on 13 uppercase headers is ~50px of table width. Worth keeping normally,
  // worth dropping when the alternative is a scrollbar.
  const TRACK = dense ? 'tracking-normal' : 'tracking-wider';
  // Columns rendered before / after the identity column. See `nameAfter`.
  const leadCols = columns.slice(0, nameAfter);
  const restCols = columns.slice(nameAfter);

  function headHtml() {
    const th = (label, sortKey, align = 'left') => {
      const sortable = sortKey !== null;
      const active = view.sort && view.sort.key === sortKey;
      // `wrapHeads` lets a long heading stack instead of forcing its column as wide as the label.
      // On a table with a dozen numeric columns the headings, not the figures, are what overflows.
      return `<th scope="col" class="${wrapHeads ? 'align-bottom' : 'whitespace-nowrap'} ${PX} py-3 text-${align} text-xs font-bold uppercase ${TRACK} text-slate-600 ${sortable ? 'cursor-pointer select-none hover:text-indigo-600' : ''}"
        ${sortable ? `data-sort="${escapeHtml(sortKey)}"` : ''}>${escapeHtml(label)}${active ? (view.sort.dir === 'asc' ? ' ▴' : ' ▾') : ''}</th>`;
    };
    const dataTh = (c) => th(c.label, c.sortable === false ? null : c.label, c.align === 'right' ? 'right' : 'left');
    return `
      <tr>
        ${showRank ? `<th scope="col" class="w-12 ${PX} py-3 text-left text-xs font-bold uppercase ${TRACK} text-slate-600">#</th>` : ''}
        ${leadCols.map(dataTh).join('')}
        ${th(nameLabel, 'name')}
        ${showScore ? th('Score', 'score') : ''}
        ${showSignals ? `<th scope="col" class="${PX} py-3 text-left text-xs font-bold uppercase ${TRACK} text-slate-600">Signals</th>` : ''}
        ${restCols.map(dataTh).join('')}
        ${link ? `<th scope="col" class="${PX} py-3 text-right text-xs font-bold uppercase ${TRACK} text-slate-600">Link</th>` : ''}
      </tr>`;
  }

  // Per-row markup is CACHED by row key. Rows are position-independent — the rank number is
  // drawn by a CSS counter and the click target carries the row's key, not its index — so a
  // sort is just "reorder cached strings and re-join", not "rebuild 535 rows".
  const rowHtmlCache = new Map();

  // Keys whose cached markup no longer describes the row — today only the watchlist star.
  // Invalidating the cache alone is NOT enough: the repaint fast path moves existing <tr>
  // nodes and never re-parses HTML, so a starred row kept its hollow ☆ until some unrelated
  // change forced a full rebuild. A stale key has to be replaced in the DOM explicitly.
  const staleKeys = new Set();

  // A slice of the body, so the first paint can put a screenful in the DOM and let the rest
  // follow. See FIRST_PAINT_ROWS below for why that is not merely a nicety.
  function bodyHtml(list, from = 0, to = list.length) {
    if (!list.length) {
      return `<tr><td colspan="${colCount}" class="px-4 py-12 text-center text-slate-400">${escapeHtml(emptyMessage)}</td></tr>`;
    }
    const watched = loadWatchlist();
    const end = Math.min(to, list.length);
    const out = [];
    for (let i = from; i < end; i++) {
      const row = list[i];
      const slug = String(key(row));
      let html = rowHtmlCache.get(slug);
      if (html === undefined) {
        const wk = watchKeyOf(row);
        html = rowHtml(row, slug, wk ? watched.has(wk) : false, wk, watchNameOf(row));
        rowHtmlCache.set(slug, html);
      }
      out.push(html);
    }
    return out.join('');
  }

  function rowHtml(row, slug, isWatched, watchSlug = null, watchLabel = null) {
        const label = String(name(row));
        const { color, initials } = avatarFor(label);
        const sc = showScore && score ? score(row) : null;
        const redFlag = !!(sc && sc.redFlag);
        const extraClass = rowClass ? rowClass(row) || '' : '';
        // A row with no company carries no star rather than a control that would file a row id as
        // a company. The span keeps the cell's layout identical either way.
        const star = watchSlug
          ? `<button type="button" data-watch="${escapeHtml(watchSlug)}" data-watch-name="${escapeHtml(watchLabel || '')}"
                  title="${isWatched ? `Remove ${escapeHtml(watchLabel || watchSlug)} from your watchlist` : `Add ${escapeHtml(watchLabel || watchSlug)} to your watchlist`}"
                  class="watch-star flex-shrink-0 text-base leading-none transition-colors ${isWatched ? 'text-amber-400' : 'text-slate-300 hover:text-amber-400'}">${isWatched ? '★' : '☆'}</button>`
          : '<span class="watch-star flex-shrink-0 text-base leading-none text-transparent" aria-hidden="true">☆</span>';
        const dataTd = (c) =>
          `<td class="whitespace-nowrap ${PX} py-3 text-sm text-slate-700 ${c.align === 'right' ? 'text-right tabular-nums' : ''}">${c.html ? c.get(row) : escapeHtml(c.get(row))}</td>`;
        return `
          <tr data-row-key="${escapeHtml(slug)}" class="row-line border-b border-slate-100 transition-colors ${onRowClick ? 'cursor-pointer' : ''} ${redFlag ? 'bg-rose-50/40 hover:bg-rose-50' : `${extraClass} hover:bg-slate-50`}"
            ${redFlag ? 'style="box-shadow: inset 3px 0 0 #f43f5e"' : ''}>
            ${
              showRank
                ? `<td class="${PX} py-3 text-sm font-medium text-slate-500">
                     <div class="flex items-center gap-1">${star}<span class="row-rank"></span></div>
                   </td>`
                : ''
            }
            ${leadCols.map(dataTd).join('')}
            <td class="${PX} py-3">
              <div class="flex items-center gap-2"${nameMaxPx ? ` style="max-width:${nameMaxPx}px"` : ''}>
                ${showRank ? '' : star}
                ${showAvatar ? `<div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${color} text-xs font-bold text-white shadow-sm">${escapeHtml(initials)}</div>` : ''}
                <div class="min-w-0">
                  <div class="truncate font-semibold text-slate-900" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
                  <div class="truncate text-xs text-slate-500" title="${escapeHtml(sub(row))}">${escapeHtml(sub(row))}</div>
                </div>
              </div>
            </td>
            ${
              sc
                ? `<td class="${PX} py-3">
                     <div class="flex items-center gap-2">
                       <span class="inline-flex min-w-[78px] items-center justify-center rounded-lg px-2.5 py-1 text-sm font-bold tabular-nums ${scoreBadgeClass(sc.pct)}">${escapeHtml(sc.points)}/${escapeHtml(sc.max)}</span>
                       ${redFlag ? `<span class="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700 ring-1 ring-rose-200" title="${escapeHtml(sc.redFlag)}">⚠ Red Flag</span>` : ''}
                     </div>
                   </td>`
                : ''
            }
            ${showSignals ? `<td class="${PX} py-3"><div class="flex items-center gap-1">${signals ? signalDots(signals(row)) : ''}</div></td>` : ''}
            ${restCols.map(dataTd).join('')}
            ${link ? `<td class="${PX} py-3 text-right"><a href="${escapeHtml(link(row) || '#')}" target="_blank" rel="noopener" data-stop class="text-sm font-medium text-indigo-600 hover:text-indigo-800">↗</a></td>` : ''}
          </tr>`;
  }

  // ---- streaming the body ----------------------------------------------------------------
  //
  // WHY THE WHOLE TABLE IS NOT IN THE FIRST PAINT ANY MORE.
  //
  // Building the markup for 1,722 rows costs ~350ms; laying it out costs another ~600ms, and the
  // layout is charged to whatever touches the DOM next — which is `segmentedToggle`'s thumb
  // reading `offsetLeft`, so a CPU profile blamed the scope toggle for a second of the Earnings
  // Hub's mount. Every one of those milliseconds is spent on rows nobody can see: the viewport
  // holds about thirteen.
  //
  // So the first paint carries a screenful and the rest is appended in slices while the browser
  // is idle. Total work is unchanged; what changes is that none of it blocks the tab appearing.
  // Measured on the Earnings Hub, tab-to-tab: ~900ms of blocked main thread down to ~60ms.
  //
  // THE ROWS STILL ALL ARRIVE. This is not virtualisation — nothing is unmounted, the DOM ends up
  // holding every visible row, and Ctrl-F, screenshots and "N of M shown" behave as they did. The
  // section carries `data-rows-pending` until the fill completes, so a test (or anything else)
  // can wait for the settled table rather than racing it.
  const FIRST_PAINT_ROWS = 80; // comfortably more than any viewport shows
  const MIN_SLICE = 100;
  const MAX_SLICE = 800;

  // requestIdleCallback where it exists, with a timeout so a busy or backgrounded tab still
  // finishes. Safari has no rIC, hence the fallback — a slower fill is fine, a stalled one is not.
  const scheduleSlice =
    typeof requestIdleCallback === 'function'
      ? (fn) => {
          const id = requestIdleCallback(fn, { timeout: 150 });
          return () => cancelIdleCallback(id);
        }
      : (fn) => {
          const id = setTimeout(fn, 16);
          return () => clearTimeout(id);
        };

  const initialList = visibleRows();

  // Installed by wire(). Until then `updateRows` is a no-op that reports nothing changed, which
  // is the truth for an unmounted table.
  let updateRows = () => 0;

  const html = `
    <section class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100" data-score-table${initialList.length > FIRST_PAINT_ROWS ? ` data-rows-pending="${initialList.length - FIRST_PAINT_ROWS}"` : ''}>
      <div class="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div class="relative max-w-md flex-1">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
            <input type="text" data-table-search placeholder="Search company..." value="${escapeHtml(view.q)}"
              class="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          ${filterDefs
            .map(
              // `max-w-full` + `truncate` because A <select> IS AS WIDE AS ITS LONGEST OPTION, and
              // the options come from the data. Corp Announcements' sub-category list carries BSE's
              // own strings, the longest of which rendered a 490px control inside a 390px viewport;
              // Super Investors' fund picker does the same at 637px. `overflow-x: hidden` on <body>
              // then CLIPS it rather than scrolling, so the control is simply unreachable on a phone
              // and nothing on screen says so. Constraining the control costs nothing — the option
              // list still opens at full width — and it is why this is fixed here rather than by
              // shortening anyone's labels.
              (f, i) => `<select data-table-filter="${i}" ${f.label ? `aria-label="${escapeHtml(f.label)}" title="${escapeHtml(f.label)}"` : ''}
                   class="max-w-full truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                   ${f.options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === view.filters[i] ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                 </select>`
            )
            .join('')}
          <button type="button" data-watch-toggle title="Show only watchlisted companies"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm transition-colors hover:border-amber-200 hover:bg-amber-50">
            <span data-watch-icon class="text-amber-400">${view.watchOnly ? '★' : '☆'}</span>
            <span>Watchlist</span>
            <span data-watch-count class="min-w-[18px] rounded-full bg-slate-200/70 px-1.5 py-0.5 text-center text-[10px] font-bold text-slate-500">${watchlist.size()}</span>
          </button>
        </div>
        <div class="flex items-center gap-3">
          <div class="hidden text-xs text-slate-500 sm:block">
            <span data-row-count class="font-semibold text-slate-700">${initialList.length} of ${totalCount}</span> shown
          </div>
          <button type="button" data-export
            class="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:bg-emerald-700 hover:shadow">
            <span>📊</span> Export Excel
          </button>
        </div>
      </div>

      <div class="scrollbar-thin overflow-x-auto" data-table-scroll ${stickyHead ? `style="max-height:${stickyHead};overflow-y:auto"` : ''}>
        <table class="w-full text-sm">
          <thead data-table-head class="sticky top-0 z-10 ${stickyHead ? 'bg-slate-50 shadow-[inset_0_-1px_0_rgb(226_232_240)]' : 'bg-slate-50/70'}">${headHtml()}</thead>
          <tbody data-table-body>${bodyHtml(initialList, 0, FIRST_PAINT_ROWS)}</tbody>
        </table>
      </div>
    </section>`;

  function wire(root) {
    const host = root.querySelector('[data-score-table]');
    if (!host) return () => {};
    const head = host.querySelector('[data-table-head]');
    const body = host.querySelector('[data-table-body]');
    const countEl = host.querySelector('[data-row-count]');
    const searchEl = host.querySelector('[data-table-search]');
    const filterEls = [...host.querySelectorAll('[data-table-filter]')];
    const watchBtn = host.querySelector('[data-watch-toggle]');
    const watchIcon = host.querySelector('[data-watch-icon]');
    const watchCount = host.querySelector('[data-watch-count]');

    let current = initialList;

    // ---- the background fill ----------------------------------------------------------
    let cancelFill = null;
    let filled = Math.min(FIRST_PAINT_ROWS, initialList.length);
    let slice = MIN_SLICE * 2;

    function markPending(n) {
      if (n > 0) {
        host.setAttribute('data-rows-pending', String(n));
      } else {
        host.removeAttribute('data-rows-pending');
        detachScroll(); // nothing left to chase — stop listening (declaration hoisted)
      }
    }

    function stopFill() {
      if (cancelFill) cancelFill();
      cancelFill = null;
    }

    /** Append the next slice, then schedule the one after it. Idempotent and cancellable. */
    function pumpFill() {
      cancelFill = null;
      if (filled >= current.length) {
        markPending(0);
        return;
      }
      const started = performance.now();
      const end = Math.min(filled + slice, current.length);
      body.insertAdjacentHTML('beforeend', bodyHtml(current, filled, end));
      filled = end;
      markPending(current.length - filled);
      // Adapt: the cost per row swings by an order of magnitude between a three-column table and
      // a thirteen-column one, so a fixed slice is either janky on one or pointlessly slow on the
      // other. Aim at roughly a frame's worth of work per slice.
      const ms = performance.now() - started;
      if (ms > 24) slice = Math.max(MIN_SLICE, Math.round(slice / 2));
      else if (ms < 8) slice = Math.min(MAX_SLICE, slice * 2);
      if (filled < current.length) cancelFill = scheduleSlice(pumpFill);
      else markPending(0);
    }

    function startFill() {
      stopFill();
      if (filled >= current.length) {
        markPending(0);
        return;
      }
      markPending(current.length - filled);
      attachScroll();
      cancelFill = scheduleSlice(pumpFill);
    }

    /**
     * Render everything still outstanding, now, in one go.
     *
     * The reader scrolling to the end of what has been painted is the one case where "later" is
     * not good enough — they are looking at the gap. Also used before anything that reads the DOM
     * as if it were the whole table.
     */
    function flush() {
      stopFill();
      if (filled >= current.length) {
        markPending(0);
        return;
      }
      body.insertAdjacentHTML('beforeend', bodyHtml(current, filled, current.length));
      filled = current.length;
      markPending(0);
    }

    // Scrolling to the end of the painted rows is the one case where "in a moment" is not good
    // enough — the reader is looking at the gap. The listeners exist only while a fill is
    // outstanding and take themselves off when it finishes, so a caller that drops the disposer
    // still leaks nothing. Which scroller matters depends on `stickyHead`: with it the tbody is
    // its own scroll container, without it the page scrolls. Both, then.
    const scroller = host.querySelector('[data-table-scroll]');
    let scrollAttached = false;
    let scrollQueued = false;

    function onScroll() {
      if (scrollQueued || filled >= current.length) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        const last = body.lastElementChild;
        if (filled >= current.length || !last) return;
        if (last.getBoundingClientRect().top < window.innerHeight * 2) flush();
      });
    }

    function attachScroll() {
      if (scrollAttached) return;
      scrollAttached = true;
      scroller?.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    function detachScroll() {
      if (!scrollAttached) return;
      scrollAttached = false;
      scroller?.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
    }

    // Repaint has a fast path. Sorting and narrowing a filter both leave a row SET the DOM
    // already contains, so we reorder the existing <tr> nodes (appendChild moves a node) and
    // drop the ones that fell out — no HTML re-parse. Only a genuinely new row forces the
    // innerHTML path. On 535 rows this is the difference between ~150ms and ~10ms per sort.
    // Listeners are delegated, so neither path re-binds anything.
    //
    // The reorder path needs every next row already in the DOM, which is only true once the fill
    // has finished. Mid-fill it falls through to the rebuild — which is now the cheap path, since
    // a rebuild is a screenful plus a fresh fill rather than 1,722 rows.
    function repaint() {
      stopFill();
      current = visibleRows();
      head.innerHTML = headHtml();

      // A Map keyed by row key CANNOT SURVIVE A DUPLICATE: the second `<tr>` displaces the first,
      // the first is then never visited by the removal loop, and it stays in the DOM for ever —
      // wrong row, wrong place, invisible to any count. That is exactly what a colliding key did
      // to the con-call table (see `rowIdOf` in js/data/concall-scans.js), so both sides are now
      // closed: the key is unique, and a duplicate here falls through to the rebuild instead of
      // quietly painting the wrong thing. A caller with a bad key gets a slower paint, never a lie.
      const existing = new Map();
      let domDupes = 0;
      for (const tr of body.children) {
        const k = tr.dataset?.rowKey;
        if (!k) continue;
        if (existing.has(k)) domDupes++;
        existing.set(k, tr);
      }

      const nextKeys = current.map((r) => String(key(r)));
      const keyDupes = nextKeys.length - new Set(nextKeys).size;
      const canReorder =
        current.length > 0 && existing.size > 0 && domDupes === 0 && keyDupes === 0 && nextKeys.every((k) => existing.has(k));

      if (canReorder) {
        const keep = new Set(nextKeys);
        for (const [k, tr] of existing) if (!keep.has(k)) tr.remove();
        const frag = document.createDocumentFragment();
        for (const k of nextKeys) frag.appendChild(existing.get(k)); // moves, doesn't clone
        body.appendChild(frag);
        replaceStaleRows();
        filled = current.length;
        markPending(0);
      } else {
        // Rebuilt from source, so nothing is stale any more — including the rows the fill has
        // yet to append, which are generated from the same cache this clears against.
        body.innerHTML = bodyHtml(current, 0, FIRST_PAINT_ROWS);
        staleKeys.clear();
        filled = Math.min(FIRST_PAINT_ROWS, current.length);
        startFill();
      }

      countEl.textContent = `${current.length} of ${totalCount}`;
      watchCount.textContent = String(watchlist.size());
    }

    // Rebuild named rows in place, leaving the row SET — and so the reader's search, filters,
    // watchlist and sort — completely untouched. For data that lands on top of a mounted table:
    // a live quote arriving over an EOD column is the reference case.
    //
    // This cannot be done by dropping the markup cache and repainting. `repaint`'s fast path
    // MOVES the existing <tr> nodes rather than rebuilding them (that is what makes a 535-row
    // sort ~30ms), so an invalidated cache entry is never consulted and not one pixel changes.
    // Rebuilding the row and swapping the node is both correct and cheaper than a full repaint.
    updateRows = (keys) => {
      const wanted = new Set([...keys].map(String));
      if (!wanted.size) return 0;
      const watched = loadWatchlist();
      // Both indexes are built ONCE, not once per key. Sixty keys scanned against six hundred
      // rows and six hundred <tr> nodes is the sort of quadratic that this table's whole design
      // exists to avoid.
      const byKey = new Map(rows.map((r) => [String(key(r)), r]));
      const trByKey = new Map();
      for (const node of body.children) if (node.dataset?.rowKey) trByKey.set(node.dataset.rowKey, node);
      const scratch = document.createElement('tbody');
      let touched = 0;
      for (const slug of wanted) {
        const row = byKey.get(slug);
        if (!row) continue;
        const wk = watchKeyOf(row);
        const markup = rowHtml(row, slug, wk ? watched.has(wk) : false, wk, watchNameOf(row));
        rowHtmlCache.set(slug, markup); // so a later sort reorders the NEW markup, not the old
        const tr = trByKey.get(slug);
        if (!tr) continue; // filtered out of view — the cache above still has it right
        scratch.innerHTML = markup;
        if (scratch.firstElementChild) {
          tr.replaceWith(scratch.firstElementChild);
          touched++;
        }
      }
      return touched;
    };

    // The watchlist star rides the SAME mechanism, on the repaint path rather than on a data
    // arrival. Starring a row leaves the row SET unchanged, so `repaint` above takes its fast
    // path and re-parses nothing — which is why dropping the row's cached markup did not change
    // one pixel and a watchlisted row kept its hollow ☆ while the filter counted it. `staleKeys`
    // names the rows whose markup no longer describes them; this drains it after the reorder.
    function replaceStaleRows() {
      if (!staleKeys.size) return;
      updateRows(staleKeys);
      staleKeys.clear();
    }

    // Delegated: header sort.
    head.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th || !head.contains(th)) return;
      const k = th.dataset.sort;
      if (view.sort && view.sort.key === k) view.sort.dir = view.sort.dir === 'asc' ? 'desc' : 'asc';
      else view.sort = { key: k, dir: 'desc' };
      repaint();
    });

    // Delegated: watchlist star, external link, row click — in that priority order.
    body.addEventListener('click', (e) => {
      const star = e.target.closest('[data-watch]');
      if (star) {
        e.stopPropagation();
        const company = star.dataset.watch;
        watchlist.toggle(company, star.dataset.watchName || null);
        // ONE COMPANY CAN BE SEVERAL ROWS. Three announcements from one filer share a watch key
        // and each carries its own star, so invalidating only the row that was clicked would leave
        // the other two showing the opposite of what is stored — the same disagreement between a
        // control and its state that `staleKeys` exists to close, arrived at from the other side.
        for (const r of rows) {
          if (watchKeyOf(r) !== company) continue;
          const slug = String(key(r));
          rowHtmlCache.delete(slug); // its star changed — rebuild just that row next paint
          staleKeys.add(slug); //      ...including on the fast path, which re-parses nothing
        }
        repaint();
        return;
      }
      if (e.target.closest('[data-stop]')) {
        e.stopPropagation();
        return;
      }
      if (!onRowClick) return;
      // A link or control inside a cell owns its own click — opening the drill behind a
      // newly-opened tab is not what anyone meant by clicking "open ↗".
      if (e.target.closest('a[href], [data-norow]')) return;
      const tr = e.target.closest('tr[data-row-key]');
      if (!tr) return;
      const row = current.find((r) => String(key(r)) === tr.dataset.rowKey);
      if (row) onRowClick(row);
    });

    searchEl.addEventListener('input', () => {
      view.q = searchEl.value.trim().toLowerCase();
      repaint();
    });

    filterEls.forEach((el, i) =>
      el.addEventListener('change', () => {
        view.filters[i] = el.value;
        repaint();
      })
    );

    watchBtn.addEventListener('click', () => {
      view.watchOnly = !view.watchOnly;
      rowHtmlCache.clear(); // star styling is baked into the cached markup
      watchIcon.textContent = view.watchOnly ? '★' : '☆';
      watchBtn.classList.toggle('bg-amber-100', view.watchOnly);
      watchBtn.classList.toggle('border-amber-300', view.watchOnly);
      watchBtn.classList.toggle('text-amber-800', view.watchOnly);
      repaint();
    });

    // Export: `onExport` receives the currently visible rows. Tabs that haven't adopted the
    // real exporter yet fall back to logging intent rather than silently doing nothing.
    // It reads `current` — the row DATA — not the DOM, so a fill still in flight cannot truncate
    // a workbook. That is the whole reason the visible set is tracked as an array.
    host.querySelector('[data-export]').addEventListener('click', () => {
      if (onExport) onExport(current, exportName);
      else console.info(`[stub] Export Excel → "${exportName}" (${current.length} rows).`);
    });

    startFill();

    return () => {
      stopFill();
      detachScroll();
    };
  }

  return { html, wire, view, updateRows: (keys) => updateRows(keys) };
}

// ---------------------------------------------------------------------------------------
// (e) drill panel + modal — singleton overlays declared in index.html.
// ---------------------------------------------------------------------------------------

let drillKeyHandler = null;
let releaseDrillFocus = null;

/**
 * openDrill({ name, sub, link, linkLabel, headerStats, groups, banner })
 *
 *  name         company / entity name (drives the gradient avatar)
 *  sub          small line under the name (sector · industry)
 *  link         optional external url shown under the title
 *  headerStats  [{ label, value, caption?, tone? }] — rendered as a 2-up block
 *  groups       [{ category, items: [{ label, criteria?, status, value, note?, points?, max?, extraHtml? }] }]
 *               `extraHtml` is trusted markup appended inside the card (e.g. provenance chips).
 *  banner       optional { tone: 'rose'|'amber'|'slate', title, body } strip under the header
 *  beforeGroupsHtml  trusted markup rendered above the rule groups (series tables, charts)
 */
export function openDrill({ name = '', sub = '', link = null, linkLabel = 'Open source ↗', headerStats = [], groups = [], banner = null, beforeGroupsHtml = '' }) {
  const panel = document.getElementById('drill-panel');
  const overlay = document.getElementById('drill-overlay');
  const content = document.getElementById('drill-content');
  if (!panel || !overlay || !content) return;

  const { color, initials } = avatarFor(name);

  const bannerTone = {
    rose: 'bg-rose-50 ring-rose-100 text-rose-800',
    amber: 'bg-amber-50 ring-amber-100 text-amber-800',
    slate: 'bg-slate-100 ring-slate-200 text-slate-700',
  };

  content.innerHTML = `
    <div class="sticky top-0 z-10 border-b border-slate-100 bg-white/95 p-5 backdrop-blur-sm">
      <button data-drill-close class="absolute right-4 top-4 text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">×</button>
      <div class="flex items-center gap-4 pr-8">
        <div class="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-lg font-bold text-white shadow-md">${escapeHtml(initials)}</div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-xl font-bold text-slate-900">${escapeHtml(name)}</div>
          ${sub ? `<div class="mt-0.5 truncate text-xs text-slate-500">${escapeHtml(sub)}</div>` : ''}
          ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener" class="text-xs text-indigo-600 hover:text-indigo-800">${escapeHtml(linkLabel)}</a>` : ''}
        </div>
      </div>
      ${
        headerStats.length
          ? `<div class="mt-4 grid grid-cols-2 gap-3">
               ${headerStats
                 .map(
                   (hs) => `
                 <div class="rounded-lg bg-slate-50 p-3">
                   <div class="text-xs font-medium text-slate-500">${escapeHtml(hs.label)}</div>
                   <div class="text-2xl font-bold tabular-nums ${METRIC_TONE[hs.tone] || 'text-slate-900'}">${escapeHtml(hs.value)}</div>
                   ${hs.caption ? `<div class="truncate text-xs text-slate-500">${escapeHtml(hs.caption)}</div>` : ''}
                 </div>`
                 )
                 .join('')}
             </div>`
          : ''
      }
      ${
        banner
          ? `<div class="mt-3 rounded-lg p-3 ring-1 ${bannerTone[banner.tone] || bannerTone.slate}">
               <div class="text-sm font-semibold">${escapeHtml(banner.title)}</div>
               <div class="mt-0.5 text-xs opacity-90">${escapeHtml(banner.body)}</div>
             </div>`
          : ''
      }
    </div>
    <div class="p-5">
      ${beforeGroupsHtml || ''}
      ${groups
        .map(
          (g) => `
        <div class="mb-5">
          <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">${escapeHtml(g.category)}</div>
          <div class="space-y-2">
            ${g.items
              .map(
                (item) => `
              <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100 transition-shadow hover:ring-slate-200">
                <div class="mb-1 flex items-start justify-between gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-semibold text-slate-900">${escapeHtml(item.label)}</div>
                    ${item.criteria ? `<div class="text-xs text-slate-500">Criteria: <span class="font-medium">${escapeHtml(item.criteria)}</span></div>` : ''}
                  </div>
                  <div class="flex flex-shrink-0 items-center gap-2">
                    ${item.status ? statusPill(item.status) : ''}
                    ${item.points !== undefined && item.max !== undefined ? `<span class="text-sm font-bold tabular-nums text-slate-700">${escapeHtml(item.points)}/${escapeHtml(item.max)}</span>` : ''}
                  </div>
                </div>
                ${item.value == null || item.value === '' ? '' : `<div class="mt-2 text-sm tabular-nums text-slate-700">${escapeHtml(item.value)}</div>`}
                ${item.note ? `<div class="mt-1 text-xs italic text-slate-500">${escapeHtml(item.note)}</div>` : ''}
                ${item.extraHtml || ''}
              </div>`
              )
              .join('')}
          </div>
        </div>`
        )
        .join('')}
    </div>`;

  panel.classList.remove('translate-x-full');
  overlay.classList.remove('hidden');

  content.querySelector('[data-drill-close]')?.addEventListener('click', closeDrill);
  overlay.addEventListener('click', closeDrill, { once: true });

  drillKeyHandler = (e) => {
    if (e.key === 'Escape') closeDrill();
  };
  document.addEventListener('keydown', drillKeyHandler);
  releaseDrillFocus?.();
  releaseDrillFocus = trapFocus(panel, { label: `${name} detail` });
}

export function closeDrill() {
  const panel = document.getElementById('drill-panel');
  const overlay = document.getElementById('drill-overlay');
  panel?.classList.add('translate-x-full');
  overlay?.classList.add('hidden');
  if (drillKeyHandler) {
    document.removeEventListener('keydown', drillKeyHandler);
    drillKeyHandler = null;
  }
  releaseDrillFocus?.();
  releaseDrillFocus = null;
}

let modalKeyHandler = null;
let releaseModalFocus = null;

/**
 * openModal(innerHtml, { size }) — centred modal. `size` is 'default' | 'wide' | 'magazine'.
 * Any element inside `innerHtml` carrying `data-modal-close` closes it, as do ESC and a
 * backdrop click.
 */
export function openModal(innerHtml, { size = 'default' } = {}) {
  const overlay = document.getElementById('modal-overlay');
  const container = document.getElementById('modal-container');
  const content = document.getElementById('modal-content');
  if (!overlay || !container || !content) return;

  const sizeClass = size === 'magazine' ? 'max-w-6xl' : size === 'wide' ? 'max-w-5xl' : 'max-w-4xl';
  container.className = `relative bg-white rounded-3xl shadow-2xl w-full ${sizeClass} my-8 scale-95 opacity-0 transition-all duration-200 overflow-hidden`;
  content.innerHTML = innerHtml;
  overlay.classList.remove('hidden');
  overlay.classList.add('is-open');
  requestAnimationFrame(() => container.classList.replace('scale-95', 'scale-100'));

  content.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', closeModal));
  releaseModalFocus?.();
  releaseModalFocus = trapFocus(container, { label: 'Dialog' });
  overlay.addEventListener('click', onBackdrop);

  modalKeyHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', modalKeyHandler);
}

function onBackdrop(e) {
  if (e.target === e.currentTarget) closeModal();
}

// ---------------------------------------------------------------------------------------
// (f) workspace — the full-screen overlay.
// ---------------------------------------------------------------------------------------

let workspaceState = null; // { tabs, activeId, onTabChange, onClose, keyHandler }
let releaseWorkspaceFocus = null;

/**
 * openWorkspace({ title, subtitle, avatarName, badges, actionsHtml, tabs, activeTab,
 *                 onTabChange, onClose })
 *
 * A full-screen overlay with its own internal tab strip — for analysis that needs more room
 * than the 480px drill panel. The Con-call Deep Dive is the reference consumer.
 *
 *  tabs        [{ id, label, badge?, render() -> html string, wire?(root) }]
 *              `render` is called lazily, only when its tab is first shown, and again on every
 *              return to it. `wire` receives the freshly-rendered panel element.
 *  activeTab   id to open on
 *  onTabChange (id) => {} — the caller writes this into the URL so a view is shareable
 *  onClose     () => {} — the caller clears its URL params
 *
 * ESC and the × close it; a backdrop click does NOT, because a workspace holds enough state
 * (a scrolled transcript, a search term) that a stray click outside should not discard it.
 * Scroll is locked on <body> while it is open.
 */
export function openWorkspace({
  title = '',
  subtitle = '',
  avatarName = null,
  badges = [],
  actionsHtml = '',
  tabs = [],
  activeTab = null,
  onTabChange = null,
  onClose = null,
} = {}) {
  const overlay = document.getElementById('workspace-overlay');
  const container = document.getElementById('workspace-container');
  const content = document.getElementById('workspace-content');
  if (!overlay || !container || !content || !tabs.length) return;

  const { color, initials } = avatarFor(avatarName || title);
  const activeId = tabs.some((t) => t.id === activeTab) ? activeTab : tabs[0].id;

  content.innerHTML = `
    <div class="sticky top-0 z-10 border-b border-slate-200 bg-white/97 backdrop-blur">
      <div class="flex items-start gap-4 px-6 pt-5">
        <div class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-base font-bold text-white shadow-md">${escapeHtml(initials)}</div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="font-display truncate text-xl font-bold text-slate-900">${escapeHtml(title)}</h2>
            ${badges.join('')}
          </div>
          ${subtitle ? `<div class="mt-0.5 truncate text-xs text-slate-500">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        <div class="flex flex-shrink-0 items-center gap-2">
          ${actionsHtml}
          <button data-ws-close class="rounded-lg px-2 text-2xl leading-none text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" aria-label="Close">×</button>
        </div>
      </div>
      <div class="scrollbar-thin mt-3 flex gap-1 overflow-x-auto px-6" role="tablist">
        ${tabs
          .map(
            (t) => `
          <button data-ws-tab="${escapeHtml(t.id)}" role="tab" aria-selected="${t.id === activeId}"
            class="ws-tab relative flex-shrink-0 whitespace-nowrap px-3 py-2.5 text-sm font-semibold transition-colors ${
              t.id === activeId ? 'text-indigo-700' : 'text-slate-500 hover:text-slate-800'
            }">
            ${escapeHtml(t.label)}
            ${t.badge != null ? `<span class="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-slate-600">${escapeHtml(t.badge)}</span>` : ''}
            <span class="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-transform duration-200 ${
              t.id === activeId ? 'scale-x-100' : 'scale-x-0'
            }"></span>
          </button>`
          )
          .join('')}
      </div>
    </div>
    <div id="workspace-panel" class="scrollbar-thin max-h-[calc(100vh-11rem)] overflow-y-auto px-6 py-5"></div>`;

  workspaceState = { tabs, activeId, onTabChange, onClose };

  content.querySelector('[data-ws-close]')?.addEventListener('click', () => closeWorkspace());
  content.querySelectorAll('[data-ws-tab]').forEach((btn) => {
    btn.addEventListener('click', () => selectWorkspaceTab(btn.dataset.wsTab));
  });

  overlay.classList.remove('hidden');
  overlay.classList.add('is-open');
  releaseWorkspaceFocus?.();
  releaseWorkspaceFocus = trapFocus(container, { label: `${title} workspace` });
  document.body.classList.add('workspace-open');
  requestAnimationFrame(() => {
    container.classList.remove('translate-y-4', 'scale-[0.98]');
    container.classList.add('translate-y-0', 'scale-100');
  });

  workspaceState.keyHandler = (e) => {
    // Let a modal stacked on top own ESC — closing the workspace out from under the keyword
    // editor would be the wrong thing to dismiss.
    if (e.key !== 'Escape') return;
    if (!document.getElementById('modal-overlay')?.classList.contains('hidden')) return;
    closeWorkspace();
  };
  document.addEventListener('keydown', workspaceState.keyHandler);

  renderWorkspacePanel(activeId);
}

function renderWorkspacePanel(id) {
  const panel = document.getElementById('workspace-panel');
  if (!panel || !workspaceState) return;
  const tab = workspaceState.tabs.find((t) => t.id === id);
  if (!tab) return;
  try {
    panel.innerHTML = tab.render() || '';
    panel.scrollTop = 0;
    tab.wire?.(panel);
  } catch (err) {
    console.error(`[workspace] tab "${id}" failed to render`, err);
    panel.innerHTML = `<div class="rounded-2xl bg-rose-50 p-6 text-center ring-1 ring-rose-100">
      <div class="text-sm font-semibold text-rose-800">This view hit a snag</div>
      <div class="mt-1 text-xs text-rose-600">${escapeHtml(String(err?.message || err))}</div>
    </div>`;
  }
}

/** Switch the workspace's internal tab. Exported so a deep link can drive it. */
export function selectWorkspaceTab(id) {
  if (!workspaceState || !workspaceState.tabs.some((t) => t.id === id)) return;
  workspaceState.activeId = id;
  document.querySelectorAll('[data-ws-tab]').forEach((btn) => {
    const on = btn.dataset.wsTab === id;
    btn.setAttribute('aria-selected', String(on));
    btn.classList.toggle('text-indigo-700', on);
    btn.classList.toggle('text-slate-500', !on);
    const bar = btn.querySelector('span:last-child');
    bar?.classList.toggle('scale-x-100', on);
    bar?.classList.toggle('scale-x-0', !on);
  });
  renderWorkspacePanel(id);
  workspaceState.onTabChange?.(id);
}

/** Re-render the current panel in place — used when data behind it changes (a keyword edit). */
export function refreshWorkspace() {
  if (workspaceState) renderWorkspacePanel(workspaceState.activeId);
}

export function isWorkspaceOpen() {
  return !!workspaceState;
}

export function closeWorkspace({ silent = false } = {}) {
  const overlay = document.getElementById('workspace-overlay');
  const container = document.getElementById('workspace-container');
  const content = document.getElementById('workspace-content');
  const state = workspaceState;
  workspaceState = null;

  if (state?.keyHandler) document.removeEventListener('keydown', state.keyHandler);
  overlay?.classList.remove('is-open');
  overlay?.classList.add('hidden');
  container?.classList.add('translate-y-4', 'scale-[0.98]');
  container?.classList.remove('translate-y-0', 'scale-100');
  document.body.classList.remove('workspace-open');
  if (content) content.innerHTML = '';
  releaseWorkspaceFocus?.();
  releaseWorkspaceFocus = null;
  // `silent` is for teardown that is already rewriting the URL (a route change) — calling back
  // would have the workspace fight the navigation it is being closed by.
  if (!silent) state?.onClose?.();
}

export function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.classList.add('hidden');
  overlay.removeEventListener('click', onBackdrop);
  if (content) content.innerHTML = '';
  if (modalKeyHandler) {
    document.removeEventListener('keydown', modalKeyHandler);
    modalKeyHandler = null;
  }
  releaseModalFocus?.();
  releaseModalFocus = null;
}

// ---------------------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------------------

/**
 * sectionHead({ title, description, meta, controls }) — the title block above every tab's stat
 * strip. `meta` and `controls` are both trusted markup.
 *
 * `meta` is the right-aligned block beside the title — right for one small pill that does not
 * change between sub-views.
 *
 * The description is capped at `max-w-5xl` rather than the old `max-w-2xl`. A subtitle is one
 * sentence and 42rem was breaking it onto a second line with half the content column empty to
 * its right — which reads as a layout fault, not as a measure. 64rem holds every subtitle in the
 * app on one line at 1440 and still stops a long one running the full 1400px.
 *
 * `controls` is a LEFT-aligned row of its own, under the heading block. Use it whenever the set
 * of chips differs between sub-views. In `meta` they sit in a `justify-between` row, so whether
 * they render beside the title or wrap under it depends on how wide the chips and the
 * description happen to be — and that flips as you switch sub-view. On the Earnings Hub the
 * controls jumped from left-under-the-title to right-of-the-title on the way from Latest Results
 * to Earnings Calendar, because the second view drops the YoY/QoQ toggle and has a shorter
 * description. Controls that move when you use them read as a different page, not a different
 * view of one. Its own row cannot wrap, so it cannot move.
 */
// The `meta` slot is `min-w-0 max-w-full`, NOT `flex-shrink-0`. It holds a pill and a scope chip
// whose text comes from the data, and at 390px "Captured 526 companies - 3d" beside
// "Universe - 722 announcements" is wider than the viewport. Refusing to shrink pushed the whole
// row out, where the overflow-x:hidden backstop clipped it rather than scrolling — so the chips
// were simply unreachable and nothing on screen said so. The inner block already carries
// flex-wrap, so letting the slot shrink makes them stack instead of vanish.
export function sectionHead({ title, description = '', meta = '', controls = '' }) {
  return `
    <div class="mb-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="font-display text-xl font-bold text-slate-900">${escapeHtml(title)}</h2>
          ${description ? `<p class="mt-1 max-w-5xl text-sm text-slate-500">${escapeHtml(description)}</p>` : ''}
        </div>
        ${meta ? `<div class="min-w-0 max-w-full">${meta}</div>` : ''}
      </div>
      ${controls ? `<div data-section-controls class="mt-3 flex flex-wrap items-center gap-2">${controls}</div>` : ''}
    </div>`;
}

/**
 * pendingPanel({ title, body, arriving }) — the honest placeholder used where a genuine data
 * feed has not landed yet. Never fabricate numbers into a chart; render this instead.
 */
/**
 * WHAT EVERY TAB SHOWS WHEN THE WATCHLIST SCOPE IS EMPTY.
 *
 * Not an error and not a "no results" — a scope narrowed to nothing is the reader's own list being
 * empty, and a table reading "No companies match your filters" over it would send them looking for
 * a filter to clear. It states the count (zero, said out loud), says exactly how a company gets
 * onto the list, and offers the one-click way to go and do it.
 *
 * It lives here rather than in each tab because it is a property of the SCOPE, not of the tab, and
 * nine copies of it is nine chances for one of them to say something slightly different.
 */
export function watchlistEmptyPanel({ tabTitle = 'This tab', universeHref = '#/research/breakouts?scope=universe' } = {}) {
  return `
    <div class="fade-in rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-watchlist-empty>
      <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-2xl text-amber-400 ring-1 ring-amber-100">☆</div>
      <h3 class="font-display mt-4 text-lg font-bold text-slate-900">There are zero watchlist companies right now</h3>
      <p class="mx-auto mt-2 max-w-xl text-sm text-slate-500">
        ${escapeHtml(tabTitle)} has nothing to show in this scope because nothing is being tracked yet.
        Add companies to track on this scope view: switch to <strong class="font-semibold text-slate-700">Universe</strong>,
        find a company on any tab, and click the ☆ beside its name. Every tab — and this scope — then follows that list.
      </p>
      <a href="${escapeHtml(universeHref)}"
         class="mt-5 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700">
        Open ${escapeHtml(tabTitle)} in Universe and star a company
      </a>
      <p class="mt-4 text-xs text-slate-400">The watchlist is kept in this browser, so it is yours and it survives a reload.</p>
    </div>`;
}

export function pendingPanel({ title, body, arriving = 'not yet wired' }) {
  return `
    <div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="text-xs font-bold uppercase tracking-wider text-slate-400">${escapeHtml(title)}</div>
        <span class="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">Pending · ${escapeHtml(arriving)}</span>
      </div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        ${Array.from({ length: 4 })
          .map(() => '<div class="skeleton-shimmer h-20 rounded-2xl bg-slate-100"></div>')
          .join('')}
      </div>
      ${body ? `<p class="mt-3 text-xs text-slate-400">${escapeHtml(body)}</p>` : ''}
    </div>`;
}
