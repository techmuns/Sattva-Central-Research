// scripts/lib/company-index.mjs — company name -> NSE symbol, from the feeds this repo already has.
//
//   buildIndex({ mc, tech, book })   an index over every name/ticker pair in those payloads
//   resolveTicker(index, name, …)    a symbol, or a stated reason there is none
//   tokenise(name)                   the shared normaliser, exported so a caller can explain a miss
//
// PURE AND OFFLINE, like scripts/lib/trendlyne.mjs: payloads in, results out, no fs and no fetch.
// That is what lets `node scripts/lib/company-index.mjs "Some Company Ltd"` explain a single
// resolution without running an import that writes a file.
//
// WHY THIS IS HARDER THAN IT LOOKS
//   An AMC writes "Prestige Estates Projects Limited". Moneycontrol truncate to about sixteen
//   characters and store "Prestige Estate". Screener writes "Prestige Estates". None of those match
//   as strings, so matching is done on TOKENS with each index token allowed to be a prefix of the
//   query token in the same position.
//
//   That rule alone is too generous in one direction: "Arvind" prefix-matches "Arvind Fashions
//   Limited", and those are two different listed companies. So an index name with FEWER tokens than
//   the query has to show evidence that it was truncated — a token cut mid-word, or a name long
//   enough to have hit the truncation limit. Everything that fails both is left unresolved for a
//   human to put in a CONFIRMED table, because a wrong symbol is far worse than a missing one: it
//   silently gives one company another's numbers.

// Words that carry no identity, dropped before a name is tokenised. `india` / `indian` are
// deliberately NOT here — they distinguish "General Insurance Corporation of India" from a dozen
// other insurers, and "Sirca Paints India" from "Sirca Paints".
const NOISE = new Set(['ltd', 'limited', 'pvt', 'private', 'the', 'and', 'co', 'corp', 'inc', 'plc']);

// Moneycontrol cut a name at about sixteen characters, so a name at least this long may be a
// truncation of something longer. Below it, the name is almost certainly complete.
//
// Twelve rather than sixteen because the tokeniser has already dropped "Ltd" and the spaces:
// "Power Finance" is what survives of "Power Finance Corporation Ltd" and squashes to twelve.
const TRUNCATION_LENGTH = 12;

/**
 * Is `short` an abbreviation of `long`, in the style these feeds actually use?
 *
 * Screener and Moneycontrol contract words by dropping interior letters rather than by truncating:
 * "Inds" for "Industries", "Pharma." for "Pharmaceuticals", "Engg" for "Engineering". A prefix test
 * rejects every one of those, which is what left Grasim and a dozen others unresolved.
 *
 * Kept deliberately tight, because this is the rule most able to produce a WRONG symbol: the
 * letters must appear in order, the first three must agree, and the abbreviation must be shorter by
 * at least two characters — so it is a contraction rather than a different word that happens to
 * start the same way. "Inds" abbreviates "Industries"; "Info" does not abbreviate "Infrastructure".
 */
function isAbbreviation(short, long) {
  if (short.length < 4 || long.length < short.length + 2) return false;
  if (short.slice(0, 3) !== long.slice(0, 3)) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i] && ++i === short.length) return true;
  return false;
}

/**
 * A name as comparable tokens.
 *
 * The "^^" and "**" an AMC uses to flag unlisted or awaiting-listing lines are punctuation here and
 * fall out with everything else non-alphanumeric.
 */
export function tokenise(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !NOISE.has(w));
}

/**
 * Build the index from already-parsed payloads.
 *
 * A name two feeds map to DIFFERENT symbols is dropped rather than resolved to whichever was read
 * last — the same collision guard resolve-portfolio-companies.mjs uses, and for the same reason:
 * "Allcargo Global" and "Allcargo Logistics" are different companies.
 */
export function buildIndex({ mc = null, tech = null, book = null, names = null } = {}) {
  const raw = [];
  const seen = new Map(); // squashed name -> ticker | 'AMBIGUOUS'

  const add = (name, ticker, from) => {
    const t = String(ticker || '').toUpperCase().trim();
    const tokens = tokenise(name);
    if (!t || !tokens.length) return;
    const key = tokens.join('');
    if (key.length < 3) return;
    const prior = seen.get(key);
    if (prior === undefined) seen.set(key, t);
    else if (prior !== t) seen.set(key, 'AMBIGUOUS');
    raw.push({ key, tokens, ticker: t, from });
  };

  for (const e of Object.values(mc?.map || {})) add(e?.fullName, e?.ticker, 'moneycontrol');
  for (const c of tech?.companies || []) add(c?.name, c?.ticker, 'technicals');
  for (const h of book?.holdings || []) if (h?.ticker) add(h?.matchedName || h?.name, h.ticker, 'the book');
  // Optional extra name/ticker pairs (e.g. an exchange directory's legal names for symbols the feeds
  // above already carry). The same collision guard applies: a name shared by two symbols is poisoned.
  for (const n of names || []) if (n?.ticker) add(n.name, n.ticker, n.from || 'directory');

  const entries = raw.filter((e) => seen.get(e.key) !== 'AMBIGUOUS');
  const byFirst = new Map();
  for (const e of entries) {
    if (!byFirst.has(e.tokens[0])) byFirst.set(e.tokens[0], []);
    byFirst.get(e.tokens[0]).push(e);
  }
  return { entries, byFirst, poisoned: [...seen].filter(([, v]) => v === 'AMBIGUOUS').map(([k]) => k) };
}

/**
 * How well one index name accounts for a query name. 0 means no match.
 *
 * See the header: every index token must prefix the query token in the same position, the index
 * must not be longer than the query, and a SHORTER index name needs truncation evidence. The score
 * is how much of the query it accounted for, so "ITC Hotels" beats "ITC" on "ITC Hotels Limited"
 * rather than whichever was found first.
 */
export function matchStrength(entry, queryTokens) {
  const t = entry.tokens;
  if (t.length > queryTokens.length) return 0;

  let cutMidWord = false;
  for (let i = 0; i < t.length; i++) {
    const q = queryTokens[i];
    if (!q.startsWith(t[i]) && !isAbbreviation(t[i], q)) return 0;
    if (t[i].length < q.length) cutMidWord = true;
  }
  if (t.length < queryTokens.length && !cutMidWord && entry.key.length < TRUNCATION_LENGTH) return 0;

  return t.reduce((a, w) => a + w.length, 0) + t.length;
}

/**
 * A symbol for one name, or a stated reason there is none.
 *
 * `confirmed` is the caller's hand-checked table, consulted first: it is the only way to resolve a
 * name the feeds know under an abbreviation ("SBI" for "State Bank of India").
 */
export function resolveTicker(index, name, { confirmed = {} } = {}) {
  const key = String(name || '').trim().toLowerCase();
  if (confirmed[key]) return { ticker: confirmed[key], resolvedBy: 'checked by hand', reason: null };

  const queryTokens = tokenise(name);
  if (!queryTokens.length) return { ticker: null, resolvedBy: null, reason: 'the line carries no usable name' };

  let best = 0;
  let winners = new Set();
  let from = null;
  for (const [t0, group] of index.byFirst) {
    if (!queryTokens[0].startsWith(t0)) continue;
    for (const e of group) {
      const s = matchStrength(e, queryTokens);
      if (!s || s < best) continue;
      if (s > best) {
        best = s;
        winners = new Set([e.ticker]);
        from = e.from;
      } else winners.add(e.ticker);
    }
  }

  if (!best) return { ticker: null, resolvedBy: null, reason: 'no NSE symbol for this name in the feeds this dashboard carries' };
  if (winners.size > 1) {
    return { ticker: null, resolvedBy: null, reason: `the name fits ${[...winners].sort().join(' and ')} equally well, so it was left unresolved rather than guessed` };
  }
  return { ticker: [...winners][0], resolvedBy: from, reason: null };
}

// ---------------------------------------------------------------------------------------
// `node scripts/lib/company-index.mjs "Grasim Industries Limited"` — explain one resolution.
// ---------------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=scripts)/, ''))) {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (f) => JSON.parse(readFileSync(resolve(here, '../../public/data', f), 'utf8'));

  const index = buildIndex({ mc: read('mc-ticker-map.json'), tech: read('technicals.json'), book: read('portfolio-companies.json') });
  for (const name of process.argv.slice(2)) {
    const tokens = tokenise(name);
    const out = resolveTicker(index, name);
    const near = index.entries
      .filter((e) => e.tokens[0] && tokens[0]?.startsWith(e.tokens[0].slice(0, 4)))
      .map((e) => `${e.tokens.join(' ')}=${e.ticker}(${matchStrength(e, tokens)})`)
      .slice(0, 8);
    console.log(`${name}\n  tokens: ${tokens.join(' | ')}\n  ->      ${JSON.stringify(out)}\n  near:   ${near.join(', ') || 'none'}\n`);
  }
}
