import * as refreshRegistry from '../core/refresh.js';
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
import { mountWindowedList } from '../ui/windowed-list.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { withoutPublisherName } from '../core/source-copy.js';
import { exportRows } from '../ui/export.js';
import * as marketNews from '../data/market-news.js';
import * as twitterNews from '../data/twitter-news.js';
import * as twitterHandles from '../core/twitter-handles.js';
import { openTwitterSources } from '../ui/twitter-sources.js';
import { classifyStory, topicFilterOptions, matchesTopic, topicLabel } from '../data/news-keywords.js';

// The same thirty keywords the company half of this tab filters by, over the same reading. Cached
// per story object for the same reason: the reader types, and every keystroke re-filters 600 rows.
//
// THE ONE DIFFERENCE IS WHAT A MATCH MEANS HERE. These stories carry no company, so "company name +
// keyword" has only its second half — this narrows the market feed to a subject and cannot say the
// subject is yours. That is why the alerts layer tags these rows and does not promote them: see the
// market-news collector in js/data/daily-alerts.js.
const readings = new WeakMap();
function readingFor(row) {
  let reading = readings.get(row);
  if (!reading) {
    reading = classifyStory(row);
    readings.set(row, reading);
  }
  return reading;
}

let unsub = null;
let postsUnsub = null;
let handlesUnsub = null;
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
let listView = { q: '', section: 'all', publisher: 'all', topic: 'all', source: 'all' };
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
//   • A BOUNDED, measured screenful throughout the visit. All stories remain in the model for
//     searching/export; natural heights preserve the complete standfirst and image layout.
//   • KEYS DERIVED FROM CONTENT — the publisher's article id — never a position.
//   • Every string escaped. These are somebody else's headlines arriving over the network.
//
// THE WHOLE CARD IS THE LINK. A news list where only a small arrow is clickable makes the reader
// hunt for the one live pixel; the anchor wraps the row, so clicking anywhere opens the publisher's
// page in a new tab. `rel="noopener noreferrer"` because the destination is not ours.

const FIRST_PAINT = 24;

// ---------------------------------------------------------------------------------------
// X/TWITTER POSTS ARE ANOTHER SOURCE IN THIS LIST, NOT A SECOND LIST.
//
// js/data/twitter-news.js converts each post into the article shape this feed already uses, so the
// merge below is the whole of the integration: one array, one sort, one search, one export, one
// card renderer with a single branch on `kind`. Nothing about the publisher feed changed.
//
// THE MERGED SORT IS BY TIME, NOT BY THE PUBLISHER'S ID. market-news.js orders by Moneycontrol's
// own article id, which increases with publication and works even for the stories whose timestamp
// was never read — correct within one publisher and meaningless across two. So the merged list
// sorts on `publishedAt` where both sides have one, and a story with no time keeps the publisher's
// relative order among the others rather than being dated with something we made up.
// ---------------------------------------------------------------------------------------

/** Every story in the list: the publisher feed plus the posts from monitored handles. */
function feedRows() {
  const publisher = marketNews.rows();
  const posts = twitterNews.rows();
  if (!posts.length) return publisher;

  // Publisher stories keep their own order and their index becomes the tie-break, so a story with
  // no readable time still sits where the publisher put it rather than falling to the bottom.
  const order = new Map(publisher.map((r, i) => [r.id, i]));
  const timeOf = (r) => {
    const t = Date.parse(r.publishedAt || '');
    return Number.isFinite(t) ? t : null;
  };
  return [...publisher, ...posts].sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== null && tb !== null) return tb - ta;
    // One side has no time. Keep the timed one first — it is the only one whose position is known.
    if (ta !== null) return -1;
    if (tb !== null) return 1;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

const isPost = (r) => r.kind === twitterNews.KIND;

// How close to the bottom of the list counts as "the reader wants more", in pixels. Generous on
// purpose: fetching a month while the last screenful is still being read is what makes the scroll
// feel continuous rather than stop-and-wait.
const NEAR_BOTTOM_PX = 600;

// The last thing loadMore() reported, so the footer can say what happened. Module state, not node
// state — the load repaints the list underneath it, so anything held on the footer node is gone by
// the time there is something to say. Same reasoning as `lastResult` above.
let lastMore = null;
let moreInFlight = false;

/**
 * The end of the list, and the only place that says how far back the archive goes.
 *
 * IT NEVER SAYS "THAT IS EVERYTHING" ON THE STRENGTH OF A FAILED READ. A month that could not be
 * fetched leaves the footer offering to try again, because reporting an outage as the end of the
 * archive is the same error as rendering a missing value as zero — and here the reader has no way
 * at all to tell the two apart from the screen.
 */
function moreFooter() {
  const arc = marketNews.archiveMeta();
  const back = arc.oldest ? istTime(arc.oldest) : null;
  const base = 'flex items-center justify-center gap-3 border-t border-slate-100 px-5 py-4 text-sm';

  if (moreInFlight || arc.loading) {
    return `<div data-news-more class="${base} text-slate-500">${SPINNER}<span>Loading older stories…</span></div>`;
  }
  if (lastMore?.failed) {
    return `<div data-news-more class="${base} text-slate-500">
      <span class="text-amber-700">Older stories could not be read${lastMore.reason ? ` — ${escapeHtml(String(lastMore.reason))}` : ''}.</span>
      <button type="button" data-news-more-btn class="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-indigo-700 ring-1 ring-slate-200 transition hover:bg-slate-50">Try again</button>
    </div>`;
  }
  if (!arc.exhausted) {
    return `<div data-news-more class="${base} text-slate-500">
      <span>Keep scrolling for older stories${arc.remaining ? ` · ${escapeHtml(formatNumber(arc.remaining))} more month${arc.remaining === 1 ? '' : 's'} in the archive` : ''}</span>
      <button type="button" data-news-more-btn class="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-indigo-700 ring-1 ring-slate-200 transition hover:bg-slate-50">Load older</button>
    </div>`;
  }
  return `<div data-news-more class="${base} text-slate-400">
    <span>That is every story captured${back ? `, back to ${escapeHtml(back)}` : ''}. History grows from here — nothing is discarded any more.</span>
  </div>`;
}

/** Pull the next month in. Guarded so a flick of the wheel cannot start three of these at once. */
async function requestMore(root) {
  if (moreInFlight) return;
  const arc = marketNews.archiveMeta();
  if (arc.exhausted) return;
  moreInFlight = true;
  const foot = root?.querySelector('[data-news-more]');
  if (foot) foot.outerHTML = moreFooter();
  try {
    lastMore = await marketNews.loadMore();
  } catch (err) {
    lastMore = { added: 0, failed: 1, reason: String(err?.message || err) };
  } finally {
    moreInFlight = false;
  }
  // A load that ADDED something emits, and the tab's own subscription repaints the list with the
  // reader's scroll position kept. A load that added nothing emits too but changes no row, so the
  // footer is refreshed here rather than waiting for a paint that has nothing to redraw.
  const still = root?.querySelector('[data-news-more]');
  if (still) still.outerHTML = moreFooter();
}

/** Which stories the search box and the four filters leave. */
function visibleRows(rows) {
  const q = (listView.q || '').trim().toLowerCase();
  const section = listView.section;
  const publisher = listView.publisher;
  const topic = listView.topic;
  const source = listView.source;
  return rows.filter((r) => {
    // The source filter is the coarsest of the four and comes first: publisher, section and topic
    // are all readings of a PUBLISHER story, and a post carries none of them.
    if (source === 'twitter' && !isPost(r)) return false;
    if (source === 'publishers' && isPost(r)) return false;
    if (isPost(r)) {
      // A post has no publisher, no section and no keyword reading, so any of those narrowing to a
      // named value excludes it — the honest answer, and not the same as pretending it matched.
      if ((publisher && publisher !== 'all') || (section && section !== 'all') || (topic && topic !== 'all')) return false;
      return !q || `${r.title || ''} ${r.handle || ''} ${r.displayName || ''}`.toLowerCase().includes(q);
    }
    if (publisher && publisher !== 'all' && r.publisher !== publisher) return false;
    if (section && section !== 'all' && r.section !== section) return false;
    if (topic && topic !== 'all' && !matchesTopic(readingFor(r), topic)) return false;
    if (!q) return true;
    return `${r.title || ''} ${r.summary || ''} ${r.section || ''} ${r.handle || ''} ${r.displayName || ''}`.toLowerCase().includes(q);
  });
}

// Only an http(s) value is ever made into an anchor. These URLs come off a scraped page, so the
// same rule the Deep Dive panel follows applies: external content may not decide what a click does.
// A story that fails it still renders — with its headline and its standfirst — as a plain block
// saying the link could not be used, because dropping the row would report a bad URL as no story.
const linkable = (u) => /^https?:\/\//i.test(String(u || ''));

const sectionLabel = (value) =>
  withoutPublisherName(String(value || '').replace(/-/g, ' ')).replace(/^the publisher\b/i, 'Publisher');

/**
 * A post's card. The same shell, the same thumbnail slot, the same meta row — the only additions
 * are the account line a publisher story has no use for and the source chip that names X.
 *
 * The text is the row and is reproduced whole in the markup: `line-clamp` shortens what is DRAWN,
 * so search and export still see every word and nothing is edited into a headline of ours.
 */
function postBody(r, canLink) {
  const when = istTime(r.publishedAt);
  const thumb = r.image
    ? `<img src="${escapeHtml(r.image)}" alt="" loading="lazy" decoding="async"
           class="h-full w-full object-cover" onerror="this.style.display='none'">`
    : `<span class="flex h-full w-full items-center justify-center text-slate-400" aria-hidden="true">
         <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.3l-4.9-6.4L6.2 22H3.1l7.3-8.3L2 2h6.4l4.4 5.9L18.9 2Zm-1.1 18h1.7L7.3 3.8H5.5L17.8 20Z"/></svg>
       </span>`;
  return `
      <div class="h-[62px] w-[110px] flex-shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-slate-100 to-slate-200 sm:h-[76px] sm:w-[135px]">${thumb}</div>
      <div class="min-w-0 max-w-4xl flex-1">
        <div class="flex flex-wrap items-baseline gap-x-1.5">
          <span class="font-display text-sm font-bold text-slate-900">${escapeHtml(r.displayName)}</span>
          <span class="text-xs font-medium text-slate-400">@${escapeHtml(r.handle)}</span>
        </div>
        <p class="mt-1 line-clamp-3 whitespace-pre-line text-[15px] leading-snug text-slate-700 ${canLink ? 'group-hover:text-indigo-700' : ''}">${escapeHtml(r.title) || '<span class="text-slate-400">(no text)</span>'}</p>
        <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          ${
            when
              ? `<span class="tabular-nums">${escapeHtml(when)}</span>`
              : '<span class="text-slate-300" title="The capture carried no post time.">time not published</span>'
          }
          <span class="text-slate-300">·</span>
          <!-- NOT \`uppercase\`, unlike the premium chip beside it in the publisher card: this is a
               product name, and "TWITTER / X" is not how it is written. -->
          <span class="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-slate-600">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.3l-4.9-6.4L6.2 22H3.1l7.3-8.3L2 2h6.4l4.4 5.9L18.9 2Zm-1.1 18h1.7L7.3 3.8H5.5L17.8 20Z"/></svg>
            Twitter / X
          </span>
        </div>
      </div>`;
}

/**
 * How a publisher is NAMED on screen — which is not always what the row stores.
 *
 * The byline itself is not optional: this feed carries five publishers, and an unattributed headline
 * in a mixed list attributes itself to whichever masthead the reader assumes. WHICH name is printed
 * is a different question and not an engineering one — CLAUDE.md puts the supplier's brand at the
 * owner's discretion, and `core/source-copy.js` already records that decision for the one publisher
 * it covers. So every display of a publisher goes through it, and the row keeps the real value for
 * matching, filtering and export keys. Naming the other four is not a new policy: nothing has ever
 * asked for them to be withheld, and withholding an attribution nobody asked to withhold would be
 * the worse default of the two.
 */
const publisherLabel = (value) =>
  withoutPublisherName(String(value || '')).replace(/^the publisher\b/i, 'The publisher');

function cardHtml(r) {
  const canLink = linkable(r.url);
  const when = istTime(r.publishedAt);
  const section = r.section ? sectionLabel(r.section) : null;
  // A story with no publisher time says so rather than showing the moment we captured it.
  const meta = [
    // THE BYLINE LEADS THE LINE, because this feed carries five publishers now. An unattributed
    // headline in a mixed list attributes itself to whichever masthead the reader assumes, and the
    // link out is not an answer — nobody reads a status bar before deciding whose reporting this is.
    r.publisher ? `<span class="font-semibold text-slate-500">${escapeHtml(publisherLabel(r.publisher))}</span>` : '',
    when
      ? `<span class="tabular-nums">${escapeHtml(when)}</span>`
      : `<span class="text-slate-300" title="This publisher’s feed carried no time for the story, and its own page was not read for one. It is not the time we saw it.">time not published</span>`,
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

  const body = isPost(r) ? postBody(r, canLink) : `
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

/**
 * The Topic options, counted against the WHOLE capture rather than the filtered rows.
 *
 * Same rule as the section list immediately below: a dropdown that loses its own options as you use
 * it cannot be used to get back. Counting the filtered set would also make every option read zero
 * the moment one of them was chosen.
 *
 * THE STRICT OPTION IS DROPPED HERE, and that is the point rather than an omission: "tracked keyword
 * AND names the company" is unanswerable on rows that carry no company, so offering it would be a
 * control that silently means something else on this half of the tab.
 */
function topicOptions() {
  const all = marketNews.rows();
  const cache = all.map(readingFor);
  const counted = (value) => cache.filter((reading) => matchesTopic(reading, value)).length;
  return topicFilterOptions(counted).filter((o) => o.value !== 'targeted');
}

function listHtml(rows) {
  const shown = rows.slice(0, FIRST_PAINT);
  const pending = Math.max(0, rows.length - shown.length);
  // The section list is the WHOLE feed's, not the filtered set's — a dropdown that loses its own
  // options as you use it cannot be used to get back. Posts are excluded from it because their
  // "section" is the source, which the control beside it already asks about.
  const allSections = [...new Set(marketNews.rows().map((r) => r.section).filter(Boolean))].sort();
  // NOT OFFERED WHEN THERE IS NOTHING TO CHOOSE BETWEEN. A dropdown whose every option means the
  // same set is a control that looks like it does something, which is worse than no control — the
  // same reason market-wide news is absent from General Alerts' chips under a narrowed scope
  // rather than present and permanently empty.
  const posts = twitterNews.rows().length;
  const sourceSelect = posts
    ? `<select data-news-source aria-label="Source"
         class="max-w-full truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
         <option value="all"${listView.source === 'all' ? ' selected' : ''}>All sources</option>
         <option value="publishers"${listView.source === 'publishers' ? ' selected' : ''}>News publishers</option>
         <option value="twitter"${listView.source === 'twitter' ? ' selected' : ''}>Twitter / X</option>
       </select>`
    : '';
  // Publishers in the order they contribute, most stories first, so the busiest masthead is the
  // easiest to reach. Read off the WHOLE feed rather than the filtered set, for the same reason the
  // sections are: a dropdown that loses its own options as you use it cannot be used to get back.
  const counts = new Map();
  for (const r of marketNews.rows()) if (r.publisher) counts.set(r.publisher, (counts.get(r.publisher) || 0) + 1);
  const allPublishers = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `
    <section data-mcnews-list class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100"${pending ? ` data-rows-pending="${pending}"` : ''}>
      <div class="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div class="relative w-full min-w-[180px] flex-1 sm:w-auto sm:max-w-md">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
            <input type="text" data-news-search placeholder="Search headlines..." value="${escapeHtml(listView.q || '')}"
              class="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          ${sourceSelect}
          ${
            allPublishers.length > 1
              ? `<select data-news-publisher aria-label="Publisher"
                   class="max-w-full truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                   <option value="all">All publishers</option>
                   ${allPublishers.map(([px, n]) => `<option value="${escapeHtml(px)}"${listView.publisher === px ? ' selected' : ''}>${escapeHtml(publisherLabel(px))} (${escapeHtml(formatNumber(n))})</option>`).join('')}
                 </select>`
              : ''
          }
          ${
            allSections.length > 1
              ? `<select data-news-section aria-label="Section"
                   class="max-w-full truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                   <option value="all">All sections</option>
                   ${allSections.map((sx) => `<option value="${escapeHtml(sx)}"${listView.section === sx ? ' selected' : ''}>${escapeHtml(sectionLabel(sx))}</option>`).join('')}
                 </select>`
              : ''
          }
          <select data-news-topic aria-label="Topic"
            class="max-w-full truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
            ${topicOptions()
              .map((o) => `<option value="${escapeHtml(o.value)}"${listView.topic === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="flex items-center gap-3">
          <span class="whitespace-nowrap text-sm text-slate-500"><strong class="text-slate-800">${escapeHtml(formatNumber(rows.length))}</strong> of ${escapeHtml(formatNumber(feedRows().length))} stories</span>
          <button type="button" data-news-export
            class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700">
            <span>📊</span><span>Export Excel</span>
          </button>
        </div>
      </div>
      <div data-news-scroll class="scrollbar-thin divide-y divide-slate-100 overflow-y-auto" style="max-height: max(360px, calc(100vh - 330px))">
        ${shown.map(cardHtml).join('') || '<p class="px-5 py-10 text-center text-sm text-slate-400">No story matches your search.</p>'}
      </div>
      ${moreFooter()}
    </section>`;
}

/**
 * Mount a measured window. Headlines, summaries and posts keep their natural heights; the full
 * retained array still backs the search, filters, counts and export. No offscreen image fanout.
 */
function fillRest(root, rows, wantScroll) {
  const host = root.querySelector('[data-news-scroll]');
  const section = root.querySelector('[data-mcnews-list]');
  if (!host || !section) return () => {};

  section.removeAttribute('data-rows-pending');
  host.tabIndex = 0; host.setAttribute('role', 'region'); host.setAttribute('aria-label', 'Market news stories');
  const windowed = mountWindowedList({ scroller: host, content: host, items: rows,
    key: r => String(r.id || r.url), rowSelector: '[data-news-key]', estimateHeight: 150,
    initialKey: wantScroll?.key || null,
    renderRows: (list, from, to) => list.slice(from, to).map(cardHtml).join(''),
    spacerHtml: (height, edge) => `<div data-window-spacer="${edge}" aria-hidden="true" style="height:${height}px;border:0;padding:0"></div>`,
    onWindow: (start, total) => { section.dataset.virtualStart = start; section.dataset.virtualTotal = total; },
  });
  if (wantScroll?.key) host.scrollTop -= wantScroll.offset || 0;
  return () => windowed.destroy();
}

/** "Mint 105, Business Standard 156, …" — for the export banner and the provenance panel. */
function publisherTally() {
  const counts = new Map();
  for (const r of marketNews.rows()) if (r.publisher) counts.set(r.publisher, (counts.get(r.publisher) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p, n]) => `${publisherLabel(p)} ${formatNumber(n)}`)
    .join(', ');
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
            ? `REAL REPORTING, NOT OURS. Market-wide news from several publishers, each read from their own feed, ` +
              `captured ${m.capturedAt || 'unknown'}, exported ${new Date().toISOString()}. ` +
              `HEADLINES, STANDFIRSTS AND SECTIONS ARE THE PUBLISHER'S, reproduced unchanged — nothing here is summarised, scored, ranked or judged. ` +
              `THE PUBLISHER COLUMN SAYS WHOSE REPORTING EACH ROW IS, and it is the only reliable answer once a workbook has left this page: ` +
              `${publisherTally() || 'no publisher recorded'}. ` +
              `A BLANK TIME MEANS THAT PUBLISHER GAVE NONE. It is never the time this dashboard saw the story. ` +
              `${m.withPublishedAt} of ${m.count} stories carry their publisher's time. ` +
              `SECTION IS OURS, NOT THEIRS: it records which of a publisher's feeds a story came from, not a tag they applied to it. ` +
              `TRACKED TOPICS ARE OURS TOO: a keyword reading of what a story is about, never a direction and never a score. ` +
              `These stories carry no company, so a topic names a subject and cannot say it is one of yours. ` +
              `Topic filter applied to this sheet: ${topicLabel(listView.topic)}.`
            : istTime(r.publishedAt) || '',
      },
      { header: 'Publisher', key: 'pub', width: 20, get: (r) => (r.__banner ? '' : publisherLabel(r.publisher)) },
      { header: 'Headline', key: 'h', width: 80, get: (r) => (r.__banner ? '' : withoutPublisherName(r.title)) },
      { header: 'Section', key: 's', width: 20, get: (r) => (r.__banner ? '' : sectionLabel(r.section)) },
      { header: 'Tracked topics', key: 'k', width: 30, get: (r) => (r.__banner ? '' : readingFor(r).labels.join(', ')) },
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
      <p><strong>Real reporting, and not ours.</strong> Every story in several publishers' market-wide feeds. Headlines and
         standfirsts are theirs, reproduced unchanged; the article stays on their site, every row links to it and
         <strong>every row names who published it</strong>. Nothing here summarises, scores, ranks or flags a story as
         important, and no publisher is ranked above another — <strong>the order is by publication time</strong>.</p>

      <p class="mt-2 text-xs"><strong>Section is ours, not theirs.</strong> Each publisher offers several feed URLs — markets,
         companies, money — so a story's section records which of their feeds it arrived on, not a tag they applied to it.
         It is kept in its own field and never presented as their own classification.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Where these stories come from</h3>
      <p class="mt-1 text-xs">${escapeHtml(publisherTally() || 'No publisher has been recorded yet.')} — counted over what is
         loaded on this page, which grows as you scroll back.</p>
      <ul class="mt-2 space-y-1 text-xs">
        ${(m.sources || [])
          .map((src) => {
            const when = src.capturedAt ? formatRelativeTime(Date.parse(src.capturedAt)) : 'never';
            // A publisher that REFUSED us and a publisher with nothing new are different facts, and
            // both differ from one we have not read at all. The capture records all three rather
            // than letting a story count stand in for any of them.
            const tone = src.ok ? 'text-emerald-700' : 'text-amber-700';
            const state = src.ok
              ? `read ${when}`
              : `could not be read ${when}${src.reason ? ` — ${src.reason}` : ''}`;
            const partial = src.ok && src.feedsOk != null && src.feedsOk < src.feeds ? ` · ${src.feeds - src.feedsOk} of its ${src.feeds} feeds failed` : '';
            return `<li><strong class="text-slate-700">${escapeHtml(publisherLabel(src.publisher) || src.id)}</strong>
              <span class="${tone}">${escapeHtml(state)}</span>${escapeHtml(partial)}</li>`;
          })
          .join('') || '<li class="text-slate-400">This capture predates per-publisher provenance.</li>'}
      </ul>
      <p class="mt-2 text-xs text-slate-500">Four of the five are read from their own RSS feeds, and each was checked for a
         <em>recent</em> newest item before being wired: a feed answering 200 with well-formed XML can still have been
         abandoned years ago, which is exactly what the fifth publisher's own RSS turned out to be — its newest item is from
         April 2024, so their listing page is read instead.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why this is a capture rather than a live read</h3>
      <p class="mt-1 text-xs"><strong>Half of these publishers refuse a server outright.</strong> Measured with Node's
         <code class="rounded bg-slate-100 px-1">fetch</code>, which is what a Cloudflare Worker uses: Business Standard
         <strong>200</strong>, Investing.com <strong>200</strong>, Mint <strong>403 with a 24-byte body</strong>, Economic
         Times <strong>403 with a 24-byte body</strong> — while <code class="rounded bg-slate-100 px-1">curl</code> with a
         browser user-agent gets all four at 200. That is TLS fingerprinting rather than headers, so there is no proxy route
         to build for them either.</p>
      <p class="mt-1 text-xs">The same is true of the listing page this tab started with, and more emphatically. Measured:
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
  const rows = feedRows();
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
  const previous = ctx.root.querySelector('[data-news-scroll]');
  const top = previous?.getBoundingClientRect().top || 0;
  const anchor = previous && [...previous.querySelectorAll('[data-news-key]')].find(row => row.getBoundingClientRect().bottom > top);
  const keep = anchor ? { key: anchor.dataset.newsKey, offset: anchor.getBoundingClientRect().top - top } : null;
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

  const filtered = visibleRows(feedRows());
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

  const topic = root.querySelector('[data-news-topic]');
  if (topic) {
    const onTopic = () => {
      listView.topic = topic.value;
      relist(root);
    };
    topic.addEventListener('change', onTopic);
  }
  const select = root.querySelector('[data-news-section]');
  select?.addEventListener('change', () => {
    listView.section = select.value;
    relist(root);
  });

  const sourceSelect = root.querySelector('[data-news-source]');
  sourceSelect?.addEventListener('change', () => {
    listView.source = sourceSelect.value;
    relist(root);
  });

  const pub = root.querySelector('[data-news-publisher]');
  pub?.addEventListener('change', () => {
    listView.publisher = pub.value;
    relist(root);
  });

  // Reads the ARRAY, never the DOM — a fill still in flight must not be able to truncate a workbook.
  root.querySelector('[data-news-export]')?.addEventListener('click', () => {
    exportVisible(visibleRows(feedRows()), marketNews.meta());
  });

  // DELEGATED ON THE SECTION, not bound to the button.
  //
  // `requestMore` rewrites the footer to report what happened, which destroys the button node — so a
  // handler bound directly to it dies with the first use, and the one state that needs the button
  // most (a month that could not be read, offering "Try again") is exactly the state that arrives
  // with a dead control. The section outlives every footer rewrite, and every paint that replaces
  // the section runs this again.
  const section = root.querySelector('[data-mcnews-list]');
  section?.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-news-more-btn]')) requestMore(root);
  });

  // REACHING THE END OF THE LIST IS THE REQUEST FOR MORE OF IT.
  //
  // Gated on the fill being finished — `data-rows-pending` is the honest signal that stories are
  // still being painted, and fetching a month while hundreds of already-held stories have not been
  // drawn yet would spend a request to answer a question the reader has not got to. No disposer is
  // needed: the listener is on the scroll node, and every repaint replaces that node.
  const host = root.querySelector('[data-news-scroll]');
  host?.addEventListener(
    'scroll',
    () => {
      if (host.scrollTop + host.clientHeight < host.scrollHeight - NEAR_BOTTOM_PX) return;
      if (root.querySelector('[data-mcnews-list][data-rows-pending]')) return;
      if (lastMore?.failed) return; // a failed month waits for the button, not for another scroll
      requestMore(root);
    },
    { passive: true },
  );
}

const DESCRIPTION =
  'Every story in the market-wide feeds of several publishers — not filtered to the companies in scope. Each row names who published it; headlines and standfirsts are theirs, and the article stays where it is published. ' +
  'Topic narrows it to the thirty keywords this desk tracks newsflow by; these rows carry no company, so a topic names a subject rather than an exposure.';

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
  // MONEYCONTROL'S OWN LAST READ, NOT THE FILE'S.
  //
  // The button and this gate both dispatch the workflow that reads Moneycontrol and nothing else,
  // while the file's `capturedAt` is whichever of the two jobs writing it ran last. Gating on the
  // file would mean the hourly RSS run keeps the timestamp fresh while Moneycontrol goes unread for
  // days and this never fires — a staleness check answered by a source it cannot refresh. Falls
  // back to the file's own time for a capture written before per-source provenance existed.
  const src = (marketNews.meta().sources || []).find((x) => x.id === 'moneycontrol');
  const at = Date.parse(src?.capturedAt || marketNews.meta().capturedAt || '');
  if (!Number.isFinite(at) || Date.now() - at < AUTO_AFTER_MS) return;
  // One attempt per window per page, so a dispatch that fails cannot become a loop.
  if (Date.now() - autoAt < AUTO_AFTER_MS) return;
  autoAt = Date.now();
  // `auto`, NOT `button`. The run name is how `lastAutomatic` answers "is this refreshing without
  // anyone pressing anything", and a fetch nobody pressed filed under `button` would make every
  // unattended refresh invisible to the one field that measures them.
  fetchLatest(ctx, 'auto');
}

let unregisterRefresh = null;

export function render(ctx) {
  ctxRef = ctx;
  if (!unregisterRefresh) unregisterRefresh = refreshRegistry.register('market-news-view', {
    label: 'News', refresh: async () => {
      const results = await Promise.all([marketNews.refresh(), twitterNews.refresh()]);
      return { added: results.reduce((n, r) => n + (r?.added || 0), 0), checked: 2,
        failed: results.filter((r) => r?.failed).length + (twitterNews.meta().lastReadFailed ? 1 : 0) };
    },
  });
  disposers.forEach((d) => d && d());
  disposers = [];
  // Guard on `ctxRef`, which the lifecycle owns, rather than on anything captured at subscribe
  // time: render() runs again on every scope and sub-view change, and a token captured in the
  // closure would be stale from the first one onwards.
  if (!unsub) unsub = marketNews.onChange(() => ctxRef && paint(ctxRef));
  // The post capture and the handle list each move the row set, so each repaints. Registered on
  // the same `ctxRef` guard and only once, exactly as the publisher feed's subscription is:
  // render() runs again on every scope change and a per-render subscription would stack up.
  if (!postsUnsub) postsUnsub = twitterNews.onChange(() => ctxRef && paint(ctxRef));
  if (!handlesUnsub) handlesUnsub = twitterHandles.onChange(() => ctxRef && paint(ctxRef));

  // Loaded in parallel with the publisher capture, and awaited by nothing: a post landing repaints
  // through the subscription above. One small conditional GET, no request per handle.
  if (!twitterNews.isLoaded()) twitterNews.load();

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
  unregisterRefresh?.(); unregisterRefresh = null;
  ctxRef = null;
  fillStop?.();
  fillStop = null;
  disposers.forEach((d) => d && d());
  disposers = [];
  unsub?.();
  unsub = null;
  postsUnsub?.();
  postsUnsub = null;
  handlesUnsub?.();
  handlesUnsub = null;
  lastResult = null;
  // The watch checks `ctxRef` before every paint, so clearing it above is what stops it. The run
  // itself carries on: it is a GitHub Action, and leaving the tab does not cancel it.
  failure = null;
  busy = false;
  modalOpen = false;
  // The filters are the reader's, and leaving the tab discards them deliberately: coming back to a
  // list silently narrowed by a search typed ten minutes ago reads as a feed that lost stories.
  listView = { q: '', section: 'all', publisher: 'all', topic: 'all', source: 'all' };
}
