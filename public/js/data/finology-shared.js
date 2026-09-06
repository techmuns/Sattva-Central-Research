// data/finology-shared.js — the super-investor vocabulary, shared by the browser and the Worker.
//
//   isSlug(s)                    what the upstream will accept as a path param
//   normaliseList(body)          the investor list, shape-guarded
//   normalisePortfolio(body, s)  one investor's book, shape-guarded
//   deriveMoves(portfolio)       quarter-over-quarter position changes
//   summarise(portfolio)         totals over one book
//
// PURE, AND IMPORTED BY `worker/finology.mjs`. Same arrangement as stockscans-shared.js: one
// definition of what a holding is, so the Worker and the browser cannot end up disagreeing about
// whether a blank quarter means zero. Nothing here touches the DOM or network. Quarter eligibility reads the current date.
//
// THE NUMBERS ARE FINOLOGY'S. Holding percentages are what the company filed with the exchanges;
// `valueCr` is Finology's own derivation from that percentage and a market cap — the same relation
// the Institutions view has with Trendlyne's value column. Neither is recomputed here.
//
// THE ONE DERIVED FIGURE is the quarter-over-quarter change in `deriveMoves`, which is subtraction
// of two of their own percentages. It is labelled as derived on every surface that shows it.

/** Only [a-z0-9-] is a valid slug upstream; anything else is a 400 there, so it is rejected here. */
export const isSlug = (s) => typeof s === 'string' && /^[a-z0-9-]+$/.test(s) && s.length <= 120;

const num = (v) => {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && (!v.trim() || v.trim() === '-')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * THE UPSTREAM'S OWN WORD FOR A CELL THAT CARRIES NO NUMBER, kept rather than erased.
 *
 * Finology print **"Filing Due"** in a quarter a company has not filed yet, and "-" where the
 * holding genuinely was not disclosed. `num()` turns both into `null`, and that collapse is what
 * let a company that simply has not filed be reported as one a fund had sold out of. It is the
 * same distinction `parseChange` keeps for Trendlyne's "Filing Awaited", for the same reason.
 *
 * Returns the label only where it is a real statement — "-" and blank say nothing a null does not.
 */
const cellNote = (v) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t === '-' || Number.isFinite(Number(t))) return null;
  return t;
};

/** Their words for "this period is not filed yet", matched loosely because it is somebody's prose. */
const PENDING_NOTE = /\b(due|awaited|pending|not\s+filed|yet\s+to\s+file)\b/i;
export const isPendingNote = (note) => !!note && PENDING_NOTE.test(String(note));
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Two decimals, because a percentage-point delta of 0.30000000000000004 is not a real figure. */
export const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Shape guard for the list.
 *
 * `bio` and `imageUrl` are documented nullable, and `name` can be missing. An investor with no
 * usable slug is DROPPED rather than rendered: the slug is the only way to fetch that investor's
 * book, so a card without one is a dead end. `dropped` carries how many, because upstream `count`
 * and the rendered count would otherwise disagree with nothing to explain it.
 */
export function normaliseList(body) {
  const raw = Array.isArray(body?.investors) ? body.investors : [];
  const investors = raw
    .map((i) => ({
      name: str(i?.name) || str(i?.slug) || null,
      slug: str(i?.slug),
      bio: str(i?.bio),
      imageUrl: str(i?.imageUrl),
    }))
    .filter((i) => isSlug(i.slug || ''));
  return {
    count: Number.isFinite(body?.count) ? body.count : investors.length,
    dropped: raw.length - investors.length,
    investors,
  };
}

/**
 * Shape guard for one portfolio.
 *
 * `quarters` is the ordered list of column labels and `quarterlyHoldings` is keyed by those
 * labels. An explicit dash/null means no disclosed percentage. A missing key or invalid value
 * is incomplete data and carries a note. It stays `null` all the way to the UI,
 * where it renders as an em dash. Coercing it to 0 would invent a position size of zero, which is
 * a claim, and would turn every gap in disclosure into a fabricated exit in `deriveMoves`.
 */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "Jun 2025" / "Jun 25" / "2025-06" -> 202506, or null when the label is not a date at all. */
export function quarterOrder(label) {
  const s = String(label || '').trim();
  const iso = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (iso) return Number(iso[2]) >= 1 && Number(iso[2]) <= 12 ? Number(iso[1]) * 100 + Number(iso[2]) : null;
  const named = /^([A-Za-z]{3})[a-z]*[\s-]*(\d{2}|\d{4})$/.exec(s);
  if (!named) return null;
  const m = MONTHS[named[1].toLowerCase()];
  if (!m) return null;
  const y = named[2].length <= 2 ? 2000 + Number(named[2]) : Number(named[2]);
  return y * 100 + m;
}

/** A dated quarter-end is eligible only after its calendar period has ended. */
const QUARTER_END_MONTHS = new Set([3, 6, 9, 12]);
export function isFiledQuarter(label, now = Date.now()) {
  const n = quarterOrder(label);
  return n != null && QUARTER_END_MONTHS.has(n % 100) && Date.UTC(Math.floor(n / 100), n % 100, 1) <= now;
}

/** Stable source identity; punctuation in a display name is only a fallback. */
export const companyKey = (h) => h?.companySlug
  ? `slug:${String(h.companySlug).trim().toUpperCase()}`
  : `name:${String(h?.company || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

/**
 * The source's quarters, newest first.
 *
 * EVERY CONSUMER ALREADY ASSUMES `quarters[0]` IS THE LATEST — `deriveMoves` compares [0] against
 * [1], `summarise` counts what is disclosed in [0], and the investor card prints "as of quarters[0]".
 * That assumption was never checked. If the upstream ever hands back ascending order, all three
 * silently describe the OLDEST quarter as the current book, which is not a rendering glitch but a
 * wrong answer stated confidently.
 *
 * So the order is now established from the labels rather than assumed from the array. Labels that
 * do not parse as dates are left exactly where they were — reordering something we cannot read
 * would be worse than trusting it — and a mixed set keeps the source's order for the same reason.
 */
function orderedQuarters(quarters) {
  const keyed = quarters.map((q) => ({ q, n: quarterOrder(q) }));
  if (keyed.some((k) => k.n == null)) return quarters;
  return keyed.sort((a, b) => b.n - a.n).map((k) => k.q);
}

/** Malformed success payloads must not replace last-good books in any cache. */
export const isPortfolioPayload = (body, slug = null) => body?.ok !== false
  && (!slug || !body?.slug || body.slug === slug) && Array.isArray(body?.quarters)
  && body.quarters.every((q) => typeof q === 'string' && q.trim()) && Array.isArray(body?.holdings)
  && body.holdings.every((h) => typeof h?.company === 'string' && h.company.trim()
    && h.quarterlyHoldings && typeof h.quarterlyHoldings === 'object' && !Array.isArray(h.quarterlyHoldings));

export function normalisePortfolio(body, slug) {
  const raw = Array.isArray(body?.quarters) ? body.quarters.filter((q) => typeof q === 'string' && q.trim()) : [];
  const quarters = orderedQuarters([...new Set(raw.map((q) => q.trim()))]);
  const rows = (Array.isArray(body?.holdings) ? body.holdings : [])
    .map((h) => {
      const byQuarter = {};
      const notes = {};
      for (const q of quarters) {
        const raw = h?.quarterlyHoldings?.[q];
        const n = num(raw);
        byQuarter[q] = n != null && n >= 0 && n <= 100 ? n : null;
        // Normalisation runs at the Worker, snapshot, device cache and browser boundaries.
        // Preserve notes through every pass; a missing key is not an explicit disclosure dash.
        const note = cellNote(raw) || str(h?.quarterlyNotes?.[q]);
        if (note) notes[q] = note;
        else if (!Object.hasOwn(h?.quarterlyHoldings || {}, q)) notes[q] = 'Not available';
        else if (raw != null && !(typeof raw === 'string' && (!raw.trim() || raw.trim() === '-')) && byQuarter[q] == null) notes[q] = 'Invalid percentage';
      }
      return {
        company: str(h?.company),
        companySlug: str(h?.companySlug),
        quarterlyHoldings: byQuarter,
        // Their word for a cell that carries no number, where they gave one. Empty on every row
        // whose cells were all numeric or a plain dash, so it costs nothing on a normal book.
        quarterlyNotes: notes,
        valueCr: num(h?.valueCr),
      };
    })
    .filter((h) => h.company);

  // Count a company once per investor. Conflicting duplicate cells cannot support a move.
  const unique = new Map();
  for (const h of rows) {
    const key = companyKey(h), existing = unique.get(key);
    if (!existing) { unique.set(key, h); continue; }
    for (const q of quarters) {
      if (existing.quarterlyHoldings[q] !== h.quarterlyHoldings[q] || existing.quarterlyNotes[q] !== h.quarterlyNotes[q]) {
        existing.quarterlyHoldings[q] = null;
        existing.quarterlyNotes[q] = 'Conflicting source rows';
      }
    }
    if (existing.valueCr !== h.valueCr) existing.valueCr = null;
  }
  const holdings = [...unique.values()];

  // THE COLUMNS ARE SPLIT ONCE, HERE, so every consumer asks the same question of the same answer.
  // `quarters` is unchanged — it is the source's own column set and the table still renders all of
  // it, "Filing Due" column included. What is new is that a comparison has somewhere honest to look.
  const filedQuarters = quarters.filter((q) => isFiledQuarter(q));
  const openQuarters = quarters.filter((q) => !isFiledQuarter(q));

  return {
    name: str(body?.name) || slug,
    slug: str(body?.slug) || slug,
    ...(str(body?.fetchedAt) ? { fetchedAt: str(body.fetchedAt) } : {}),
    ...(str(body?.sourceCheckedAt) ? { sourceCheckedAt: str(body.sourceCheckedAt) } : {}),
    netWorthCr: num(body?.netWorthCr),
    activeStocks: num(body?.activeStocks),
    totalStocks: num(body?.totalStocks),
    quarters,
    filedQuarters,
    openQuarters,
    holdings,
  };
}

/**
 * The latest closed quarter and its immediately preceding quarter, or null for a gap.
 *
 * Exported because the Data Table classifies a row from its own book's quarters and must ask the
 * same question `deriveMoves` asks. It used to answer it itself, off `quarters[0]` and `[1]`.
 */
export function filedPair(quarters, now = Date.now()) {
  const filed = orderedQuarters((quarters || []).filter((q) => isFiledQuarter(q, now)));
  const latest = filed[0] || null;
  const n = quarterOrder(latest);
  const previous = n == null ? null : n % 100 === 3 ? n - 91 : n - 3;
  return [latest, filed.find((q) => quarterOrder(q) === previous) || null];
}

/**
 * ONE CLASSIFIER FOR ONE HOLDING, and the only one in this codebase.
 *
 * `js/investors/live.js` carried a second copy — the same five branches over `quarters[0]` and
 * `[1]` — so the Data Table went on printing "Undisclosed" against a company whose drill panel and
 * alert had been corrected. Two predicates over one question is the shape this repository keeps
 * having to un-write, and here it meant a fix could land in three places and still be visibly
 * wrong in the fourth.
 *
 * Returns null where there is nothing to say, so the caller can drop the row.
 */
export function classifyHolding(h, latest, prior) {
  if (!latest || !prior) return null;
  const now = h?.quarterlyHoldings?.[latest] ?? null;
  const before = h?.quarterlyHoldings?.[prior] ?? null;
  const notes = [h?.quarterlyNotes?.[latest], h?.quarterlyNotes?.[prior]].filter(Boolean);
  // A pending/invalid cell on either side makes the comparison incomplete, even if it
  // carries a number. In particular, a pending prior filing cannot establish a new entrant.
  if (notes.length) return { action: 'awaiting', deltaPp: null, now, before };
  if (now == null && before == null) return null;
  if (now == null) return { action: h?.valueCr === 0 ? 'exited' : 'awaiting', deltaPp: null, now, before };
  if (before == null) return { action: 'new', deltaPp: null, now, before };
  const deltaPp = round2(now - before);
  return { action: deltaPp > 0 ? 'added' : deltaPp < 0 ? 'trimmed' : 'held', deltaPp, now, before };
}

/** Only measured changes and explicit disclosure appearances/disappearances are moves. */
export const MOVE_ACTIONS = ['new', 'exited', 'added', 'trimmed'];
export const isMove = (action) => MOVE_ACTIONS.includes(action);

export function deriveMoves(portfolio) {
  const [latest, prior] = filedPair(portfolio?.quarters);
  const pending = (portfolio?.quarters || []).filter((q) => !isFiledQuarter(q));
  if (!latest || !prior) {
    return { comparable: false, latest, prior, pending, moves: [], reason: 'missing consecutive closed quarters' };
  }

  const moves = [];
  for (const h of portfolio.holdings) {
    const change = classifyHolding(h, latest, prior);
    if (!change) continue; // disclosed in neither: nothing to say
    moves.push({ company: h.company, companySlug: h.companySlug, valueCr: h.valueCr, ...change });
  }

  return { comparable: true, latest, prior, pending, moves, reason: null };
}

/**
 * Totals over one book. Every figure is a count or a sum of their own numbers.
 *
 * THE VALUE SUMS ONLY WHAT IS STILL DISCLOSED. `holdings` carries every company that has ever
 * appeared in this investor's history, including ones absent from the latest quarter — and
 * summing those into a "book" produced the contradiction this was written to fix: a card reading
 * `0 holdings` beside `₹793 Cr book`, because the count used the latest quarter and the total
 * used all of history. What someone holds now is the latest quarter, so both figures use it.
 *
 * Within that set, only the rows that actually carry a value are summed, and `valuedCount` says
 * how many did. A total that silently skips a third of the book while looking complete is worse
 * than no total at all.
 */
export function summarise(portfolio) {
  // THE LATEST *FILED* QUARTER, for the same reason `deriveMoves` uses it. Counting an open
  // "Filing Due" column as the current book made Madhusudan Kela hold one company instead of
  // fifteen and put his book at a fraction of its size — a card stating, in figures, that an
  // investor had liquidated. `latestQuarter` is what every surface prints as "as of", so it has to
  // name a quarter that was actually filed.
  const [latest] = filedPair(portfolio?.quarters);
  const disclosed = latest ? portfolio.holdings.filter((h) => h.quarterlyHoldings[latest] != null) : [];
  const valued = disclosed.filter((h) => h.valueCr != null);
  return {
    latestQuarter: latest || null,
    disclosedCount: disclosed.length,
    rowCount: portfolio.holdings.length,
    valueCr: valued.length ? round2(valued.reduce((a, h) => a + h.valueCr, 0)) : null,
    valuedCount: valued.length,
  };
}
