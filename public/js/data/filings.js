// data/filings.js — the feed behind News, Corporate Announcements and Insider Trades.
//
//   const feed = createFeed('announcements');
//   feed.load(items)        the committed snapshot and this device, with NO live walk
//                           (items are tickers, or { ticker, name } — the name is what news searches)
//   feed.refresh()          the live walk, on demand — what the Refresh button calls
//   feed.rows()             every row that has landed, newest first
//   feed.meta()             what loaded, what failed, where the paint came from, and when
//   feed.onChange(fn)       fires as rows arrive, so the table fills in progressively
//
// ONE MODULE, THREE FEEDS, because everything that differs between them is a URL and a row shape,
// and both of those already live elsewhere — the routes in worker/index.js, the shapes in
// filings-shared.js. What they share is the hard part, and it is worth writing once.
//
// TWO SOURCES OF ROWS, AND THE ORDER MATTERS.
//
//   1. A COMMITTED SNAPSHOT covering the whole universe, written by scripts/scrape-filings.mjs on a
//      schedule. One fetch, 603 companies, instant. This is how "the complete universe" is possible
//      at all: the two per-ticker upstreams are rate limited to 60 requests a minute, so asking for
//      603 companies live would take ten minutes and hammer somebody else's service on every visit.
//
//   2. A LIVE WALK for companies the snapshot does not cover, bounded by LIVE_LIMIT and run
//      CONCURRENCY at a time.
//
// AND THE WALK DOES NOT RUN ON A PAGE LOAD. That is the whole point of the split, and it took a
// while to get right. Each of these upstreams is one request PER COMPANY, so a landing that walked
// forty of them was forty round trips before the table settled — and when the insider-trades
// upstream went down, every one of those requests spent the Worker's full retry budget, so the tab
// counted forty companies down over a quarter of an hour and painted nothing at all. Measured: 93.5
// seconds per company, forty companies, four at a time.
//
// So the snapshot is what arrives automatically, and the walk is what the reader asks for — see
// `refresh()` and `js/core/refresh.js`. The one exception is an empty cache: with nothing to paint,
// a table saying "press Refresh" is worse than a slow one, so a first-ever visit walks once.
//
// A SNAPSHOT IS NOT STALE DATA PRETENDING TO BE LIVE. `meta().origin` says which of `snapshot`,
// `store`, `mixed` or `live` produced what is on screen and `meta().capturedAt` when the snapshot
// was taken, and both reach the pill. An announcement is an event with its own date; the risk here
// is not that a row is old, it is that the READER cannot tell how recently we looked. It is derived
// rather than assigned — see `originNow` — because as a field it kept reading `null` mid-walk, and
// the pill renders that as "Live".
//
// NEWS IS SEARCHED BY COMPANY NAME, NOT BY SYMBOL. `?q=JAYNECOIND` returns three results, most of
// them quote pages; `?q=Jayaswal Neco Industries` returns twenty, about the company. The ticker is
// still what a row is filed under and what the store is keyed by — only the search term changes.
//
// A FAILED COMPANY IS NOT A COMPANY WITH NO NEWS. Failures are kept per ticker with the reason the
// Worker named, and the pill says how many could not be read. Rendering them as zero rows would
// report an outage as an absence of events.

import { conditionalJson, readEntries, writeEntry, KEYS, isPersistent } from '../core/store.js';
import { mergeInsiderTrades, mergeInsiderHeaders } from './insider-history.js';
import { withFilingArchive } from './filing-archives.js';
import { withAnnouncementLookups } from './announcements-extra.js';

// How many companies a live walk will ask about before it stops and says so. The upstreams allow
// 60 requests a minute; forty keeps a cold start under a minute and well inside that budget.
const LIVE_LIMIT = 40;
const CONCURRENCY = 4;

// How long a company's rows are reused without asking again. Matches the Worker's own edge window
// per feed, deliberately rather than as a guess at tolerable staleness: inside it the server has
// nothing else to tell us, so a request would be spent receiving bytes we already hold.
const REVALIDATE_AFTER_MS = { news: 180_000, announcements: 900_000, insider: 900_000 };

// HOW LONG THE BROWSER WILL HOLD A CONNECTION OPEN FOR ONE COMPANY.
//
// A browser allows about six concurrent connections per origin, and a walk that holds four of them
// against a hung upstream is holding two thirds of the page's entire budget. Measured with all
// three Muns upstreams down: the walks starved everything else on the origin — the Superstar
// Investors grid could not fetch its own committed snapshot, a static file, for forty-four seconds,
// and painted nothing. A tab being slow is one thing; a tab making the OTHER tabs slow is another.
//
// The Worker's own budget is 20s (worker/muns.mjs), so anything past this is the Worker not
// answering rather than the upstream being thoughtful, and the connection is worth more than the
// answer. An abort lands as a failure against that ticker, which is what it is.
const REQUEST_TIMEOUT_MS = 25_000;

const SNAPSHOT = {
  news: 'data/news.json',
  announcements: 'data/corp-announcements.json',
  insider: 'data/insider-trades.json',
};

// EACH ROUTE APPENDS THE DATE RANGE ITSELF, because only the route knows whether it already has a
// query string. The previous version built one `qs` string and patched a `?` onto the front of it,
// which is right for the two path-parameter routes and WRONG for news — `api/news?q=X` + `?from=…`
// produced a URL with two question marks, so the Worker read `q` as `"RELIANCE?from=2026-07-18"`
// and `from` as absent. The upstream then searched for that literal string, which is why every
// company came back with the same generic market news instead of its own.
const ROUTE = {
  news: (query, range) => `api/news?q=${encodeURIComponent(query)}&${range}`,
  announcements: (ticker, range) => `api/announcements/${encodeURIComponent(ticker)}?${range}`,
  insider: (ticker, range) => `api/insider-trades/${encodeURIComponent(ticker)}?${range}`,
};

// Which array each payload carries its rows in, and what a row's company is called.
const ROWS_KEY = { news: 'articles', announcements: 'announcements', insider: 'trades' };

/** How far back each feed asks. An announcement is worth a year; news past a month is not news. */
export const WINDOW_DAYS = { news: 30, announcements: 365, insider: 365 };

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * 86400000);

/**
 * One story at two addresses is one story.
 *
 * `moneycontrol.com/news/…-13990522.html` and `…/amp` are the same article, as are
 * `economictimes.com/…` and `m.economictimes.com/…`. A search engine returns both, and a table that
 * lists them twice reads as broken even though the payload is faithful. So the comparison is on
 * host-without-its-mobile-prefix plus path-without-`/amp`.
 *
 * WHAT IT DELIBERATELY DOES NOT MERGE:
 *   • the query string, which on some sites is the whole identity of the page;
 *   • the same story from two DIFFERENT publishers — Hindustan Times and the Economic Times both ran
 *     "Prestige Group launches 3 housing projects in Q1", and those are two outlets reporting, not
 *     one row duplicated;
 *   • the same story under two companies. A story that genuinely mentions two of the companies in
 *     scope appears under each, because the ticker a row is filed under is OUR search term — which
 *     is what the provenance modal says — and dropping one would hide it from whichever reader was
 *     looking at that company. Hence: within a company, never across.
 */
const canonicalUrl = (raw) => {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '');
    const path = u.pathname.replace(/\/amp\/?$/i, '').replace(/\/+$/, '');
    return `${host}${path}${u.search}`;
  } catch {
    return String(raw);
  }
};

const dedupeArticles = (list) => {
  const seenUrl = new Set();
  const seenStory = new Set();
  return list.filter((r) => {
    const u = r?.url ? canonicalUrl(r.url) : null;
    // No URL is not the same as the same URL — an article with none is kept.
    if (u) {
      if (seenUrl.has(u)) return false;
      seenUrl.add(u);
    }
    // Same publisher, same headline, twice. Unambiguous, and the only title comparison made: two
    // headlines that merely share a long prefix are two stories, and the table shows the prefix.
    const story = r?.title && r?.source ? `${r.source} :: ${String(r.title).trim().toLowerCase()}` : null;
    if (story) {
      if (seenStory.has(story)) return false;
      seenStory.add(story);
    }
    return true;
  });
};

export function createFeed(kind) {
  let state = fresh();
  let loading = null;
  let seeding = null;
  const subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn());

  function fresh() {
    return {
      loaded: false,
      rows: new Map(), // ticker -> rows[]
      failures: new Map(), // ticker -> { reason, message, requestedUrl }
      asked: new Set(),
      // ticker -> company name, so the news search asks about the COMPANY rather than the symbol.
      names: new Map(),
      // Companies the committed snapshot covers. They are not re-walked: the snapshot is the bulk
      // source and is refreshed on a schedule, and its age is reported as `capturedAt` rather than
      // hidden by 603 live requests.
      fromSnapshot: new Set(),
      // ASKED, AND THE ANSWER WAS "NOTHING". A different fact from a company with rows and a very
      // different one from a company nobody reached, and it used to be recorded as neither: the
      // scrape wrote only companies that had something, so one with no trades vanished from the
      // file and `outstanding()` counted it unchecked for ever. Measured on the shipped insider
      // capture: 51 companies reported as "not been checked since" that had all been checked.
      askedEmpty: new Set(),
      // ticker -> when the SERVER last confirmed those rows, whether that was this session or an
      // earlier one. A company inside its window is not re-asked; one never read always is.
      confirmedAt: new Map(),
      // The subset the server confirmed IN THIS SESSION. Kept apart from `confirmedAt` because they
      // answer different questions: that one is "how old are these bytes", this one is "did we
      // check". A device-cached company has a real confirmation time and has not been checked, and
      // only the second of those may be allowed to spell "Live".
      confirmedHere: new Set(),
      snapshotCount: 0,
      // Set only by a snapshot that declares it. A date-indexed capture asks the exchange what was
      // filed rather than asking each company, so every company is covered and an empty result for
      // one is a real answer rather than a gap in our budget.
      coversUniverse: false,
      exchangeCompanies: null,
      unnamedRows: 0,
      // The window the snapshot actually holds, which a date-indexed capture knows and a per-company
      // walk does not. Falls back to the feed's own constant.
      snapshotWindowDays: null,
      capturedAt: null,
      oldestDataAt: null,
      fallbackCount: 0,
      checkedAt: null,
      reason: null,
      message: null,
      inFlight: 0,
      pending: 0,
      truncated: 0,
      headers: [], // insider trades keeps the upstream's own column headings
      // The companies in scope, as the tab last asked for them. `refresh()` re-reads these, so the
      // button asks about what is on screen rather than about everything the module has ever seen.
      wanted: [],
      // A deployment whose scheduled capture has not run yet has nothing to paint, so `load()`
      // walks once. Recorded so the tab can say the walk was ours rather than the reader's.
      coldStart: false,
      lastRefreshAt: null,
    };
  }

  /**
   * Where what is on screen came from — DERIVED, never asserted.
   *
   * It was a field that four different places wrote to, and it spent the whole of a live walk
   * reading `null`, which the pill renders as "Live" over rows that had come off the device. A
   * freshness control that can claim a freshness it has not confirmed is worse than none. Computing
   * it from the two facts that decide it — what is painted, and what the server has confirmed in
   * this session — means it cannot drift from them.
   *
   *   live      every painted company was confirmed by the server this session
   *   mixed     some were
   *   snapshot  none were, and every painted company came from the committed file
   *   store     none were, and at least one came off this device's cache
   */
  function originNow() {
    const covered = state.rows.size;
    if (!covered) return null;
    let confirmed = 0;
    let snapshot = 0;
    for (const t of state.rows.keys()) {
      if (state.confirmedHere.has(t)) confirmed++;
      else if (state.fromSnapshot.has(t)) snapshot++;
    }
    if (confirmed === covered) return 'live';
    if (confirmed) return 'mixed';
    return snapshot === covered ? 'snapshot' : 'store';
  }

  function meta() {
    const covered = state.rows.size;
    return {
      kind,
      ok: covered > 0 || state.failures.size === 0,
      loaded: state.loaded,
      reason: state.reason,
      message: state.message,
      covered,
      failed: state.failures.size,
      pending: state.pending,
      inFlight: state.inFlight,
      truncated: state.truncated,
      rowCount: [...state.rows.values()].reduce((a, r) => a + r.length, 0),
      snapshotCount: state.snapshotCount,
      // Asked, and answered nothing. The coverage sentence needs this to say "searched, and these
      // genuinely have none" rather than leaving the reader to read a gap as a failure to fetch.
      askedEmpty: state.askedEmpty.size,
      coversUniverse: state.coversUniverse,
      exchangeCompanies: state.exchangeCompanies,
      unnamedRows: state.unnamedRows,
      capturedAt: state.capturedAt,
      oldestDataAt: state.oldestDataAt,
      fallbackCount: state.fallbackCount,
      // The OLDEST confirmation behind what is on screen, not the newest — otherwise one fresh
      // company would overstate the age of the forty beside it.
      checkedAt: state.confirmedAt.size ? Math.min(...state.confirmedAt.values()) : state.checkedAt,
      origin: originNow(),
      headers: state.headers,
      persisted: isPersistent(),
      // A date-indexed snapshot knows its own window; only fall back to the constant when nothing
      // has declared one, so the coverage text cannot claim a year it does not hold.
      windowDays: state.snapshotWindowDays ?? WINDOW_DAYS[kind],
      // WHAT THIS SESSION HAS NOT LOOKED AT, which is a statement about us and not a claim about
      // the upstream. These routes answer per company and have no index, so "is there anything
      // new?" cannot be answered without asking — the honest thing to print is how many companies
      // have not been asked and when the data on screen was captured, and let the reader decide.
      //
      // A feed whose snapshot covers the whole exchange has NOTHING outstanding: it was not asked
      // company by company, so there is no company it failed to ask about. `outstanding()` returns
      // an empty list there rather than the strip inventing a backlog that cannot exist.
      outstanding: state.loaded ? outstanding().length : 0,
      coldStart: state.coldStart,
      lastRefreshAt: state.lastRefreshAt,
    };
  }

  /** Every row that has landed, newest first. Rows with no readable date sort last, never first. */
  function rows() {
    const out = [];
    for (const [ticker, list] of state.rows) for (const r of list) out.push({ ...r, ticker: r.ticker || ticker });
    return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  const forTicker = (t) => state.rows.get(String(t || '').toUpperCase()) || [];
  /** Was this company asked, and did it answer nothing? Not the same as "we have no rows for it". */
  const wasAskedEmpty = (t) => state.askedEmpty.has(String(t || '').toUpperCase());
  const failureFor = (t) => state.failures.get(String(t || '').toUpperCase()) || null;

  /**
   * Does this company still need asking about?
   *
   * ONE definition, used by the queue AND by the request, because they were two and they disagreed:
   * `load()` queued every company whose rows were old, and `loadOne()` then returned early for any
   * company that had rows at all. So the walk counted down through forty companies without sending
   * a single request, the strip said "reading 40 more companies" the whole time, and nothing was
   * ever revalidated after its window expired.
   */
  const stale = (t) => {
    const at = state.confirmedAt.get(t);
    return at == null || Date.now() - at > REVALIDATE_AFTER_MS[kind];
  };

  // The news search asks about the COMPANY, not the symbol — see the header. A ticker whose name
  // the caller did not supply falls back to the ticker, which is a worse search and still a search.
  const queryFor = (t) => state.names.get(t) || t;

  /**
   * The committed snapshot and this device, and NOTHING ELSE — no walk, and no claim on `wanted`.
   *
   * For a reader that wants the rows this feed already holds without being the tab that owns it.
   * General Alerts is the one consumer: it consolidates today's filings across every feed,
   * and it must not be the thing that decides which companies the Corporate Announcements tab will
   * later refresh.
   *
   * `state.wanted` IS THE POINT OF THE SEPARATION. `load()` memoises its promise, so a seed call
   * arriving first and then a real `load(items)` would hand the second caller the first one's
   * promise and silently discard its company list — the Refresh button would then re-read an empty
   * set and ask about nothing. Seeding keeps its own promise and never writes `wanted`, so
   * whichever order the two arrive in, the tab's list is the one that survives.
   */
  function seed() {
    if (loading) return loading;
    if (seeding) return seeding;
    seeding = (async () => {
      await seedFromSnapshot();
      await seedFromDevice(state.wanted);
      state.loaded = true;
      emit();
    })();
    return seeding;
  }

  /**
   * Fill from the committed snapshot and this device. **NOTHING IS WALKED HERE.**
   *
   * A LANDING MAY NOT COST FORTY REQUESTS. Each of these upstreams is one request per company, and
   * a walk of forty on every visit is what made the tabs feel broken — a table that fills in for a
   * minute, and, when the upstream is down, one that never fills at all while the strip counts
   * companies down. The committed snapshot is what arrives automatically; the live walk is what the
   * reader asks for, with the Refresh button. See `refresh()` below and `js/core/refresh.js`.
   *
   * THE ONE EXCEPTION IS AN EMPTY CACHE. With no snapshot and nothing on the device there is
   * nothing to paint, and an empty table saying "press Refresh" is worse than a slow one. So a
   * first-ever visit to a deployment whose scheduled capture has not run yet still walks, once.
   *
   * `items` may be tickers or `{ ticker, name }`. The name is what the news search uses.
   */
  /**
   * WHICH COMPANIES ARE IN SCOPE RIGHT NOW — and it is NOT a one-time fact.
   *
   * `wanted` decides two things: what `outstanding()` reports as unchecked, and what `refresh()`
   * walks. Both are properties of the view on screen, and the view changes with the scope toggle
   * while the feed is loaded exactly once.
   *
   * It used to be set only inside `load()`, which memoises — so the first scope to mount won the
   * list for the life of the page. Measured after News lost its picker: mounting under Portfolio
   * and then switching to Watchlist left `wanted` holding the book, so the strip reported nothing
   * outstanding for the watched companies and Refresh walked **40 book companies instead of the 3
   * watched ones**. Nothing threw; the button simply asked about somebody else's list.
   *
   * So recording the scope is separate from loading the data, and the tab does it on every render.
   */
  function setWanted(items = []) {
    const wanted = [];
    for (const item of items) {
      const t = String(item?.ticker ?? item ?? '').toUpperCase();
      if (!t || wanted.includes(t)) continue;
      wanted.push(t);
      // Names accumulate across scopes rather than being replaced: the news search needs a name for
      // any company it may walk, and a company can leave the current scope while its name stays
      // true. The list is per-scope; the lookup is not.
      if (item?.name) state.names.set(t, String(item.name));
    }
    state.wanted = wanted;
    return wanted;
  }

  function load(items = [], { walkWanted = false } = {}) {
    if (loading) return loading;
    loading = (async () => {
      const wanted = setWanted(items);

      // The committed snapshot and this device, with no per-company request at all. A seed already
      // in flight is awaited rather than raced: both read the same file, and letting them overlap
      // would merge the same rows twice for nothing.
      if (seeding) await seeding;
      else await seedFromSnapshot();
      await seedFromDevice(wanted);
      state.loaded = true;
      emit();

      // A SNAPSHOT INDEXED BY DATE COVERS EVERY COMPANY, INCLUDING THE ONES WITH NO ROWS.
      //
      // The per-company walk exists because a snapshot built company by company can only reach the
      // companies its request budget allowed — so a company absent from it might have filed
      // something we never asked about. The BSE announcements feed is indexed the other way round:
      // it asks "what was filed on these dates" across the whole exchange, so a company with no
      // rows filed nothing in the window. Walking it would spend sixty requests a minute to
      // rediscover that. `coversUniverse` is the snapshot saying so, and it is the ONLY thing that
      // may switch the walk off — never a row count, which cannot tell absence from truncation.
      //
      // It also suppresses the cold-start walk below: an empty universe-covering file would be a
      // scrape that failed, and forty per-company requests is the wrong answer to that.
      // THE READER NAMING COMPANIES IS NOT A PAGE LOAD. `walkWanted` is how a caller says the walk
      // was asked for — News's company picker is the only one that does. It still goes through
      // `outstanding()`, so `stale()` and `fromSnapshot` apply: the first search sends one request
      // per company named, and a re-render inside the cache window sends none. Without this the
      // picker committed a selection and fetched nothing, which is the worst of both designs.
      if (walkWanted && !state.coversUniverse) {
        walkMissing();
      } else if (!state.rows.size && !state.coversUniverse) {
        // Nothing to show. Walk once rather than render an empty table over a working feed.
        state.coldStart = true;
        walkMissing();
      }
      return state;
    })();
    return loading;
  }

  /** The companies in scope whose rows nobody has confirmed inside the feed's window. */
  // A universe-covering snapshot was never asked company by company, so no company is waiting to be
  // asked about. Reporting a backlog there would invent one.
  const outstanding = () =>
    state.coversUniverse ? [] : state.wanted.filter((t) => !state.fromSnapshot.has(t) && !state.askedEmpty.has(t) && stale(t));

  function walkMissing() {
    const missing = outstanding();
    if (!missing.length) return null;
    state.truncated = Math.max(0, missing.length - LIVE_LIMIT);
    state.pending = Math.min(missing.length, LIVE_LIMIT);
    return walk(missing.slice(0, LIVE_LIMIT));
  }

  /**
   * Read the live routes now, because the reader asked. Registered with `js/core/refresh.js`.
   *
   * Resolves when the walk finishes, with what it found — the button reports that rather than
   * spinning and vanishing. `force` on every company, because "refresh" means "ask again", and a
   * refresh that silently skipped everything inside its cache window would be a button that does
   * nothing on the one occasion the reader is sure something has changed.
   */
  async function refresh() {
    const before = rowCountNow();
    // The scheduled capture may have moved since this page loaded, and that costs one conditional
    // GET rather than forty. Do it first, so the walk only asks about what the file still lacks.
    await seedFromSnapshot({ replace: true });
    if (kind === 'insider') await seedFromDevice([...state.rows.keys()]);
    // FOR A DATE-INDEXED FEED, RE-READING THE FILE *IS* THE REFRESH. There is no per-company route
    // behind it to ask again, and walking one would be forty requests against an upstream this feed
    // no longer uses. `checked` reports the companies the file covers, because that is what was
    // actually re-read — not a walk we did not perform.
    if (state.coversUniverse) {
      state.lastRefreshAt = Date.now();
      emit();
      return { added: Math.max(0, rowCountNow() - before), checked: state.rows.size, failed: state.failures.size };
    }
    const queue = state.wanted.length ? state.wanted : [...state.rows.keys()];
    state.truncated = Math.max(0, queue.length - LIVE_LIMIT);
    state.pending = Math.min(queue.length, LIVE_LIMIT);
    state.reason = null;
    state.message = null;
    emit();
    await walk(queue.slice(0, LIVE_LIMIT), { force: true });
    state.lastRefreshAt = Date.now();
    emit();
    return { added: Math.max(0, rowCountNow() - before), checked: Math.min(queue.length, LIVE_LIMIT), failed: state.failures.size };
  }

  /**
   * Re-read only the committed bulk capture.
   *
   * The app-wide company-news freshness check uses this after its dedicated Action finishes. It
   * must not call `refresh()`: for a per-company feed that method continues into a forty-company
   * live walk, while the Action has already done the complete universe walk once for everybody.
   * One conditional GET is the whole operation here, and `emit()` lets a mounted News tab replace
   * yesterday's rows as soon as the new deployment reaches the browser.
   */
  async function refreshSnapshot() {
    const before = state.capturedAt;
    const available = await seedFromSnapshot({ replace: true });
    if (kind === 'insider') await seedFromDevice([...state.rows.keys()]);
    state.loaded = true;
    emit();
    return { available, changed: !!state.capturedAt && state.capturedAt !== before, capturedAt: state.capturedAt };
  }

  const rowCountNow = () => [...state.rows.values()].reduce((a, r) => a + r.length, 0);

  function addHeaders(headers = []) {
    if (kind === 'insider') state.headers = mergeInsiderHeaders(state.headers, headers);
    else if (headers.length && !state.headers.length) state.headers = headers;
  }

  function storeRows(ticker, incoming) {
    const list = kind === 'insider'
      ? mergeInsiderTrades(state.rows.get(ticker) || [], incoming, { from: daysAgo(WINDOW_DAYS.insider), to: iso(Date.now()) })
      : incoming;
    state.rows.set(ticker, list);
    if (kind === 'insider') {
      addHeaders(list.flatMap((row) => Object.keys(row.cells || {})));
      if (list.length) state.askedEmpty.delete(ticker);
    }
    return list;
  }

  function saveInsiderHistory(ticker) {
    // The history's write time is never used as a server confirmation time.
    void writeEntry(KEYS.insiderHistory(ticker), { value: { trades: state.rows.get(ticker) || [], headers: state.headers } });
  }

  /**
   * Everything this device already holds for the wanted companies, in ONE store transaction.
   *
   * A miss is not an error — it means "fetch it", which pass two does. A stored FAILURE is never
   * replayed: the Worker caches `ok: false` for fifteen seconds precisely so a corrected token
   * takes effect at once, and painting one from disk would undo that.
   */
  async function seedFromDevice(tickers) {
    if (!tickers.length) return;
    let entries;
    try {
      entries = await readEntries(tickers.flatMap((t) => [KEYS.filingRow(kind, t), ...(kind === 'insider' ? [KEYS.insiderHistory(t)] : [])]));
    } catch {
      return;
    }
    // WHICHEVER COPY WAS CONFIRMED LATER WINS, and that is a comparison, not an order of calls.
    // The snapshot is seeded first because it supplies the companies the device has never seen; a
    // company the device DOES hold is newer whenever the server wrote those bytes here after the
    // file was captured, which is the normal case for anything the reader has refreshed.
    const capturedAt = Date.parse(state.capturedAt || '') || 0;
    for (const t of tickers) {
      if (kind === 'insider') {
        const history = entries.get(KEYS.insiderHistory(t))?.value;
        if (Array.isArray(history?.trades)) {
          addHeaders(history.headers || []);
          storeRows(t, history.trades);
        }
      }
      const hit = entries.get(KEYS.filingRow(kind, t));
      const body = hit?.value;
      if (!body || body.ok === false) continue;
      const savedAt = hit.savedAt || 0;
      const newerThanFile = savedAt > capturedAt;
      if (kind === 'insider' || !state.rows.has(t) || newerThanFile) {
        addHeaders(body.headers || []);
        storeRows(t, rowsIn(body));
        if (newerThanFile) state.fromSnapshot.delete(t);
      }
      if (Array.isArray(body.headers)) addHeaders(body.headers);
      // `savedAt` is when the SERVER's bytes were written here, so it is a real confirmation time
      // rather than this tab vouching for itself.
      if (savedAt) state.confirmedAt.set(t, savedAt);
    }
    if (kind === 'insider') for (const t of tickers) if (state.rows.has(t)) saveInsiderHistory(t);
    state.snapshotCount = state.fromSnapshot.size;
  }

  /**
   * The committed snapshot. A miss is not an error — it means the scheduled run has not run yet.
   *
   * THIS IS THE CHANNEL BY WHICH NEW DATA ARRIVES ON ITS OWN, and it costs one conditional GET: a
   * scheduled job captures the universe and the browser picks the file up, 304 when it has not
   * moved. `replace` is for a refresh, where a capture newer than the one this page loaded should
   * win over what is in memory; on the initial seed a company already read live must not be
   * overwritten by an older file.
   */
  async function seedFromSnapshot({ replace = false } = {}) {
    let res;
    try {
      res = await conditionalJson(SNAPSHOT[kind], { key: KEYS.filings(kind), optional: true });
    } catch {
      res = null;
    }
    const body = res?.value;
    state.checkedAt = res?.checkedAt || Date.now();
    if (!body || typeof body !== 'object') return false;

    const capturedAt = body.capturedAt || body.generated_at || null;
    const nextCaptured = Date.parse(capturedAt || '');
    const heldCaptured = Date.parse(state.capturedAt || '');
    // "Newer" is chronological, not merely different. A rollback or stale edge response must not
    // replace rows this browser has already proved came from a later capture.
    const newer = replace && Number.isFinite(nextCaptured) && (!Number.isFinite(heldCaptured) || nextCaptured > heldCaptured);
    if (!replace || newer) state.capturedAt = capturedAt;
    if (!replace || newer) {
      state.oldestDataAt = body.oldestDataAt || capturedAt;
      state.fallbackCount = Number.isFinite(body.fallbackCount) ? body.fallbackCount : 0;
    }
    if (Array.isArray(body.headers) && body.headers.length) {
      if (kind === 'insider') addHeaders(body.headers);
      else state.headers = body.headers;
    }
    // What the file declares about its own coverage and window. Read before the early return, so a
    // re-read that finds nothing newer still leaves these describing the file we actually hold.
    state.coversUniverse = body.coversUniverse === true;
    state.exchangeCompanies = Number.isFinite(body.exchangeCompanies) ? body.exchangeCompanies : null;
    state.unnamedRows = Number.isFinite(body.unnamedRows) ? body.unnamedRows : 0;
    state.snapshotWindowDays = Number.isFinite(body.windowDays) ? body.windowDays : null;
    if (replace && !newer) return state.rows.size > 0;

    if (newer) {
      // News/announcements snapshots replace rows. Companies that aged out
      // of the rolling window or answered empty in the new run must lose yesterday's rows now,
      // without waiting for a page reload. Preserve only companies read live in this session —
      // those bytes are newer than the bulk file by definition.
      if (kind === 'insider') {
        // A smaller response cannot retract a disclosure. Only the retention window expires it.
        for (const t of state.rows.keys()) storeRows(t, []);
      } else {
        for (const t of state.fromSnapshot) {
          if (!state.confirmedHere.has(t)) state.rows.delete(t);
        }
      }
      state.fromSnapshot.clear();
      state.askedEmpty.clear();
      for (const [t, failure] of state.failures) {
        if (failure?.fromSnapshot) state.failures.delete(t);
      }
    }

    const byTicker = body.byTicker || {};
    const snapshotWins = (t) => !state.confirmedHere.has(t) || (state.confirmedAt.get(t) || 0) <= nextCaptured;
    for (const [ticker, list] of Object.entries(byTicker)) {
      if (!Array.isArray(list) || !list.length) continue;
      const t = ticker.toUpperCase();
      // On the initial seed the device's copy has already been placed and is newer; on a refresh a
      // newer capture wins unless this session confirmed the company AFTER the capture was made.
      if (kind !== 'insider' && state.rows.has(t) && !(newer && snapshotWins(t))) continue;
      storeRows(t, kind === 'news' ? dedupeArticles(list) : list);
      if (kind === 'insider' && state.confirmedHere.has(t) && !snapshotWins(t)) continue;
      state.fromSnapshot.add(t);
      if (newer) {
        state.confirmedHere.delete(t);
        state.confirmedAt.delete(t);
      }
    }
    // Companies the capture ASKED and that answered nothing. They get no rows — there are none —
    // but they are covered, so they must not be reported as waiting to be asked about.
    for (const t of Array.isArray(body.empty) ? body.empty : []) {
      if (typeof t !== 'string' || !t) continue;
      const ticker = t.toUpperCase();
      // A newer bulk search that found nothing must remove an older live row too. Without this,
      // yesterday's article survives until reload even though the replacement capture explicitly
      // says the company is empty in the current window.
      const wins = !newer || snapshotWins(ticker);
      if (newer && wins) {
        if (kind === 'insider') storeRows(ticker, []);
        else state.rows.delete(ticker);
        state.fromSnapshot.delete(ticker);
        state.confirmedHere.delete(ticker);
        state.confirmedAt.delete(ticker);
      }
      if (wins && (kind !== 'insider' || !state.rows.get(ticker)?.length)) state.askedEmpty.add(ticker);
      else if (wins && kind === 'insider') state.fromSnapshot.add(ticker);
    }
    // Companies the capture ASKED and could not read. A third answer again, distinct from having
    // rows and from having none: the pill turns amber for these, the coverage sentence names them
    // rather than leaving the reader to reach them by subtraction, and Refresh retries them. Never
    // over a company that has since been read live — that answer is newer than the file's.
    for (const [ticker, info] of Object.entries(body.failed || {})) {
      const t = String(ticker || '').toUpperCase();
      const unresolved = kind === 'insider' ? snapshotWins(t) : !state.rows.has(t);
      if (t && unresolved && !state.failures.has(t)) state.failures.set(t, { ...info, fromSnapshot: true });
    }
    state.snapshotCount = state.fromSnapshot.size;
    return state.rows.size > 0 || state.askedEmpty.size > 0;
  }

  /** The rows out of one company's payload, deduplicated where duplication is meaningless. */
  function rowsIn(body) {
    const list = Array.isArray(body[ROWS_KEY[kind]]) ? body[ROWS_KEY[kind]] : [];
    return kind === 'news' ? dedupeArticles(list) : list;
  }

  async function walk(queue, { force = false } = {}) {
    const q = [...queue];
    const workers = Array.from({ length: Math.min(CONCURRENCY, q.length) }, async () => {
      for (;;) {
        const t = q.shift();
        if (!t) return;
        state.inFlight++;
        await loadOne(t, { force });
        state.inFlight--;
        state.pending = Math.max(0, state.pending - 1);
        emit();
      }
    });
    await Promise.all(workers);
    emit();
  }

  /** One company. Never throws — a failure is recorded against that ticker and the walk goes on. */
  async function loadOne(key, { force = false } = {}) {
    const t = String(key || '').toUpperCase();
    if (!force && !stale(t)) return state.rows.get(t) || [];
    if (kind === 'insider') await seedFromDevice([t]);
    state.asked.add(t);

    const range = `from=${daysAgo(WINDOW_DAYS[kind])}&to=${iso(Date.now())}`;
    const path = ROUTE[kind](kind === 'news' ? queryFor(t) : t, range);
    let res;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      res = await conditionalJson(path, { key: KEYS.filingRow(kind, t), optional: true, signal: abort.signal });
    } catch {
      res = null;
    } finally {
      clearTimeout(timer);
    }
    const body = res?.value;

    if (!body) {
      // No route at this origin at all — a plain static server rather than the Worker.
      state.failures.set(t, { reason: 'no-route', message: `This origin has no /api/${kind} route. The live feed needs the Cloudflare Worker.` });
      if (!state.reason) {
        state.reason = 'no-route';
        state.message = 'This origin serves the static files only, so there is no live route to answer. Run `npx wrangler dev`, or open the deployed site.';
      }
      return null;
    }
    if (body.ok === false) {
      state.failures.set(t, { reason: body.reason || 'upstream', message: body.message || 'Could not be read.', requestedUrl: body.requestedUrl || null });
      // The first operator-fixable reason becomes the feed's reason, because one expired token is
      // not 123 unrelated failures and the screen should say so once.
      if (!state.reason && ['no-token', 'unauthorised', 'rate-limited'].includes(body.reason)) {
        state.reason = body.reason;
        state.message = body.message;
      }
      return null;
    }

    if (Array.isArray(body.headers)) addHeaders(body.headers);
    const list = storeRows(t, rowsIn(body));
    if (kind === 'insider') {
      // Never attach the upstream ETag to merged bytes: a subsequent 304 must replay only the
      // actual response. This separate entry preserves live-only additions across page reloads.
      saveInsiderHistory(t);
    }
    state.fromSnapshot.delete(t);
    state.failures.delete(t);
    state.confirmedAt.set(t, res?.checkedAt || Date.now());
    state.confirmedHere.add(t);
    if (!state.capturedAt && body.fetchedAt) state.checkedAt = Date.parse(body.fetchedAt) || state.checkedAt;
    return list;
  }

  return {
    seed,
    setWanted,
    load,
    loadOne,
    refresh,
    refreshSnapshot,
    rows,
    forTicker,
    wasAskedEmpty,
    failureFor,
    meta,
    isLoaded: () => state.loaded,
    invalidate() {
      state = fresh();
      loading = null;
      seeding = null;
    },
    onChange(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

// One instance per feed, module-level so a second visit to the tab repaints instantly instead of
// re-walking. Same reasoning as the super-investor feed.
export const news = createFeed('news');
export const announcements = withAnnouncementLookups(withFilingArchive(createFeed('announcements'), 'announcements'));
export const insider = withFilingArchive(createFeed('insider'), 'insider');
