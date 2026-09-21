// data/sentiment-shared.js — the SentimentDash vocabulary, shared by the browser and the Worker.
//
//   normaliseDashboard(body)      the /dashboard response, shape-guarded
//   normalisePosts(body)          a posts response, shape-guarded
//   resolveEntry(entry, index)    slug -> NSE symbol, or a stated reason it has none
//   buildResolverIndex(sources)   the lookup the resolver reads
//   fingerprint(entries)          order-independent change signal
//
// PURE, AND BROWSER-ONLY IN PRACTICE. It was written to be shared with a Worker client the way
// stockscans-shared.js and finology-shared.js are, and that client is gone: this upstream cannot be
// proxied at all (see js/data/chatter-live.js). Keeping the module free of `fetch`, the DOM and any
// global is still worth it — it is what makes the resolver testable offline, which is how the
// `value` -> VALUEIND false positive was caught.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COUNTS AND THE SENTIMENT ARE THEIRS. THE NSE SYMBOL IS OURS.
//
// Everything under `raw` is reproduced from the API unchanged — mentions, changePct, the
// sentiment split, the source breakdown, the sparkline. `sentiment` preserves their aggregate.
// `sentimentReading` separately describes the complete split for customer summaries: opposing
// tags are Mixed and a directional minority cannot outweigh neutral mentions. It is explicitly
// our description of source tags, not their score's band or an interpretation of the source text.
//
// The one thing this file derives is `ticker` — the NSE symbol — because the API has none.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `ticker` IN THEIR PAYLOAD IS NOT AN EXCHANGE SYMBOL. It is a forum-topic slug used as a routing
// key: `zomato`, `fiis`, `3b-blackbio-dx`. Their `exchange` and `sector` fields exist in the
// schema and are empty strings for essentially every entry. So the slug is carried through as
// `slug`, never as `ticker`, and anything downstream that means "NSE symbol" reads `ticker`,
// which this file sets to null unless it could actually resolve one.
//
// `changePct` IS A CHANGE IN MENTION COUNT, NOT A PRICE MOVE. It compares this scrape's mentions
// against the previous scrape's. There is no price anywhere in this API. It travels as
// `mentionsChangePct` here so no consumer can mistake it for a return by reading the field name.

import { chatterSentiment } from './chatter-sentiment.js';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = num(v);
  return n == null ? null : Math.round(n);
};

export const SOURCES = ['reddit', 'valuepickr', 'news', 'tradingqna'];
export const SENTIMENTS = ['bullish', 'bearish', 'neutral'];

// Their labels, reproduced. `reddit` is a valid source key that is currently 0 everywhere — it
// stays in the vocabulary because their schema has it, and a source with no posts is a fact
// about this scrape, not a reason to pretend the key does not exist.
export const SOURCE_LABEL = {
  reddit: 'Reddit',
  valuepickr: 'ValuePickr',
  news: 'Google News',
  tradingqna: 'TradingQnA',
};

const sourceCounts = (o) => {
  const out = {};
  for (const k of SOURCES) out[k] = int(o?.[k]) ?? 0;
  return out;
};
const sentimentCounts = (o) => {
  const out = {};
  for (const k of SENTIMENTS) out[k] = int(o?.[k]) ?? 0;
  return out;
};

/**
 * One ranked entry, shape-guarded.
 *
 * `rank` is deliberately allowed to be null: their `/stocks/{ticker}` route rebuilds an entry
 * from its posts file when it has dropped out of the ranked list, and says so with `rank: null`
 * plus `derivedFromPosts`. A zero there would claim it ranked first.
 */
export function normaliseEntry(raw) {
  const slug = str(raw?.ticker);
  if (!slug) return null;
  const s = raw?.sentiment || {};
  return {
    slug,
    name: str(raw?.name) || slug,
    rank: raw?.rank == null ? null : int(raw.rank),
    mentions: int(raw?.mentions) ?? 0,
    mentionsPrev: int(raw?.mentionsPrev) ?? 0,
    // Named for what it is. See the header: this is mention volume, never a price move.
    mentionsChangePct: num(raw?.changePct),
    direction: ['up', 'down', 'flat'].includes(raw?.direction) ? raw.direction : 'flat',
    sentimentReading: chatterSentiment(s, raw?.mentions),
    sentiment: {
      ...sentimentCounts(s),
      score: num(s?.score),
      label: SENTIMENTS.includes(s?.label) ? s.label : 'neutral',
      labelText: str(s?.labelText) || 'Neutral',
      color: str(s?.color),
      total: int(s?.total) ?? 0,
      percent: {
        bullish: num(s?.percent?.bullish) ?? 0,
        bearish: num(s?.percent?.bearish) ?? 0,
        neutral: num(s?.percent?.neutral) ?? 0,
      },
    },
    sources: sourceCounts(raw?.sources),
    activeSources: Array.isArray(raw?.activeSources) ? raw.activeSources.filter((x) => SOURCES.includes(x)) : [],
    sourceLabel: str(raw?.sourceLabel) || '',
    // Per-RUN mention counts, oldest first — points are scrape runs, not days. Anything that
    // renders this must not put a time axis under it.
    sparkline: Array.isArray(raw?.sparkline) ? raw.sparkline.map((n) => int(n) ?? 0) : [],
  };
}

export function normaliseOverview(raw) {
  if (!raw) return null;
  const m = raw.marketMood || {};
  const compact = (c) =>
    c
      ? {
          slug: str(c.ticker),
          name: str(c.name) || str(c.ticker),
          rank: c.rank == null ? null : int(c.rank),
          mentions: int(c.mentions) ?? 0,
          mentionsChangePct: num(c.changePct),
          sentimentScore: num(c.sentimentScore),
          sentimentLabel: SENTIMENTS.includes(c.sentimentLabel) ? c.sentimentLabel : 'neutral',
        }
      : null;
  return {
    generatedAt: str(raw.generatedAt),
    window: str(raw.window) || '30d',
    totalPosts: int(raw.totalPosts) ?? 0,
    totalEntries: int(raw.totalStocks) ?? 0,
    marketMood: {
      ...sentimentCounts(m),
      total: int(m.total) ?? 0,
      score: num(m.score),
      label: SENTIMENTS.includes(m.label) ? m.label : 'neutral',
      labelText: str(m.labelText) || 'Neutral',
      percent: {
        bullish: num(m?.percent?.bullish) ?? 0,
        bearish: num(m?.percent?.bearish) ?? 0,
        neutral: num(m?.percent?.neutral) ?? 0,
      },
    },
    // Their picks, reproduced under their own names. NOTE these are computed across ALL entries,
    // so "most bullish" has been the word "Growth" and "top mover" a broker. Any surface that
    // shows them has to survive that, or not show them.
    mostBullish: compact(raw.mostBullish),
    topMover: compact(raw.topMover),
    sourceTotals: sourceCounts(raw.sourceTotals),
  };
}

export function normaliseDashboard(body) {
  const entries = Array.isArray(body?.stocks) ? body.stocks.map(normaliseEntry).filter(Boolean) : [];
  return {
    generatedAt: str(body?.generatedAt),
    window: str(body?.window) || '30d',
    overview: normaliseOverview(body?.overview),
    total: int(body?.pagination?.total) ?? entries.length,
    entries,
  };
}

/**
 * One post. These are REAL posts by REAL forum members, which is the opposite of the constraint
 * the synthetic chatter set was built under — there, handles had to be fictional because
 * inventing words for a named person is not something a label can make acceptable. Here the words
 * are genuinely theirs, so the UI shows only a short identifying excerpt and links to the
 * original. `url` is mandatory-ish for that reason; a post without one cannot be attributed.
 */
export function normalisePost(raw) {
  const id = str(raw?.id);
  if (!id) return null;
  return {
    id,
    source: SOURCES.includes(raw?.source) ? raw.source : null,
    author: str(raw?.author),
    handle: str(raw?.handle),
    community: str(raw?.community),
    at: str(raw?.timestamp),
    text: str(raw?.text) || '',
    url: str(raw?.url),
    sentiment: SENTIMENTS.includes(raw?.sentiment) ? raw.sentiment : null,
    likes: int(raw?.likes) ?? 0,
    comments: int(raw?.comments) ?? 0,
    slug: str(raw?.ticker),
    sourceLabel: str(raw?.sourceLabel) || SOURCE_LABEL[raw?.source] || '',
  };
}

export function normalisePosts(body) {
  const posts = Array.isArray(body?.posts) ? body.posts.map(normalisePost).filter(Boolean) : [];
  return {
    slug: str(body?.ticker),
    name: str(body?.name),
    generatedAt: str(body?.generatedAt),
    // Their own "12 of 40" pair: `total` is unfiltered, `filtered` is after the query.
    total: int(body?.counts?.total) ?? posts.length,
    filtered: int(body?.counts?.filtered) ?? posts.length,
    posts,
  };
}

// ---------------------------------------------------------------------------------------
// Slug -> NSE symbol
//
// THE API HAS NO EXCHANGE SYMBOL, AND ABOUT A THIRD OF ITS ENTRIES ARE NOT COMPANIES AT ALL —
// brokers (`guggenheim`, `td-cowen`), themes (`nuclear-energy`, `defence`) and bare words
// (`value`, `growth`, `income`), because entries are discovered bottom-up from forum topics.
//
// The rule here is deliberately NOT a hand-kept list of brokers and themes to exclude. Such a
// list is unfalsifiable, silently rots, and makes "is this a company?" a matter of what someone
// remembered to type. Instead: **an entry is a company when its slug resolves to a symbol we
// already cover** — `universe.json` or the book. Everything else is not rejected, it is
// `unresolved`, carries the reason, and is shown in its own section.
//
// That is the same shape as `coverage.js`: a line with no ticker is still a real line, it just
// cannot join a feed keyed by ticker. Here it also means the Portfolio scope works, because
// scope filtering needs an NSE symbol and now has one wherever one exists.
// ---------------------------------------------------------------------------------------

/** Lowercase, strip anything that is not a letter or digit. `3b-blackbio-dx` -> `3bblackbiodx`. */
export const squash = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * LEGAL-FORM SUFFIXES ONLY. These carry no identity, so "Tata Motors Ltd" and "Tata Motors" must
 * squash the same or a real company misses its own symbol.
 *
 * `industries`, `enterprises` and `india` were in here and had to come out: they are DESCRIPTIVE,
 * not structural, and stripping them collapses "Value Industries" to `value` — which then matches
 * the bare forum topic *value* and files a stranger's posts under VALUEIND. That is the exact
 * false positive this resolver exists to avoid, and it was caught by the trap-word check rather
 * than by reading the list. Removing them costs nothing: the slugs that need those words carry
 * them anyway (`rain-industries` → `rainindustries` still matches "Rain Industries").
 *
 * The test to apply before adding a word here: would a forum topic ever be JUST this word? If so,
 * it is not noise.
 */
const NOISE = /\b(ltd|limited|pvt|private|the|and|co|corp|corporation|inc|plc|company|industries|inds|enterprises)\b/g;

// What is left after stripping has to stay long enough to still identify a company. Below this,
// the strip has eaten the name rather than its packaging.
const MIN_STRIPPED = 8;

/**
 * The canonical form a name is matched on.
 *
 * `industries` / `inds` are back in NOISE because Moneycontrol truncates to ~15 characters, so the
 * index holds "Walchandnagar Inds" while the forum slug is `walchandnagar-industries` — without
 * stripping, every such pair misses, which is a systematic gap rather than a couple of rows.
 *
 * The guard is what makes that safe. Stripping is used ONLY if ≥8 characters survive:
 *
 *   Walchandnagar Industries -> walchandnagar   (13) ✓ stripped, and "Walchandnagar Inds" agrees
 *   Value Industries         -> value            (5) ✗ too short, so `valueindustries` is kept —
 *                                                    and the bare forum topic `value` no longer
 *                                                    matches it, which is the false positive the
 *                                                    trap-word check caught
 *   Rain Industries          -> rain             (4) ✗ kept whole, and `rain-industries` is too,
 *                                                    so the pair still matches
 *
 * Both sides of every comparison run through this same function, so the slug and the index name
 * can never disagree about which form to use.
 */
const squashName = (s) => {
  const clean = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');
  const stripped = squash(clean.replace(NOISE, ' '));
  return stripped.length >= MIN_STRIPPED ? stripped : squash(clean);
};

/**
 * Build the lookup the resolver reads.
 *
 * `sources` is a list of `{ ticker, name }` — pass `universe.json` and the book together. Order
 * matters only for the name a collision keeps; the symbol is the same either way.
 */
export function buildResolverIndex(sources = []) {
  const bySymbol = new Map();
  const byName = new Map();
  for (const row of sources) {
    const t = str(row?.ticker);
    if (!t) continue;
    const symbol = t.toUpperCase();
    const sq = squash(symbol);
    if (sq && !bySymbol.has(sq)) bySymbol.set(sq, { ticker: symbol, name: str(row?.name) || symbol });
    const n = squashName(row?.name);
    // Two-character squashed names match far too much; require some length before trusting one.
    if (n.length >= 4 && !byName.has(n)) byName.set(n, { ticker: symbol, name: str(row?.name) || symbol });
  }
  return { bySymbol, byName, size: bySymbol.size };
}

/**
 * Resolve one entry to an NSE symbol.
 *
 * Returns `{ ticker, matchedBy, matchedName }` on a hit, or `{ ticker: null, reason }`.
 *
 * EXACT MATCHES ONLY, ON PURPOSE. An earlier draft did prefix matching, the way the book resolver
 * does, and it is wrong here: the book is 142 lines checked by hand against a statement, while
 * this is an open-ended stream of forum topic names where `value`, `growth` and `defence` are
 * real entries. Prefix-matching those against a 535-name universe produces confident nonsense —
 * and a wrong symbol here does not fail loudly, it silently files someone else's forum posts
 * under a company you hold. An unresolved entry costs a row in the second section; a mis-resolved
 * one corrupts the first.
 */
export function resolveEntry(entry, index) {
  const slug = str(entry?.slug) || str(entry?.ticker);
  if (!slug || !index) return { ticker: null, reason: 'no slug to resolve' };

  const bySlug = index.bySymbol.get(squash(slug));
  if (bySlug) return { ticker: bySlug.ticker, matchedBy: 'slug=symbol', matchedName: bySlug.name };

  const byNameFromSlug = index.byName.get(squashName(slug.replace(/-/g, ' ')));
  if (byNameFromSlug) return { ticker: byNameFromSlug.ticker, matchedBy: 'slug=name', matchedName: byNameFromSlug.name };

  const byName = index.byName.get(squashName(entry?.name));
  if (byName) return { ticker: byName.ticker, matchedBy: 'name=name', matchedName: byName.name };

  const bySymbolName = index.bySymbol.get(squash(entry?.name));
  if (bySymbolName) return { ticker: bySymbolName.ticker, matchedBy: 'name=symbol', matchedName: bySymbolName.name };

  return { ticker: null, reason: 'no NSE symbol — a forum topic we do not cover as a company' };
}

/** Resolve a whole list in one pass. Mutates nothing; returns new objects. */
export function resolveAll(entries, index) {
  return entries.map((e) => {
    const r = resolveEntry(e, index);
    return { ...e, ticker: r.ticker, matchedBy: r.matchedBy || null, matchedName: r.matchedName || null, unresolvedReason: r.reason || null };
  });
}

/**
 * Order-independent change signal over identity and the counts.
 *
 * Order-independent for the same reason the results feed's is: the payload arrives in their rank
 * order while the cache may be held in ours, and an order-sensitive hash would report "changed"
 * on every tick. Sums per-entry hashes so row order cannot affect the result.
 */
export function fingerprint(entries = []) {
  let total = 0;
  for (const e of entries) {
    const tok = `${e.slug}|${e.mentions}|${e.sentiment?.bullish ?? ''}|${e.sentiment?.bearish ?? ''}|${e.sentiment?.neutral ?? ''}`;
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
    total = (total + h) | 0;
  }
  return `${entries.length}:${total}`;
}
