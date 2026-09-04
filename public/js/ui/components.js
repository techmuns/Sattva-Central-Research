// ui/components.js — shared UI primitives reused by every tab. Each primitive is a pure
// function: it returns either a plain HTML string, or `{ html, wire(root) }` when it needs
// event listeners / measurement after being inserted into the DOM. `wire()` never mutates
// global state on its own — it only wires the markup it was just handed.

import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime, toneForValue } from '../core/format.js';
import { scopeLabel } from '../data/scope.js';
import * as watchlist from '../core/watchlist.js';

// Semantic tones (positive/negative/caution) describe a data outcome; brand/accent are the
// indigo→purple chrome colours. Never use a semantic tone to mean "branded".
const TONE_CLASSES = {
  positive: { text: 'text-emerald-700', bg: 'bg-emerald-50', ring: 'ring-emerald-100', dot: 'bg-emerald-500' },
  negative: { text: 'text-rose-700', bg: 'bg-rose-50', ring: 'ring-rose-100', dot: 'bg-rose-500' },
  caution: { text: 'text-amber-700', bg: 'bg-amber-50', ring: 'ring-amber-100', dot: 'bg-amber-500' },
  neutral: { text: 'text-slate-600', bg: 'bg-slate-100', ring: 'ring-slate-200', dot: 'bg-slate-400' },
  brand: { text: 'text-indigo-700', bg: 'bg-indigo-50', ring: 'ring-indigo-200', dot: 'bg-indigo-500' },
  accent: { text: 'text-purple-700', bg: 'bg-purple-50', ring: 'ring-purple-200', dot: 'bg-purple-500' },
};
function toneClasses(tone) {
  return TONE_CLASSES[tone] || TONE_CLASSES.neutral;
}

// A single KPI tile: label + big number + optional signed delta or sublabel.
export function statCard({ label, value, delta = null, deltaTone = null, sublabel = null }) {
  const tone = deltaTone || (delta != null ? toneForValue(parseFloat(delta)) : 'neutral');
  const c = toneClasses(tone);
  return `
    <div class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <div class="text-xs font-medium text-slate-500">${escapeHtml(label)}</div>
      <div class="font-display mt-1 text-2xl font-extrabold tabular-nums text-slate-900">${escapeHtml(value)}</div>
      ${delta != null ? `<div class="mt-1 text-xs font-semibold tabular-nums ${c.text}">${escapeHtml(delta)}</div>` : sublabel ? `<div class="mt-1 text-xs text-slate-400">${escapeHtml(sublabel)}</div>` : ''}
    </div>`;
}

// Panel title + one-line description, with an optional right-aligned meta slot (e.g. a scope pill).
export function sectionHeader({ title, description = '', meta = '' }) {
  return `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="font-display text-xl font-bold text-slate-900">${escapeHtml(title)}</h2>
        ${description ? `<p class="mt-1 max-w-2xl text-sm text-slate-500">${escapeHtml(description)}</p>` : ''}
      </div>
      ${meta ? `<div class="shrink-0">${meta}</div>` : ''}
    </div>`;
}

// "Universe · 25 companies" / "Portfolio · 12 holdings" chip — reflects the global scope toggle.
/**
 * The scope pill — and, in Portfolio scope, HOW MUCH OF THE BOOK THIS FEED ACTUALLY COVERS.
 *
 * The book is 142 company lines. No feed here carries all of them: 19 have no NSE symbol at all
 * (unlisted holdings, warrant lines, BSE-only companies), and of the 123 that do, each feed covers
 * a different subset — a company only appears in the Earnings Hub if it has reported, in Con-call
 * if it has held a call, in Breakouts if it is in the NSE 500.
 *
 * So a bare "Portfolio · 96 companies" is a half-truth: it invites the reading that the book is 96
 * long. The pill now carries the denominator and a `title` explaining the gap, on every tab at
 * once, because the alternative is a reader scanning for a holding, not finding it, and having no
 * way to tell whether it is absent from the feed or absent from the book.
 */
export function scopeSummary({ scope, count, noun = 'companies', book = null }) {
  const label = scopeLabel(scope);
  const tone = scope === 'universe' ? 'brand' : 'accent';

  // WATCHLIST PRINTS ITS OWN DENOMINATOR, and it is a different fact from the book's. The book's
  // gap is partly permanent — nineteen lines carry no NSE symbol and no feed here can ever show
  // them. A watchlist entry came FROM a feed, so its gap is only ever "this particular feed does
  // not carry it", which is a smaller and more temporary claim and must not be worded like the
  // other one.
  if (scope === 'watchlist') {
    const tracked = watchlist.size();
    if (!tracked) return pill({ label: `${label} · nothing tracked yet`, tone, title: 'Star a company under Universe to track it here.' });
    const why =
      tracked === count
        ? `Every one of the ${formatNumber(tracked)} companies you track appears on this feed.`
        : `You track ${formatNumber(tracked)} companies; ${formatNumber(count)} of them appear on this feed. The rest are tracked but not carried here.`;
    return pill({ label: `${label} · ${formatNumber(count)} of ${formatNumber(tracked)} ${noun}`, tone, title: why });
  }

  if (scope !== 'portfolio' || !book?.count) return pill({ label: `${label} · ${formatNumber(count)} ${noun}`, tone });

  const gap = book.count - count;
  const why = [
    `The book holds ${formatNumber(book.count)} companies; ${formatNumber(count)} of them appear on this feed.`,
    book.uncovered ? `${formatNumber(book.uncovered)} carry no NSE symbol — unlisted holdings, warrant lines and BSE-only companies — so no feed here can ever show them.` : '',
    gap > (book.uncovered || 0) ? 'The rest are listed but not on this particular feed yet.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return pill({ label: `${label} · ${formatNumber(count)} of ${formatNumber(book.count)} ${noun}`, tone, title: why });
}

// Scrollable tabs with explicit overflow controls and manual keyboard activation.
export function tabBar({ tabs, activeId, onSelect, label = 'Sections' }) {
  let list = null;
  let revealActive = () => {};
  const html = `
    <div class="tab-bar" data-tab-bar>
      <div class="tab-list" role="tablist" aria-label="${escapeHtml(label)}" data-tab-list>
      ${tabs
        .map(
          (t) => `
        <button type="button" role="tab" data-tab-id="${escapeHtml(t.id)}" aria-selected="${t.id === activeId}"
          tabindex="${t.id === activeId ? 0 : -1}" class="tab-btn${t.id === activeId ? ' is-active' : ''}">
          ${escapeHtml(t.label)}
        </button>`
        )
        .join('')}
      </div>
      <div class="tab-scroll-controls" data-tab-scroll-controls hidden>
        <button type="button" class="tab-scroll-btn" data-tab-scroll="-1" aria-label="Scroll tabs left" title="Scroll tabs left">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m12 5-5 5 5 5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <button type="button" class="tab-scroll-btn" data-tab-scroll="1" aria-label="Scroll tabs right" title="Scroll tabs right">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m8 5 5 5-5 5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </div>
    </div>`;

  function wire(root) {
    const bar = root.querySelector('[data-tab-bar]');
    list = bar.querySelector('[data-tab-list]');
    const buttons = [...list.querySelectorAll('[data-tab-id]')];
    const controls = bar.querySelector('[data-tab-scroll-controls]');
    const previous = bar.querySelector('[data-tab-scroll="-1"]');
    const next = bar.querySelector('[data-tab-scroll="1"]');
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;

    const scrollTo = (left, animate = true) => list.scrollTo({ left, behavior: animate && !motion.matches ? 'smooth' : 'instant' });
    const reveal = (button, animate = true) => {
      if (!button) return;
      const bounds = list.getBoundingClientRect();
      const target = button.getBoundingClientRect();
      // Long labels on small screens take priority over the decorative edge fades.
      const inset = Math.max(0, Math.min(14, (bounds.width - target.width) / 2));
      if (target.left < bounds.left + inset) scrollTo(list.scrollLeft + target.left - bounds.left - inset, animate);
      else if (target.right > bounds.right - inset) scrollTo(list.scrollLeft + target.right - bounds.right + inset, animate);
    };
    const syncEdges = () => {
      const maxScroll = list.scrollWidth - list.clientWidth;
      previous.disabled = list.scrollLeft <= 1;
      next.disabled = list.scrollLeft >= maxScroll - 1;
      bar.dataset.canScrollLeft = String(!previous.disabled);
      bar.dataset.canScrollRight = String(!next.disabled);
    };
    const measure = () => {
      // Compare against the FULL available width, including the space controls would release.
      // Otherwise controls can keep themselves visible after the viewport grows to fit all tabs.
      controls.hidden = list.scrollWidth <= bar.clientWidth - 12 + 1;
      const focused = buttons.includes(document.activeElement) ? document.activeElement : null;
      reveal(focused || buttons.find((button) => button.dataset.tabId === activeId), false);
      syncEdges();
    };
    revealActive = () => {
      reveal(buttons.find((button) => button.dataset.tabId === activeId));
      syncEdges();
    };
    const tabStop = (button) => buttons.forEach((item) => { item.tabIndex = item === button ? 0 : -1; });
    const onClick = (event) => {
      const button = event.target.closest('[data-tab-id]');
      if (!button) return;
      tabStop(button);
      onSelect(button.dataset.tabId);
    };
    const onKeydown = (event) => {
      const index = buttons.indexOf(event.target);
      if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      let target;
      if (event.key === 'ArrowRight') target = buttons[(index + 1) % buttons.length];
      else if (event.key === 'ArrowLeft') target = buttons[(index - 1 + buttons.length) % buttons.length];
      else if (event.key === 'Home') target = buttons[0];
      else if (event.key === 'End') target = buttons.at(-1);
      else return; // Enter/Space activate the native button; arrows only move focus.
      event.preventDefault();
      tabStop(target);
      target.focus({ preventScroll: true });
      reveal(target);
    };
    const onScrollClick = (event) => {
      const button = event.target.closest('[data-tab-scroll]');
      if (button) scrollTo(list.scrollLeft + Number(button.dataset.tabScroll) * list.clientWidth * 0.75);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncEdges);
    };

    list.addEventListener('click', onClick);
    list.addEventListener('keydown', onKeydown);
    list.addEventListener('scroll', onScroll, { passive: true });
    controls.addEventListener('click', onScrollClick);
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    // Font loading can change the content width without changing the container's width.
    buttons.forEach((button) => observer.observe(button));
    measure();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      list.removeEventListener('click', onClick);
      list.removeEventListener('keydown', onKeydown);
      list.removeEventListener('scroll', onScroll);
      controls.removeEventListener('click', onScrollClick);
      revealActive = () => {};
      list = null;
    };
  }

  function update(nextActiveId) {
    activeId = nextActiveId;
    if (!list) return;
    for (const button of list.querySelectorAll('[data-tab-id]')) {
      const selected = button.dataset.tabId === activeId;
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('is-active', selected);
      button.tabIndex = selected ? 0 : -1;
    }
    revealActive();
  }

  return { html, wire, update };
}

// Scope segmented control with a sliding brand thumb.
export function segmentedToggle({ options, activeValue, onChange }) {
  // Every scope label fits comfortably inside 5rem. Fixed equal segments let the active thumb be
  // positioned without reading offsetWidth/offsetLeft after a tab has inserted a large table.
  // That read used to force layout of the newly-painted panel and cost 114ms in a transition trace.
  const activeIndex = Math.max(0, options.findIndex((option) => option.value === activeValue));
  const html = `
    <div class="relative inline-flex items-center rounded-full bg-white/70 p-0.5 ring-1 ring-slate-200" data-segmented>
      <span data-segmented-thumb class="absolute inset-y-0.5 left-0.5 w-20 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 shadow-sm transition-transform duration-200 ease-out"
        style="transform:translateX(${activeIndex * 5}rem);"></span>
      ${options
        .map(
          (o) => `
        <button type="button" data-value="${escapeHtml(o.value)}" aria-pressed="${o.value === activeValue}"
          class="relative z-10 w-20 rounded-full px-2 py-1.5 text-xs font-semibold transition-colors ${o.value === activeValue ? 'text-white' : 'text-slate-600 hover:text-slate-800'}">
          ${escapeHtml(o.label)}
        </button>`
        )
        .join('')}
    </div>`;

  function wire(root) {
    const wrap = root.querySelector('[data-segmented]');
    const onClick = (e) => {
      const btn = e.target.closest('[data-value]');
      if (btn) onChange(btn.dataset.value);
    };
    wrap.addEventListener('click', onClick);
    return () => wrap.removeEventListener('click', onClick);
  }

  return { html, wire };
}

// Sortable, sticky-header data table. Horizontal-scrolls inside its own container so the page
// body never scrolls sideways. Zebra-free — rows differentiate on hover only.
export function dataTable({ columns, rows, sortable = true, initialSort = null, emptyMessage = 'No data yet.' }) {
  function cellValue(row, col) {
    return col.render ? col.render(row) : escapeHtml(row[col.key] ?? '—');
  }

  function renderRows(list) {
    if (!list.length) {
      return `<tr><td colspan="${columns.length}">${emptyState({ title: emptyMessage })}</td></tr>`;
    }
    return list
      .map(
        (row) => `
      <tr class="border-t border-slate-50 transition-colors hover:bg-slate-50/70">
        ${columns.map((col) => `<td class="whitespace-nowrap px-3 py-2.5 text-sm text-slate-700 ${col.align === 'right' ? 'text-right tabular-nums' : ''}">${cellValue(row, col)}</td>`).join('')}
      </tr>`
      )
      .join('');
  }

  const html = `
    <div class="overflow-x-auto rounded-2xl ring-1 ring-slate-100" data-table-wrap>
      <table class="w-full min-w-max border-collapse text-sm">
        <thead class="sticky top-0 z-10 bg-slate-50/95 backdrop-blur">
          <tr>
            ${columns
              .map(
                (col) => `
              <th scope="col" data-col-key="${escapeHtml(col.key)}"
                class="whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 ${col.align === 'right' ? 'text-right' : 'text-left'} ${sortable && col.sortable !== false ? 'cursor-pointer select-none hover:text-slate-700' : ''}">
                <span class="inline-flex items-center gap-1">${escapeHtml(col.label)}${sortable && col.sortable !== false ? '<span class="sort-caret text-[10px] text-slate-300" data-caret>↕</span>' : ''}</span>
              </th>`
              )
              .join('')}
          </tr>
        </thead>
        <tbody data-table-body>${renderRows(rows)}</tbody>
      </table>
    </div>`;

  function wire(root) {
    if (!sortable) return () => {};
    const wrap = root.querySelector('[data-table-wrap]');
    const tbody = wrap.querySelector('[data-table-body]');
    let sortState = initialSort; // { key, dir: 'asc'|'desc' }
    let data = rows.slice();

    function applySort() {
      if (!sortState) return;
      const { key, dir } = sortState;
      const mul = dir === 'asc' ? 1 : -1;
      data = data.slice().sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av > bv ? 1 : -1) * mul;
      });
    }

    function updateCarets() {
      wrap.querySelectorAll('[data-col-key]').forEach((th) => {
        const caret = th.querySelector('[data-caret]');
        if (!caret) return;
        if (sortState && th.dataset.colKey === sortState.key) {
          caret.textContent = sortState.dir === 'asc' ? '▲' : '▼';
          caret.classList.remove('text-slate-300');
          caret.classList.add('text-teal-600');
        } else {
          caret.textContent = '↕';
          caret.classList.add('text-slate-300');
          caret.classList.remove('text-teal-600');
        }
      });
    }

    applySort();
    updateCarets();

    wrap.querySelectorAll('th[data-col-key]').forEach((th) => {
      const key = th.dataset.colKey;
      const col = columns.find((c) => c.key === key);
      if (!col || col.sortable === false) return;
      th.addEventListener('click', () => {
        const dir = sortState && sortState.key === key && sortState.dir === 'asc' ? 'desc' : 'asc';
        sortState = { key, dir };
        applySort();
        tbody.innerHTML = renderRows(data);
        updateCarets();
      });
    });

    return () => {};
  }

  return { html, wire };
}

// Small rounded label — status/tone chips (positive, negative, caution, neutral, brand, accent).
export function pill({ label, tone = 'neutral', title = '' }) {
  const c = toneClasses(tone);
  return `<span class="inline-flex items-center gap-1 rounded-full ${c.bg} ${c.text} ring-1 ${c.ring} px-2.5 py-1 text-xs font-semibold"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
}

// Compact numeric/status tag for inline table use (smaller than `pill`).
export function badge({ label, tone = 'neutral' }) {
  const c = toneClasses(tone);
  return `<span class="inline-flex items-center rounded-md ${c.bg} ${c.text} px-1.5 py-0.5 text-[11px] font-bold tabular-nums">${escapeHtml(label)}</span>`;
}

// Score-out-of-max pill, colour-scaled green/amber/red by ratio (quality scores, technical scores…).
export function scorePill({ score, max = 100 }) {
  const ratio = max ? score / max : 0;
  const tone = ratio >= 0.7 ? 'positive' : ratio >= 0.4 ? 'caution' : 'negative';
  const c = toneClasses(tone);
  return `<span class="inline-flex items-center rounded-full ${c.bg} ${c.text} ring-1 ${c.ring} px-2 py-0.5 text-xs font-bold tabular-nums">${formatNumber(score)}${max ? `<span class="ml-0.5 font-medium opacity-60">/${formatNumber(max)}</span>` : ''}</span>`;
}

// Row of toggleable filter chips (single- or multi-select, caller decides via onToggle logic).
export function filterChips({ options, activeIds = [], onToggle }) {
  const html = `
    <div class="flex flex-wrap gap-2" data-filter-chips>
      ${options
        .map(
          (o) => `
        <button type="button" data-chip-id="${escapeHtml(o.id)}"
          class="rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
            activeIds.includes(o.id) ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
          }">
          ${escapeHtml(o.label)}
        </button>`
        )
        .join('')}
    </div>`;

  function wire(root) {
    const wrap = root.querySelector('[data-filter-chips]');
    function handler(e) {
      const btn = e.target.closest('[data-chip-id]');
      if (btn) onToggle(btn.dataset.chipId);
    }
    wrap.addEventListener('click', handler);
    return () => wrap.removeEventListener('click', handler);
  }

  return { html, wire };
}

// Global search box with a ⌘K / Ctrl-K shortcut badge and a typeahead results dropdown.
export function searchInput({ placeholder = 'Search…', shortcutLabel = '⌘K', options = [], onSelect }) {
  const html = `
    <div class="relative w-full" data-search-root>
      <div class="relative">
        <svg class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
        </svg>
        <input type="text" data-search-input autocomplete="off" placeholder="${escapeHtml(placeholder)}"
          class="w-full rounded-xl bg-white py-2.5 pl-10 pr-14 text-sm text-slate-800 shadow-sm ring-1 ring-slate-200 transition-shadow placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        <kbd data-search-kbd class="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 ring-1 ring-slate-200 sm:inline-block">${escapeHtml(shortcutLabel)}</kbd>
      </div>
      <div data-search-results class="scrollbar-thin absolute left-0 right-0 top-full z-50 mt-2 hidden max-h-[420px] overflow-y-auto rounded-xl bg-white shadow-2xl ring-1 ring-slate-200"></div>
    </div>`;

  function wire(root) {
    const wrap = root.querySelector('[data-search-root]');
    const input = wrap.querySelector('[data-search-input]');
    const results = wrap.querySelector('[data-search-results]');

    function renderResults(matches) {
      if (!matches.length) {
        results.classList.add('hidden');
        results.innerHTML = '';
        return;
      }
      results.innerHTML = matches
        .slice(0, 8)
        .map(
          (m) => `
        <button type="button" data-result-ticker="${escapeHtml(m.ticker)}" class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-indigo-50/60">
          <span class="font-semibold text-slate-800">${escapeHtml(m.ticker)}</span>
          <span class="truncate text-slate-400">${escapeHtml(m.name)}</span>
        </button>`
        )
        .join('');
      results.classList.remove('hidden');
    }

    function close() {
      results.classList.add('hidden');
    }

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) return close();
      const matches = options.filter((o) => o.ticker.toLowerCase().includes(q) || o.name.toLowerCase().includes(q));
      renderResults(matches);
    });

    results.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-result-ticker]');
      if (!btn) return;
      // Fallback when the caller supplies no onSelect. The shell's global search passes one.
      if (onSelect) onSelect(btn.dataset.resultTicker);
      input.value = '';
      close();
    });

    function onKeydown(e) {
      const isShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isShortcut) {
        e.preventDefault();
        input.focus();
        input.select();
      } else if (e.key === 'Escape' && document.activeElement === input) {
        input.blur();
        close();
      }
    }
    document.addEventListener('keydown', onKeydown);

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });

    return () => document.removeEventListener('keydown', onKeydown);
  }

  return { html, wire };
}

// Layout row: left-aligned control group + right-aligned control group (chips, search, buttons…).
export function toolbar({ left = [], right = [] }) {
  return `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-2">${left.join('')}</div>
      <div class="flex flex-wrap items-center gap-2">${right.join('')}</div>
    </div>`;
}
// NOTE: the right-slide drill panel and the centred modal moved to ui/screener.js, where they
// are singleton overlays declared once in index.html. Import { openDrill, openModal } from
// './screener.js' rather than mounting per-tab copies.

// Centred placeholder for a panel/table with no data yet.
export function emptyState({ title = 'Nothing here yet', message = '', icon = '🗂️' }) {
  return `
    <div class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div class="text-3xl">${icon}</div>
      <div class="text-sm font-semibold text-slate-600">${escapeHtml(title)}</div>
      ${message ? `<div class="max-w-sm text-xs text-slate-400">${escapeHtml(message)}</div>` : ''}
    </div>`;
}

// Shimmering loading placeholder — `variant: 'rows'` for table-shaped skeletons, `'cards'` for stat cards.
export function skeleton({ rows = 4, variant = 'rows' } = {}) {
  if (variant === 'cards') {
    return `<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${Array.from({ length: rows })
      .map(() => '<div class="skeleton-shimmer h-20 rounded-2xl bg-slate-100"></div>')
      .join('')}</div>`;
  }
  return `<div class="flex flex-col gap-2">${Array.from({ length: rows })
    .map(() => '<div class="skeleton-shimmer h-9 rounded-lg bg-slate-100"></div>')
    .join('')}</div>`;
}

/**
 * The header status control: one pill reading `Connected · checked 4m ago`, plus a refresh button.
 *
 * It used to be two separate chips — a green "Live · just now" and a white "Updated 52 minutes
 * ago" — which read as two competing claims about the same thing and left the reader to work out
 * which mattered. They also measured different facts: the green one moved on the 20-second
 * heartbeat, which asks nothing of any server, so it said "just now" whether or not a single byte
 * of data had been confirmed in an hour.
 *
 * One pill, one honest timestamp: `getTimestamp` is wired to the last tick of a poller that
 * actually talked to a server (`live.getLastDataTick()`), falling back to when the page loaded its
 * data. It is a passive status label; the old source/freshness popup is intentionally gone.
 *
 * `onRefresh` returns `{ announced }` so the button can report a result instead of just spinning.
 */
export function statusControl({ getTimestamp, subscribeTick = null, onRefresh = null }) {
  const html = `
    <div class="flex items-center gap-1.5">
      <span data-status-pill title="Most recent server confirmation from an active feed"
        class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100">
        <span class="relative flex h-1.5 w-1.5">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
        </span>
        <span>Connected</span>
        <span class="text-emerald-300">·</span>
        <span data-live-time class="tabular-nums font-medium text-emerald-600">—</span>
      </span>
      <button type="button" data-header-refresh title="Check every live feed for new data now"
        class="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-200 disabled:cursor-wait disabled:opacity-60">
        <svg data-header-refresh-icon width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
        </svg>
        <span data-header-refresh-label>Refresh</span>
      </button>
    </div>`;

  function wire(root) {
    const timeEl = root.querySelector('[data-live-time]');
    const btn = root.querySelector('[data-header-refresh]');
    const icon = root.querySelector('[data-header-refresh-icon]');
    const label = root.querySelector('[data-header-refresh-label]');

    function refresh() {
      const ts = getTimestamp ? getTimestamp() : null;
      timeEl.textContent = ts ? `checked ${formatRelativeTime(ts)}` : 'connecting…';
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    const unsubscribe = subscribeTick ? subscribeTick(refresh) : null;

    // A REFRESH THAT NEVER RETURNS IS THE EXACT FAILURE THIS BUTTON EXISTS TO PREVENT.
    //
    // `refreshAll()` awaits every running poller's fetcher, and an upstream that accepts the
    // connection without answering leaves that promise pending for ever. The button was then
    // stuck on "Checking…" AND disabled — no result, no retry, and the one control on the page
    // whose whole job is to say whether the data was confirmed saying nothing at all.
    //
    // So the wait is bounded, and both failure modes report themselves. "Couldn't check" is a
    // result; a spinner is not. What must never happen is the third option the old code took on
    // the error path: printing "Up to date" after a check that did not complete, which claims a
    // freshness nothing confirmed — the same rule that governs `meta.checkedAt`.
    const REFRESH_TIMEOUT_MS = 15000;
    const TIMED_OUT = Symbol('timeout');
    let resetTimer = null;
    async function doRefresh() {
      if (btn.disabled) return;
      btn.disabled = true;
      clearTimeout(resetTimer);
      icon.classList.add('spin-slow');
      label.textContent = 'Checking…';
      let announced = 0;
      let pending = false;
      let failed = false;
      let timer = null;
      try {
        const outcome = await Promise.race([
          Promise.resolve(onRefresh?.()),
          new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), REFRESH_TIMEOUT_MS); }),
        ]);
        if (outcome === TIMED_OUT) failed = true;
        // `pending` is a THIRD outcome and not a failure: the per-company feeds are one request per
        // company, so a walk can still be running perfectly well when the button's patience runs
        // out. Saying "Couldn't check" about work that is proceeding is the same class of lie as
        // saying "Up to date" about a check that did not complete.
        else ({ announced = 0, pending = false } = outcome || {});
      } catch (err) {
        console.error('[status] refresh failed', err);
        failed = true;
      } finally {
        clearTimeout(timer);
      }
      icon.classList.remove('spin-slow');
      // Say what happened. "Up to date" is a real answer and the common one — a spinner that
      // vanishes leaves the reader unsure whether anything was checked at all.
      label.textContent = failed ? 'Couldn’t check' : pending ? 'Still reading…' : announced ? `${announced} new` : 'Up to date';
      refresh();
      btn.disabled = false;
      resetTimer = setTimeout(() => { label.textContent = 'Refresh'; }, 4000);
    }
    btn.addEventListener('click', doRefresh);

    return () => {
      clearInterval(interval);
      clearTimeout(resetTimer);
      unsubscribe?.();
    };
  }

  return { html, wire };
}

// Pulsing-dot "Live" indicator + relative last-update time. Refreshes on every poller tick via
// `subscribeTick`, plus on a slow interval so the relative time ("2m ago") keeps ageing.
export function liveBadge({ label = 'Live', getTimestamp, subscribeTick = null }) {
  const html = `
    <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100" data-live-badge>
      <span class="relative flex h-1.5 w-1.5">
        <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
        <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
      </span>
      <span>${escapeHtml(label)}</span>
      <span class="text-emerald-300">·</span>
      <span data-live-time class="tabular-nums text-emerald-600">—</span>
    </span>`;

  function wire(root) {
    const timeEl = root.querySelector('[data-live-time]');
    function refresh() {
      const ts = getTimestamp ? getTimestamp() : null;
      timeEl.textContent = ts ? formatRelativeTime(ts) : 'waiting…';
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    const unsubscribe = subscribeTick ? subscribeTick(refresh) : null;
    return () => {
      clearInterval(interval);
      unsubscribe?.();
    };
  }

  return { html, wire };
}

// Tiny inline SVG sparkline — no chart library, just a polyline scaled to fit the box.
export function spark({ values = [], width = 64, height = 24, tone = 'brand' } = {}) {
  const strokeByTone = { brand: '#0d9488', accent: '#7c3aed', positive: '#059669', negative: '#e11d48', neutral: '#64748b' };
  const stroke = strokeByTone[tone] || strokeByTone.brand;
  if (!values.length) return `<svg width="${width}" height="${height}" aria-hidden="true"></svg>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`).join(' ');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

// Hover tooltip: wraps `trigger` markup and reveals `content` above/below it on hover/focus.
export function tooltip({ trigger, content, position = 'top' }) {
  const sideClass = position === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5';
  return `
    <span class="group relative inline-flex items-center">
      ${trigger}
      <span class="pointer-events-none absolute left-1/2 ${sideClass} z-50 -translate-x-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
        ${escapeHtml(content)}
      </span>
    </span>`;
}
