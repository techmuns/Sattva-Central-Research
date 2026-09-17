// data/daily-alerts.js — A NEWEST-FIRST TIMELINE ACROSS THIS DASHBOARD'S RESEARCH FEEDS.
//
//   const day = today();                     // the IST trading date
//   const report = await collect({ scope, includeHistory: true });
//   report.events   one row per thing in the retained feed windows, newest first
//   report.feeds    one row per feed: what it contributed, and WHETHER IT REACHES TODAY
//
// This module adds no source of its own. Every event on it is a reading taken from a feed that
// already had a tab, which is the whole point: the tabs answer "what does this feed hold", and this
// answers "what happened" by asking several of them the same question at once. The timeline tab
// requests retained history; the default remains one day so callers that need a daily report keep
// that exact contract.
//
// ---------------------------------------------------------------------------------------
// The registry includes every supported source category, including raw snapshots, schedules,
// NSE/IPO history and session-only lookup records. See docs/GENERAL-ALERTS-POOL.md for retention
// and on-demand limitations. Collection never walks companies or dispatches capture jobs.
//
// Every event carries TWO INDEPENDENT readings:
//   direction   positive | negative | neutral
//   importance  high | low
// Source-provided bands win where they exist. Announcements use a small, exported keyword policy;
// insider and investor activity use the transaction itself plus stated numeric thresholds. The
// row always carries both reasons, so neither colour is an unexplained judgement. News remains
// neutral: an editorial headline is not sentiment data.
//
// ---------------------------------------------------------------------------------------
// "NOTHING TODAY" AND "WE HAVE NOT LOOKED AT TODAY" ARE DIFFERENT ANSWERS
//
// All of these feeds are committed captures refreshed on a schedule, and a schedule is best-effort
// (see *And the schedule is best-effort twice over* in CLAUDE.md). So a feed whose newest capture
// predates today CANNOT say nobody filed — it can only say when it last looked. `feeds[]` carries
// `reachesToday` for exactly that, and the tab prints it per feed rather than rendering an empty
// bucket that reads as an all-clear.
//
// Bulk captures and their published archive shards are reused; no per-company requests.
//
// The data layer owns no poller. Its tab subscribes to changes and revalidates every 90 seconds
// while visible; cached reassembly never fetches.

let lastAssembleInput = null;
let lastAssembleOutput = null;

import * as technicals from './technicals.js';
import * as marketNews from './market-news.js';
import * as earnings from './earnings-live.js';
import * as concalls from './concall-scans.js';
import * as chatter from './chatter-live.js';
import * as investors from './super-investors.js';
import * as screenerInsights from './screener-insights.js';
// ONE definition of what a filed-book change is — see `isMove` there. A negative filter here
// (`action !== 'held'`) admitted every future state by default, which is how an outstanding
// filing would have become a negative alert about a named investor.
import { isMove } from './finology-shared.js';
import { announcements, insider, news, createQueryNews } from './filings.js';
import { insiderTradeSourceUrl, articleUrlKey, canonicalArticleUrl } from './filings-shared.js';
import { classifyStory } from './news-keywords.js';
import { announcementSignal } from './filing-signals.js';
export { announcementSignal, BSE_CRITICAL_IS_MATERIAL } from './filing-signals.js';
import { scopeMatcher } from './scope.js';
import * as coverage from './coverage.js';
import { ADDITIONAL_SOURCES, additionalSourceDependencies } from './alert-sources.js';
import * as records from './alert-records.js';
import { alertWindowCache } from './alert-window-cache.js';
import { allAlertsCache, allAlertsViewCache, alertWindowKey, materializeAllAlerts, restoreAllAlertSources, retainAlertSource, publicAlertFeed } from './all-alerts-cache.js';
import { scopeTickers } from './scope.js';
import * as scopeLists from '../core/scope-lists.js';
export { ALERT_WINDOW_CACHE_KEY } from './alert-window-cache.js';
import { AI_ALERT_WINDOW_DAYS as ALERT_WINDOW_CACHE_DAYS } from '../core/alert-window.js';
export { AI_ALERT_WINDOW_DAYS as ALERT_WINDOW_CACHE_DAYS } from '../core/alert-window.js';
import { portfolioNewsEntities } from './company-news-identity.js';
import { attributeNewsRow, attributionFor, newsSearchText } from './company-news-attribution.js';
import { matchPortfolioNews, newsEventTopics } from './portfolio-news-matching.js';
import { enrichmentCoverageIncomplete } from '../core/news-view-status.js';

// ---------------------------------------------------------------------------------------
// Today, in IST
// ---------------------------------------------------------------------------------------

// Every date on this dashboard is an Indian trading date — a company files at 14:32 IST and the
// exchange calendar is IST — so `toISOString()` on its own names YESTERDAY for the five and a half
// hours between 18:30 IST and midnight UTC. That window is the evening, which is exactly when a
// reader opens an alerts page to see what happened today.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export const today = (now = Date.now()) => new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);

// A compact, public-only materialized view for the one dashboard surface that
// otherwise has to assemble every source before it can draw a useful card. It
// deliberately carries no Family reply, holding weight, private document or
// sourceRecord. Those stay memory-only; this cache is safe to survive a reload.

function shiftDay(day, amount) {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function materializePublicAlertWindow(report) {
  const firstDay = shiftDay(report.day, -(ALERT_WINDOW_CACHE_DAYS - 1));
  const privateFeeds = new Set(['company-documents', 'drhp-documents']);
  return {
    version: 1,
    day: report.day,
    feeds: (report.feeds || []).filter((feed) => !privateFeeds.has(feed.id)).map(({ events, count, todayCount, ...feed }) => feed),
    events: (report.events || [])
      .filter((event) => !event.private && !privateFeeds.has(event.feed) && (event.ticker || event.entityId) && event.day >= firstDay && event.day <= report.day)
      .map(({ sourceRecord: _sourceRecord, private: _private, weightPct: _weightPct,
        holdingWeightPct: _holdingWeightPct, ...event }) => event),
  };
}

function validAlertWindow(value, throughDay) {
  const privateFeeds = new Set(['company-documents', 'drhp-documents']);
  if (value?.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(value.day || '') ||
      !Array.isArray(value.events) || !Array.isArray(value.feeds)) return false;
  const captured = Date.parse(`${value.day}T00:00:00Z`);
  const through = Date.parse(`${throughDay}T00:00:00Z`);
  return Number.isFinite(captured) && Number.isFinite(through) && captured <= through &&
    through - captured < ALERT_WINDOW_CACHE_DAYS * 86_400_000 &&
    value.feeds.every((feed) => !privateFeeds.has(feed?.id)) &&
    value.events.every((event) => !event.private && !privateFeeds.has(event.feed) && event.sourceRecord == null &&
      event.weightPct == null && event.holdingWeightPct == null &&
      (typeof event.ticker === 'string' || typeof event.entityId === 'string') && typeof event.feed === 'string');
}

/** Restore a ready public alert window, narrowed against the current in-memory scope. */
export async function readCachedAlertWindow({ scope = 'portfolio', holdings = null, day = today() } = {}) {
  const entry = await alertWindowCache.read();
  if (!validAlertWindow(entry?.value, day)) return null;
  const wanted = scopeMatcher(scope, holdings || coverage.holdings());
  const firstDay = shiftDay(day, -(ALERT_WINDOW_CACHE_DAYS - 1));
  const entityIds = new Set(portfolioNewsEntities(holdings || coverage.holdings()).map(e => e.entityId));
  const scopeContext = { scope, wanted, entityIds };
  const events = entry.value.events.filter((event) => event.day >= firstDay && event.day <= day &&
    matchesAlertScope(event, scopeContext));
  const sameDay = entry.value.day === day;
  return {
    day,
    scope,
    includeHistory: true,
    events,
    feeds: entry.value.feeds.map((feed) => ({ ...feed, reachesToday: sameDay ? feed.reachesToday : false })),
    pending: 0,
    cacheSavedAt: entry.savedAt || null,
  };
}

// Capture membership as well as the scope label. A watchlist edit, Family handoff or Universe
// exclusion can change the answer without changing the route or any source timestamp.
export function alertContextKey(scope, holdings = coverage.holdings(), day = today()) {
  return JSON.stringify([scope, day, portfolioNewsEntities(holdings),
    [...(scopeTickers(scope, holdings) || [])].sort(), scopeLists.removed('universe')]);
}

export async function readCachedAllAlerts({ scope, holdings = coverage.holdings(), day = today(), queryWindow = null }) {
  let entry = await allAlertsViewCache(queryWindow).read();
  let sources = restoreAllAlertSources(entry?.value, FEEDS, day, queryWindow);
  // An existing full-history cache remains useful on the first visit after this upgrade.
  if (!sources && queryWindow) {
    entry = await allAlertsCache.read();
    sources = restoreAllAlertSources(entry?.value, FEEDS, day);
  }
  if (!sources) return null;
  return { ...assemble({ day, scope, holdings, includeHistory: true, queryWindow,
    settledFeeds: new Map(sources.map(feed => [feed.id, feed])) }), cacheSavedAt: entry.savedAt || null };
}

/** Current public source results win over disk. Pending/failed reads retain saved evidence;
 * successful reads replace their source independently. Every adoption rechecks current scope
 * and ephemeral sources, so an old account or membership cannot be painted by a late callback. */
export function adoptAllAlertsReport(incoming, previous, { scope, holdings = coverage.holdings(), day = today(), queryWindow = null }) {
  const sourcesFor = report => (report?.sourceFeeds || []).map(feed => ({ ...feed,
    // A narrow successful read cannot certify a broader request. Keep its evidence while
    // the remaining history loads; never adopt it as an authoritative full-source replacement.
    status: coversAlertQuery(report.queryWindow, queryWindow) ? feed.status : 'pending',
    reachesToday: report.day === day ? feed.reachesToday : false,
  }));
  const prior = new Map(sourcesFor(previous).map(feed => [feed.id, feed]));
  const sourceReport = incoming || previous;
  const sources = sourcesFor(sourceReport).map(feed => retainAlertSource(feed, prior.get(feed.id)));
  return assemble({ day, scope, holdings, includeHistory: true, queryWindow,
    settledFeeds: new Map(sources.map(feed => [feed.id, feed])) });
}

let lastAllAlertsSave = null;
export function saveAllAlerts(report) {
  // Do not serialize the whole pool again for duplicate completion notifications.
  if (report.sourceFeeds === lastAllAlertsSave) return;
  lastAllAlertsSave = report.sourceFeeds;
  return allAlertsViewCache(report.queryWindow).write(materializeAllAlerts(report));
}

/** The IST clock time of an instant, as HH:MM, for a row that carries a real timestamp. */
function istTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/** The IST calendar date of an instant. */
function istDayOf(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
// A pure string-to-string function asked about the same 80,000 timestamps on every pass over the
// news history (two Date allocations each): bounded FIFO on the raw string, the same shape as
// `matchKeywords` and `canonicalArticleUrl`. The key is the row's own string, so nothing is copied.
const IST_DAY_CACHE_MAX = 65_536;
const istDayCache = new Map();
const istDayKeys = new Array(IST_DAY_CACHE_MAX);
let nextIstDayKey = 0;
function istDay(value) {
  if (!value) return null;
  if (typeof value !== 'string') return istDayOf(value);
  const hit = istDayCache.get(value);
  if (hit !== undefined) return hit;
  const day = istDayOf(value);
  istDayCache.delete(istDayKeys[nextIstDayKey]);
  istDayKeys[nextIstDayKey] = value;
  nextIstDayKey = (nextIstDayKey + 1) % IST_DAY_CACHE_MAX;
  istDayCache.set(value, day);
  return day;
}

// ---------------------------------------------------------------------------------------
// The thresholds and signal vocabulary this module states out loud
// ---------------------------------------------------------------------------------------

// A material day move. This is an importance threshold, no longer a collection threshold:
// below-threshold measurements remain in the pool and do not change the existing AI policy.
export const MOVE_PCT = 5;
export const INSIDER_HIGH_PCT = 1;
export const INSIDER_HIGH_VALUE = 100_000_000; // ₹10 crore
export const INVESTOR_HIGH_PP = 1;
export const CHATTER_HIGH_MENTIONS = 10;
export const CHATTER_HIGH_CHANGE_PCT = 100;

// Today's traded volume against the company's own 20-day average. Two times is where participation
// stops being ordinary: measured on the shipped capture, 40 of 603 companies clear 2x and 16 clear
// 3x, so this surfaces a readable handful rather than a second copy of the universe.
//
// A VOLUME SPIKE IS NOT A PRICE MOVE AND HAS ITS OWN ROW. `MOVE_PCT` asks whether the price went
// somewhere; this asks whether anyone was there. They answer different questions and routinely
// disagree — a 6% move on ordinary volume is a thin tape, and 3x volume on a flat close is
// accumulation or distribution nobody has priced yet — so folding one into the other would lose
// whichever signal the other did not carry.
export const VOLUME_X = 2;

export const DIRECTION = { POSITIVE: 'positive', NEGATIVE: 'negative', NEUTRAL: 'neutral' };
export const IMPORTANCE = { HIGH: 'high', LOW: 'low' };

/**
 * The severity of a day move, or null if it does not reach the threshold at all.
 *
 * Exported because it IS the alert rule, and a rule that only runs inside a collector can only be
 * tested on days the data happens to contain a big faller — which is most days not at all. The
 * suite asserts it directly.
 */
export function moveSeverity(pct) {
  if (pct == null || Number.isNaN(pct) || Math.abs(pct) < MOVE_PCT) return null;
  return pct < 0 ? SEVERITY.ALERT : SEVERITY.UPDATE;
}

export const SEVERITY = { ALERT: 'alert', UPDATE: 'update' };

const signal = (direction, importance, signalReason, importanceReason) => ({
  direction,
  importance,
  signalReason,
  importanceReason,
  // Kept for notification/backward compatibility. The table no longer presents this legacy
  // binary model; a negative reading is an alert and every other reading is an update.
  severity: direction === DIRECTION.NEGATIVE ? SEVERITY.ALERT : SEVERITY.UPDATE,
  reason: signalReason,
});

/**
 * A company-news story's reading: TOPIC AND MATERIALITY, NEVER DIRECTION.
 *
 * `tabs/news.js` carries no sentiment of ours and this does not change that — see the header of
 * `js/data/news-keywords.js`. A tracked keyword says what a story is ABOUT, and "Lawsuit" is a
 * topic a company can be on either side of, so the direction stays NEUTRAL exactly as it was.
 *
 * What a match changes is IMPORTANCE, which is the question the desk's thirty keywords were written
 * to answer: is this one of the things we watch, or is it the name-collision noise that makes up
 * three quarters of a search-built feed. The reason string says "matched the tracked keyword X" and
 * never "the company won an order" — a word in a headline is not a verified event.
 *
 * Exported because it is the entry rule for this feed's high-importance rows, and a rule that only
 * runs inside a collector can only be tested on the days the capture happens to contain one.
 */
export function newsSignal(row = {}) {
  const reading = classifyStory(row);
  const attribution = reading.attribution;
  const identityReading = { attribution, aiEligible: attribution.status === 'confirmed', namesCompany: reading.namesCompany };
  const eventTopics = newsEventTopics(row);
  if (eventTopics.length && ['confirmed', 'related'].includes(attribution.status)) {
    return { ...signal(DIRECTION.NEUTRAL, IMPORTANCE.HIGH,
      'Reported topic; this classification does not verify the event, opinion or its financial impact.',
      `High: ${eventTopics.join(', ')} in the headline or bounded article body. ${attribution.reason}`),
      keywords: [...new Set([...reading.labels, ...eventTopics])], ...identityReading,
      reviewContext: attribution.status === 'related' };
  }
  if (!reading.tracked) {
    return {
      ...signal(
        DIRECTION.NEUTRAL,
        IMPORTANCE.LOW,
        'Publisher headline; not directionally graded.',
        attribution.status !== 'confirmed'
          ? `Low: no tracked keyword matched. ${attribution.reason}`
          : 'Low: no tracked keyword matched, so this is general coverage rather than a watched event.'
      ),
      keywords: [],
      // Attribution and topic are independent. The old early return lost this field precisely on
      // the untracked rows that make up most search spillover, leaving All Alerts unable to tell
      // “the article names the company” from “the search API filed it under the company”.
      ...identityReading,
    };
  }
  const labels = reading.labels;
  const named = reading.namesCompany;
  const where = reading.inTitle ? 'headline' : 'standfirst';
  // Identity and topic are separate. Unknown identity stays visible in company search, but cannot
  // promote an event or count as independent AI corroboration. Absence of a name is NOT a mismatch.
  // AND THE KEYWORD HAS TO BE IN THE HEADLINE, NOT ONLY THE STANDFIRST.
  //
  // The publisher chose what to lead with; a standfirst is a paragraph that happened to contain the
  // word. Measured on the shipped capture, the difference is not marginal — 3,278 stories carry a
  // tracked keyword somewhere and 1,990 carry one in the headline — and the gap is mostly the
  // upstream's chrome: several outlets' "summary" is a related-links strip, so ONE Business Today
  // sidebar reading "…Hexaware shares tank 4% after CEO steps down…" was tagging unrelated stories
  // about MCX and aircraft leasing as Resignation. Nothing was wrong with the pattern; the field it
  // read was not this story's standfirst.
  //
  // The FILTER still matches both, and the chip says which — exploring a feed and asserting a
  // company needs attention are different jobs, and only the second is a claim.
  const bothHalves = named === true && reading.inTitle;
  return {
    ...signal(
      DIRECTION.NEUTRAL,
      bothHalves ? IMPORTANCE.HIGH : IMPORTANCE.LOW,
      `Publisher headline; not directionally graded. Topic only: ${labels.join(', ')}.`,
      bothHalves
        ? `High: matched the tracked ${labels.length === 1 ? 'keyword' : 'keywords'} ${labels.join(', ')} in the ${where}` +
          (named === true ? ', and the story names the company.' : '.')
        : named !== true
          ? `Low: matched the tracked ${labels.length === 1 ? 'keyword' : 'keywords'} ${labels.join(', ')}. ${attribution.reason}`
          : `Low: matched the tracked ${labels.length === 1 ? 'keyword' : 'keywords'} ${labels.join(', ')} only in the standfirst, which several outlets fill with a related-links strip rather than this story's own summary. The headline is what the publisher chose to lead with.`
    ),
    keywords: labels,
    keywordIds: reading.ids,
    keywordGroups: reading.groups,
    ...identityReading,
  };
}

/**
 * The text All Alerts is allowed to match for one event.
 *
 * Confirmed and uncertain news retain company search recall. Only a reviewed mismatch loses the
 * query identity from search; the article stays in the unassigned retained stream. The old rule
 * excluded every missing-name result and hid real brand/spelling variants from company searches.
 */
export function eventSearchText(event = {}) {
  const row = { ...event.sourceRecord, title: event.headline, company: event.company, ticker: event.ticker, attribution: event.attribution || event.sourceRecord?.attribution };
  const identity = event.feed === 'news' ? newsSearchText(row) : `${event.company || ''} ${event.ticker || ''}`;
  return `${event.day || ''} ${event.time || ''} ${identity} ${event.direction || ''} ${event.importance || ''} ${event.headline || ''} ${event.detail || ''} ${event.signalReason || ''} ${event.importanceReason || ''} ${event.feedLabel || ''}`;
}

const numeric = (value) => {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/\d/.test(text)) return null;
  const n = Number(text.replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (/\b(?:crore|cr)\b/i.test(text)) return n * 10_000_000;
  if (/\b(?:lakh|lac|lacs)\b/i.test(text)) return n * 100_000;
  return n;
};

/** Transaction direction plus comparable, stated thresholds; unknown transaction words stay neutral. */
export function insiderSignal(cells = {}) {
  const transaction = String(cells.Transaction ?? cells['Acq/Disp'] ?? '').trim();
  const mode = String(cells.Mode ?? '').trim();
  const transactionWords = transaction.toLowerCase();
  const modeWords = mode.toLowerCase();
  let direction = DIRECTION.NEUTRAL;
  let basis = 'No recognised directional transaction word was carried; shown as neutral.';
  // Transaction is the authoritative action. Mode describes how it happened and is consulted
  // only for a generic/pledge transaction; otherwise "Disposal · Market Purchase" becomes a buy.
  if (/\b(?:revoke|revocation|release)\w*\b/.test(transactionWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Pledge release/revocation in the upstream transaction wording.';
  } else if (/\binvoke\w*\b/.test(transactionWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Pledge creation/invocation in the upstream transaction wording.';
  } else if (/\b(?:disposal|dispose\w*|sell|sold|sale)\b/.test(transactionWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Disposal/sale in the upstream transaction wording.';
  } else if (/\b(?:acquisition|acquire\w*|buy|bought|purchase)\b/.test(transactionWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Acquisition/purchase in the upstream transaction wording.';
  } else if (/\bpledge\b/.test(transactionWords)) {
    if (/\b(?:revoke|revocation|release)\w*\b/.test(modeWords)) {
      direction = DIRECTION.POSITIVE;
      basis = 'Pledge release/revocation in the upstream mode wording.';
    } else {
      direction = DIRECTION.NEGATIVE;
      basis = 'Pledge creation/invocation in the upstream transaction wording.';
    }
  } else if (/\b(?:revoke|revocation|release)\w*\b.*\bpledge\b|\bpledge\b.*\b(?:revoke|revocation|release)\w*\b/.test(modeWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Pledge release/revocation in the upstream mode wording.';
  } else if (/\b(?:invoke\w*|creat\w*)\b.*\bpledge\b|\bpledge\b/.test(modeWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Pledge creation/invocation in the upstream mode wording.';
  } else if (/\b(?:disposal|dispose\w*|sell|sold|sale)\b/.test(modeWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Disposal/sale in the upstream mode wording.';
  } else if (/\b(?:acquisition|acquire\w*|buy|bought|purchase)\b/.test(modeWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Acquisition/purchase in the upstream mode wording.';
  }

  const pct = numeric(cells['Trade %']);
  const value = numeric(cells['Trade Value']);
  const highPct = pct != null && Math.abs(pct) >= INSIDER_HIGH_PCT;
  const highValue = value != null && Math.abs(value) >= INSIDER_HIGH_VALUE;
  const importance = highPct || highValue ? IMPORTANCE.HIGH : IMPORTANCE.LOW;
  const why = [
    highPct ? `${Math.abs(pct).toFixed(2)}% is at least ${INSIDER_HIGH_PCT}%` : null,
    highValue ? `₹${(Math.abs(value) / 10_000_000).toFixed(1)} crore is at least ₹${INSIDER_HIGH_VALUE / 10_000_000} crore` : null,
  ].filter(Boolean);
  return signal(
    direction,
    importance,
    basis,
    why.length ? `High: ${why.join(' and ')}.` : `Low: below ${INSIDER_HIGH_PCT}% and ₹${INSIDER_HIGH_VALUE / 10_000_000} crore, or those values were not carried.`
  );
}

// ---------------------------------------------------------------------------------------
// Feed registry — id, label, which tab owns it, and what it can contribute
// ---------------------------------------------------------------------------------------

export const FEEDS = [
  { id: 'technicals', label: 'Price & volume', tab: 'breakouts', what: `Two readings of the last completed session, dated to it and never to the capture: a close that moved more than ${MOVE_PCT}% against the close before it, and participation — volume at ${VOLUME_X}x the company's own 20-day average, or a confirmed break above its consolidation base. Volume is reported neutral because the tape does not say whether heavy trading was accumulation or distribution. Moves past the check threshold are re-derived from the Muns market-data endpoint where it answered.` },
  { id: 'earnings', label: 'Earnings', tab: 'earnings-hub', what: 'Filed quarterly results, graded from the source revenue and net-profit comparison.' },
  { id: 'concalls', label: 'Con-calls', tab: 'concall', what: "Held con-calls, using StockScans' own result and sentiment bands." },
  { id: 'chatter', label: 'Public chatter', tab: 'public-chatter', what: "The source's rolling 30-day company sentiment snapshot, dated to its capture." },
  { id: 'investors', label: 'Investor activity', tab: 'super-investors', what: 'Quarter-over-quarter disclosed holding changes from Super Investors, dated to each current investor book confirmation.' },
  { id: 'announcements', label: 'Announcements', tab: 'corp-announcements', what: "Everything filed to BSE in the retained exchange-wide capture. Direction comes from a narrow rule over the filing's own text; high importance means the filing matched one of the thirty tracked keywords or that directional rule. BSE's own critical marker is reproduced on every row but does not gate importance — it covers routine AGM and board-meeting filings." },
  { id: 'insider', label: 'Insider trades', tab: 'insider-trades', what: 'Retained insider and promoter disclosures, under their broadcast dates.' },
  { id: 'news', label: 'Company news', tab: 'news', what: 'Retained stories about a company in scope, under their published dates. High importance means the story matched one of the thirty tracked keywords the desk watches newsflow by; the reading is a TOPIC and never a direction, so every row here stays neutral.' },
  { id: 'market-news', label: 'Market news', tab: 'news', what: 'Retained market-wide stories, tagged with the same tracked keywords for filtering. They carry no company, so importance stays low — a keyword is material ABOUT a company, and there is none on these rows — and they are Universe only.' },
  ...ADDITIONAL_SOURCES.map(({ load, read, ...feed }) => feed),
];

const feedById = new Map(FEEDS.map((f) => [f.id, f]));
const loadingFeeds = new Map();
const loadErrors = new Map();
const loadedFeeds = new Set();
const listeners = new Set();
// One normalized snapshot per public feed, not per tab/scope/filter. Keep source subscriptions
// alive while the tab is unmounted so a change elsewhere cannot resurrect an old snapshot.
// No poller or durable storage here; private document feeds are always read directly.
const normalizedFeeds = new Map();
const PRIVATE_FEEDS = new Set(['company-documents', 'drhp-documents']);
let observingSources = false;
function observeSources() {
  if (observingSources) return;
  observingSources = true;
  const dependencies = [
    [technicals, ['technicals']], [earnings, ['earnings']],
    [concalls, ['concalls', 'scheduled-concalls', 'screener-portfolio-upcoming']],
    [chatter, ['chatter', 'chatter-posts']], [investors, ['investors', 'investor-positions']],
    [announcements, ['announcements']], [insider, ['insider']], [news, ['news']],
    [marketNews, ['market-news']], [records, []], ...additionalSourceDependencies,
  ];
  for (const [source, ids] of dependencies) source.onChange?.(() => {
    for (const id of ids) normalizedFeeds.delete(id);
    if (ids.includes('news') || ids.includes('market-news')) {
      newsCandidates = null;
      lastNewsSourceQuery = null;
      // Full source interpretations are independent. Only period queries depend on companions
      // from the other route; do not reclassify full news on every market-feed status change.
      const other = ids.includes('news') ? 'market-news' : 'news';
      if (normalizedFeeds.get(other)?.windowKey !== 'null') normalizedFeeds.delete(other);
    }
    listeners.forEach((fn) => fn());
  });
  // Some collectors resolve issuer names against the current in-memory portfolio.
  coverage.onChange(({ changed }) => { if (changed) normalizedFeeds.clear(); });
}

export function inAlertQuery(event, window) {
  if (!window) return true;
  const day = event.day || istDay(event.at);
  return day ? day >= window.from && day <= window.to : !!window.includeUndated;
}
export function coversAlertQuery(source, requested) {
  return !source || !!requested && source.from <= requested.from && source.to >= requested.to &&
    (!requested.includeUndated || source.includeUndated);
}
const queryProjections = new WeakMap();
function queryEvents(events, queryWindow) {
  if (!queryWindow) return events;
  const key = alertWindowKey(queryWindow);
  let saved = queryProjections.get(events);
  if (saved?.key !== key) {
    saved = { key, events: events.filter(event => inAlertQuery(event, queryWindow)) };
    queryProjections.set(events, saved);
  }
  return saved.events;
}
// Date corrections can disagree across collection routes. Include every companion for a
// matching URL before choosing the canonical company/article and preserving its provenance.
// Raw history remains the authority; only the expensive alert interpretation is narrowed.
let newsCandidates = null;
const queryNewsReaders = new Map();
let activeCollections = 0, releaseRequested = false, researchOwnsSources = false;
function trimQueryReaders() {
  for (const [key, entry] of queryNewsReaders) {
    if (queryNewsReaders.size <= 2) break;
    if (entry.active) continue;
    queryNewsReaders.delete(key); entry.off(); entry.reader.release();
  }
}
function releaseInactiveMemory() {
  if (!releaseRequested || listeners.size || activeCollections || loadingFeeds.size) return;
  for (const entry of queryNewsReaders.values()) { entry.off(); entry.reader.release(); }
  queryNewsReaders.clear();
  lastAllAlertsSave = null;
  // Research keeps a prepared estate between questions. Its source owner is independent of
  // alert navigation; clearing that store would make a cached research preparation incomplete.
  if (!researchOwnsSources) { news.invalidate(); loadedFeeds.delete('news'); loadErrors.delete('news'); }
  normalizedFeeds.delete('news'); normalizedFeeds.delete('market-news');
  newsCandidates = null; lastNewsSourceQuery = null; lastAssembleInput = null; lastAssembleOutput = null;
  releaseRequested = false;
}
function queryNewsReader(queryWindow) {
  if (!queryWindow) return news;
  const key = alertWindowKey(queryWindow);
  let entry = queryNewsReaders.get(key);
  if (!entry) {
    // The visible alert tabs own their 90-second/focus refresh. Cached periods must not each
    // add a second independent poller that keeps revisiting old history after a period switch.
    const reader = createQueryNews(queryWindow, { extraRows: () => marketNews.rows(), autoRefresh: false });
    const off = reader.onChange(() => {
      normalizedFeeds.delete('news'); newsCandidates = null; lastNewsSourceQuery = null;
      if (normalizedFeeds.get('market-news')?.windowKey !== 'null') normalizedFeeds.delete('market-news');
      listeners.forEach(fn => fn());
    });
    entry = { reader, off, active: 0 };
  }
  queryNewsReaders.delete(key); queryNewsReaders.set(key, entry);
  // Keep at most two inactive reading periods; active overlapping readers stay pinned.
  entry.active++;
  trimQueryReaders();
  return entry.reader;
}
// `articleUrlKey` (filings-shared.js) is the row's own canonical address: `canonicalArticleUrl`
// keeps a 16,384-entry text cache, which a pass over 81,921 history rows evicts as fast as it
// fills, so every switch between the AI window and a selected period parsed every URL again
// (profiled at 1,635ms plus 868ms inside the URL constructor).
const rowUrlKey = articleUrlKey;
function newsQueryRows(reader, queryWindow, companyReader = news) {
  if (!queryWindow) { newsCandidates = null; return reader.rows(); }
  const companyRows = companyReader.rows(), marketRows = marketNews.rows();
  const key = alertWindowKey(queryWindow);
  if (newsCandidates?.companyRows !== companyRows || newsCandidates.marketRows !== marketRows || newsCandidates.key !== key) {
    const selected = row => inAlertQuery({ at: row.publishedAt || row.date }, queryWindow);
    const urls = new Set([...companyRows, ...marketRows].filter(selected).filter(row => row.url).map(rowUrlKey));
    const matches = row => selected(row) || row.url && urls.has(rowUrlKey(row));
    newsCandidates = { companyRows, marketRows, key, company: companyRows.filter(matches), market: marketRows.filter(matches) };
  }
  return reader === companyReader ? newsCandidates.company : newsCandidates.market;
}
function readFeed(feed, { day, includeHistory, queryWindow = null, newsReader = news }) {
  const newsFeed = ['news', 'market-news'].includes(feed.id);
  const windowKey = alertWindowKey(newsFeed ? queryWindow : null);
  const cached = normalizedFeeds.get(feed.id);
  if (cached?.day === day && cached.includeHistory === includeHistory && cached.windowKey === windowKey && (!newsFeed || cached.newsReader === newsReader)) {
    // Re-age the wall-clock discovery note without reclassifying thousands of unchanged stories.
    return feed.id === 'news' ? { ...cached.row, ...companyNewsState(day, newsReader.meta()) } : cached.row;
  }
  const out = COLLECTORS[feed.id]({ day, includeHistory, queryWindow, newsReader, scope: 'universe', wanted: null }) || {};
  const row = toFeedRow(feed, { ...out,
    events: (out.events || []).filter((e) => includeHistory || eventDay(e) === day) }, day);
  if (loadedFeeds.has(feed.id) && !PRIVATE_FEEDS.has(feed.id)) normalizedFeeds.set(feed.id, { day, includeHistory, windowKey, newsReader: newsFeed ? newsReader : null, row });
  return row;
}

function loadFeed(id, refresh) {
  if (loadingFeeds.has(id)) return loadingFeeds.get(id);
  const pending = Promise.resolve().then(() => LOADERS[id]?.(refresh)).then(
    () => {
      // A loader may update freshness without publishing row changes (e.g. HTTP 304).
      if (refresh || !loadedFeeds.has(id)) normalizedFeeds.delete(id);
      loadErrors.delete(id); loadedFeeds.add(id);
    },
    (error) => { loadErrors.set(id, String(error?.message || error)); throw error; },
  ).finally(() => {
    // The bulk calendar adapter owns a capture outside earnings-calendar's event store.
    if (id === 'earnings-calendar') normalizedFeeds.delete(id);
    loadingFeeds.delete(id); listeners.forEach((fn) => fn());
    releaseInactiveMemory();
  });
  loadingFeeds.set(id, pending);
  return pending;
}

/** Revalidate the evidence stores without building a large alerts report.
 * Ask Research needs fresh inputs for the next question, not a discarded timeline. */
export async function refreshSources() {
  researchOwnsSources = true;
  observeSources();
  const context = screenerInsights.load({ refresh: true }).then(() => {
    if (screenerInsights.meta()?.latestReadFailed) throw Error('Company insights could not be refreshed.');
  });
  const results = await Promise.allSettled([...FEEDS.map((feed) => loadFeed(feed.id, true)), context]);
  return { checked: results.filter((r) => r.status === 'fulfilled').length,
    failed: results.filter((r) => r.status === 'rejected').length };
}

/** Load the shared feed stores without assembling or sorting any timeline. */
export async function prepareSources({ refresh = false, feedIds = null } = {}) {
  researchOwnsSources = true;
  observeSources();
  const wanted = feedIds == null ? null : new Set(feedIds);
  const selected = wanted ? FEEDS.filter(feed => wanted.has(feed.id)) : FEEDS;
  return Promise.allSettled(selected.map(feed => loadFeed(feed.id, refresh)));
}

// ---------------------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------------------

/**
 * Read every feed and return the requested day (default) or retained history through it, plus a
 * per-feed account of what was read.
 *
 * `Promise.allSettled`, never `all`: one feed being unreachable must cost that feed's rows and
 * nothing else. A failure becomes a `feeds[]` row saying so — the same rule as everywhere here, a
 * failed read is never an empty result.
 */
// WARM THE PER-ROW READINGS IN TIME-SLICED CHUNKS BEFORE THE SYNCHRONOUS COLLECTOR RUNS.
//
// `fromCompanyNews` classifies and attributes every story in one synchronous pass, and after a
// release the full-history reader is rebuilt from disk as new row objects, so that pass is cold
// again on every return: profiled at 4.2 seconds on one main-thread task, landing while the reader
// had already moved from AI Alerts to All Alerts. The readings themselves are memoised on the row
// object, so touching them here in ~12ms slices with a yield between each turns that one task into
// forty small ones. Nothing is skipped and nothing is decided here — the collector still reads
// every row itself and reports its own failures; this only changes when the work happens.
async function warmNewsReadings(feedId, reader, queryWindow, yieldForInput) {
  let rows;
  try {
    if (feedId === 'news') await reader.warm?.(yieldForInput);
    rows = feedId === 'news' ? newsQueryRows(reader, queryWindow, reader) : newsQueryRows(marketNews, queryWindow, reader);
  } catch { return; }
  let started = performance.now();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try { if (feedId === 'news') companyNewsEvent(row); else classifyStory(row); } catch { /* the collector reports the row's own failure */ }
    if (performance.now() - started >= 12) { await yieldForInput(); started = performance.now(); }
  }
}

export async function collect({ scope = 'universe', day = today(), holdings = null, includeHistory = false, refresh = false, load = true, onPartial = null, requestedCompanies = [], queryWindow = null, isCurrent = () => true } = {}) {
  observeSources();
  // Pure reassembly of explicitly preloaded source fixtures keeps using those same records.
  const newsReader = queryWindow && (load || queryNewsReaders.has(alertWindowKey(queryWindow))) ? queryNewsReader(queryWindow) : news;
  activeCollections++;
  try {
  const book = holdings || coverage.holdings();
  const settledFeeds = new Map(); // feed id -> the finished feed row
  // A warm estate can still require cold normalization. Do not make a tab click synchronously
  // classify every source before the shell can paint. Yield between source-sized batches too;
  // this changes scheduling only, never the records, coverage or private-data filtering.
  const yieldForInput = () => typeof window === 'undefined' ? Promise.resolve()
    : new Promise(resolve => setTimeout(resolve, 0));
  await yieldForInput();
  let batchStarted = performance.now();
  // Start with every source's current in-memory records. Refreshing one source
  // must not temporarily remove all the others from the timeline. The pending
  // status still says these records have not been rechecked by this collection.
  for (const feed of load ? FEEDS : []) {
    try {
      settledFeeds.set(feed.id, { ...readFeed(feed, { day, includeHistory, queryWindow, newsReader }), status: 'pending' });
    } catch { /* A source with no readable snapshot starts empty. */ }
    if (performance.now() - batchStarted >= 8) { await yieldForInput(); batchStarted = performance.now(); }
  }
  const build = () => {
    // Either news route can finish last. Reconcile companions from both current readers while
    // retaining each request's real pending/failed status; a partial is never a completed check.
    if (queryWindow) for (const id of ['news', 'market-news']) {
      const previous = settledFeeds.get(id);
      if (previous) {
        try { settledFeeds.set(id, { ...previous, events: readFeed(feedById.get(id), { day, includeHistory, queryWindow, newsReader }).events }); }
        catch { settledFeeds.set(id, { ...previous, status: 'failed', reachesToday: false,
          note: 'This news view could not be rebuilt. Previously read evidence remains visible.' }); }
      }
    }
    return assemble({ day, scope, holdings: book, includeHistory, settledFeeds, requestedCompanies, queryWindow });
  };
  // Publish the in-memory seed snapshot before any network requests start.
  if (load && onPartial) {
    try { onPartial(build()); } catch (err) { console.error('[daily-alerts] onPartial threw', err); }
  }
  // Feed promises often finish in one burst. Building/sorting the entire history after every
  // promise made one cached refresh rebuild a 60k-row pool twenty times before yielding to input.
  // Coalesce progress at the data boundary; throttling only the eventual DOM paint is too late.
  let partialTimer = null;
  const publishPartial = () => {
    partialTimer = null;
    // A partial nobody will read is not built. AI Alerts hands its own currency check through;
    // once its reader has moved to another tab, assembling and sorting the full-history report
    // for it was a one-to-two second task landing under the tab they had moved to. Collection,
    // the final report and the saved window are unaffected — only the progress publication.
    if (!isCurrent()) return;
    try { onPartial?.(build()); } catch (err) { console.error('[daily-alerts] onPartial threw', err); }
  };
  const schedulePartial = () => {
    if (load && onPartial && partialTimer === null) partialTimer = setTimeout(publishPartial, 80);
  };

  // EACH FEED SETTLES ON ITS OWN AND THE PAGE PAINTS AS IT DOES.
  //
  // The first version awaited all eight together, and the timeline then sat blank for as long
  // as the SLOWEST of them — measured at 10-15 seconds on a static origin, because the chatter API
  // is a direct call to somebody else's service and an unreachable host takes its own time to say
  // so. Seven feeds that had already answered were held hostage by the one that had not, on the
  // page. `Promise.all` over independent reads is head-of-line blocking with a
  // tidy syntax.
  //
  // Each feed loads and collects independently; `onPartial` publishes a bounded cadence of
  // progress while slower reads remain outstanding. Nothing rejects: a failed read is
  // never an empty result.
  await Promise.all(
    FEEDS.map(async (feed) => {
      let out;
      // Collect once without company narrowing. Scope is a view over the same source records,
      // never an ingestion filter. Unresolved rows survive in Universe.
      const args = { day, scope: 'universe', wanted: null, includeHistory, queryWindow, newsReader };
      try {
        if (load && feed.id === 'news' && newsReader !== news) {
          // The publisher route can correct dates at the same URL. Its complete original pool
          // supplies companions before the company working set is selected.
          try { await loadFeed('market-news', refresh); } catch { /* Company capture remains useful. */ }
          await refreshFilings(newsReader, refresh);
          loadedFeeds.add('news'); normalizedFeeds.delete('news');
        } else if (load) await loadFeed(feed.id, refresh);
        await yieldForInput();
        if (feed.id === 'news' || feed.id === 'market-news') await warmNewsReadings(feed.id, newsReader, queryWindow, yieldForInput);
        out = readFeed(feed, args);
        if (!load && loadErrors.has(feed.id)) out = { ...out, status: 'failed', reachesToday: false, note: `Last read failed: ${loadErrors.get(feed.id)}. Retained records remain visible.` };
        else if (!load && (!loadedFeeds.has(feed.id) || loadingFeeds.has(feed.id)) && LOADERS[feed.id]) out = { ...out, status: 'pending' };
      } catch (err) {
        // A failed refresh must not erase a last-good capture or masquerade as an empty feed.
        try { out = readFeed(feed, args); } catch { out = toFeedRow(feed, { events: [] }, day); }
        out = { ...out, status: 'failed', reachesToday: false, note: `Read failed: ${String(err?.message || err)}. Retained records remain visible.` };
      }
      settledFeeds.set(feed.id, out);
      schedulePartial();
    })
  );

  if (partialTimer !== null) clearTimeout(partialTimer);
  const completed = build();
  if (load && !queryWindow) {
    // Materialize from the already-settled source records; this starts no second
    // read. Universe is used so the same public snapshot can be narrowed against
    // the current Portfolio or Watchlist after a reload without persisting either.
    const allPublic = scope === 'universe' && !requestedCompanies.length ? completed
      : assemble({ day, scope: 'universe', holdings: book, includeHistory, settledFeeds });
    void alertWindowCache.write(materializePublicAlertWindow(allPublic));
  }
  return completed;
  } finally {
    activeCollections--;
    const entry = queryNewsReaders.get(alertWindowKey(queryWindow));
    if (newsReader !== news && entry?.reader === newsReader) entry.active--;
    trimQueryReaders(); releaseInactiveMemory();
  }
}

const LOADERS = {
  technicals: (refresh) => refresh ? technicals.refresh() : technicals.load(),
  earnings: (refresh) => refresh ? earnings.refresh() : earnings.load(),
  concalls: (refresh) => refresh ? concalls.refresh() : concalls.load(),
  chatter: (refresh) => refresh ? chatter.refresh() : chatter.load(),
  // One bulk snapshot only. `investors.refresh()` is a ninety-one-request upstream walk and belongs
  // to that tab's explicit "Re-read everything" control, not this consolidated header button.
  investors: (refresh) => refresh ? investors.refreshSnapshot() : investors.load(),
  announcements: (refresh) => refreshFilings(announcements, refresh),
  insider: (refresh) => refreshFilings(insider, refresh),
  news: (refresh) => refreshFilings(news, refresh),
  'market-news': async (refresh) => {
    await marketNews.load();
    if (refresh) await marketNews.refresh();
    while (marketNews.archiveMeta().remaining) {
      const before = marketNews.archiveMeta().remaining;
      const result = await marketNews.loadMore();
      if (result.failed || marketNews.archiveMeta().remaining >= before) throw Error('Market-news archive could not be completely read');
    }
    if (marketNews.meta().lastReadFailed) throw Error('Market-news capture could not be revalidated');
  },
  ...Object.fromEntries(ADDITIONAL_SOURCES.map((s) => [s.id, s.load])),
  'scheduled-concalls': (refresh) => loadFeed('concalls', refresh),
  'investor-positions': (refresh) => loadFeed('investors', refresh),
  'chatter-posts': (refresh) => loadFeed('chatter', refresh),
};

const yieldToInput = () => typeof window === 'undefined' ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 0));
async function refreshFilings(feed, refresh) {
  await feed.seed();
  if (refresh && !(await feed.refreshSnapshot()).available) throw Error('Latest filings capture unavailable');
  // `meta()` below rebuilds the reader's rows synchronously, and after a load every row is new:
  // warm the readings that rebuild will hit in slices first, so it pays for the join, not for
  // attributing every retained story in one task. A feed without `warm` (announcements, insider)
  // is unchanged.
  await feed.warm?.(yieldToInput);
  const m = feed.meta();
  if (m.reason || m.failed || m.truncated) throw Error(m.message || 'Filings coverage is incomplete');
}

// Read-only source notifications; the tab reassembles loaded records without triggering fetches.
export function onChange(fn) {
  observeSources();
  releaseRequested = false;
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      releaseRequested = true;
      // Reading work nobody is watching STOPS here, rather than being left to finish. The
      // release below cannot do it: it waits for the in-flight collection, and that collection
      // is itself awaiting the archive walk it would cancel, so it can only ever arrive after
      // the walk. Each pooled period reader is one request per retained month, so a walk left
      // running spends a tab's worth of requests after the tab is gone.
      //
      // DROPPING THEM FROM THE POOL MATTERS AS MUCH AS RELEASING THEM. Cancelling alone only
      // ends the walk in flight: a released reader still reachable from the pool starts the
      // whole walk again on its very next read, which is the same leak one request later.
      // The shared reader is deliberately left to the gated release below, so a prepared
      // research estate is not discarded by alert navigation.
      for (const [key, entry] of queryNewsReaders) {
        queryNewsReaders.delete(key); entry.off(); entry.reader.release();
      }
      releaseInactiveMemory();
    }
  };
}

const COLLECTORS = {
  technicals: fromTechnicals,
  earnings: fromEarnings,
  concalls: fromConcalls,
  chatter: fromChatter,
  investors: fromInvestors,
  announcements: fromAnnouncements,
  insider: fromInsider,
  news: fromCompanyNews,
  'market-news': fromMarketNews,
  ...Object.fromEntries(ADDITIONAL_SOURCES.map((s) => [s.id, s.read])),
};

function toFeedRow(feed, out, day) {
  const seen = new Map();
  const events = (out.events || []).filter((event) => {
    // Deduplicate exact records within a source, not independent exchange/publisher evidence.
    // Most IDs occur once. Only serialize source records when an ID actually collides.
    const id = String(event.id);
    const prior = seen.get(id);
    if (!prior) { seen.set(id, { first: event, signatures: null }); return true; }
    prior.signatures ||= new Set([JSON.stringify(prior.first.sourceRecord || prior.first)]);
    const signature = JSON.stringify(event.sourceRecord || event);
    if (prior.signatures.has(signature)) return false;
    prior.signatures.add(signature); return true;
  }).map((event) => ({ ...event, day: eventDay(event), feed: feed.id, feedLabel: feed.label, tab: feed.tab }));
  let oldestDay = null, newestDay = null, todayCount = 0;
  for (const event of events) {
    if (event.day === day) todayCount++;
    if (!event.day) continue;
    if (oldestDay === null || event.day < oldestDay) oldestDay = event.day;
    if (newestDay === null || event.day > newestDay) newestDay = event.day;
  }
  return {
    ...feed,
    status: out.status || 'ok',
    revision: out.revision || out.snapshotUpdatedAt || out.capturedAt || out.checkedAt || out.asOf || String(events.length),
    count: events.length,
    todayCount,
    oldestDay,
    newestDay,
    events,
    // Whether this feed's data actually extends to today. `null` where the feed cannot know.
    reachesToday: out.reachesToday ?? null,
    asOf: out.asOf ?? null,
    note: out.note || null,
    scopable: out.scopable !== false,
  };
}

/**
 * Build the report out of whatever has settled so far.
 *
 * A feed nobody has heard from yet is `pending` — NOT "nothing today", which is the one thing a
 * half-finished read must never be allowed to say. It carries no count at all, so the totals below
 * are of what has actually been read rather than of what is eventually expected.
 */
const discoveryMappings = new WeakMap();
const scopeProjections = new WeakMap();
let lastPublisherProjection = null;
let lastNewsSourceQuery = null;
function querySourceFeeds(feeds, queryWindow) {
  if (!queryWindow) { lastNewsSourceQuery = null; return feeds; }
  const company = feeds.find(feed => feed.id === 'news')?.events || [];
  const market = feeds.find(feed => feed.id === 'market-news')?.events || [];
  const key = alertWindowKey(queryWindow);
  if (lastNewsSourceQuery?.company !== company || lastNewsSourceQuery.market !== market || lastNewsSourceQuery.key !== key) {
    const urls = new Set([...company, ...market].filter(event => inAlertQuery(event, queryWindow))
      .filter(event => event.url).map(event => canonicalArticleUrl(event.url)));
    const matches = event => inAlertQuery(event, queryWindow) || event.url && urls.has(canonicalArticleUrl(event.url));
    lastNewsSourceQuery = { company, market, key, news: company.filter(matches), 'market-news': market.filter(matches) };
  }
  return feeds.map(feed => ({ ...feed, events: ['news', 'market-news'].includes(feed.id)
    ? lastNewsSourceQuery[feed.id] : queryEvents(feed.events, queryWindow) }));
}
export function mapPortfolioDiscoveryEvents(feedId, events, portfolioEntities) {
  if (!['market-news', 'twitter', 'ipos'].includes(feedId)) return events;
  const signature = JSON.stringify(portfolioEntities);
  const cached = discoveryMappings.get(events);
  if (cached?.feedId === feedId && cached.signature === signature) return cached.value;
  const value = events.flatMap(event => {
    const row = { ...event.sourceRecord, title: feedId === 'ipos' ? `${event.company || ''}: ${event.headline}` : event.headline,
      url: event.url, summary: event.sourceRecord?.summary };
    const matches = matchPortfolioNews(row, portfolioEntities);
    if (feedId === 'twitter') {
      // A post may discuss the company only in an attached image/thread. Keep exact collector
      // query context searchable as uncertain, without treating that query as article evidence.
      for (const query of event.sourceRecord?.matchedQueries || []) {
        const identity = portfolioEntities.find(e => e.entityId === query.entityId);
        if (identity && !matches.some(m => m.entityId === identity.entityId)) matches.push(attributeNewsRow(row, identity));
      }
    }
    if (!matches.length) return [event];
    return matches.map(matched => ({ ...event, ...newsSignal(matched),
      ...(feedId === 'twitter' ? { aiEligible: false, importance: IMPORTANCE.LOW } : {}),
      id: `${event.id}:entity:${matched.entityId}`, entityId: matched.entityId, ticker: matched.ticker,
      company: matched.company, issuer: feedId === 'ipos' ? event.company : null,
      sourceRecord: matched,
      detail: [event.detail, feedId === 'twitter' ? 'Unverified social discussion; open the post and corroborate against primary sources.' : null,
        matched.attribution.reason].filter(Boolean).join(' · '),
    }));
  });
  discoveryMappings.set(events, { feedId, signature, value });
  return value;
}

/** One company/article can arrive through company search and the shared publisher projection.
 * Collapse only that cross-route display overlap; never collapse different companies, unrelated
 * Universe stories, or filings/social events. Source readers and their complete archives remain
 * untouched. The preferred row retains its attribution and full source record, with compact
 * provenance for every contributing route; feed counts and exports use this same unique view.
 */
export function dedupePublisherAlertFeeds(feeds, { day, entities = [] } = {}) {
  const news = feeds.find(feed => feed.id === 'news')?.events;
  const market = feeds.find(feed => feed.id === 'market-news')?.events;
  const identity = JSON.stringify(entities);
  if (lastPublisherProjection?.news === news && lastPublisherProjection.market === market &&
      lastPublisherProjection.day === day && lastPublisherProjection.identity === identity) {
    return feeds.map(feed => lastPublisherProjection.groups.has(feed.id)
      ? { ...feed, ...lastPublisherProjection.groups.get(feed.id) } : feed);
  }
  const byTicker = new Map(entities.filter(entity => entity.ticker).map(entity => [String(entity.ticker).toUpperCase(), entity.entityId]));
  const groups = new Map();
  feeds.forEach((feed, feedIndex) => {
    if (!['news', 'market-news'].includes(feed.id)) return;
    feed.events.forEach((event, rowIndex) => {
      const ticker = String(event.ticker || '').toUpperCase();
      const identity = event.entityId && !event.entityId.startsWith('ticker:') ? event.entityId
        : byTicker.get(ticker) || (ticker ? `ticker:${ticker}` : event.entityId);
      if (!identity || !event.url) return;
      const key = JSON.stringify([identity, canonicalArticleUrl(event.url)]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ event, feed, feedIndex, rowIndex });
    });
  });
  const changes = new Map();
  const quality = event => ({ confirmed: 3, related: 2, uncertain: 1, unrelated: 0 })[event.attribution?.status] ?? 0;
  for (const group of groups.values()) {
    if (new Set(group.map(item => item.feed.id)).size < 2) continue;
    // Prefer stronger article/company evidence; equal evidence keeps the Company news route.
    const winner = [...group].sort((a, b) => quality(b.event) - quality(a.event) || Number(b.feed.id === 'news') - Number(a.feed.id === 'news'))[0];
    const provenance = group.flatMap(({ event, feed }) => event.newsProvenance || [{ feed: feed.id, eventId: event.id,
      url: event.url, publisher: event.sourceRecord?.publisher || event.sourceRecord?.source || null,
      discoverySource: event.sourceRecord?.discoverySource || null }]);
    for (const item of group) changes.set(`${item.feedIndex}:${item.rowIndex}`, item === winner ? { ...winner.event,
      newsProvenance: [...new Map(provenance.map(record => [JSON.stringify(record), record])).values()] } : null);
  }
  const result = !changes.size ? feeds : feeds.map((feed, feedIndex) => {
    if (!['news', 'market-news'].includes(feed.id)) return feed;
    const events = feed.events.flatMap((event, rowIndex) => {
      const key = `${feedIndex}:${rowIndex}`;
      return !changes.has(key) ? [event] : changes.get(key) ? [changes.get(key)] : [];
    });
    return { ...feed, events, count: events.length, todayCount: events.filter(event => event.day === day).length };
  });
  lastPublisherProjection = { news, market, day, identity, groups: new Map(result
    .filter(feed => ['news', 'market-news'].includes(feed.id))
    .map(feed => [feed.id, { events: feed.events, count: feed.count, todayCount: feed.todayCount }])) };
  return result;
}

function assemble({ day, scope, holdings, includeHistory, settledFeeds, requestedCompanies = [], queryWindow = null }) {
  const contextKey = alertContextKey(scope, holdings, day);
  const projectionKey = JSON.stringify([contextKey, includeHistory, requestedCompanies, queryWindow]);
  const scoped = scopeMatcher(scope, holdings);
  const requested = new Set(requestedCompanies.map(company => company.ticker).filter(Boolean));
  const requestedEntities = new Set(portfolioNewsEntities(requestedCompanies).map(entity => entity.entityId));
  // Research can name a public issuer outside the selected view. The view still controls
  // private portfolio-only feeds; public identity expansion must not change that boundary.
  const wanted = { has: ticker => scoped.has(ticker) || requested.has(ticker) };
  const portfolioEntities = portfolioNewsEntities([...holdings, ...requestedCompanies]);
  const portfolioNewsIds = new Set(portfolioEntities.map((entity) => entity.entityId));
  const scopeContext = { scope, wanted, entityIds: portfolioNewsIds, requestedEntities };
  const sourceFeeds = querySourceFeeds(FEEDS.map(
    (feed) => settledFeeds.get(feed.id) || { ...feed, status: 'pending', count: 0, events: [], reachesToday: null, asOf: null, note: null }
  ), queryWindow);
  const scopedFeeds = sourceFeeds.map((settled) => {
    // Private results can be cleared while public reads are in flight. Never let an old partial
    // report restore a previous account's rows after logout; read these memory-only feeds afresh.
    let feed = settled;
    if (PRIVATE_FEEDS.has(settled.id)) {
      const current = COLLECTORS[settled.id]({ day });
      current.events = current.events.filter((e) => (includeHistory || eventDay(e) === day) && inAlertQuery(e, queryWindow));
      feed = toFeedRow(settled, current, day);
    } else if (settled.portfolioOnly) {
      // The calendar is excluded from the public saved pool. Read its current source cache,
      // whose source/membership subscriptions invalidate it even while this tab is unmounted.
      // Recreating unchanged calendar events here would force the whole timeline to sort again.
      feed = readFeed(feedById.get(settled.id), { day, includeHistory, queryWindow });
    }
    const all = mapPortfolioDiscoveryEvents(feed.id, feed.events, portfolioEntities);
    // The S Screen calendar is already scoped by the exact synchronized portfolio membership.
    // That fact lets BSE-only holdings survive even when they have no NSE ticker; it must not make
    // the private portfolio schedule leak into Universe or the reader's personal watchlist.
    // Company News has the same legitimate no-ticker case, but carries a stable ISIN entity id
    // instead of being pre-scoped by its collector.
    let projection = scopeProjections.get(all);
    if (projection?.key !== projectionKey) {
      const events = all.filter(event => matchesAlertScope(event, scopeContext));
      projection = { key: projectionKey, events, todayCount: events.filter(e => e.day === day).length,
        unresolved: all.filter(event => !event.ticker && !event.entityId).length };
      scopeProjections.set(all, projection);
    }
    const { events, unresolved, todayCount } = projection;
    const unscopable = feed.portfolioOnly && scope !== 'portfolio';
    return { ...feed, events, count: events.length, todayCount,
      sourceCount: all.length, unresolvedCount: unresolved, scopable: !unscopable,
      note: [feed.note, scope !== 'universe' && unresolved ? `${unresolved} records have no resolved ticker and are available in Universe only.` : null].filter(Boolean).join(' ') || null };
  });

  const feeds = dedupePublisherAlertFeeds(scopedFeeds, { day, entities: portfolioEntities }).map(feed => {
    if (!queryWindow) return feed;
    const events = queryEvents(feed.events, queryWindow);
    return { ...feed, events, count: events.length, todayCount: events.filter(event => event.day === day).length };
  });

  const inputMatches = lastAssembleInput && lastAssembleInput.scope === scope && lastAssembleInput.day === day &&
      lastAssembleInput.includeHistory === includeHistory && lastAssembleInput.windowKey === alertWindowKey(queryWindow) && feeds.every((feed, i) => {
        const previous = lastAssembleInput.eventGroups[i];
        return previous === feed.events || (previous?.length === feed.events.length && feed.events.every((event, j) => event === previous[j]));
      });

  const done = feeds.filter((f) => f.status !== 'pending');

  // A capture timestamp cannot identify a scoped result: membership, private access and
  // same-count corrections can change without advancing it. Reuse only identical records;
  // still recompute source-health metadata on status-only arrivals.
  const events = inputMatches ? lastAssembleOutput.events : [];
  if (!inputMatches) {
    for (const f of feeds) for (const ev of f.events) events.push(ev);
    events.sort(byNewestFirst);
    ensureUniqueIds(events);
  }
  const eventDays = inputMatches ? null : [...new Set(events.map((event) => event.day).filter(Boolean))].sort();

  lastAssembleInput = { scope, day, includeHistory, windowKey: alertWindowKey(queryWindow), eventGroups: feeds.map(feed => feed.events) };
  lastAssembleOutput = {
    day,
    scope,
    contextKey,
    ...(queryWindow ? { queryWindow } : {}),
    sourceFeeds: sourceFeeds.filter(publicAlertFeed),
    includeHistory,
    events,
    feeds,
    pending: feeds.filter((f) => f.status === 'pending').length,
    meta: {
      ...(inputMatches ? lastAssembleOutput.meta : {
      alerts: events.filter((e) => e.severity === SEVERITY.ALERT).length,
      updates: events.filter((e) => e.severity === SEVERITY.UPDATE).length,
      positive: events.filter((e) => e.direction === DIRECTION.POSITIVE).length,
      negative: events.filter((e) => e.direction === DIRECTION.NEGATIVE).length,
      neutral: events.filter((e) => e.direction === DIRECTION.NEUTRAL).length,
      highImportance: events.filter((e) => e.importance === IMPORTANCE.HIGH).length,
      companies: new Set(events.map((e) => e.ticker || e.entityId).filter(Boolean)).size,
      days: eventDays.length,
      undated: events.filter((e) => !e.day).length,
      scheduled: events.filter((e) => e.kind === 'scheduled').length,
      oldestEventDay: eventDays[0] || null,
      newestEventDay: eventDays.at(-1) || null,
      }),
      sourceRecords: feeds.reduce((n, f) => n + (f.sourceCount || 0), 0),
      unresolvedRecords: feeds.reduce((n, f) => n + (f.unresolvedCount || 0), 0),
      // The FRESHEST feed and the STALEST feed, both, because one number cannot describe eight
      // captures taken at eight different times and picking the freshest would flatter the rest.
      newestRead: maxTime(done.map((f) => f.asOf)),
      oldestRead: minTime(done.filter((f) => f.status === 'ok').map((f) => f.asOf)),
      feedsReachingToday: feeds.filter((f) => f.reachesToday === true).length,
      feedsBehind: feeds.filter((f) => f.reachesToday === false).length,
      feedsPending: feeds.filter((f) => f.status === 'pending').length,
      feedsTotal: feeds.length,
      moveThreshold: MOVE_PCT,
    },
  };
  return lastAssembleOutput;
}

/** Match stable company identity OR ticker, exactly as Portfolio News does. A discovered BSE
 * symbol or an older ticker must not veto the same held ISIN in another dashboard view. This
 * affects visibility, not the article's attribution/AI materiality or the source's saved identity.
 */
export function matchesAlertScope(event, { scope, wanted, entityIds, requestedEntities } = {}) {
  if (event.portfolioOnly) return scope === 'portfolio';
  if (event.entityId && requestedEntities?.has(event.entityId)) return true;
  if (scope === 'portfolio' && event.entityId && entityIds?.has(event.entityId)) return true;
  if (event.ticker) return !!wanted?.has(event.ticker);
  return scope === 'universe';
}

/**
 * ONE KEY MUST NEVER MEAN TWO ROWS — closed here, once, for every feed.
 *
 * `scoreTable`'s repaint holds `<tr>` nodes in a Map keyed by the row key, so a duplicate key
 * silently displaces one node and orphans it in the DOM: wrong row, wrong place, invisible to any
 * COUNT. That has bitten this codebase twice already (the News table's position-derived key, and
 * the con-call table's `(company, time)` pair), and it bit here on the third read: **the same story
 * is returned by two companies' news searches**, so `news:<url>` named two different rows — a
 * RELIANCE row and an HDFCBANK row about one article. Both are real and neither may be dropped.
 *
 * So the ids stay content-derived — never positional, which is the failure that cannot be fixed by
 * a counter — and a counter closes genuine content duplicates. The reverse failure, two keys
 * meaning one row, is not possible here: the suffix is assigned in the feed's own settled order.
 *
 * It lives in `assemble()` rather than in each collector because this is the only place that sees
 * every feed's rows together, and a collision can span two feeds as easily as two rows of one.
 */
function ensureUniqueIds(events) {
  const seen = new Map();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const n = seen.get(ev.id) || 0;
    seen.set(ev.id, n + 1);
    if (n) events[i] = { ...ev, id: `${ev.id}#${n}` };
  }
  return events;
}

/** Newest day first, then newest clock time. A row with no time follows timed rows on that day. */
function byNewestFirst(a, b) {
  const ad = eventDay(a) || '';
  const bd = eventDay(b) || '';
  if (ad !== bd) return bd.localeCompare(ad);
  const at = a.time || '';
  const bt = b.time || '';
  if (at && bt && at !== bt) return bt.localeCompare(at);
  if (at && !bt) return -1;
  if (bt && !at) return 1;
  // THE SAME DAY AND THE SAME CLOCK TIME IS A TIE, AND A TIE MAY NOT BE LEFT TO INPUT ORDER.
  // One story returned by two companies' searches is two rows carrying identical timestamps, and
  // the bounded reader and the full-history reader assemble them in different orders — so an
  // unbroken tie makes the same evidence come out in a different sequence depending on which
  // period is selected. That is what "1-day query preserves full-history IDs" reports, and no
  // row was ever missing: both companies are present in both readings, in opposite order.
  // Company then id — both already part of the row's identity, so neither invents an ordering.
  return String(a.company || '').localeCompare(String(b.company || '')) ||
    String(a.id || '').localeCompare(String(b.id || ''));
}

/** The Indian trading date committed on the row, whether `at` is a day or a full instant. */
function eventDay(event) {
  if (event?.day && /^\d{4}-\d{2}-\d{2}$/.test(String(event.day))) return String(event.day);
  const at = event?.at;
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  return istDay(at);
}

/** One-day mode matches exactly; history mode includes every retained row through the report day. */
function inRequestedWindow(value, day, includeHistory) {
  if (includeHistory) return true; // retain undated rows and future schedules; view filters are downstream
  const rowDay = eventDay({ at: value });
  if (!rowDay) return false;
  return rowDay === day;
}

const maxTime = (list) => latestConfirmation(...list);
const minTime = (list) => {
  let oldest = null;
  let oldestMs = Infinity;
  for (const value of list.filter((v) => v != null)) {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(ms) && ms < oldestMs) {
      oldest = value;
      oldestMs = ms;
    }
  }
  return oldest;
};

/** Newest real confirmation across mixed ISO-string and epoch timestamps. */
function latestConfirmation(...values) {
  let latest = null;
  let latestMs = -Infinity;
  for (const value of values.filter((v) => v != null)) {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

const inScope = (wanted, ticker) => !wanted || (!!ticker && wanted.has(String(ticker).toUpperCase()));

// ---------------------------------------------------------------------------------------
// Per-feed collectors
//
// Each returns { events, status, reachesToday, asOf, note }. `reachesToday` is the honest half:
// a collector that finds nothing must say whether it LOOKED at today.
// ---------------------------------------------------------------------------------------

const metricText = (metric) => {
  if (!metric) return null;
  const label = metric.label || 'Metric';
  const pct = numeric(metric.pct);
  if (metric.kind === 'turnaround') return `${label} to profit`;
  if (metric.kind === 'slipped-to-loss') return `${label} to loss`;
  if (metric.kind === 'loss-narrowed') return `${label} loss narrowed${pct == null ? '' : ` ${Math.abs(pct).toFixed(1)}%`}`;
  if (metric.kind === 'loss-widened') return `${label} loss widened${pct == null ? '' : ` ${Math.abs(pct).toFixed(1)}%`}`;
  if (metric.kind === 'loss-flat') return `${label} loss flat`;
  if (metric.kind === 'flat') return `${label} 0%`;
  if (metric.kind !== 'normal' || pct == null) return `${label} comparison unavailable`;
  return `${label} ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
};

/** Filed results. Direction uses the source's YoY/QoQ revenue and net-profit comparisons. */
function fromEarnings({ day, wanted, includeHistory }) {
  const m = earnings.meta() || {};
  const degraded = !!m.degraded;
  // Reading a committed file proves only that the file is readable now, not that Moneycontrol was
  // read now. `checkedAt` is source freshness only for a live/store confirmation.
  const confirmedAt = degraded || m.origin === 'snapshot' ? m.fetchedAt : latestConfirmation(m.checkedAt, m.fetchedAt);
  const fetchedDay = istDay(confirmedAt);
  const basis = String(m.subType || 'yoy').toUpperCase();
  const rows = earnings.all().filter((r) => inRequestedWindow(r.resultDate, day, includeHistory) && inScope(wanted, r.ticker));
  const events = rows.map((r) => {
    const revenue = Number(r.revenue?.direction || 0);
    const profit = Number(r.netProfit?.direction || 0);
    const direction = profit > 0 && revenue >= 0
      ? DIRECTION.POSITIVE
      : profit < 0 && revenue <= 0
        ? DIRECTION.NEGATIVE
        : DIRECTION.NEUTRAL;
    const reading = direction === DIRECTION.POSITIVE
      ? `${basis}: net profit rose and revenue did not fall.`
      : direction === DIRECTION.NEGATIVE
        ? `${basis}: net profit fell and revenue did not rise.`
        : `${basis}: revenue and net profit were mixed or flat; shown as neutral.`;
    return {
      id: `earnings:${r.scId || r.ticker}:${r.resultDate}:${basis}`,
      sourceRecord: r,
      ...signal(direction, IMPORTANCE.HIGH, reading, 'High: a quarterly financial result was filed.'),
      time: null,
      at: r.resultDate,
      ticker: r.ticker || null,
      company: r.company || r.fullName || r.name || r.ticker || '—',
      headline: `${basis} quarterly result filed`,
      detail: [metricText(r.revenue), metricText(r.netProfit)].filter(Boolean).join(' · ') || 'Filed figures carried without a comparable percentage',
      url: r.mcUrl || null,
    };
  });
  return {
    events,
    status: degraded ? 'failed' : 'ok',
    reachesToday: !degraded && !!fetchedDay && fetchedDay >= day,
    asOf: confirmedAt,
    note: degraded
      ? `The earnings feed is using its retained snapshot because the live read degraded (${m.degraded}).`
      : fetchedDay && fetchedDay >= day ? null : `The earnings feed was last read on ${fetchedDay || 'an unknown date'}.`,
  };
}

/** Held con-calls, reproducing StockScans' own sentiment and result bands. */
function fromConcalls({ day, wanted, includeHistory }) {
  const m = concalls.meta() || {};
  const degraded = !!m.degraded;
  const confirmedAt = degraded || m.origin === 'snapshot' ? m.fetchedAt : latestConfirmation(m.checkedAt, m.fetchedAt);
  const fetchedDay = istDay(confirmedAt);
  const rows = concalls.all().filter((r) => r.analysisTracked !== false && inRequestedWindow(r.date || r.when, day, includeHistory) && inScope(wanted, r.ticker));
  const events = rows.map((r) => {
    const sentiment = r.sentiment?.label || null;
    const direction = ['Bullish', 'Optimistic'].includes(sentiment)
      ? DIRECTION.POSITIVE
      : ['Bearish', 'Cautious'].includes(sentiment)
        ? DIRECTION.NEGATIVE
        : DIRECTION.NEUTRAL;
    const analysed = r.resultScore != null;
    const importance = direction !== DIRECTION.NEUTRAL || (analysed && (r.resultScore >= 80 || r.resultScore < 20))
      ? IMPORTANCE.HIGH
      : IMPORTANCE.LOW;
    const result = r.resultTier?.label ? `${r.resultTier.label} result score ${Number(r.resultScore).toFixed(1)}` : 'result analysis pending';
    return {
      id: `concall:${concalls.rowUid(r)}`,
      sourceRecord: r,
      ...signal(
        direction,
        importance,
        sentiment ? `StockScans sentiment: ${sentiment}.` : 'StockScans sentiment is pending; shown as neutral.',
        importance === IMPORTANCE.HIGH ? `High: non-neutral sentiment or an extreme StockScans result band (${result}).` : `Low: neutral or pending analysis (${result}).`
      ),
      time: istTime(r.when),
      at: r.when || r.date,
      ticker: r.ticker || null,
      company: r.name || r.ticker || '—',
      headline: `Con-call ${analysed ? 'analysis published' : 'held; analysis pending'}`,
      detail: [result, ...(r.tags || [])].join(' · '),
      url: r.transcriptUrl || null,
    };
  });
  return {
    events,
    status: degraded ? 'failed' : 'ok',
    reachesToday: !degraded && !!fetchedDay && fetchedDay >= day,
    asOf: confirmedAt,
    note: degraded
      ? `The con-call feed is using its retained snapshot because the live read degraded (${m.degraded}).`
      : fetchedDay && fetchedDay >= day ? null : `The con-call feed was last read on ${fetchedDay || 'an unknown date'}.`,
  };
}

/** One event per covered company in the source's rolling public-chatter snapshot. */
function fromChatter({ day, wanted, includeHistory }) {
  const m = chatter.meta() || {};
  const generatedDay = istDay(m.generatedAt);
  const inWindow = inRequestedWindow(generatedDay, day, includeHistory);
  const rows = inWindow ? chatter.all().filter((r) => inScope(wanted, r.ticker)) : [];
  const events = rows.map((r) => {
    const label = String(r.sentiment?.label || 'neutral').toLowerCase();
    const direction = label === 'bullish' ? DIRECTION.POSITIVE : label === 'bearish' ? DIRECTION.NEGATIVE : DIRECTION.NEUTRAL;
    const mentions = numeric(r.mentions) || 0;
    const change = numeric(r.mentionsChangePct);
    const importance = mentions >= CHATTER_HIGH_MENTIONS || (change != null && Math.abs(change) >= CHATTER_HIGH_CHANGE_PCT)
      ? IMPORTANCE.HIGH
      : IMPORTANCE.LOW;
    const threshold = [
      mentions >= CHATTER_HIGH_MENTIONS ? `${mentions} mentions` : null,
      change != null && Math.abs(change) >= CHATTER_HIGH_CHANGE_PCT ? `${Math.abs(change).toFixed(0)}% mention change` : null,
    ].filter(Boolean);
    return {
      id: `chatter:${r.slug || r.ticker}:${m.generatedAt || generatedDay}`,
      sourceRecord: r,
      ...signal(
        direction,
        importance,
        `Source rolling-${m.window || '30d'} sentiment: ${r.sentiment?.labelText || r.sentiment?.label || 'Neutral'}.`,
        importance === IMPORTANCE.HIGH
          ? `High: ${threshold.join(' and ')} reached the stated chatter threshold.`
          : `Low: fewer than ${CHATTER_HIGH_MENTIONS} mentions and less than ${CHATTER_HIGH_CHANGE_PCT}% absolute mention change.`
      ),
      time: istTime(m.generatedAt),
      at: m.generatedAt || generatedDay,
      // `at` is a UTC instant. Preserve the already-computed IST date so an evening capture does
      // not move back one day when `eventDay()` sees the ISO prefix.
      day: generatedDay,
      ticker: r.ticker || null,
      company: r.name || r.ticker || '—',
      headline: `${r.sentiment?.labelText || r.sentiment?.label || 'Neutral'} public chatter`,
      detail: `${mentions} mentions in the rolling ${m.window || '30d'} window${change == null ? '' : ` · ${change > 0 ? '+' : ''}${change.toFixed(0)}% vs prior window`}`,
      url: m.url || null,
    };
  });
  return {
    events,
    status: m.ok === false ? 'failed' : m.health?.state === 'updated' ? 'ok' : 'partial',
    reachesToday: m.health?.state === 'updated' && istDay(m.health.checkedAt) === day,
    asOf: m.health?.checkedAt ? new Date(m.health.checkedAt).toISOString() : null,
    note: m.ok === false
      ? `Public Chatter could not be confirmed (${m.reason || 'upstream'}).${events.length ? ' Retained rows remain visible.' : ''}`
      : m.health?.state !== 'updated'
        ? `${m.health?.label || 'Source checks unconfirmed'}. Captured discussion remains visible; company coverage is not exhaustive.`
        : generatedDay === day
        ? null
        : `Public Chatter is a rolling snapshot last generated on ${generatedDay || 'an unknown date'}; it is not a post-by-post event log.`,
  };
}

const investorTicker = (move) => {
  const slug = String(move.companySlug || '').trim().toUpperCase();
  return slug && !slug.startsWith('SCRIP-') ? slug : null;
};

/** The complete/incomplete rule for the investor feed, exported so an outage is testable. */
export function investorCoverageState(m = {}) {
  const listFailed = m.ok === false;
  // MISSING EVIDENCE AND UNCONFIRMED EVIDENCE ARE BOTH INCOMPLETE, AND THEY ARE NOT THE SAME
  // CLAIM. A book with no copy at all contributes no rows and its absence can hide a real move;
  // a retained book whose latest re-check did not answer contributes every one of its rows and is
  // simply of a known age. Counting the second as missing is what let this feed report "90 of 90
  // books available" and "90 could not be included" out of the same metadata.
  const missingBooks = Number(m.pending || 0) + Number(m.failedBooks || 0);
  const uncheckedBooks = Number(m.uncheckedBooks || 0);
  const staleBooks = Number(m.staleBooks || 0);
  const incomplete = listFailed || missingBooks > 0 || m.stale === true || staleBooks > 0 || uncheckedBooks > 0;
  const problems = [
    listFailed
      ? `the investor list could not be read${m.reason || m.message ? ` (${m.reason || m.message})` : ''}`
      : null,
    missingBooks > 0 ? `${m.loadedBooks || 0} of ${m.total || 0} investor books are available; ${missingBooks} could not be included` : null,
    staleBooks > 0
      ? `${staleBooks} investor book${staleBooks === 1 ? ' is' : 's are'} last-good fallback data${m.staleReason ? ` (${m.staleReason})` : ''}`
      : m.stale === true
        ? `the investor list is last-good fallback data${m.staleReason ? ` (${m.staleReason})` : ''}`
        : null,
    uncheckedBooks > 0
      ? `${uncheckedBooks} investor book${uncheckedBooks === 1 ? ' is' : 's are'} retained from the last good read and could not be re-checked${m.staleReason ? ` (${m.staleReason})` : ''}`
      : null,
  ].filter(Boolean);
  return { incomplete, missingBooks, staleBooks, uncheckedBooks, problems };
}

/** Quarterly disclosed holding changes. A disappearance is labelled, not overstated as a sale. */
function fromInvestors({ day, scope, wanted, includeHistory }) {
  const m = investors.meta() || {};
  const confirmedAt = (move) => investors.confirmedAtFor(move.slug) || m.checkedAt || m.capturedAt || m.fetchedAt;
  const moves = investors.allMoves().filter((move) => {
    const confirmedDay = istDay(confirmedAt(move));
    const ticker = investorTicker(move);
    return isMove(move.action)
      && inRequestedWindow(confirmedDay, day, includeHistory)
      && (ticker ? inScope(wanted, ticker) : scope === 'universe');
  });
  const events = moves.map((move) => {
    const ticker = investorTicker(move);
    const bookConfirmedAt = confirmedAt(move);
    const confirmedDay = istDay(bookConfirmedAt);
    const positive = move.action === 'new' || move.action === 'added';
    const direction = positive ? DIRECTION.POSITIVE : DIRECTION.NEGATIVE;
    const presenceChange = move.action === 'new' || move.action === 'exited';
    const largeDelta = move.deltaPp != null && Math.abs(move.deltaPp) >= INVESTOR_HIGH_PP;
    const importance = presenceChange || largeDelta ? IMPORTANCE.HIGH : IMPORTANCE.LOW;
    const actionText = {
      new: 'newly disclosed',
      added: `increased by ${Math.abs(move.deltaPp || 0).toFixed(2)}pp`,
      trimmed: `reduced by ${Math.abs(move.deltaPp || 0).toFixed(2)}pp`,
      exited: 'no longer disclosed',
    }[move.action] || move.action;
    return {
      id: `investor:${move.slug}:${move.companySlug}:${move.latest}:${move.action}`,
      sourceRecord: move,
      ...signal(
        direction,
        importance,
        `${move.investor}'s holding was ${actionText} between ${move.prior} and ${move.latest}.`,
        presenceChange
          ? 'High: the holding appeared in or disappeared from disclosure.'
          : importance === IMPORTANCE.HIGH
            ? `High: the disclosed holding changed by at least ${INVESTOR_HIGH_PP} percentage point.`
            : `Low: the disclosed holding changed by less than ${INVESTOR_HIGH_PP} percentage point.`
      ),
      time: istTime(bookConfirmedAt),
      at: bookConfirmedAt || confirmedDay,
      day: confirmedDay,
      ticker,
      company: move.company || ticker || '—',
      headline: `${move.investor}: ${actionText}`,
      detail: `${move.prior} → ${move.latest}${move.action === 'exited' ? ' · “No longer disclosed” does not prove a complete sale.' : ''}`,
      url: move.companySlug ? `https://ticker.finology.in/company/${encodeURIComponent(move.companySlug)}` : null,
      // Machine-readable copies of what `actionText` already spells out. `deltaPp` stays
      // NULL for `new` and `exited` exactly as `deriveMoves` leaves it — a first or last
      // disclosure states a stake, never a change — so a card printing it can never invent
      // a trade size for a position that simply appeared or disappeared.
      action: move.action,
      investor: move.investor,
      deltaPp: move.action === 'added' || move.action === 'trimmed' ? move.deltaPp ?? null : null,
    };
  });
  // `meta().checkedAt` is deliberately the OLDEST confirmation behind the current set of books.
  // It is therefore the only honest feed-wide freshness claim when books were confirmed at
  // different moments; individual rows above keep the confirmation for their own investor book.
  const coverageAt = m.checkedAt || m.capturedAt || m.fetchedAt;
  const coverageDay = istDay(coverageAt);
  const coverage = investorCoverageState(m);
  return {
    events,
    status: coverage.incomplete ? 'failed' : 'ok',
    reachesToday: !coverage.incomplete && coverageDay === day,
    asOf: coverageAt || null,
    note: coverage.incomplete
      ? `${coverage.problems.join('; ')}. This reading is incomplete.`
      : coverageDay === day
      ? 'Investor changes are quarterly disclosure comparisons dated to each investor book confirmation, not trade timestamps.'
      : `Investor changes are quarterly disclosure comparisons; the oldest current book confirmation is ${coverageDay || 'unknown'}, not a trade date.`,
  };
}

/** Everything filed to BSE, with the exported conservative rule and BSE's own critical flag. */
function fromAnnouncements({ day, wanted, includeHistory }) {
  const m = announcements.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = announcements.rows().filter((r) => inRequestedWindow(r.date, day, includeHistory) && inScope(wanted, r.ticker));

  const events = rows.map((r) => ({
    id: `ann:${r.newsId || JSON.stringify([r.ticker, r.date, r.url, r.title, r.category])}`,
    sourceRecord: r,
    ...announcementSignal(r),
    time: r.time ? String(r.time).slice(0, 5) : null,
    at: r.date,
    ticker: r.ticker || null,
    company: r.company || r.ticker || '—',
    headline: r.title || r.headline || 'Filing',
    detail: [...(r.sources || [r.source]), r.category, r.subCategory].filter(Boolean).join(' · ') || 'Category not carried',
    url: r.url || null,
  }));

  return {
    events,
    // A DATE-INDEXED CAPTURE CAN ANSWER THIS EXACTLY. The snapshot asks BSE what was filed on a
    // day across the whole exchange, so if the capture ran today it has today; if it did not, an
    // empty bucket means nobody looked, not that nobody filed.
    reachesToday: !!capturedDay && capturedDay >= day,
    asOf: m.capturedAt || null,
    note: (capturedDay && capturedDay >= day ? '' : `The newest BSE capture ran on ${capturedDay || 'an unknown date'}. `) +
      'Exchange-wide coverage and freshness refer to BSE. Additional NSE/DRHP rows cover only requested company/date lookups.',
  };
}

/** Insider and promoter disclosures, classified from the transaction and measurable size. */
function fromInsider({ day, wanted, includeHistory }) {
  const m = insider.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = insider.rows().filter((r) => inRequestedWindow(r.date, day, includeHistory) && inScope(wanted, r.ticker));

  const events = rows.map((r) => {
    const cells = r.cells || {};
    const pick = (...names) => names.map((n) => cells[n]).find((v) => v != null && v !== '');
    return {
      // Content-derived rather than position-derived: loading an older day must not rename every
      // row after it, or a refresh would report the whole timeline as newly arrived.
      id: `insider:${r.ticker}|${r.date}|${JSON.stringify(cells)}`,
      sourceRecord: r,
      ...insiderSignal(cells),
      time: null,
      at: r.date,
      ticker: r.ticker || null,
      company: pick('Company') || r.ticker || '—',
      headline: [pick('Insider'), pick('Transaction', 'Acq/Disp', 'Mode')].filter(Boolean).join(' — ') || 'Insider disclosure',
      detail: [pick('Category'), pick('Mode'), pick('Trade Shares') ? `${pick('Trade Shares')} shares` : null].filter(Boolean).join(' · ') || 'Details not carried',
      // Prefer the exchange filing URL when one is carried; otherwise use the same exact-insider
      // public disclosure search as the Insider Trades tab. AI Alerts can then trace this evidence
      // to a public record instead of ending at a derived dashboard sentence.
      url: insiderTradeSourceUrl(r),
    };
  });

  return {
    events,
    reachesToday: !!capturedDay && capturedDay >= day,
    asOf: m.capturedAt || null,
    note: capturedDay && capturedDay >= day ? null : `The newest insider capture ran on ${capturedDay || 'an unknown date'}, so nothing here has looked at ${day}.`,
  };
}

/** Complete technical readings, labelled as snapshots/measurements versus material signals. */
function fromTechnicals({ day, wanted, includeHistory }) {
  const m = technicals.meta() || {};
  const generated = m.generated_at || null;
  // THE MOVE IS DATED BY ITS SESSION, NOT BY THE CAPTURE. `pct_change_today` is the change between
  // a company's last two completed closes, and the file says which session that close belongs to
  // (`price_date`, per row `bar_date`). The scrape is scheduled for 07:00 IST — the morning AFTER
  // those closes — and when GitHub ran it late, mid-session, the capture day and the session day
  // disagreed in the other direction too: an unfinished 2 September bar was printed as that day's
  // close. Dating by the capture was wrong both ways. A file from before `price_date` existed falls
  // back to the capture's IST day, which is the best it can say.
  const priceDay = m.price_date || istDay(generated);
  // EQUALS, NOT ">=". This feed holds ONE session's closes and nothing about any other day.
  const reachesToday = priceDay === day;

  const events = [];
  for (const s of technicals.all()) {
    const c = s.company || {};
    const move = numeric(c.pct_change_today);
    const barDay = c.bar_date || priceDay;
    if (!inScope(wanted, c.ticker) || !inRequestedWindow(barDay, day, includeHistory)) continue;
    // Every scored or failed source row is retained, including below-threshold measurements.
    // A technical reading is labelled as a snapshot, never invented as a breakout or trade.
    events.push(records.record({ id: `technical-snapshot:${c.ticker || c.name}:${barDay}`, row: s,
      at: barDay, ticker: c.ticker, company: c.name, headline: 'Technical session snapshot',
      detail: `${barDay || 'Session date unavailable'} · ${s.tickerError ? 'Price data unavailable' : `Close ${c.cmp ?? 'not supplied'}; change ${move == null ? 'not supplied' : `${move}%`}; volume ratio ${c.volume_ratio_today ?? 'not supplied'}`}`,
      url: c.screenerUrl, kind: 'snapshot' }));
    // PARTICIPATION IS ITS OWN EVENT. `volume_ratio_today` is today's volume against the company's
    // own 20-day average and `consolidation_breakout` is the feed's base-breakout reading; neither
    // is a price move, and a company can trip either with the close barely changed. That is the
    // case worth surfacing — volume arriving before the price does — so it is a row rather than a
    // detail hidden inside a move that may not have happened.
    //
    // NEUTRAL, BECAUSE VOLUME HAS NO SIGN. Heavy trading is accumulation or distribution and the
    // tape does not say which; calling it positive would be a judgement the data does not support.
    // A confirmed break above a base IS directional, and only that branch is called positive.
    const volX = numeric(c.volume_ratio_today);
    const breakout = c.consolidation_breakout || {};
    const brokeOut = breakout.breaks_out === true && (breakout.quality === 'strong' || breakout.quality === 'weak_base');
    if ((Number.isFinite(volX) && volX >= VOLUME_X) || brokeOut) {
      const barDay = c.bar_date || priceDay;
      if (inScope(wanted, c.ticker) && inRequestedWindow(barDay, day, includeHistory)) {
        const volText = Number.isFinite(volX) ? `${volX.toFixed(1)}x its 20-day average volume` : null;
        events.push({
          id: `vol:${c.ticker}:${barDay}`,
          sourceRecord: s,
          ...signal(
            brokeOut ? DIRECTION.POSITIVE : DIRECTION.NEUTRAL,
            IMPORTANCE.HIGH,
            brokeOut
              ? `Closed above its ${breakout.base_range_pct != null ? `${breakout.base_range_pct}% ` : ''}consolidation base on the ${barDay} session${breakout.volume_confirm ? ', with volume confirming' : ', without volume confirmation'} (the feed grades the base ${breakout.quality}).`
              : `Traded ${volText} on the ${barDay} session. Volume is participation, not direction — the tape does not say whether it was accumulation or distribution.`,
            brokeOut
              ? 'High: the technicals feed reports a completed break above a consolidation base.'
              : `High: today's volume reached the stated ${VOLUME_X}x threshold against the company's own 20-day average.`
          ),
          time: null,
          at: barDay,
          ticker: c.ticker || null,
          company: c.name || c.ticker || '—',
          headline: brokeOut
            ? `Broke out of its base at the ${barDay} close`
            : `Volume ${volX.toFixed(1)}x its 20-day average at the ${barDay} close`,
          detail: [
            volText,
            move != null ? `close ${move >= 0 ? '+' : ''}${Number(move).toFixed(1)}%` : null,
            c.delivery_trend_diff != null ? `delivery ${c.delivery_trend_diff > 0 ? '+' : ''}${Number(c.delivery_trend_diff).toFixed(1)} pp vs the prior fortnight` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          url: c.screenerUrl || null,
          kind: brokeOut ? 'breakout' : 'volume',
          // THE SAME NUMBERS THE SENTENCE ABOVE ALREADY STATES, in a form a reader-facing
          // card can print without parsing prose. No new fact: `volumeX` is the ratio this
          // row's headline names and `movePct` the close it reports beside it. AI Alerts
          // reads these for its metric strip — regexing a headline for a figure is how a
          // reworded sentence silently becomes a missing number.
          volumeX: Number.isFinite(volX) ? volX : null,
          movePct: move != null && Number.isFinite(Number(move)) ? Number(move) : null,
        });
      }
    }
    // THE ONE ALERT RULE ON THIS PAGE, asked of the exported predicate rather than re-implemented
    // here — the suite tests that predicate directly, and a second copy of the comparison is a
    // second thing that can drift from the number the tab prints.
    const severity = moveSeverity(move);
    if (move == null) continue;
    if (!inScope(wanted, c.ticker)) continue;
    // A row priced on another session than the file's is still that session's move, dated so —
    // and, like every other feed's rows, it is reported only inside the requested window.
    if (!inRequestedWindow(barDay, day, includeHistory)) continue;
    const down = move < 0;
    const verified = c.move_source
      ? ` Re-derived from the Muns market-data endpoint's closes (${c.move_check}).`
      : c.move_check === 'unavailable'
        ? " Yahoo's figure; the Muns market-data endpoint has not answered for this name yet."
        : '';
    events.push({
      id: `tech:${c.ticker}:${barDay}`,
      sourceRecord: s,
      ...signal(
        down ? DIRECTION.NEGATIVE : move > 0 ? DIRECTION.POSITIVE : DIRECTION.NEUTRAL,
        severity ? IMPORTANCE.HIGH : IMPORTANCE.LOW,
        `${down ? 'Down' : 'Up'} ${Math.abs(move).toFixed(1)}% between the ${c.prev_bar_date || c.move_prev_date || 'previous'} and ${barDay} closes.${verified}`,
        severity ? `High: the absolute day move reached ${MOVE_PCT}%.` : `Low: below ${MOVE_PCT}%; retained in the complete pool.`
      ),
      time: null,
      at: barDay,
      ticker: c.ticker || null,
      company: c.name || c.ticker || '—',
      headline: `${down ? 'Fell' : 'Rose'} ${Math.abs(move).toFixed(1)}% at the ${barDay} close`,
      // Named so the correlation layer in ai-alerts.js can tell a price move from a participation
      // reading without re-deriving either. Both come off this feed and they are different events.
      kind: severity ? 'move' : 'price-reading',
      aiEligible: !!severity,
      movePct: Number(move),
      detail: [c.cmp != null ? `Close ₹${Number(c.cmp).toFixed(2)}` : null, c.prev_bar_date ? `vs ${c.prev_bar_date}` : null, c.rsi14 != null ? `RSI ${c.rsi14}` : null, c.above_200dma === false ? 'below its 200-day average' : null].filter(Boolean).join(' · '),
      url: c.screenerUrl || null,
    });
  }

  return {
    events,
    reachesToday,
    asOf: generated,
    note: reachesToday ? null : `The latest completed close in this feed is ${priceDay || 'unknown'}; there is no close for ${day} yet.`,
  };
}

// ONE EVENT PER ROW OBJECT. The collector rebuilt every story's event on every pass — 81,926
// objects, each spreading a fresh `newsSignal` reading — and after a reader rebuild that pass is
// cold again. The event is a pure function of the row and the book, so it is memoised on the row
// and checked against the holdings array; `toFeedRow` copies it before adding feed fields, and no
// consumer edits it. The warm-up touches it in slices so the synchronous pass only maps.
const companyNewsEvents = new WeakMap();
function companyNewsEvent(r) {
  const holdings = coverage.holdings();
  const hit = companyNewsEvents.get(r);
  if (hit && hit.holdings === holdings) return hit.event;
  const event = {
    // THE TICKER IS PART OF THE IDENTITY. One story is returned by several companies' searches,
    // and a RELIANCE row and an HDFCBANK row about the same article are two rows, not one.
    id: `news:${r.entityId || r.ticker || '?'}|${r.url || JSON.stringify([r.date, r.title, r.source])}`,
    sourceRecord: r,
    // THE TRACKED KEYWORDS ARE THIS FEED'S MATERIALITY RULE. Before them every story on the busiest
    // feed here was low-importance and neutral, so 11,060 rows of name-matched search results —
    // three quarters of it coverage of other companies that happen to share a word — carried the
    // same weight as each other and none of it could ever surface. Direction is untouched and
    // stays neutral; see `newsSignal`.
    ...newsSignal(r),
    // `publishedAt`, NOT `raw.page_age` — `raw` is stripped before the snapshot is committed, so
    // reading the time off it worked on a live walk and returned undefined for every row that came
    // from the file. See `isoInstant` in filings-shared.js.
    time: istTime(r.publishedAt) || null,
    at: r.publishedAt || r.date,
    ticker: r.ticker || null,
    entityId: r.entityId || null,
    company: attributionFor(r).status === 'unrelated' ? 'Unrelated search result' : r.company || attributionFor(r).queryCompany || coverage.holdings().find((h) => h.ticker === r.ticker)?.name || r.ticker || 'Unresolved company',
    headline: r.title || 'Story',
    detail: [r.source ? `Published by ${r.source}` : 'Publisher not carried',
      attributionFor(r).status === 'related' ? attributionFor(r).reason : null].filter(Boolean).join(' · '),
    url: r.url || null,
  };
  companyNewsEvents.set(r, { holdings, event });
  return event;
}

/** Company news published today. An editorial headline is not sentiment data, so it stays neutral. */
function fromCompanyNews({ day, wanted, includeHistory, queryWindow, newsReader = news }) {
  const rows = newsQueryRows(newsReader, queryWindow, newsReader).filter((r) => inRequestedWindow(r.publishedAt || r.date, day, includeHistory) && inScope(wanted, r.ticker));

  const events = rows.map(companyNewsEvent);

  return { events, ...companyNewsState(day, newsReader.meta()) };
}

export function companyNewsState(day, m = news.meta(), now = Date.now()) {
  const capturedDay = istDay(m.capturedAt);
  const enrichmentAt = Date.parse(m.enrichmentCoverage?.capturedAt || '');
  const enrichmentStale = !Number.isFinite(enrichmentAt) || enrichmentAt > now + 10 * 60_000 || now - enrichmentAt > 24 * 3600000;
  const delivery = m.newsDelivery;
  const sourceStates = ['core', 'publishers', 'tradingView'].map(key => delivery?.[key]).filter(Boolean);
  const failed = sourceStates.some(source => ['partial', 'unavailable'].includes(source.status) || source.error || source.historyError) ||
    !!m.newsHistory?.error || !!m.reason || !!m.failed || !!m.truncated || enrichmentCoverageIncomplete(m.enrichmentCoverage, now);
  const pending = sourceStates.some(source => source.pending || source.status === 'pending' || source.historyPending) ||
    !!m.newsHistory?.pending;
  return {
    // A successful TradingView subset cannot establish that the main news head, publisher feeds
    // and every advertised history part reached the customer. Readiness and freshness differ.
    status: failed ? 'failed' : pending ? 'pending' : 'ok',
    reachesToday: !failed && !pending && !!m.enrichmentCoverage && !!capturedDay && capturedDay >= day,
    asOf: m.capturedAt || null,
    note: [m.newsHistory?.error,
      delivery ? ['core', 'publishers', 'tradingView'].map(key => delivery[key] ? `${key === 'core' ? 'Company news' : key === 'publishers' ? 'Publisher feeds' : 'TradingView'}: ${delivery[key].status}.${delivery[key].error ? ` ${delivery[key].error}` : ''}${delivery[key].historyError ? ` ${delivery[key].historyError}` : ''}` : null).filter(Boolean).join(' ') : null,
      capturedDay && capturedDay >= day ? null : `The newest company-news capture ran on ${capturedDay || 'an unknown date'}.`,
      m.enrichmentCoverage ? `${enrichmentStale ? 'Global/IR discovery check time is stale or unverified. ' : ''}Last reported: ${Number(m.enrichmentCoverage.staleOrIncompleteQueries) || 0} stale or incomplete global queries; ${Number(m.enrichmentCoverage.pagesFailed) || 0} IR pages need recovery; ${Number(m.enrichmentCoverage.documentsPending) || 0} documents not yet read. Checked ${m.enrichmentCoverage.capturedAt || 'time not supplied'}.` : 'Global/IR enrichment has not reported coverage yet.',
      m.tradingViewCoverage ? `TradingView public headlines: ${m.tradingViewCoverage.mappedCompanies}/${m.tradingViewCoverage.activeCompanies} companies mapped; ${m.tradingViewCoverage.staleOrFailedSymbols} stale/failed symbol reads; ${m.tradingViewCoverage.possibleGapSymbols} possible window gaps; ${m.tradingViewCoverage.restrictedHeadlines} restricted headlines not extracted. Checked ${m.tradingViewCoverage.checkedAt}.${m.tradingViewHealth?.ok === false ? ' TradingView coverage is stale or incomplete.' : ''}${m.tradingViewCoverage.portfolioError ? ' Portfolio changes could not be verified.' : ''}${m.tradingViewReadError ? ' Latest published snapshot could not be confirmed; retained headlines remain visible.' : ''}` : 'TradingView enrichment has not reported coverage yet.']
      .filter(Boolean).join(' ') || null,
  };
}

/**
 * Market-wide stories published today.
 *
 * THESE CARRY NO COMPANY, so they cannot be narrowed by one. Filtering them by ticker would report
 * "your companies are not in the news" when the truth is that nothing on the row says whose it is —
 * the same rule the chatter tab follows for its unresolved half. They appear under Universe and the
 * feed row says why they do not appear under the other two.
 */
function fromMarketNews({ day, scope, includeHistory, queryWindow, newsReader = news }) {
  const m = marketNews.meta();
  const capturedDay = istDay(m.capturedAt);
  const scopable = true; // Reviewed portfolio matches are resolved centrally before scope filtering.

  const events = scopable
    ? newsQueryRows(marketNews, queryWindow, newsReader)
        .filter((a) => inRequestedWindow(a.publishedAt, day, includeHistory))
        .map((a) => ({
          id: `mcnews:${a.id}`,
          sourceRecord: a,
          // TAGGED WITH THE SAME KEYWORDS, BUT NOT PROMOTED BY THEM. The tags let the timeline and
          // the news list filter market-wide stories by topic. Importance stays low because a
          // keyword is material ABOUT a company and these rows carry none — "Fraud" on a story
          // with no company attached names a subject, not an exposure.
          ...signal(DIRECTION.NEUTRAL, IMPORTANCE.LOW, 'Publisher headline; not directionally graded.', 'Low: a market-wide story carries no company, so a tracked keyword on it names a subject rather than an exposure.'),
          keywords: classifyStory(a).labels,
          time: istTime(a.publishedAt),
          at: a.publishedAt,
          ticker: null,
          // "Market-wide" under a heading that says Company is the honest reading of a row that has
          // no company on it — the section goes in the sub-line, where it describes the story
          // rather than standing in for a name nobody supplied.
          company: 'Market-wide',
          section: a.section || null,
          headline: a.title || 'Story',
          detail: a.summary || 'Market-wide story — no company attached',
          url: a.url || null,
        }))
    : [];

  return {
    events,
    scopable,
    reachesToday: !!capturedDay && capturedDay >= day,
    asOf: m.capturedAt || null,
    note: scopable
      ? capturedDay && capturedDay >= day
        ? null
        : `The newest market-news capture ran on ${capturedDay || 'an unknown date'}.`
      : 'Market-wide stories carry no company, so they cannot be narrowed to a book or a watchlist. Switch to Universe to see them.',
  };
}

export const feedLabel = (id) => feedById.get(id)?.label || id;
