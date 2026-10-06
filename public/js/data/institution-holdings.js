// data/institution-holdings.js — REAL institutional holdings, from TWO different disclosures.
//
//   prime(payload)            // optional seed for a complete validated capture
//   all()                     // every fund, both kinds
//   byId(investorId)
//   meta()                    // source, when it was read
//   holdingsForScope(scope, holdings, fund)
//   quarterlySummary(opts)    // cross-book moves, shareholding filings only
//   quarterlyCompany(key)     // one company across every quarterly institution book
//
// TWO DISCLOSURES, AND KEEPING THEM APART IS THE WHOLE POINT OF THIS MODULE.
//
//   `disclosure: 'shareholding'` — Trendlyne. Indian companies file their shareholding pattern with
//     the exchanges each quarter, naming every holder above 1% with a share count and a percentage
//     OF THE COMPANY. Those two numbers are the filing itself. Only positions above the naming
//     threshold appear at all. The RUPEE VALUE is Trendlyne's own derivation, holding % × market
//     cap — reproduced unchanged and attributed, never recomputed, for the same reason the con-call
//     scores stay StockScans'.
//
//   `disclosure: 'portfolio'` — an AMC's own monthly portfolio. The percentage is % TO NAV, how
//     much OF THE FUND sits in that company. Every position appears however small, and the rupee
//     value is the AMC's OWN published figure, because a portfolio disclosure does state one.
//
//   So 2.5 under one and 2.5 under the other are not the same measurement, and this module never
//   puts them in the same field under the same name. What it does do is give both a shared
//   VOCABULARY — `periods`, `pctByPeriod`, `pct` — so the view can lay them out with one set of
//   components while labelling each with what it actually means. The shared names describe the
//   SHAPE (a series of percentages over time); `disclosure` is what says what they measure, and
//   every consumer must branch on it before writing a heading.
//
// A MISSING PERCENTAGE IS NEVER A ZERO, in either kind, but it means something different in each.
//   Shareholding: filings trickle in for weeks after a quarter closes, so a holding can carry a
//   share count and a value while its newest percentage is still outstanding — Trendlyne label that
//   "Filing Awaited". Portfolio: a blank month is a month the fund did not hold the line at all.
//   Rendering either as 0% would report something that is not so.

import { filterByScope } from './scope.js';

const PATH = 'data/institution-holdings.json';

let cache = null;
let loadPromise = null;
const subscribers = new Set();
export const onChange = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
export async function refresh() {
  const { revalidatedJson } = await import('../core/store.js');
  const payload = await revalidatedJson(PATH);
  if (!Array.isArray(payload?.institutions)) throw Error('Institutional capture unavailable');
  ingest(payload);
  subscribers.forEach((fn) => fn());
  return cache;
}

/** Optional complete-capture seed; ordinary readers use the shared on-demand load(). */
export function prime(payload) {
  if (payload && !cache) ingest(payload);
  return cache;
}

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = import('../core/store.js')
    .then((s) => s.revalidatedJson(PATH, { optional: true }))
    .then((p) => {
      loadPromise = null;
      if (p) ingest(p);
      return cache;
    })
    .catch(() => {
      loadPromise = null;
      return null;
    });
  return loadPromise;
}

/**
 * One fund, in the shared vocabulary.
 *
 * The scraper writes `quarters` / `quarterLabels` / `pctByQuarter` and the importer writes
 * `periods` / `periodLabels` / `pctByPeriod`. Aliasing here rather than rewriting either producer
 * keeps scrape-institution-holdings.mjs untouched — it runs on its own schedule against a live
 * upstream and is the last thing that should need editing to add a fund of a different kind.
 */
function normalise(f) {
  const shareholding = (f.disclosure || 'shareholding') === 'shareholding';
  const periods = f.periods || f.quarters || [];
  const periodLabels = f.periodLabels || f.quarterLabels || [];
  const row = (h) => ({
    ...h,
    pctByPeriod: h.pctByPeriod || h.pctByQuarter || {},
    // `pct` is the latest period's percentage. What it MEANS is `disclosure`'s job to say.
    pct: h.pct ?? h.weightPct ?? h.holdingPct ?? null,
  });

  return {
    ...f,
    disclosure: shareholding ? 'shareholding' : 'portfolio',
    periods,
    periodLabels,
    periodNoun: f.periodNoun || 'quarter',
    latestPeriod: f.latestPeriod || f.latestQuarter || periods[0] || null,
    latestPeriodLabel: f.latestPeriodLabel || f.latestQuarterLabel || periodLabels[0] || null,
    // Newest first by position size, which is the order a reader scans for.
    holdings: (f.holdings || []).map(row).sort((a, b) => (b.valueCr ?? 0) - (a.valueCr ?? 0)),
    former: (f.former || []).map(row),
  };
}

function ingest(payload) {
  const institutions = (payload.institutions || []).map(normalise);
  cache = {
    institutions,
    byId: new Map(institutions.map((f) => [f.investorId, f])),
    meta: {
      source: payload.source || null,
      generator: payload.generator || null,
      generatedAt: payload.generated_at || null,
      quarter: payload.quarter || null,
      quarterLabel: payload.quarterLabel || null,
      count: institutions.length,
    },
  };
  return cache;
}

export const isLoaded = () => !!cache;
export const all = () => (cache ? cache.institutions : []);
export const meta = () => (cache ? cache.meta : null);
export const byId = (id) => (cache && id ? cache.byId.get(id) || null : null);

// ---------------------------------------------------------------------------------------
// Quarterly shareholding changes across every institution book
//
// AMC portfolios deliberately do not enter this roll-up. Their monthly percentages are weights
// in a fund (% to NAV); a shareholding filing's quarterly percentage is a stake in a company. Both
// are real, but grouping or ranking them together would make unlike measurements look comparable.
// ---------------------------------------------------------------------------------------

const round2 = (n) => Math.round(n * 100) / 100;
const companyKey = (h) => (h.ticker ? `ticker:${String(h.ticker).toUpperCase()}` : `name:${String(h.name || '').trim().toLowerCase()}`);

function changeFor(h, fund) {
  const [latest, prior] = fund.periods || [];
  if (!latest || !prior) return { action: 'unknown', deltaPp: null, now: null, before: null };
  const now = h.pctByPeriod?.[latest] ?? null;
  const before = h.pctByPeriod?.[prior] ?? null;

  // A company that has not filed the newest quarter is still in the fund's current holdings.
  // Calling its blank an exit would be the exact lie the table's Filing Awaited label prevents.
  if (h.changeNote === 'Filing Awaited' && now == null) return { action: 'awaiting', deltaPp: null, now, before };
  if (now == null && before == null) return null;
  if (before == null) return { action: 'new', deltaPp: null, now, before };
  if (now == null) return { action: 'exited', deltaPp: null, now, before };
  const deltaPp = round2(now - before);
  return { action: deltaPp > 0 ? 'added' : deltaPp < 0 ? 'trimmed' : 'held', deltaPp, now, before };
}

function quarterlyRows() {
  const out = [];
  for (const fund of all().filter((f) => f.disclosure === 'shareholding')) {
    const seen = new Set();
    for (const h of [...fund.holdings, ...(fund.former || [])]) {
      const key = companyKey(h);
      // A producer is required to keep one row per company, but de-duplicating here keeps one bad
      // source row from becoming two institutional votes in a consensus card.
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const change = changeFor(h, fund);
      if (!change) continue;
      out.push({
        key,
        company: h.name,
        ticker: h.ticker || null,
        institution: fund.name,
        institutionId: fund.investorId,
        house: fund.house || null,
        category: fund.category || null,
        latest: fund.periodLabels?.[0] || fund.periods?.[0] || null,
        prior: fund.periodLabels?.[1] || fund.periods?.[1] || null,
        valueCr: h.valueCr ?? null,
        qty: h.qty ?? null,
        url: h.url || null,
        note: h.changeNote || null,
        ...change,
      });
    }
  }
  return out;
}

/**
 * The latest quarter across the institution books that are actually quarterly.
 *
 * New and no-longer-disclosed positions carry no invented delta; measured increases/reductions
 * use percentage points of the company. Consensus is a count of institutions, never a signal.
 */
export function quarterlySummary({ include = null, limit = 5 } = {}) {
  const books = all().filter((f) => f.disclosure === 'shareholding');
  const comparableBooks = books.filter((f) => (f.periods || []).length > 1);
  const allRows = quarterlyRows().filter((r) => r.action !== 'awaiting' && r.action !== 'unknown');
  const rows = include ? allRows.filter((r) => include(r)) : allRows;
  const counts = { new: 0, exited: 0, added: 0, trimmed: 0, held: 0 };
  for (const r of rows) if (counts[r.action] != null) counts[r.action] += 1;

  const group = (actions) => {
    const grouped = new Map();
    for (const row of rows) {
      if (!actions.includes(row.action)) continue;
      if (!grouped.has(row.key)) grouped.set(row.key, { key: row.key, company: row.company, ticker: row.ticker, institutions: [] });
      grouped.get(row.key).institutions.push({ institution: row.institution, institutionId: row.institutionId, action: row.action, deltaPp: row.deltaPp, now: row.now });
    }
    return [...grouped.values()]
      .filter((item) => item.institutions.length > 1)
      .map((item) => ({
        ...item,
        count: item.institutions.length,
        sized: item.institutions.filter((i) => i.deltaPp != null).length,
        sumPp: round2(item.institutions.reduce((sum, i) => sum + (i.deltaPp ?? 0), 0)),
      }))
      .sort((a, b) => b.count - a.count || Math.abs(b.sumPp) - Math.abs(a.sumPp) || a.company.localeCompare(b.company));
  };

  const byAction = (action) => rows.filter((r) => r.action === action);
  const pairs = [];
  for (const fund of comparableBooks) {
    const latest = fund.periodLabels?.[0] || fund.periods[0];
    const prior = fund.periodLabels?.[1] || fund.periods[1];
    if (!pairs.some((p) => p.latest === latest && p.prior === prior)) pairs.push({ latest, prior });
  }

  return {
    counts,
    total: rows.length,
    pairs,
    comparableBooks: comparableBooks.length,
    singleQuarterBooks: books.length - comparableBooks.length,
    contributingBooks: new Set(rows.map((r) => r.institutionId)).size,
    consensusBuys: group(['new', 'added']).slice(0, limit),
    consensusExits: group(['exited', 'trimmed']).slice(0, limit),
    newEntrants: byAction('new').sort((a, b) => (b.now ?? 0) - (a.now ?? 0)),
    topAdds: byAction('added').sort((a, b) => b.deltaPp - a.deltaPp),
    topTrims: byAction('trimmed').sort((a, b) => a.deltaPp - b.deltaPp),
    exits: byAction('exited'),
  };
}

/** Every relevant quarterly institution row for one company, including unchanged/pending books. */
export function quarterlyCompany(key) {
  return quarterlyRows()
    .filter((row) => row.key === key && (row.now != null || row.before != null || row.action === 'awaiting'))
    .sort((a, b) => (b.now != null) - (a.now != null) || (b.now ?? -1) - (a.now ?? -1) || a.institution.localeCompare(b.institution));
}

/** Every ticker any tracked institution currently holds — used to answer "who owns this?". */
export function holdersOf(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (!t) return [];
  return all()
    .filter((f) => f.holdings.some((h) => h.ticker.toUpperCase() === t))
    .map((f) => ({ fund: f, holding: f.holdings.find((h) => h.ticker.toUpperCase() === t) }));
}

/**
 * Narrow a fund's holdings to the active scope. Portfolio scope answers a different and more
 * useful question than "what does this fund own" — it answers "where does this fund overlap me".
 */
export function holdingsForScope(scope, portfolioHoldings = [], rows = []) {
  // A row with no ticker cannot be matched against the book or the watchlist, so it drops out of
  // either narrowed scope. That is a limit of the join and not a claim the fund does not hold it —
  // the row is still there under Universe, and it says why it carries no symbol. Tested explicitly
  // rather than left to String(null) happening not to collide with a real symbol.
  return filterByScope(rows, scope, portfolioHoldings);
}
