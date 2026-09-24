// THE PRECOMPUTED ALERT POOL, AS THE BROWSER READS IT.
//
// A pooled feed's events are the same objects the collector in daily-alerts.js would build from the
// committed captures, built once on the runner (scripts/build-alert-pool.mjs) and served by the
// Worker from the artifact of the latest build (worker/alert-pool.mjs). Reading them here replaces
// downloading and classifying a month of captures with a few gzip shards — and NOTHING ELSE:
//
//   - A feed is stood in for only when the pool was built for TODAY (IST), from the very capture
//     revisions the Worker is serving now (`/api/capture-status`), and the collection would read
//     no rows for it that the pool cannot carry — a company walked or searched live in this
//     session, a device copy a tab loaded, an announcement lookup (the feed modules answer that).
//     Any of those false, and that feed loads exactly as it did before, on this visit.
//   - A window the pool does not cover (All history, undated records, a day before its range), a
//     static origin with no Worker, an unreadable index or an invalid shard all mean "no pool",
//     which is the path the dashboard took before the pool existed. A failed read is never an
//     empty feed.
//   - The feed rows carry the runner's own status, capture time and coverage note; the company-news
//     row is recomputed from the runner's inputs against this reader's clock, exactly as the live
//     read recomputes it on every pass.
//
// Members are addressed by artifact id, so a shard URL is immutable and the browser's HTTP cache
// answers it without a request; only the index is revalidated, and only the shards a new build
// changed are downloaded again. Decoded shards are kept in memory for the current artifact only.
import { authHeaders } from '../core/host-context.js';
import { readEntry, KEYS } from '../core/store.js';
import { validateShard, assembleFeedEvents } from './alert-pool-format.js';
import { ALERT_POOL_CONTRACT, POOL_FEEDS, POOL_FEED_CAPTURES, isDay, windowDays, dayMember } from './alert-pool-shared.js';

export const INDEX_ROUTE = 'api/alert-pool/index';
export const STATUS_ROUTE = 'api/capture-status';
const REQUEST_TIMEOUT_MS = 20_000;
const INDEX_REUSE_MS = 20_000;
const CONCURRENCY = 4;
// `companyNewsState` (daily-alerts.js) reads these and nothing else off the news reader's meta.
export const NEWS_STATE_FIELDS = ['capturedAt', 'enrichmentCoverage', 'newsDelivery', 'newsHistory', 'reason', 'failed', 'truncated',
  'tradingViewCoverage', 'tradingViewHealth', 'tradingViewReadError'];

export function newsStateInputs(meta = {}) {
  const out = {};
  for (const field of NEWS_STATE_FIELDS) if (meta[field] !== undefined) out[field] = meta[field];
  return JSON.parse(JSON.stringify(out));
}
/** What a company-news event can read off the book: the name behind a ticker. */
export function bookSignature(holdings = []) {
  return JSON.stringify(holdings.filter((h) => h?.ticker).map((h) => [String(h.ticker), h.name ?? null]).sort((a, b) => a[0].localeCompare(b[0])));
}

let indexRead = null; // { at, refresh, promise }
let statusRead = null;
let lastIndex = null; // the newest adopted index, with its artifact id
const shards = new Map(); // member url -> { artifact, promise }
const results = new Map(); // read key -> the last successful read
let disabledUntil = 0;

async function ask(path, { noCache = false } = {}) {
  let response;
  try {
    response = await fetch(path, { headers: { accept: 'application/json', ...authHeaders(path) },
      ...(noCache ? { cache: 'no-cache' } : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
  const type = response.headers.get('content-type') || '';
  if ([404, 405, 501].includes(response.status) || !/json/i.test(type)) { await response.body?.cancel?.(); return { ok: false, reason: 'no-worker', status: response.status }; }
  if (!response.ok) { await response.body?.cancel?.(); return { ok: false, reason: 'upstream', status: response.status }; }
  try { return { ok: true, value: await response.json() }; }
  catch { return { ok: false, reason: 'invalid' }; }
}

function validIndex(value) {
  return !!value && value.ok !== false && value.version === 1 && value.contract === ALERT_POOL_CONTRACT && isDay(value.day) &&
    Number.isSafeInteger(value.artifact) && value.artifact > 0 && value.captures && typeof value.captures === 'object' &&
    value.feeds && typeof value.feeds === 'object' && Array.isArray(value.days) && Array.isArray(value.ai) &&
    value.days.every((entry) => isDay(entry?.day) && typeof entry.member === 'string') &&
    value.ai.every((entry) => typeof entry?.member === 'string' && typeof entry.span === 'string');
}

function readIndex(refresh) {
  const now = Date.now();
  if (indexRead && !refresh && now - indexRead.at < INDEX_REUSE_MS) return indexRead.promise;
  if (indexRead && indexRead.pending) return indexRead.promise;
  const entry = { at: now, pending: true };
  entry.promise = ask(INDEX_ROUTE, { noCache: true }).then((out) => {
    entry.pending = false;
    if (!out.ok || !validIndex(out.value)) return null;
    if (lastIndex?.artifact !== out.value.artifact) {
      // A new build: nothing decoded from the previous artifact is addressed by the new members.
      for (const [url, held] of shards) if (held.artifact !== out.value.artifact) shards.delete(url);
    }
    lastIndex = out.value;
    return out.value;
  });
  indexRead = entry;
  return entry.promise;
}

function readStatus(refresh) {
  const now = Date.now();
  if (statusRead && !refresh && now - statusRead.at < INDEX_REUSE_MS) return statusRead.promise;
  if (statusRead && statusRead.pending) return statusRead.promise;
  const entry = { at: now, pending: true };
  entry.promise = ask(STATUS_ROUTE, { noCache: true }).then((out) => {
    entry.pending = false;
    return out.ok && out.value?.captures && typeof out.value.captures === 'object' ? out.value : null;
  });
  statusRead = entry;
  return entry.promise;
}

/** Why a feed cannot be stood in for by this pool, or null when every capture it reads matches. */
export function verifyFeed(feedId, index, status) {
  for (const name of POOL_FEED_CAPTURES[feedId] || []) {
    const built = index.captures?.[name];
    const live = status.captures?.[name];
    if (!built || !live) return `${name}: not reported`;
    if (name === 'exchangeDeals') {
      if (!Number.isSafeInteger(built.artifactId) || !Number.isSafeInteger(live.artifactId)) return `${name}: not reported`;
      if (built.artifactId !== live.artifactId) return `${name}: moved`;
      continue;
    }
    if (typeof built.revision !== 'string' || typeof live.revision !== 'string') return `${name}: not reported`;
    if (built.revision !== live.revision) return `${name}: moved`;
  }
  return null;
}

/**
 * Feeds the collection would read rows for that the pool cannot carry. `sessionRows(feedId)` is
 * the collector's own question to its feed modules — does this reader hold rows this session
 * supplied beyond the capture (a live walk, a live search, a device copy a tab loaded)? — and a
 * reason string answers yes. A per-company entry left in the device store by an earlier visit is
 * deliberately not asked about: a reader seeded with no company list never reads it, so a
 * collection made now would not see it either, and declining on it kept every device that had
 * ever pressed Refresh on News on the live news path for good. Announcement lookups are the one
 * store-held record the shared announcements reader restores on load, so those are still read.
 */
export async function deviceExtras(sessionRows = () => null) {
  const extras = new Map();
  for (const feedId of ['news', 'insider']) {
    try { const reason = sessionRows(feedId); if (reason) extras.set(feedId, String(reason)); }
    catch { extras.set(feedId, 'session rows could not be checked'); }
  }
  try {
    const lookups = (await readEntry(KEYS.announcementLookups))?.value;
    if (Array.isArray(lookups?.rows) && lookups.rows.length) extras.set('announcements', 'announcement lookups on this device');
  } catch {
    // An unreadable store answers nothing about the device: every feed that could hold extras
    // keeps its live path, which is the path that reads them.
    for (const id of ['news', 'insider', 'announcements']) extras.set(id, 'device store unreadable');
  }
  return extras;
}

function memberUrl(index, member) { return `api/alert-pool/${index.artifact}/${member}`; }

function readShard(index, member, expected) {
  const url = memberUrl(index, member);
  const held = shards.get(url);
  if (held) return held.promise;
  const entry = { artifact: index.artifact, promise: (async () => {
    const out = await ask(url);
    if (!out.ok) throw new Error(`Alert pool member ${member} could not be read (${out.reason}${out.status ? ` ${out.status}` : ''})`);
    return validateShard(out.value, expected);
  })() };
  entry.promise.then(() => { entry.settled = true; }, () => { if (shards.get(url) === entry) shards.delete(url); });
  shards.set(url, entry);
  return entry.promise;
}

async function readShards(index, members, isCurrent) {
  const out = new Array(members.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, members.length) }, async () => {
    while (next < members.length) {
      const i = next++;
      if (!isCurrent()) throw new Error('Alert pool read abandoned');
      out[i] = await readShard(index, members[i].member, members[i].expected);
    }
  }));
  return out;
}

function membersFor(mode, index, queryWindow) {
  if (mode === 'window') {
    const days = windowDays(queryWindow, index.day);
    if (!days) return null;
    const known = new Map(index.days.map((entry) => [entry.day, entry.member]));
    if (!days.every((day) => known.has(day))) return null;
    return days.map((day) => ({ member: known.get(day), expected: { day } }));
  }
  if (mode === 'ai') return index.ai.map((entry) => ({ member: entry.member, expected: { span: entry.span } }));
  return null;
}

const readKey = (mode, day, queryWindow) => JSON.stringify([mode, day, queryWindow || null]);

/**
 * The pooled feeds' rows for a collection, or null when the pool cannot stand in at all.
 * `feeds` maps only the feeds the pool may answer for; every other pooled feed's reason is in
 * `declined`, and the caller loads it as before.
 */
export async function read({ mode, day, queryWindow = null, refresh = false, isCurrent = () => true, book = [], newsState = (meta) => meta, sessionRows = () => null }) {
  if (!['window', 'ai'].includes(mode) || !isDay(day)) return null;
  if (Date.now() < disabledUntil && !refresh) return null;
  const index = await readIndex(refresh);
  if (!index || !isCurrent()) return null;
  if (index.day !== day) return null;
  const members = membersFor(mode, index, queryWindow);
  if (!members) return null;
  const [status, extras] = await Promise.all([readStatus(refresh), deviceExtras(sessionRows)]);
  if (!status || !isCurrent()) return null;
  const declined = new Map();
  const wanted = [];
  for (const feedId of POOL_FEEDS) {
    const row = index.feeds[feedId]?.row;
    const reason = !row || row.id !== feedId ? 'not in this pool' : verifyFeed(feedId, index, status) || extras.get(feedId) ||
      (feedId === 'news' && index.feeds.news.bookDependent && index.bookSignature !== bookSignature(book) ? 'built under another book' : null);
    if (reason) declined.set(feedId, reason); else wanted.push(feedId);
  }
  if (!wanted.length) return { feeds: new Map(), declined, index, mode, day, queryWindow };
  let decoded;
  try { decoded = await readShards(index, members, isCurrent); }
  catch (error) {
    // Moving to another period is not an outage. Do not disable the fast path for the next
    // selection (or another tab) for a minute because this view no longer needs its result.
    if (!isCurrent()) return null;
    // Shards that do not read are the pool failing, not the captures: hold off briefly rather
    // than asking on every partial, and let every feed take its live path this time.
    disabledUntil = Date.now() + 60_000;
    throw error;
  }
  if (!isCurrent()) return null;
  const feeds = new Map();
  for (const feedId of wanted) {
    const events = assembleFeedEvents(decoded, feedId);
    const base = index.feeds[feedId].row;
    const row = feedId === 'news' ? { ...base, ...newsState(index.feeds.news.newsMeta || {}) } : { ...base };
    // A period's row counts the events it carries — the selected period and its companions —
    // exactly as the bounded live read counts its own rows. The AI pool keeps the full read's
    // figures: its rows describe the sources the ranking was read from, not the subset it reads.
    // (The ranking report's own feed rows are rebuilt by `toFeedRow` over what it read; the AI
    // tab reads their `status` and prints no count.)
    if (mode === 'window') {
      let oldestDay = null, newestDay = null, todayCount = 0;
      for (const event of events) {
        if (event.day === day) todayCount++;
        if (!event.day) continue;
        if (oldestDay === null || event.day < oldestDay) oldestDay = event.day;
        if (newestDay === null || event.day > newestDay) newestDay = event.day;
      }
      Object.assign(row, { count: events.length, todayCount, oldestDay, newestDay });
    }
    feeds.set(feedId, { ...row, events });
  }
  const result = { feeds, declined, index, mode, day, queryWindow, at: Date.now(), members: members.map((entry) => memberUrl(index, entry.member)) };
  results.set(readKey(mode, day, queryWindow), result);
  // WHAT STAYS DECODED: the shards behind the latest read of each mode, and nothing else. A
  // reader who looked at Last 30 days and came back to Today would otherwise keep thirty decoded
  // day shards for as long as the build lasts — the memory the live path releases with its readers.
  for (const held of results.values()) if (held.mode === mode && held !== result) results.delete(readKey(held.mode, held.day, held.queryWindow));
  const keep = new Set([...results.values()].flatMap((held) => held.members));
  for (const [url, held] of shards) if (!keep.has(url) && held.settled) shards.delete(url);
  return result;
}

/** The last successful read for this collection, for a reassembly that must not fetch. */
export function current({ mode, day, queryWindow = null }) {
  const held = results.get(readKey(mode, day, queryWindow));
  return held && held.index.artifact === lastIndex?.artifact ? held : null;
}

/** Whether an event travels without the source record a notebook snapshot is taken from. */
export function needsFullRecord(event) {
  if (!event || !POOL_FEEDS.includes(event.feed)) return false;
  if (event.sourceRecord == null) return true;
  return event.feed === 'news' && typeof event.sourceRecord === 'object' &&
    Object.keys(event.sourceRecord).every((key) => ['publisher', 'source', 'discoverySource'].includes(key));
}
/** The full source record of an event that came from the pool in compact form, or null. */
export async function fullRecord(event) {
  if (!event || !isDay(event.day) || !POOL_FEEDS.includes(event.feed)) return null;
  const index = lastIndex || await readIndex(false);
  if (!index || !index.days.some((entry) => entry.day === event.day)) return null;
  try {
    const shard = await readShard(index, dayMember(event.day), { day: event.day });
    const group = shard.feeds[event.feed];
    const hit = [...(group?.events || []), ...(group?.companions?.events || [])].find((row) => row.id === event.id);
    return hit?.sourceRecord && typeof hit.sourceRecord === 'object' ? hit.sourceRecord : null;
  } catch { return null; }
}

/** What the last pool read decided, for provenance surfaces. */
export function status() {
  const latest = [...results.values()].sort((a, b) => b.at - a.at)[0];
  if (!latest) return { available: !!lastIndex, artifact: lastIndex?.artifact || null, builtAt: lastIndex?.builtAt || null, day: lastIndex?.day || null, feeds: {} };
  return { available: true, artifact: latest.index.artifact, builtAt: latest.index.builtAt, day: latest.index.day,
    feeds: Object.fromEntries(POOL_FEEDS.map((id) => [id, latest.feeds.has(id) ? { pooled: true } : { pooled: false, reason: latest.declined.get(id) || 'not requested' }])) };
}

/** Test seam. A reload has the same effect. */
export function resetForTest() {
  indexRead = null; statusRead = null; lastIndex = null; shards.clear(); results.clear(); disabledUntil = 0;
}
