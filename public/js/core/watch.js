// core/watch.js — the app-wide feed watchers behind the notification stack.
//
//   watch.start(live);        // once, at shell mount
//   watch.ensureRunning();    // after every route change
//   await watch.refreshNow(); // the header's refresh button
//
// WHY THIS EXISTS SEPARATELY FROM THE TABS
//   `startLive` / `stopLive` on each feed are owned by the tab that shows it: the Earnings Hub
//   starts the results poller in render() and stops it in destroy(). That is right for a table —
//   nothing should poll a feed nothing is showing. It is wrong for an alert, which is only worth
//   having if it fires while the reader is somewhere else. So the watchers hold their own claim on
//   the same two pollers, and `ensureRunning()` re-asserts it after each route change, because a
//   tab's destroy() calls `live.stop()` on the id the watcher also depends on.
//
// WHAT IT COSTS, AND WHY THAT IS ACCEPTABLE
//   Both feeds are conditional: an unchanged con-call tick is a bodyless 304 (~0.3KB) and an
//   unchanged results tick is the ~30KB prices projection, which drops to ~0.3KB when even the
//   prices have not moved. The full 1.1MB payload is pulled only when `structureTag` moves — i.e.
//   when a company has actually filed. Watching two feeds app-wide is affordable *because* of the
//   caching work in `core/store.js` and `worker/http.mjs`; without it this would be indefensible.
//
// THE BACKLOG RULE
//   Both feeds accumulate `newArrivals()` from page load onward. On the watcher's first change
//   event that list may already hold rows the reader has been looking at for ten minutes. Those are
//   suppressed rather than announced: a notification asserts "this just happened", and replaying
//   history through it devalues every alert after it.

import * as earnings from '../data/earnings-live.js';
import * as concalls from '../data/concall-scans.js';
import * as chatter from '../data/chatter-live.js';
import * as marketNews from '../data/market-news.js';
import * as refreshRegistry from './refresh.js';
import { withoutPublisherName } from './source-copy.js';

// How long the header's Refresh waits for the per-company feeds before saying they are still
// going. Long enough for a warm walk to finish, short enough that the button is not dead.
const ON_DEMAND_WAIT_MS = 12_000;
import * as coverage from '../data/coverage.js';
import * as notifications from '../ui/notifications.js';
import { formatCroreCompact, formatPct } from './format.js';

let engine = null;
let started = false;
const stops = [];

// Arrival keys are stable across ticks, which is what lets `notifications.push` dedupe: the feeds
// re-hand the whole arrival list every time anything changes.
const earningsKey = (r) => `earnings:${r.scId}:${r.resultDate}`;
const concallKey = (r) => `concall:${r.companyKey}:${r.when}:${r.reason}`;
const chatterKey = (r) => `chatter:${r.slug}`;

export function start(live) {
  if (started) return;
  started = true;
  engine = live;
  notifications.mount();

  // Load, then watch. A failed load is not an error state for the watcher — the tab that owns the
  // feed reports it properly, and an alert stack that announced its own fetch failures would be
  // noise about our plumbing rather than news about the market.
  wire(earnings, { keyOf: earningsKey, announce: announceEarnings, label: earnings.LIVE_ID });
  wire(concalls, { keyOf: concallKey, announce: announceConcalls, label: concalls.LIVE_ID });
  wire(chatter, { keyOf: chatterKey, announce: announceChatter, label: chatter.LIVE_ID });
  wire(marketNews, { keyOf: marketNewsKey, announce: announceMarketNews, label: marketNews.LIVE_ID });
}

function wire(feed, { keyOf, announce, label }) {
  feed
    .load()
    .then(() => {
      // Everything already on the arrival list at this moment predates the watcher. Seed the
      // dedupe set with it so the first change event announces only what is genuinely new.
      notifications.suppress(feed.newArrivals().map(keyOf));
      stops.push(feed.startLive(engine));
      stops.push(feed.onChange(announce));
    })
    .catch((err) => console.warn(`[watch] ${label} unavailable — no alerts from it`, err));
}

/**
 * Re-assert the watchers' claim on both pollers.
 *
 * Called after every route change because a tab's `destroy()` calls `live.stop()` on the same
 * poller id. `live.start()` is a no-op when the poller is already running, so this is cheap and
 * idempotent — and without it, visiting the Earnings Hub once and leaving would permanently kill
 * the alerts for that feed.
 */
export function ensureRunning() {
  if (!engine) return;
  for (const id of [earnings.LIVE_ID, concalls.LIVE_ID, chatter.LIVE_ID, marketNews.LIVE_ID]) engine.start(id);
}

/**
 * Force every running poller to check now. Resolves to what changed, so the button can say
 * something true rather than just spinning for a moment.
 */
export async function refreshNow() {
  const before = notifications.announcedCount();
  // TWO KINDS OF FEED, AND THE BUTTON DRIVES BOTH.
  //
  //   the POLLERS — the results feed and the con-call scan. Conditional, cheap, already ticking,
  //   and the source of every alert. `engine.refreshAll()` ticks the running ones.
  //
  //   the ON-DEMAND feeds — News, Corporate Announcements, Insider Trades, Superstar Investors.
  //   One request per company, so they must not tick at all; this button is the only thing that
  //   reads them. Registered by whichever tab is mounted, so the cost stays bounded.
  //
  // Both are awaited together and the counts are summed, because the reader pressed one button and
  // is owed one answer.
  const pollers = (async () => {
    if (!engine) return null;
    ensureRunning();
    return engine.refreshAll();
  })();

  // A WALK OF FORTY COMPANIES DOES NOT FIT IN A BUTTON'S PATIENCE, and the button must not lie
  // about that. It waits a bounded time for the on-demand feeds and then reports `pending` if they
  // are still going — "Still reading…" is a true statement and "Couldn't check" would not be, on
  // work that is proceeding perfectly well. The tab's own strip shows the walk as it lands.
  const STILL_RUNNING = Symbol('pending');
  const onDemand = refreshRegistry.refreshAll();
  const bounded = await Promise.race([
    Promise.all([pollers, onDemand]).then(([, o]) => o),
    new Promise((resolve) => setTimeout(() => resolve(STILL_RUNNING), ON_DEMAND_WAIT_MS)),
  ]);
  // The feeds' own onChange fires synchronously inside the tick, so by here the announcements
  // have already been made.
  const announced = notifications.announcedCount() - before;
  if (bounded === STILL_RUNNING) return { announced, pending: true };
  // A feed that was already walking when the button was pressed is still walking now.
  return { announced: announced + (bounded?.announced || 0), pending: (bounded?.skipped || 0) > 0 };
}

// ---------------------------------------------------------------------------------------
// Turning arrivals into alerts
//
// Every string below is built from a field the feed carried. Where a figure is missing the line
// says what is missing instead of substituting a zero — a result with no reported profit is not a
// result of zero, and a con-call awaiting its analysis is `pending` upstream, not a score of nil.
// ---------------------------------------------------------------------------------------

function announceEarnings() {
  for (const r of [...earnings.newArrivals()].reverse()) {
    notifications.push({
      key: earningsKey(r),
      kind: 'earnings',
      title: r.company || r.shortName || r.ticker || 'A company has reported',
      detail: earningsDetail(r),
      href: '#/research/earnings-hub/latest-results',
      at: r.seenAt || Date.now(),
    });
  }
}

export function earningsDetail(r) {
  const parts = [];
  const rev = describeMetric('Revenue', r.revenue);
  const pat = describeMetric('Net profit', r.netProfit);
  if (rev) parts.push(rev);
  if (pat) parts.push(pat);
  if (!parts.length) return r.resultDate ? `Filed ${r.resultDate}. Figures not yet parsed.` : 'Filed. Figures not yet parsed.';
  return parts.join(' · ');
}

/**
 * One metric as a phrase. `kind` comes from `classifyChange()` in worker/mc.mjs and is the whole
 * reason this is not a template string: 13% of reported moves cross zero, where a percentage is
 * not a growth rate at all. Those get the words the table uses rather than a coloured number that
 * would be a lie in a smaller font.
 */
function describeMetric(label, m) {
  if (!m || m.current == null) return '';
  const value = formatCroreCompact(m.current);
  if (m.kind === 'loss_to_profit') return `${label} ${value} — turned profitable`;
  if (m.kind === 'profit_to_loss') return `${label} ${value} — swung to a loss`;
  if (m.kind === 'loss_both') return `${label} ${value} — loss in both periods`;
  if (m.pct == null) return `${label} ${value}`;
  return `${label} ${value} (${formatPct(m.pct, { signed: true })})`;
}

/**
 * The publisher's own article id. Stable across captures and across edits to the headline, which a
 * title-derived key would not be — Moneycontrol revise headlines after publication, and that would
 * announce one story twice.
 */
const marketNewsKey = (a) => `mcnews:${a.id || a.url}`;

/**
 * A story that appeared since this page loaded.
 *
 * NO SUMMARY AND NO JUDGEMENT. The detail line carries the publisher's own standfirst, trimmed, and
 * the section they filed it under — nothing here decides a story is important, and nothing rewrites
 * their words. An alert is the one surface that reaches a reader with none of the page's context,
 * so it is the last place to start editorialising.
 *
 * The time shown is the PUBLISHER'S where we have it. A story whose date was not fetched carries
 * `firstSeenAt`, which is when this dashboard saw it — different fact, and the card must not
 * present the second as the first, so it falls back to "just captured" rather than to a timestamp.
 */
function announceMarketNews() {
  for (const a of [...marketNews.newArrivals()].reverse()) {
    notifications.push({
      key: marketNewsKey(a),
      kind: 'news',
      title: withoutPublisherName(a.title) || 'A story was published',
      detail: marketNewsDetail(a),
      // The publisher's own thumbnail, the same one the card on the tab shows. Hot-linked, never
      // copied, and dropped by the alert if it is not an https URL.
      image: a.image || null,
      href: '#/research/news?scope=universe',
      at: a.publishedAt ? Date.parse(a.publishedAt) : Date.now(),
    });
  }
}

export function marketNewsDetail(a) {
  // THE BYLINE LEADS, for the same reason it leads the card on the tab: this feed carries five
  // publishers, and an unattributed headline attributes itself to whichever masthead the reader
  // assumes. An alert travels further than a row — it can be the only thing somebody sees of a
  // story — so it is the last place to leave the attribution off.
  const section = a.section ? withoutPublisherName(a.section.replace(/-/g, ' ')).replace(/^the publisher\b/i, 'Publisher') : null;
  const lead = a.summary ? withoutPublisherName(a.summary).slice(0, 140) : null;
  const head = [a.publisher ? withoutPublisherName(a.publisher).replace(/^the publisher\b/i, 'The publisher') : null, section].filter(Boolean).join(' · ');
  if (lead && head) return `${head} · ${lead}`;
  return lead || (head ? `Published under ${head}` : 'Market news published');
}

function announceConcalls() {
  for (const r of [...concalls.newArrivals()].reverse()) {
    notifications.push({
      key: concallKey(r),
      kind: 'concall',
      title: r.name || r.ticker || 'A con-call was held',
      detail: concallDetail(r),
      href: '#/research/concall',
      at: r.seenAt || Date.now(),
    });
  }
}

export function concallDetail(r) {
  // `reason` is set by the feed: 'listed' means the call joined the index, 'analysed' means
  // StockScans' read of it landed. They are different events and read as different sentences.
  if (r.reason === 'analysed') {
    const score = r.resultScore != null ? `Result score ${Math.round(r.resultScore)}/100 (third-party)` : 'Analysis ready (third-party)';
    return r.resultTier?.label ? `${score} · ${r.resultTier.label}` : score;
  }
  if (r.analysisTracked === false) {
    const kinds = [...new Set((r.documents || []).map((document) => document.type))];
    return kinds.length ? `${kinds.join(', ')} added to the concall document index` : 'Concall document added';
  }
  if (r.resultScore == null) return 'Call held — analysis pending';
  return `Result score ${Math.round(r.resultScore)}/100 (third-party)`;
}

/**
 * Chatter alerts fire ONLY for companies in the book, and only on first appearance.
 *
 * The other two feeds announce every arrival, which is right: a company filing a result is an
 * event whoever owns it. Chatter is different in scale and in kind — a scrape adds entries for
 * brokers, themes and companies nobody here holds, and a stack of "Guggenheim was mentioned"
 * cards would train the reader to dismiss the whole component, including the results alerts that
 * matter. So the filter is the book, and the threshold is appearance rather than movement: a
 * holding being discussed for the first time is news; its count drifting from 3 to 4 is not.
 */
function announceChatter() {
  for (const r of [...chatter.newArrivals()].reverse()) {
    if (!r.ticker || !coverage.has(r.ticker)) continue;
    notifications.push({
      key: chatterKey(r),
      kind: 'chatter',
      title: r.name,
      detail: chatterDetail(r),
      href: '#/research/public-chatter',
      at: r.seenAt || Date.now(),
    });
  }
}

export function chatterDetail(r) {
  const where = r.sourceLabel ? ` on ${r.sourceLabel}` : '';
  const n = r.mentions === 1 ? '1 mention' : `${r.mentions} mentions`;
  // Their sentiment word, not a score of ours, and no percentage — `mentionsChangePct` is mention
  // volume and putting it in a one-line alert is exactly where it would be read as a price move.
  return `Now discussed${where} — ${n} in 30 days · ${r.sentiment.labelText} (SentimentDash)`;
}

export function stop() {
  for (const off of stops.splice(0)) {
    try {
      off?.();
    } catch { /* a disposer that throws must not strand the others */ }
  }
  started = false;
}
