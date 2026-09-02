// tabs/daily-alerts.js — GENERAL ALERTS, THE COMPLETE CHRONOLOGICAL STREAM.
//
// Every other tab here is organised by SOURCE: this is what the results feed holds, this is what
// BSE filed, this is what the technicals scrape measured. That is the right shape for research and
// the wrong shape for prioritisation, when the question is not "what does Moneycontrol have" but
// "what happened, and does any of it need me". AI Alerts answers that narrower question. This tab
// remains the complete TIME view: one stream, every feed, newest first through retained history.
//
// It introduces no data source of its own — see js/data/daily-alerts.js, which is where the
// readings are taken and where the rule for each one is written down.
//
// ---------------------------------------------------------------------------------------
// DIRECTION AND IMPORTANCE ARE SEPARATE. Green/red/grey reproduce an explicit source band,
// transaction direction, or the conservative rule printed beside the row. High/Low is a second
// badge driven by the stated thresholds in data/daily-alerts.js. Neither is left unexplained.
//
// ---------------------------------------------------------------------------------------
// THE COVERAGE PANEL IS NOT DECORATION — IT IS THE HALF THAT MAKES AN EMPTY DAY READABLE
//
// Most of these feeds are committed captures on a best-effort schedule. So a bucket with nothing in
// it has two completely different meanings — nobody filed, or nothing has looked at today yet — and
// a consolidated page that showed only the events would present the second as the first on every
// weekend, every holiday and every morning before the scrapes run. `Feeds read for this day` states,
// per feed, when it last looked and whether that reaches today. It is the same rule as the filings
// tabs' "63 companies have not been checked since": never claim nothing is new.

import { scoreTable, sectionHead } from '../ui/screener.js';
import { scopeSummary, pill } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as refresh from '../core/refresh.js';
import * as alerts from '../data/daily-alerts.js';
import * as coverage from '../data/coverage.js';
import { scopeLabel } from '../data/scope.js';

export const meta = {
  id: 'daily-alerts',
  title: 'General Alerts',
  subtitle: 'Every retained alert in one newest-first timeline.',
  // No rail. This is one stream and splitting it by feed would rebuild the tabs it exists to
  // collapse — the feed filter in the toolbar does that job without costing a navigation.
  subviews: [],
};

const REFRESH_ID = 'daily-alerts';

// ---------------------------------------------------------------------------------------
// Module state
//
// `ctxRef` IS THE LIFECYCLE GUARD, and it is the thing the shell actually owns: `render()` runs
// again on every scope change, so a subscription guarded by a token captured inside one render is
// alive until the reader touches the scope toggle and dead afterwards (CLAUDE.md, the module
// interface contract). Every handler below re-reads `ctxRef` instead of closing over a ctx.
// ---------------------------------------------------------------------------------------
let ctxRef = null;
let report = null; // the last collected report
let loadToken = 0;
let unsubs = [];
let tableView = null; // the reader's search / filters / sort, carried across repaints
let routeCompany = null; // a company deep-link supplied by an AI Alert card
// WHICH FEEDS ARE TICKED. `null` means All — deliberately not "a Set holding every id", because
// those are different claims the moment a feed appears or disappears: All keeps meaning all, while
// a full Set silently becomes a partial filter when a sixth feed is added. The same distinction
// `scopeTickers` draws between `null` and an empty Set, for the same reason.
let picked = null;

export function render(ctx) {
  ctxRef = ctx;

  // AI ALERTS LINKS TO THE COMPLETE EVIDENCE FOR ONE COMPANY. Seed the existing table search
  // rather than inventing a second company filter. Entering through that link resets an earlier
  // General Alerts filter state: "See all" cannot quietly retain e.g. Today-only or one feed and
  // then show an empty subset. Subsequent feed repaints retain the new table's own state as usual.
  const requestedCompany = String(ctx.params?.company || '').trim();
  if (requestedCompany && requestedCompany !== routeCompany) tableView = { q: requestedCompany };
  else if (!requestedCompany && routeCompany) tableView = { ...(tableView || {}), q: '' };
  routeCompany = requestedCompany || null;

  if (!unsubs.length) {
    // NOTHING SUBSCRIBED. The owning tabs may poll while mounted, but this consolidated page takes
    // one cached/snapshot reading on mount and another only when the reader presses Refresh.
    unsubs.push(
      refresh.register(REFRESH_ID, {
        label: 'General Alerts',
        // A REFRESH HERE COSTS NOTHING PER COMPANY. Earnings, con-calls and chatter each expose a
        // bounded one-shot revalidation; investors revalidate the one bulk snapshot. The owning
        // Super Investors tab keeps the deliberate ninety-one-book walk behind its own control.
        refresh: async () => {
          const before = new Set((report?.events || []).map((e) => e.id));
          await recollect(ctxRef, { refresh: true });
          const now = report?.events || [];
          // IDENTITIES, NEVER SIZES. A count cannot answer "did anything change" for a collection
          // that can gain and lose rows in the same read — the day rolls over, a capture lands, a
          // story drops off the end. Same rule, and same failure, as the news Fetch button.
          const added = now.filter((e) => !before.has(e.id)).length;
          return { added, checked: (report?.feeds || []).filter((f) => f.status === 'ok').length };
        },
      })
    );
  }

  // A REPORT FOR ANOTHER SCOPE IS NOT A HEAD START, IT IS THE WRONG ANSWER. `render()` runs again
  // on every scope change and the module keeps its last report so a return visit paints instantly
  // — but that report was collected FOR a scope, and painting Universe's rows under a Portfolio
  // pill for the second before the new collect lands is the page stating something untrue.
  if (report && report.scope !== ctx.scope) report = null;

  // Paint immediately with whatever is already collected, then collect. A tab that renders nothing
  // until every feed has answered is a blank timeline.
  paint(ctx);
  recollect(ctx);
}

export function destroy() {
  ctxRef = null;
  cancelThrottledPaint();
  for (const off of unsubs) {
    try {
      off && off();
    } catch (err) {
      console.error('[daily-alerts] cleanup failed', err);
    }
  }
  unsubs = [];
}

/**
 * Re-read every feed and repaint.
 *
 * `loadToken` closes the obvious race: a scope change while a collect is in flight would otherwise
 * paint the previous scope's rows over the new one. The token is compared against the module's
 * counter, not against a captured ctx, for the same reason the subscriptions are.
 */
async function recollect(ctx, { refresh: forceRefresh = false } = {}) {
  // NO "already collecting" EARLY RETURN. `render()` runs again on every scope change, so bailing
  // out because a collect was in flight would leave the new scope showing the old scope's rows for
  // ever — the guard has to be about which result is allowed to PAINT, not about which reads are
  // allowed to start. Every read below is a conditional GET against a file or a cached route, so
  // an overlapping one costs a revalidation, not a download.
  const token = ++loadToken;
  try {
    const next = await alerts.collect({
      scope: ctx.scope,
      holdings: coverage.holdings(),
      // The source snapshots already retain history. The old tab threw those rows away with
      // `date === today`; the timeline keeps them and lets the table reveal older days as its
      // internal scroller advances. No request per company and no new route are introduced.
      includeHistory: true,
      refresh: forceRefresh,
      // Feeds land one at a time and the page follows them. Coalesced, because eight arrivals is
      // eight full rebuilds of a table the reader may be typing into — a TRAILING THROTTLE rather
      // than a debounce, since a debounce would keep deferring while feeds kept landing and the
      // page would sit still until the slowest of them finished, which is the thing this exists to
      // stop. The final report below paints immediately, so the settled state never waits on a timer.
      onPartial: (partial) => {
        if (token !== loadToken || !ctxRef) return;
        report = partial;
        throttledPaint();
      },
    });
    if (token !== loadToken || !ctxRef) return;
    cancelThrottledPaint();
    report = next;
    paint(ctxRef);
  } catch (err) {
    console.error('[daily-alerts] collect failed', err);
  }
}

// ---- the trailing throttle ------------------------------------------------------------
const PAINT_COALESCE_MS = 250;
let paintTimer = null;
let paintedAt = 0;

function throttledPaint() {
  const wait = Math.max(0, PAINT_COALESCE_MS - (Date.now() - paintedAt));
  if (paintTimer) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    paintedAt = Date.now();
    if (ctxRef) paint(ctxRef);
  }, wait);
}

function cancelThrottledPaint() {
  if (paintTimer) clearTimeout(paintTimer);
  paintTimer = null;
  paintedAt = Date.now();
}


// ---------------------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------------------

function paint(ctx) {
  const day = report?.day || alerts.today();
  const events = report?.events || [];
  const feeds = report?.feeds || [];
  const m = report?.meta || {};

  // THE FEEDS ON OFFER, AND THEN THE ONES TICKED. Market-wide news carries no company, so under a
  // narrowed scope it contributes nothing and is not shown as a filter — the reason it is absent
  // stays in the source registry. Dropping the chip is not dropping the claim.
  const shown = feeds.filter((f) => ctx.scope === 'universe' || f.scopable !== false);
  const available = shown.map((f) => f.id);
  // A SELECTION THAT SURVIVES A REPAINT BUT NOT A VANISHED FEED. Rows land while feeds settle and
  // every arrival repaints, so the ticks live in the module; but a scope change can take a feed
  // off the page entirely, and a tick on a feed that is no longer offered would filter the stream
  // to nothing with no visible control explaining why.
  if (picked) {
    picked = new Set([...picked].filter((id) => available.includes(id)));
    if (!picked.size || picked.size === available.length) picked = null;
  }
  const visible = picked ? events.filter((e) => picked.has(e.feed)) : events;

  const focus = captureFocus(ctx.root);
  const table = eventsTable(ctx, visible, day);
  tableView = table.view;

  // NO DESCRIPTION AND NO STAT STRIP. The four cards were the loudest version of
  // the problem: three of them counted rows the table beneath them already lists, and the fourth
  // printed a date the pill now carries. The pill is deliberately passive; full provenance stays
  // in the source registry and export — see the stat-strip opt-out rule in CLAUDE.md.
  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'General Alerts',
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${livePill(report, day)}${pendingPill(report)}${scopeSummary({
        scope: ctx.scope,
        count: m.companies || 0,
        noun: 'companies in loaded history',
        book: coverage.meta(),
      })}${historyPill(m)}</div>`,
    })}
    ${coveragePanel(shown, day, ctx.scope)}
    ${table.html}`;

  table.wire(ctx.root);
  wireFeedFilter(ctx, available);
  fitStreamToViewport(ctx.root);
  restoreFocus(ctx.root, focus);
}

/**
 * KEEP THE READER'S CARET WHERE THEY LEFT IT.
 *
 * This panel repaints as each feed lands — eight times on a cold visit, over about three seconds —
 * and a repaint replaces `ctx.root.innerHTML`, which takes the focus and the caret out of the
 * search box somebody may be typing into. `initialView` already carries the TEXT across; this
 * carries the cursor. Same class of thing the News tab handles by rebuilding only its list.
 *
 * Only the search input, and only while it is genuinely focused inside this panel: restoring focus
 * to a control the reader was not using would be its own kind of rude.
 */
function captureFocus(root) {
  const el = document.activeElement;
  // Matched on the kit's own hook rather than on `type`, which is `text` — the screener's search
  // box is not an `<input type="search">`, and testing for one would silently never fire.
  if (!el || !root.contains(el) || !el.matches?.('[data-table-search]')) return null;
  return { start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(root, focus) {
  if (!focus) return;
  const el = root.querySelector('[data-table-search]');
  if (!el) return;
  el.focus();
  try {
    el.setSelectionRange(focus.start, focus.end);
  } catch {
    // Some browsers refuse setSelectionRange on certain input types — the focus is the useful half.
  }
}

/**
 * The one always-visible statement of what this page is and where it came from.
 *
 * IT CARRIES THE DATE ON ITS FACE, and that is not decoration: this is the one tab defined by a
 * DAY, the date is in IST rather than UTC (a UTC date names yesterday for five and a half hours
 * every evening), and a screenshot travels without the source registry. Detailed provenance stays
 * in that registry and the export.
 *
 * IT IS GREEN ONLY WHEN THE DATA EARNS IT. Every feed reaching today is the claim; one behind is
 * amber and says so, because a chip that reads Live over a feed that has not looked at today is
 * the same false freshness claim as the header chip that tracked a heartbeat and asked no server
 * anything.
 */
function livePill(rep, day) {
  const feeds = rep?.feeds || [];
  const behind = feeds.filter((f) => f.reachesToday === false).length;
  const reading = rep?.pending ?? 0;
  const label = `${fmtDay(day)}`;
  if (behind || reading) {
    return `<span data-alerts-info
       class="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-300"
       title="${escapeHtml(behind ? `${behind} feed${behind === 1 ? ' has' : 's have'} not looked at today yet.` : 'Still reading.')}">
       <span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span> ${escapeHtml(label)}
     </span>`;
  }
  return `<span data-alerts-info
     class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200"
     title="Every feed on this page has looked at today. Indian trading date, not UTC.">
     <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span> Live · ${escapeHtml(label)}
   </span>`;
}

/** `2026-09-01` -> `01 Sept 2026`, so the chip reads as a date rather than as an id. */
function fmtDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
/**
 * How many feeds have not answered yet — a statement about US, not about the day.
 *
 * It names the count rather than saying "loading", because a partial page that looks finished is
 * the failure this whole tab is built to avoid: a reader who sees four rows and no pill has no way
 * to know that four more feeds are still being read.
 */
function pendingPill(rep) {
  const n = rep?.pending ?? 0;
  if (!n) return '';
  return pill({ label: `Reading ${n} more ${n === 1 ? 'feed' : 'feeds'}…`, tone: 'neutral' });
}

/** The retained range currently represented in the scrollable stream. */
function historyPill(historyMeta) {
  if (!historyMeta?.oldestEventDay || !historyMeta?.newestEventDay) return '';
  const dates = historyMeta.days || 1;
  return pill({
    label: `History · ${dates} ${dates === 1 ? 'date' : 'dates'}`,
    tone: 'neutral',
    title: `${fmtDay(historyMeta.oldestEventDay)} through ${fmtDay(historyMeta.newestEventDay)}, newest first.`,
  });
}

// ---------------------------------------------------------------------------------------
// The coverage panel — one row per feed
// ---------------------------------------------------------------------------------------

function coveragePanel(feeds, day, scope) {
  if (!feeds.length) {
    return `<div class="mb-5 text-xs text-slate-400" data-alerts-coverage>Reading the feeds…</div>`;
  }

  const box = (on) => `
    <span class="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border transition-colors ${
      on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 bg-white text-transparent'
    }">
      <svg viewBox="0 0 12 12" class="h-2.5 w-2.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5 4.7 9 10 3.5"/></svg>
    </span>`;

  const total = feeds.reduce((a, f) => a + (f.count || 0), 0);
  const allOn = !picked;
  const chips = [
    `<button type="button" data-feed-toggle="__all" role="checkbox" aria-checked="${allOn}"
       title="Show every feed on this page. This is the default."
       class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5 transition-colors hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
       ${box(allOn)}
       <span class="font-semibold ${allOn ? 'text-slate-800' : 'text-slate-500'}">All</span>
       <span class="font-semibold text-slate-400">${escapeHtml(formatNumber(total))}</span>
     </button>`,
  ];

  for (const f of feeds) {
    const st = feedState(f);
    const on = !!picked && picked.has(f.id);
    // THE TOOLTIP CARRIES THE SENTENCE THE ROW USED TO PRINT, and the modal carries all of it in a
    // table. Compressing the panel may not compress what it is accountable for.
    const title = [
      `${f.label}: ${st.label}.`,
      `${formatNumber(f.count || 0)} retained event${f.count === 1 ? '' : 's'}; ${formatNumber(f.todayCount || 0)} on ${day}.`,
      f.note || f.what,
      f.asOf ? `Last read ${formatRelativeTime(f.asOf)}.` : null,
      'Tick to show only the ticked feeds.',
    ]
      .filter(Boolean)
      .join(' ');
    chips.push(`
      <button type="button" data-feed-toggle="${escapeHtml(f.id)}" data-feed="${escapeHtml(f.id)}"
        role="checkbox" aria-checked="${on}" title="${escapeHtml(title)}"
        class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5 transition-colors hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
        ${box(on)}
        <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full ${st.dot}"></span>
        <span class="font-semibold ${on || allOn ? 'text-slate-700' : 'text-slate-400'}">${escapeHtml(f.label)}</span>
        <span class="font-semibold ${st.text}">${escapeHtml(st.short(f))}</span>
      </button>`);
  }

  return `
    <section class="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs" data-alerts-coverage>
      ${chips.join('')}
    </section>`;
}

/**
 * Size the stream so its bottom edge lands just above the fold, whatever is above it.
 *
 * THE HEIGHT OF THE HEAD IS NOT A CONSTANT, which is what a `calc(100vh - 558px)` assumes. It
 * changes with the window width (the chip row wraps), with how many feeds are on offer (four under
 * a narrowed scope, five under Universe), and with the reader's zoom. Measured against one window
 * the constant was exact and the table ended 24px above the fold; on a wider one it stopped about
 * 110px short, which is the dead band this exists to remove. So the number is read from the
 * element itself, after the paint, rather than written down.
 *
 * Re-applied on resize, and the listener is returned to `unsubs` so it dies with the tab — a
 * window listener re-registered on every repaint is a leak that grows with every feed that lands.
 */
let unfit = null;
function fitStreamToViewport(root) {
  if (unfit) {
    unfit();
    unfit = null;
  }
  const el = root.querySelector('[data-table-scroll]');
  if (!el) return;
  const set = (h) => {
    el.style.maxHeight = `${h}px`;
    el.style.height = `${h}px`;
  };
  const apply = () => {
    if (!el.isConnected) return;
    // Viewport-relative, and only meaningful at the top of the page — which is where the reader is
    // when this matters, because a table that fills the viewport leaves the page nothing to scroll.
    const top = el.getBoundingClientRect().top;
    let h = Math.max(MIN_STREAM_PX, Math.round(window.innerHeight - top - STREAM_BOTTOM_GAP_PX));
    set(h);
    // NO "CORRECT FOR THE RESIDUAL PAGE SCROLL" PASS HERE, and that is deliberate. There is a 16px
    // overflow in a sandbox with no Tailwind — `body` keeps the browser's default 8px margin
    // because preflight never loads, on top of a `min-height: 100vh` — and shrinking the table by
    // it changed the document height not at all, because the floor is the min-height rather than
    // the content. Compensating would have made the table 16px short for every real reader to fix
    // something only the sandbox has. Measure what the element needs; do not chase the page.

  };
  apply();
  const onResize = () => apply();
  window.addEventListener('resize', onResize);
  unfit = () => window.removeEventListener('resize', onResize);
  unsubs.push(unfit);
}

// Enough table to be worth having on a short window, and enough margin to keep the card's bottom
// edge and its shadow off the fold.
const MIN_STREAM_PX = 320;
const STREAM_BOTTOM_GAP_PX = 24;

/**
 * The tick boxes, which filter the stream by the feed a row came from.
 *
 * `All` IS `null`, NOT "every id ticked" — see the declaration of `picked`. Two behaviours follow
 * and both are deliberate: ticking every feed individually collapses back to All rather than
 * leaving a filter that only looks like one, and unticking the last feed returns to All rather
 * than emptying the stream. A reader who has just unticked their way to a blank page has no
 * control on screen saying why it is blank, and "no events today" is a claim this page may not
 * make on the strength of a filter the reader set.
 */
function wireFeedFilter(ctx, available) {
  const root = ctx.root.querySelector('[data-alerts-coverage]');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-feed-toggle]');
    if (!btn) return;
    const id = btn.dataset.feedToggle;
    if (id === '__all') {
      picked = null;
    } else {
      const next = new Set(picked || available);
      // From All, the first tick means "only this one" — ticking one box out of an implicit
      // everything and getting everything-minus-nothing would be a control that does nothing.
      if (!picked) next.clear();
      if (next.has(id)) next.delete(id);
      else next.add(id);
      picked = next.size && next.size < available.length ? next : null;
    }
    paint(ctx);
  });
}

/**
 * The four states a feed can be in, kept apart deliberately.
 *
 * EXPORTED BECAUSE IT IS THE RULE, not because a tab needs it — the same reason `moveSeverity` is.
 * The branch that matters most here is the one that must never print a number, and it can only be
 * reached on a day a feed is actually behind, which most days it is not: asserting it through the
 * rendered panel passes vacuously and proves nothing. The suite calls this directly instead.
 *
 * "Behind" and "failed" are different things an operator does different things about, and neither
 * is "no events" — collapsing any two of them would throw away the only information that makes the
 * panel worth having.
 */
export function feedState(f) {
  // `label` is the full wording carried by the chip title. `short` is what the
  // compact chip shows, and the two must agree: a chip that reads `0` under a feed whose state is
  // "has not looked at today" would be the exact confusion this panel exists to prevent — a count
  // is a finished answer and that state is the absence of one, so it prints a WORD, never a number.
  const n = (x) => formatNumber(x || 0);
  // PENDING IS ITS OWN STATE. A feed nobody has heard from yet must never be drawn as "nothing
  // today" — that is a finished answer, and this is the absence of one.
  if (f.status === 'pending') {
    return { label: 'reading…', short: () => 'reading…', dot: 'bg-slate-300 animate-pulse', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-slate-400' };
  }
  if (f.status === 'failed') {
    return { label: 'source is updating', short: () => 'updating', dot: 'bg-slate-300 animate-pulse', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-slate-500' };
  }
  if (f.scopable === false) {
    return { label: 'not in this scope', short: () => 'not in scope', dot: 'bg-slate-300', ring: 'ring-slate-100', bg: 'bg-slate-50/50', text: 'text-slate-400' };
  }
  if (f.reachesToday === false) {
    return { label: 'latest available capture', short: () => 'latest', dot: 'bg-slate-300', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-slate-500' };
  }
  const todayCount = f.todayCount ?? f.count ?? 0;
  if (todayCount) {
    return { label: 'current', short: (x) => n(x.count), dot: 'bg-emerald-500', ring: 'ring-emerald-100', bg: 'bg-emerald-50/40', text: 'text-emerald-700' };
  }
  return { label: 'current · nothing today', short: (x) => n(x.count), dot: 'bg-emerald-500', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-emerald-700' };
}

// ---------------------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------------------

// The row tint plus a 3px left edge in the direction's semantic colour. NO `hover:` class here —
// `scoreTable` appends its own `hover:bg-slate-50`
// after whatever `rowClass` returns, and two hover rules on one element are decided by stylesheet
// order rather than by class order, which is a coin toss dressed up as a decision.
const DIR = {
  positive: { label: 'Positive', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200', row: 'bg-emerald-50/30 shadow-[inset_3px_0_0_#059669]', reason: 'text-emerald-700' },
  negative: { label: 'Negative', chip: 'bg-rose-50 text-rose-700 ring-rose-200', row: 'bg-rose-50/40 shadow-[inset_3px_0_0_#e11d48]', reason: 'text-rose-700' },
  neutral: { label: 'Neutral', chip: 'bg-slate-100 text-slate-600 ring-slate-200', row: 'shadow-[inset_3px_0_0_#94a3b8]', reason: 'text-slate-500' },
};
const IMP = {
  high: 'bg-violet-50 text-violet-700 ring-violet-200',
  low: 'bg-slate-50 text-slate-500 ring-slate-200',
};

function eventsTable(ctx, events, day) {
  return scoreTable({
    rows: events,
    // Content-derived and unique per event — never a position. The stream grows while feeds land,
    // so an index in the key would make one key mean a different row on every arrival, which is
    // exactly what made the News table look as though it were duplicating rows.
    key: (e) => e.id,
    // THE STAR MARKS THE COMPANY, NOT THE EVENT. Three announcements from one filer are three rows
    // and one watched company; a market-wide story has no company and gets no star at all.
    watchKey: (e) => e.ticker || null,
    watchName: (e) => e.company,
    name: (e) => e.company,
    nameLabel: 'Company',
    nameMaxPx: 220,
    sub: (e) => [e.ticker, e.section, e.feedLabel].filter(Boolean).join(' · '),
    showRank: false,
    // Date and time lead every row. Some feeds resolve only to a day; saying "Day only" is more
    // informative than an em dash and keeps older rows intelligibly ordered as the reader scrolls.
    nameAfter: 1,
    dense: true,
    wrapHeads: true,
    // A FIRST-FRAME FALLBACK ONLY — `fitStreamToViewport` sets the real height after the paint.
    // A `calc(100vh - <constant>)` cannot do this job: the constant IS the height of everything
    // above the table, and that varies with the window width (the chip row wraps), with the
    // number of feeds on offer, and with the reader's zoom. Measured against my own window it was
    // exact, and on a wider one the table stopped ~110px short — a magic number that was only ever
    // right for the geometry it was measured on.
    stickyHead: 'max(320px, calc(100vh - 560px))',
    // This is a historical stream, not a screener whose full DOM is useful for Ctrl-F. Keep the
    // complete data set in the table model, but append DOM rows only as the internal scroller nears
    // its end. Search, filters, counts and export still operate over every retained event.
    fillMode: 'scroll',
    rowClass: (e) => DIR[e.direction]?.row || DIR.neutral.row,
    columns: [
      {
        label: 'Date / time',
        align: 'left',
        get: (e) => `<time datetime="${escapeHtml(e.day || '')}" data-event-day="${escapeHtml(e.day || '')}" class="block whitespace-nowrap tabular-nums text-slate-700">
          <span class="block font-medium">${escapeHtml(fmtDay(e.day || ''))}</span>
          <span class="block text-xs ${e.time ? 'text-slate-500' : 'text-slate-400'}">${e.time ? `${escapeHtml(e.time)} IST` : 'Day only'}</span>
        </time>`,
        html: true,
        sortValue: (e) => `${e.day || ''}T${e.time || ''}`,
      },
      {
        label: 'Direction',
        get: (e) => {
          const s = DIR[e.direction] || DIR.neutral;
          return `<span class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${s.chip}">${s.label}</span>`;
        },
        html: true,
        sortValue: (e) => e.direction,
      },
      {
        label: 'Importance',
        get: (e) => `<span class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${IMP[e.importance] || IMP.low}">${escapeHtml(e.importance || 'low')}</span>`,
        html: true,
        sortValue: (e) => (e.importance === 'high' ? 1 : 0),
      },
      {
        label: 'What happened',
        get: (e) => `
          <div class="max-w-[560px]">
            <div class="truncate font-medium text-slate-800" title="${escapeHtml(e.headline)}">${escapeHtml(e.headline)}</div>
            <div class="truncate text-xs text-slate-500" title="${escapeHtml(e.detail || '')}">${escapeHtml(e.detail || '')}</div>
            <div class="mt-0.5 truncate text-xs font-semibold ${(DIR[e.direction] || DIR.neutral).reason}" title="${escapeHtml(e.signalReason || '')}">${escapeHtml(e.signalReason || '')}</div>
            <div class="truncate text-[11px] text-slate-400" title="${escapeHtml(e.importanceReason || '')}">${escapeHtml(e.importanceReason || '')}</div>
          </div>`,
        html: true,
        sortValue: (e) => String(e.headline || '').toLowerCase(),
      },
      { label: 'Feed', get: (e) => e.feedLabel },
    ],
    link: (e) => e.url || null,
    // THE ROW OPENS THE SOURCE. It used to navigate to the tab that owns the feed, which put two
    // clicks and a scan between the reader and the thing the row is about — they had already read
    // the headline here. A row with no URL falls back to its tab, because a click that silently
    // does nothing is worse than one that goes somewhere useful; nothing here reproduces the
    // article, which is the rule that actually matters (see the con-call link rule in CLAUDE.md).
    onRowClick: (e) => {
      if (e.url) {
        window.open(e.url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (e.tab) location.hash = `#/research/${e.tab}?scope=${ctx.scope}`;
    },
    searchable: (e) => `${e.day || ''} ${e.time || ''} ${e.company} ${e.ticker || ''} ${e.direction || ''} ${e.importance || ''} ${e.headline} ${e.detail || ''} ${e.signalReason || ''} ${e.importanceReason || ''} ${e.feedLabel}`,
    filters: [
      {
        label: 'Direction',
        options: [
          { value: 'all', label: 'Every direction' },
          { value: 'positive', label: 'Positive only' },
          { value: 'negative', label: 'Negative only' },
          { value: 'neutral', label: 'Neutral only' },
        ],
        match: (e, v) => e.direction === v,
      },
      {
        label: 'Importance',
        options: [
          { value: 'all', label: 'High and low' },
          { value: 'high', label: 'High only' },
          { value: 'low', label: 'Low only' },
        ],
        match: (e, v) => e.importance === v,
      },
      {
        label: 'Feed',
        options: [{ value: 'all', label: 'Every feed' }, ...feedOptions(events)],
        match: (e, v) => e.feed === v,
      },
      {
        label: 'Date range',
        options: dateRangeOptions(events, day),
        match: (e, v) => matchesDateRange(e.day, day, v),
      },
    ],
    initialSort: { key: 'Date / time', dir: 'desc' },
    initialView: tableView,
    emptyMessage: emptyMessageFor(ctx.scope, day),
    exportName: `sattva-general-alerts-through-${day}`,
    onExport: (visible) => exportStream(visible, day, ctx.scope),
  });
}

function shiftDay(day, amount) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

function dateRangeOptions(events, day) {
  const options = [
    { value: 'all', label: 'All available dates' },
    { value: 'today', label: 'Today only' },
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
  ];
  if (events.some((event) => event.day < shiftDay(day, -29))) options.push({ value: 'older', label: 'Older than 30 days' });
  return options;
}

function matchesDateRange(eventDay, throughDay, range) {
  if (!eventDay || range === 'all') return !!eventDay;
  if (range === 'today') return eventDay === throughDay;
  if (range === '7d') return eventDay >= shiftDay(throughDay, -6) && eventDay <= throughDay;
  if (range === '30d') return eventDay >= shiftDay(throughDay, -29) && eventDay <= throughDay;
  if (range === 'older') return eventDay < shiftDay(throughDay, -29);
  return true;
}

const feedOptions = (events) => {
  const seen = new Map();
  for (const e of events) if (!seen.has(e.feed)) seen.set(e.feed, e.feedLabel);
  return [...seen].map(([value, label]) => ({ value, label }));
};

/**
 * The empty table's message, which must not overstate what an empty table means.
 *
 * "Nothing happened today" is a claim nobody measured — the coverage panel above says which feeds
 * have actually looked. So this says what IS true: nothing reached this page, and points at the
 * panel that explains why.
 */
function emptyMessageFor(scope, day) {
  const where = scope === 'universe' ? 'across the market' : `for your ${scopeLabel(scope).toLowerCase()}`;
  return `No loaded event ${where} matches the current search, feed, direction, importance and date filters through ${day}. The feed panel above still says which sources have checked today.`;
}

// ---------------------------------------------------------------------------------------
// Export
//
// ROW 1 IS THE BANNER. A workbook leaves the page without any of the chrome above it — no legend,
// no coverage panel, no source registry — so everything a reader needs in order not to misread the
// colours has to travel inside the file.
// ---------------------------------------------------------------------------------------

function exportStream(visible, day, scope) {
  const feeds = report?.feeds || [];
  const behind = feeds.filter((f) => f.reachesToday === false).map((f) => f.label);
  const banner = {
    __banner: true,
    line:
      `SATTVA CENTRAL RESEARCH — GENERAL ALERTS HISTORY through ${day} (Indian trading date), ${scopeLabel(scope)} scope. ` +
      `Rows consolidate Earnings, Con-calls, Public Chatter, Price moves, Investor activity, Announcements, Insider trades and News. ` +
      `Direction (positive/negative/neutral) and Importance (high/low) are independent; every row carries both reasons. ` +
      `High thresholds: price ±${alerts.MOVE_PCT}%; insider ${alerts.INSIDER_HIGH_PCT}% or ₹${alerts.INSIDER_HIGH_VALUE / 10_000_000} crore; investor presence change or ${alerts.INVESTOR_HIGH_PP}pp; chatter ${alerts.CHATTER_HIGH_MENTIONS} mentions or ${alerts.CHATTER_HIGH_CHANGE_PCT}% mention change. ` +
      `Announcement direction is rule-derived and unmatched filings stay neutral; news stays neutral. ` +
      (behind.length
        ? `NOT EVERY FEED HAS LOOKED AT THIS DAY: ${behind.join(', ')} last read earlier, so an absence here is not evidence that nothing happened.`
        : `Every daily feed on this dashboard had read this day when the sheet was written.`),
  };

  const cell = (get) => (r) => (r.__banner ? '' : get(r));
  return exportRows({
    filename: `sattva-general-alerts-through-${day}`,
    sheetName: 'General Alerts',
    columns: [
      { header: 'Date (IST)', key: 'date', width: 14, get: (r) => (r.__banner ? r.line : r.day || '') },
      { header: 'Time (IST)', key: 'time', width: 12, get: cell((r) => r.time || '') },
      { header: 'Direction', key: 'direction', width: 12, get: cell((r) => r.direction || 'neutral') },
      { header: 'Importance', key: 'importance', width: 12, get: cell((r) => r.importance || 'low') },
      { header: 'Feed', key: 'feed', width: 18, get: cell((r) => r.feedLabel) },
      { header: 'Ticker', key: 'ticker', width: 14, get: cell((r) => r.ticker || '') },
      { header: 'Company', key: 'company', width: 32, get: cell((r) => r.company) },
      { header: 'What happened', key: 'headline', width: 60, get: cell((r) => r.headline) },
      { header: 'Detail', key: 'detail', width: 50, get: cell((r) => r.detail || '') },
      { header: 'Direction reason', key: 'signalReason', width: 48, get: cell((r) => r.signalReason || '') },
      { header: 'Importance reason', key: 'importanceReason', width: 48, get: cell((r) => r.importanceReason || '') },
      { header: 'Source link', key: 'url', width: 44, get: cell((r) => r.url || '') },
    ],
    rows: [banner, ...visible],
  });
}
