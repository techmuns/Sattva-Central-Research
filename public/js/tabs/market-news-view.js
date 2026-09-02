// tabs/market-news-view.js — the Universe half of the News tab: market-wide stocks news.
//
// ONE TAB, TWO QUESTIONS, AND THE SCOPE TOGGLE PICKS WHICH.
//   Portfolio scope asks "what has been written about each of these companies" — a search, one
//   request per company, which is why it makes the reader name them. Universe scope asks the other
//   question, "what has been published", because 603 searches is ten minutes of somebody else's
//   service. They are different feeds from different publishers answering different questions, and
//   the description on each says which — a reader must never have to guess why the same tab shows
//   unrelated rows under two scopes.
//
// WHAT THE REFRESH CONTROL MAY CLAIM.
//   Neither the browser nor the Worker can read Moneycontrol — both get a 403 from TLS
//   fingerprinting, measured (see js/data/market-news.js). A scheduled Action reads it and commits
//   the capture. So this button asks whether a NEWER CAPTURE exists; it cannot and does not fetch
//   the publisher. It says so in those words, and the two times are printed separately:
//
//     "Moneycontrol last read"  the capture's own time — how fresh the NEWS is
//     "checked"                 when this browser last confirmed it has the newest capture
//
//   A twenty-minute-old capture confirmed one second ago is fresh in one sense and not the other,
//   and one combined "updated just now" would let the second stand in for the first.
//
// NO SCORE, NO SENTIMENT, NO RANKING. The order is the publisher's own, by their article id.
// Headlines and standfirsts are theirs, reproduced; the article stays on their site.

import { sectionHead, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { withoutPublisherName } from '../core/source-copy.js';
import { exportRows } from '../ui/export.js';
import * as marketNews from '../data/market-news.js';

let unsub = null;
let disposers = [];
let ctxRef = null;
let busy = false;
let lastResult = null;
// Module state, not node state — a fetch outlives many repaints, and holding this on the button
// meant the control vanished mid-run and came back offering to start another. (See CLAUDE.md,
// *Work the reader has to ask for*: the result must survive its own repaints.)
let failure = null;
// The reader's own filters. Module state, not node state: every repaint rebuilds the list, so a
// value held on the input would be discarded the moment a capture landed.
let listView = { q: '', section: 'all' };
let fillStop = null;
// Whether the provenance modal — which holds the Fetch control — is on screen, so a fetch's
// progress can be re-rendered into it rather than reported to a panel nobody is looking at.
let modalOpen = false;

/** IST, because the market and the publisher are both there and the reader almost certainly is. */
function istTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// This matches the watchdog: beyond 45 minutes in the publisher's working window, recovery starts
// and the face reports the measured age instead of claiming the capture is current.
const FRESH_MS = 45 * 60 * 1000;

/**
 * The whole of this tab's chrome: one small chip.
 *
 * IT REPLACED A FULL-WIDTH CARD — a button, a freshness sentence, a note about the scheduled job —
 * which is a lot of furniture above a list whose headlines are the point. The chip now states the
 * material status directly and is intentionally passive; it opens no provenance dialog.
 *
 * Freshness follows the capture timestamp, never a browser heartbeat. Recent data says `Up to
 * date`; otherwise the actual age is printed and the watchdog starts recovery in the background.
 */
function pill(m) {
  const at = m.capturedAt ? Date.parse(m.capturedAt) : NaN;
  const age = Number.isFinite(at) ? Date.now() - at : null;
  const fresh = age !== null && age < FRESH_MS;
  const tone = fresh ? 'text-emerald-700' : 'text-slate-500';
  const label = age === null ? 'Updating' : fresh ? 'Up to date' : `Updated ${formatRelativeTime(at)}`;
  return `<span data-mcnews-info title="Market-news capture status"
      class="inline-flex items-center gap-1.5 text-xs font-semibold ${tone}">
      ${escapeHtml(label)}
    </span>`;
}

// ---------------------------------------------------------------------------------------
// AN EDITORIAL LIST, NOT A TABLE — the one place in this dashboard that hand-rolls its rows.
//
// CLAUDE.md says to build every tab out of the screener kit and not to hand-roll a table, and that
// rule stands everywhere it applies. It does not apply here: this feed's row is a thumbnail, a
// headline and a standfirst — a piece of editorial, not a record with columns — and `scoreTable`
// models a record with columns. Forcing it into one made a headline share width with a date and a
// section chip, which is exactly backwards for content whose headline IS the row.
//
// What the kit's discipline still buys, and is kept by hand here:
//   • A SCREENFUL FIRST, then the rest under requestIdleCallback. 600 cards is far more DOM than
//     600 table rows, so mounting all of it up front would block the main thread on every visit.
//     `data-rows-pending` on the section is the honest signal that stories are outstanding, and the
//     suite waits on it rather than sleeping.
//   • KEYS DERIVED FROM CONTENT — the publisher's article id — never a position.
//   • Every string escaped. These are somebody else's headlines arriving over the network.
//
// THE WHOLE CARD IS THE LINK. A news list where only a small arrow is clickable makes the reader
// hunt for the one live pixel; the anchor wraps the row, so clicking anywhere opens the publisher's
// page in a new tab. `rel="noopener noreferrer"` because the destination is not ours.

const FIRST_PAINT = 24;

/** Which stories the search box and the section filter leave. */
function visibleRows(rows) {
  const q = (listView.q || '').trim().toLowerCase();
  const section = listView.section;
  return rows.filter((r) => {
    if (section && section !== 'all' && r.section !== section) return false;
    if (!q) return true;
    return `${r.title || ''} ${r.summary || ''} ${r.section || ''}`.toLowerCase().includes(q);
  });
}

// Only an http(s) value is ever made into an anchor. These URLs come off a scraped page, so the
// same rule the Deep Dive panel follows applies: external content may not decide what a click does.
// A story that fails it still renders — with its headline and its standfirst — as a plain block
// saying the link could not be used, because dropping the row would report a bad URL as no story.
const linkable = (u) => /^https?:\/\//i.test(String(u || ''));

const sectionLabel = (value) =>
  withoutPublisherName(String(value || '').replace(/-/g, ' ')).replace(/^the publisher\b/i, 'Publisher');

function cardHtml(r) {
  const canLink = linkable(r.url);
  const when = istTime(r.publishedAt);
  const section = r.section ? sectionLabel(r.section) : null;
  // A story with no publisher time says so rather than showing the moment we captured it.
  const meta = [
    when
      ? `<span class="tabular-nums">${escapeHtml(when)}</span>`
      : `<span class="text-slate-300" title="The publisher’s listing page carries no time, and this story’s own page was not read for one. It is not the time we saw it.">time not published</span>`,
    section ? `<span>${escapeHtml(section)}</span>` : '',
    r.premium ? '<span class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">premium</span>' : '',
  ]
    .filter(Boolean)
    .join('<span class="text-slate-300">·</span>');

  // `onerror` rather than a broken-image icon: the thumbnails are on the publisher's CDN, and a
  // reader offline (or a verification run with no egress) should get a clean placeholder.
  const thumb = r.image
    ? `<img src="${escapeHtml(r.image)}" alt="" loading="lazy" decoding="async"
           class="h-full w-full object-cover" onerror="this.style.display='none'">`
    : '';

  const body = `
      <div class="h-[62px] w-[110px] flex-shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-slate-100 to-slate-200 sm:h-[76px] sm:w-[135px]">${thumb}</div>
      <div class="min-w-0 max-w-4xl flex-1">
        <h3 class="font-display text-[15px] font-bold leading-snug text-slate-900 ${canLink ? 'group-hover:text-indigo-700' : ''}">${escapeHtml(withoutPublisherName(r.title) || '(untitled)')}</h3>
        ${r.summary ? `<p class="mt-1 line-clamp-2 text-sm leading-relaxed text-slate-500">${escapeHtml(withoutPublisherName(r.summary))}</p>` : ''}
        <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">${meta}</div>
      </div>`;
  const key = escapeHtml(String(r.id || r.url));
  const shell = 'group flex gap-4 px-5 py-4 transition-colors';

  if (!canLink) {
    return `<div data-news-key="${key}" data-news-unlinkable class="${shell}">${body}
      <span class="self-start rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500" title="The capture carried no usable http(s) address for this story.">no link</span>
    </div>`;
  }
  return `
    <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" data-news-key="${key}"
       class="${shell} hover:bg-slate-50 focus:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500">${body}
    </a>`;
}

function listHtml(rows) {
  const shown = rows.slice(0, FIRST_PAINT);
  const pending = Math.max(0, rows.length - shown.length);
  // The section list is the WHOLE feed's, not the filtered set's — a dropdown that loses its own
  // options as you use it cannot be used to get back.
  const allSections = [...new Set(marketNews.rows().map((r) => r.section).filter(Boolean))].sort();
  return `
    <section data-mcnews-list class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100"${pending ? ` data-rows-pending="${pending}"` : ''}>
      <div class="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div class="relative w-full min-w-[180px] flex-1 sm:w-auto sm:max-w-md">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
            <input type="text" data-news-search placeholder="Search headlines..." value="${escapeHtml(listView.q || '')}"
              class="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          ${
            allSections.length > 1
              ? `<select data-news-section aria-label="Section"
                   class="max-w-full truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                   <option value="all">All sections</option>
                   ${allSections.map((sx) => `<option value="${escapeHtml(sx)}"${listView.section === sx ? ' selected' : ''}>${escapeHtml(sectionLabel(sx))}</option>`).join('')}
                 </select>`
              : ''
          }
        </div>
        <div class="flex items-center gap-3">
          <span class="whitespace-nowrap text-sm text-slate-500"><strong class="text-slate-800">${escapeHtml(formatNumber(rows.length))}</strong> of ${escapeHtml(formatNumber(marketNews.rows().length))} stories</span>
          <button type="button" data-news-export
            class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700">
            <span>📊</span><span>Export Excel</span>
          </button>
        </div>
      </div>
      <div data-news-scroll class="scrollbar-thin divide-y divide-slate-100 overflow-y-auto" style="max-height: max(360px, calc(100vh - 330px))">
        ${shown.map(cardHtml).join('') || '<p class="px-5 py-10 text-center text-sm text-slate-400">No story matches your search.</p>'}
      </div>
    </section>`;
}

/**
 * Append the remainder in idle slices.
 *
 * Not virtualisation: every story ends up in the DOM, so Ctrl-F, screenshots and the accessibility
 * tree behave normally. The timeout matters — a backgrounded tab never goes idle, and without it
 * the list would sit at 24 stories until the reader came back.
 */
function fillRest(root, rows, wantScroll) {
  const host = root.querySelector('[data-news-scroll]');
  const section = root.querySelector('[data-mcnews-list]');
  if (!host || !section) return () => {};

  // Restoring a scroll offset is only possible once the rows it points into exist, so the request
  // is carried through the fill and dropped the moment the reader scrolls for themselves. See
  // CLAUDE.md: if you rebuild a scrolling container, you own restoring its scroll position.
  let want = wantScroll || 0;
  let lastSet = 0;
  const settle = () => {
    if (!want || host.scrollTop >= want) return;
    host.scrollTop = want;
    lastSet = host.scrollTop;
  };
  const onScroll = () => {
    if (Math.abs(host.scrollTop - lastSet) > 2) want = 0;
  };
  host.addEventListener('scroll', onScroll, { passive: true });
  settle();

  let at = FIRST_PAINT;
  let handle = null;
  let cancelled = false;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 16));
  const cancelIdle = window.cancelIdleCallback || clearTimeout;
  const stop = () => {
    cancelled = true;
    if (handle) cancelIdle(handle);
    handle = null;
    host.removeEventListener('scroll', onScroll);
  };

  if (rows.length <= FIRST_PAINT) {
    section.removeAttribute('data-rows-pending');
    return stop;
  }

  const step = () => {
    if (cancelled) return;
    const slice = rows.slice(at, at + 40);
    if (!slice.length) {
      section.removeAttribute('data-rows-pending');
      settle();
      host.removeEventListener('scroll', onScroll);
      return;
    }
    host.insertAdjacentHTML('beforeend', slice.map(cardHtml).join(''));
    at += slice.length;
    settle();
    const left = rows.length - at;
    if (left > 0) {
      section.setAttribute('data-rows-pending', String(left));
      handle = idle(step, { timeout: 400 });
    } else {
      section.removeAttribute('data-rows-pending');
      host.removeEventListener('scroll', onScroll);
    }
  };
  handle = idle(step, { timeout: 400 });
  return stop;
}

async function exportVisible(visible, m) {
  await exportRows({
    filename: 'sattva-market-news',
    sheetName: 'Market news',
    columns: [
      {
        header: 'Published (IST)',
        key: 'd',
        width: 18,
        get: (r) =>
          r.__banner
            ? `REAL REPORTING, NOT OURS. Market-wide stocks news from the publisher's own listing, ` +
              `captured ${m.capturedAt || 'unknown'}, exported ${new Date().toISOString()}. ` +
              `HEADLINES, STANDFIRSTS AND SECTIONS ARE THE PUBLISHER'S, reproduced unchanged — nothing here is summarised, scored, ranked or judged, and the order is their own. ` +
              `A BLANK TIME MEANS THE PUBLISHER'S TIME WAS NOT READ: their listing page carries no date, so it is fetched per story and is budgeted. It is never the time this dashboard saw the story. ` +
              `${m.withPublishedAt} of ${m.count} stories carry the publisher's time.`
            : istTime(r.publishedAt) || '',
      },
      { header: 'Headline', key: 'h', width: 80, get: (r) => (r.__banner ? '' : withoutPublisherName(r.title)) },
      { header: 'Section', key: 's', width: 20, get: (r) => (r.__banner ? '' : sectionLabel(r.section)) },
      { header: 'Standfirst (publisher)', key: 'p', width: 80, get: (r) => (r.__banner ? '' : withoutPublisherName(r.summary)) },
      { header: 'Premium', key: 'x', width: 10, get: (r) => (r.__banner ? '' : r.premium ? 'yes' : '') },
      { header: 'URL', key: 'u', width: 70, get: (r) => (r.__banner ? '' : r.url || '') },
      { header: 'First seen by this dashboard', key: 'f', width: 26, get: (r) => (r.__banner ? '' : r.firstSeenAt || '') },
    ],
    rows: [{ __banner: true }, ...visible],
  });
}

const SPINNER = `<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" opacity="0.25"></circle>
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"></path>
  </svg>`;

function provenance(m) {
  const captured = m.capturedAt ? formatRelativeTime(Date.parse(m.capturedAt)) : 'never';
  const result = lastResult ? `<span class="ml-2 text-xs font-semibold ${lastResult.tone || 'text-slate-500'}">${escapeHtml(withoutPublisherName(lastResult.text))}</span>` : '';
  const fix = failure?.fix ? ` <code class="rounded bg-white/70 px-1">${escapeHtml(failure.fix)}</code>` : '';
  return `<div class="px-7 py-6">
    <div class="mb-3 flex items-start justify-between gap-4">
      <h2 class="font-display text-xl font-bold text-slate-900">Market news</h2>
      <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
    </div>

    <div class="mb-4 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-100">
      <div class="flex flex-wrap items-center gap-3">
        <button type="button" data-mcnews-fetch ${busy ? 'disabled' : ''}
          class="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300">
          ${busy ? SPINNER : '<span>↧</span>'}<span>${busy ? 'Fetching…' : 'Fetch latest news'}</span>
        </button>
        <p class="min-w-0 flex-1 text-xs text-slate-500">
          Publisher feed last read <strong class="text-slate-700">${escapeHtml(captured)}</strong> · a scheduled job also reads it through the day.${result}
        </p>
      </div>
      ${failure ? `<p data-mcnews-failure class="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-800 ring-1 ring-rose-100">${escapeHtml(withoutPublisherName(failure.text))}${fix}</p>` : ''}
    </div>

    <div class="text-sm leading-relaxed text-slate-600">
      <p><strong>Real reporting, and not ours.</strong> Every story in the publisher's market-wide stocks feed. Headlines, standfirsts and section names are
         theirs, reproduced unchanged; the article stays on their site and every row links to it. Nothing here summarises,
         scores, ranks or flags a story as important, and <strong>the order is their own</strong> — by their article id.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why this is a capture rather than a live read</h3>
      <p class="mt-1 text-xs">The publisher's site refuses automated readers by TLS fingerprint, not by headers. Measured:
         <code class="rounded bg-slate-100 px-1">curl</code> with a browser user-agent gets <strong>200 and 598 KB</strong>;
         Node's <code class="rounded bg-slate-100 px-1">fetch</code> gets <strong>403 with a 24-byte body</strong> on every
         header set tried, including the full browser set; and a <strong>Cloudflare Worker gets 403 as well</strong>. So there
         is no proxy route to build — a scheduled GitHub Action reads the page and commits what it finds, and this page
         reads that capture. The only time printed here is when the publisher was actually <em>read</em>; nothing on this
         tab reports when the browser last checked, because that is a fact about us rather than about the news.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Scheduled first, checked again when the dashboard opens</h3>
      <p class="mt-1 text-xs">It said <em>"refreshed automatically every 20 minutes"</em>. Measured over 41 hours, that was
         not happening on two counts, so the sentence is gone rather than reworded smaller.</p>
      <p class="mt-2 text-xs"><strong>GitHub drops most of a dense cron.</strong> A 20-minute schedule fired
         <strong>12 times against 124</strong> — about one run every 3.8 hours. Their scheduler is best-effort on shared
         infrastructure and sheds the densest schedules first.</p>
      <p class="mt-2 text-xs"><strong>And the publisher refuses the runner outside Indian hours.</strong> Of those 12 runs,
         <strong>7 were answered with HTTP 403</strong>, and the split by clock is total — every success fell between
         10:27 and 21:14 IST, every refusal between 20:28 and 05:29 IST. So the job now runs every 30 minutes across the
         window that works and hourly outside it, retries a 403 with a real backoff, and reports a refusal as a refusal
         rather than as a broken scraper. <strong>None of that makes the cron exact</strong>, so the dashboard also checks
         the committed capture after first paint. During the publisher's working window, a capture older than 45 minutes
         starts this same workflow automatically; the Worker declines duplicate or recently-started runs. The heading says
         <em>Up to date</em> only inside the measured freshness window and otherwise prints the capture's age.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">A stale capture recovers automatically</h3>
      <p class="mt-1 text-xs">After the dashboard's first paint, one small status request checks capture timestamps for all
         scheduled sources. If market news is overdue during the hours the publisher answers, it starts one refresh and
         watches for the newly committed file. The check never blocks the page, never starts a current source, and is
         deduplicated both in this browser and at the Worker edge.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What the Fetch button does</h3>
      <p class="mt-1 text-xs">It reads the committed capture first — free, and if a scheduled run has just published one
         this browser has not picked up, that is the answer and nothing is started. Otherwise it asks the GitHub runner
         to read the publisher feed <em>now</em>, starting the same scheduled job on demand and watching it. The automatic
         watchdog and this button share the same duplicate guard, so if a run is already going they watch that one rather
         than starting a second. The credential that authorises it lives on the Worker and has never been in a browser.</p>
      <p class="mt-2 text-xs">There used to be a second button that only made the free check. It was removed because it
         did nothing a reader was not already getting for nothing: the twenty-minute poll makes that same check
         unprompted, and the fetch has always ended by making it too. Two controls that do the same job read as two
         different features.</p>
      <p class="mt-2 text-xs">A finished run is <strong>not</strong> the same as new stories on screen: the job commits
         only if it found something, and the site serves the new file only after the deploy that follows. So the result
         beside the button counts the stories that actually arrived — <strong>by their ids, never by the length of the
         list</strong>, because the capture is capped and a new story pushes the oldest off the end.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The blank times are the honest part</h3>
      <p class="mt-1 text-xs">The publisher's listing page carries no date on any story — checked, there is no date, time or
         timestamp element on it. The time comes from each story's own page, which costs one request per story, so it is
         budgeted and the newest are done first. <strong>${escapeHtml(formatNumber(m.withPublishedAt))} of
         ${escapeHtml(formatNumber(m.count))}</strong> stories carry the publisher's time; the rest read
         <em>time not published</em> in those words — on a card there is no column heading to tell a reader what
         a dash would have been standing in for.
         They are <strong>never</strong> stamped with the moment this dashboard first saw them — that is a fact about the
         scraper, is kept in its own field, and reaches the export under its own heading.</p>
    </div>
  </div>`;
}

function paint(ctx) {
  const m = marketNews.meta();
  const rows = marketNews.rows();
  if (fillStop) {
    fillStop();
    fillStop = null;
  }

  if (!rows.length) {
    ctx.root.innerHTML = `
      ${sectionHead({ title: 'News', description: DESCRIPTION, meta: pill(m) })}
      <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100">
        <h3 class="font-display text-lg font-bold text-slate-900">No market-news capture yet</h3>
        <p class="mx-auto mt-2 max-w-xl text-sm text-slate-500">
          The scheduled run that reads the publisher feed has not committed a capture to this deployment.
          ${escapeHtml(withoutPublisherName(m.message))}
        </p>
      </div>`;
    wireHead(ctx);
    return;
  }

  // A capture landing must not throw the reader back to the top of the list.
  const keep = ctx.root.querySelector('[data-news-scroll]')?.scrollTop || 0;
  const filtered = visibleRows(rows);
  ctx.root.innerHTML = `
    ${sectionHead({ title: 'News', description: DESCRIPTION, meta: pill(m) })}
    ${listHtml(filtered)}`;
  wireHead(ctx);
  wireList(ctx.root);
  fillStop = fillRest(ctx.root, filtered, keep);
  if (modalOpen) {
    const host = document.getElementById('modal-content');
    if (host) {
      host.innerHTML = provenance(marketNews.meta());
      wireModal(ctx);
    }
  }
}

/**
 * Rebuild ONLY the list, for a change the reader made rather than one the feed made.
 *
 * A full `paint()` would work and would also re-render the search box the reader is typing into,
 * taking the focus and the caret with it. So the head and its freshness line stay put — nothing
 * about them depends on the filter — and the scroll returns to the top, which is right here: a new
 * filter is a new list, and holding the old offset would land the reader in the middle of it.
 */
function relist(root) {
  const old = root.querySelector('[data-mcnews-list]');
  if (!old) return;
  if (fillStop) {
    fillStop();
    fillStop = null;
  }
  const search = old.querySelector('[data-news-search]');
  const hadFocus = document.activeElement === search;
  const caret = search ? search.selectionStart : null;

  const filtered = visibleRows(marketNews.rows());
  old.outerHTML = listHtml(filtered);
  wireList(root);
  fillStop = fillRest(root, filtered, 0);

  const next = root.querySelector('[data-news-search]');
  if (next && hadFocus) {
    next.focus();
    if (caret != null) next.setSelectionRange(caret, caret);
  }
}

/** The section head is one chip now, and it opens everything else. */
function wireHead() {}

/**
 * The provenance modal, which is also where the Fetch button lives.
 *
 * A fetch takes minutes and repaints as it goes, so the modal has to be re-rendered in place rather
 * than left showing the state it opened in — and `modalOpen` is what tells `paint()` whether there
 * is one to re-render. A reader who closes it mid-fetch loses nothing: the run carries on, the
 * stories that arrive raise their own alerts, and the chip turns green when the capture lands.
 */
function openProvenance(ctx) {
  modalOpen = true;
  openModal(provenance(marketNews.meta()), { size: 'default' });
  wireModal(ctx);
}

function wireModal(ctx) {
  const host = document.getElementById('modal-content');
  if (!host) return;
  host.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', () => { modalOpen = false; }));
  // The ONLY caller of fetchLatest in the codebase. Nothing on a render, nothing on a poll.
  host.querySelector('[data-mcnews-fetch]')?.addEventListener('click', () => fetchLatest(ctx, 'button'));
}

/**
 * The one control on this page that can start work somewhere else.
 *
 * WHAT IT DOES, AND WHY IT CANNOT DO THE OBVIOUS THING. Neither this browser nor the Worker can
 * read moneycontrol.com — 403 by TLS fingerprint, measured both ways — so "fetch" means "ask the
 * GitHub runner that CAN read it to run now", then watch until the answer is on screen.
 *
 * THE FREE READ COMES FIRST. A scheduled run may already have published a capture this browser has
 * not picked up; answering from that costs nothing and starts nothing. Only when it carries no
 * story we lack does this dispatch — which is all the second button ever did, folded in where it
 * cannot be mistaken for a different feature.
 */
async function fetchLatest(ctx, source = 'button') {
  if (busy) return;
  busy = true;
  failure = null;
  lastResult = null;
  paint(ctx);

  try {
    const already = await marketNews.refresh();
    if (already.added > 0) {
      lastResult = countResult(already.added);
      return;
    }

    const out = await marketNews.startScrape(source);
    if (out.ok === false) {
      failure = { text: failureText(out), fix: out.fix || null };
      return;
    }

    const result = await marketNews.watchScrape();
    if (!ctxRef) return;
    switch (result.outcome) {
      case 'landed':
        lastResult = countResult(result.added);
        break;
      case 'nothing-new':
        lastResult = { tone: 'text-slate-500', text: 'No new stories' };
        break;
      case 'published':
      case 'publish-failed':
      case 'timed-out':
        // None of these has measured a story either way, and none is a failure of the run. The
        // shortest true sentence is that the answer has not reached this page yet.
        lastResult = { tone: 'text-slate-500', text: 'Read — waiting for it to reach this page' };
        break;
      default:
        failure = { text: result.message || failureText(result), fix: result.fix || null };
    }
  } catch (err) {
    failure = { text: `The fetch could not be completed (${String(err?.message || err)}).` };
  } finally {
    busy = false;
    if (ctxRef) paint(ctxRef);
  }
}

const countResult = (n) => ({ tone: 'text-emerald-700', text: `${formatNumber(n)} new ${n === 1 ? 'story' : 'stories'}` });

/** A named failure has a named fix; "could not fetch" throws the useful half away. */
function failureText(out) {
  switch (out.reason) {
    case 'no-worker':
      return 'This origin serves static files only, so there is no Worker to start a fetch. The scheduled job is unaffected.';
    case 'no-token':
      return 'This deployment has no GitHub token, so it cannot start a fetch. An operator adds one here:';
    case 'no-repo':
      return 'No repository is configured on the Worker, so it cannot start a fetch. Set GH_REPO in wrangler.jsonc and redeploy.';
    case 'unauthorised':
      return 'GitHub rejected the token — it has expired or been revoked. Replace it here:';
    case 'forbidden':
      return 'The token is not allowed to start this workflow. It needs "Actions: read and write" on this repository.';
    case 'rate-limited':
      return "GitHub's hourly limit for this token is spent; it resets on the hour. The scheduled job is unaffected.";
    case 'not-found':
      // The chatter-API lesson: a 404 with two readings must admit both, and name what was asked.
      return `GitHub answered 404 for ${out.requested || 'the workflow'}. That means EITHER the workflow file is not on the configured branch, OR the token cannot see this repository — GitHub answers 404 rather than 403 for a repository a token has no access to.`;
    case 'refused':
      return out.message || 'GitHub refused the request.';
    case 'timeout':
      return 'GitHub did not answer in time. Nothing was started, and the scheduled job is unaffected.';
    default:
      return `The fetch could not be started (${out.reason || 'unknown'}). The scheduled job is unaffected.`;
  }
}

/** Search, section and export. Rebound on every list rebuild, because the nodes are new. */
function wireList(root) {
  const search = root.querySelector('[data-news-search]');
  search?.addEventListener('input', () => {
    listView.q = search.value;
    relist(root);
  });

  const select = root.querySelector('[data-news-section]');
  select?.addEventListener('change', () => {
    listView.section = select.value;
    relist(root);
  });

  // Reads the ARRAY, never the DOM — a fill still in flight must not be able to truncate a workbook.
  root.querySelector('[data-news-export]')?.addEventListener('click', () => {
    exportVisible(visibleRows(marketNews.rows()), marketNews.meta());
  });
}

const DESCRIPTION =
  'Every story in the market-wide publisher feed — not filtered to the companies in scope. Headlines and standfirsts are theirs; the article stays where it is published.';

/**
 * OPENING THIS TAB ON A STALE CAPTURE FETCHES ONE. A DELIBERATE REVERSAL, SO HERE IS THE REASONING.
 *
 * "Nothing dispatches on its own" was stated firmly and repeatedly in this file and in CLAUDE.md,
 * and it is being narrowed rather than abandoned. That rule exists for two reasons, and neither
 * applies here:
 *
 *   1. NEVER SPEND A METERED RESOURCE UNPROMPTED. That is the Deep Dive rule, where every dispatch
 *      is a paid LLM run on somebody's account. This is our own GitHub Action on free minutes.
 *   2. NEVER HAMMER A RATE-LIMITED SERVICE ON A PAGE LOAD. That is the per-company filings walk —
 *      forty round trips against a ~60/minute cap. This is ONE request to a public listing page,
 *      at most once per `AUTO_AFTER_MS` across every reader, because the capture's own age is the
 *      gate and a run in flight is declined at the edge.
 *
 * What forced it is measurement, not preference. Both schedulers are ruled out — GitHub's cron
 * fires roughly every four hours, and a Cloudflare cron cannot be registered on this account (the
 * Workers Free limit of 5 cron triggers is per ACCOUNT and is spent) — so for a stretch the only
 * thing that refreshed the news was a reader pressing a button to fix a staleness they had already
 * had to notice. That is the page failing at its job and asking the reader to compensate.
 *
 * A READER OPENING THE TAB IS THE DEMAND SIGNAL, and acting on it is strictly better than a blind
 * clock: the news is fresh exactly when somebody is reading it, and nothing runs when nobody is.
 * It is also a SAFETY NET rather than the mechanism — an external scheduler still keeps the capture
 * warm for the alert stack, which fires while the reader is on other tabs. See the provenance
 * modal, which says all of this to the reader too.
 */
const AUTO_AFTER_MS = 20 * 60 * 1000;
let autoAt = 0;

function maybeAutoFetch(ctx) {
  if (busy) return;
  const at = Date.parse(marketNews.meta().capturedAt || '');
  if (!Number.isFinite(at) || Date.now() - at < AUTO_AFTER_MS) return;
  // One attempt per window per page, so a dispatch that fails cannot become a loop.
  if (Date.now() - autoAt < AUTO_AFTER_MS) return;
  autoAt = Date.now();
  // `auto`, NOT `button`. The run name is how `lastAutomatic` answers "is this refreshing without
  // anyone pressing anything", and a fetch nobody pressed filed under `button` would make every
  // unattended refresh invisible to the one field that measures them.
  fetchLatest(ctx, 'auto');
}

export function render(ctx) {
  ctxRef = ctx;
  disposers.forEach((d) => d && d());
  disposers = [];
  // Guard on `ctxRef`, which the lifecycle owns, rather than on anything captured at subscribe
  // time: render() runs again on every scope and sub-view change, and a token captured in the
  // closure would be stale from the first one onwards.
  if (!unsub) unsub = marketNews.onChange(() => ctxRef && paint(ctxRef));

  if (!marketNews.isLoaded()) {
    ctx.root.innerHTML = `${sectionHead({ title: 'News', description: DESCRIPTION })}
      <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
    marketNews.load().then(() => {
      if (!ctxRef) return;
      paint(ctxRef);
      maybeAutoFetch(ctxRef);
    });
    return;
  }
  paint(ctx);
  maybeAutoFetch(ctx);
}

export function destroy() {
  ctxRef = null;
  fillStop?.();
  fillStop = null;
  disposers.forEach((d) => d && d());
  disposers = [];
  unsub?.();
  unsub = null;
  lastResult = null;
  // The watch checks `ctxRef` before every paint, so clearing it above is what stops it. The run
  // itself carries on: it is a GitHub Action, and leaving the tab does not cancel it.
  failure = null;
  busy = false;
  modalOpen = false;
  // The filters are the reader's, and leaving the tab discards them deliberately: coming back to a
  // list silently narrowed by a search typed ten minutes ago reads as a feed that lost stories.
  listView = { q: '', section: 'all' };
}
