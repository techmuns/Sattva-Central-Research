// Public posts are discussion evidence, never verified company disclosures.
import { normalizeNewsText } from '../data/company-news-attribution.js';
import { reviewedNewsIdentity } from '../data/company-news-reviewed.js';

export const CHATTER_TOPIC_LIMIT = 6;
export const SOCIAL_READ_TIMEOUT_MS = 1500;
const common = new Set('india indian global international industries industry company corporation holdings finance financial capital energy steel power technologies services idea sail gail page rain star pearl zen cera fine just next one man can vip max rise jet clean prime focus united sun gem food life nest key fit safe sharp polo home force time best more team gold silver pilot quick ready total happy'.split(' '));
const nameKey = value => normalizeNewsText(value).replace(/(?:\s+(?:limited|ltd|private|pvt|plc))+$/, '');
const phrase = (text, key) => ` ${text} `.includes(` ${key} `);
// Display names from the company universe abbreviate these suffixes. Expand only a known
// complete word, retaining the distinctive rest of the issuer name. This is not prefix matching:
// "Hexaware Tech." can match "Hexaware Technologies", never "Hexaware Techno Holdings".
const abbreviatedSuffixes = new Map([
  ['tech', ['technologies', 'technology']],
  ['technol', ['technologies', 'technology']],
  ['technolog', ['technologies', 'technology']],
  ['inds', ['industries']],
]);
function expandedNameKeys(key) {
  const words = key.split(' ');
  const suffixes = abbreviatedSuffixes.get(words.at(-1));
  const prefix = words.slice(0, -1);
  if (!suffixes || !prefix.some(word => word.length >= 3 && !common.has(word))) return [];
  return suffixes.map(suffix => [...prefix, suffix].join(' '));
}

// Full reviewed names/aliases or qualified symbols only. A distinctive first word is useful for
// understanding a question, but cannot establish the identity of an unsolicited channel post.
export function telegramCompanyRows(posts, identities, identityUniverse = identities) {
  const makeEntry = raw => {
    const identity = reviewedNewsIdentity(raw);
    const names = [...new Set([identity.name, identity.legalName,
      ...(identity.aliases || []), ...(identity.formerNames || []), ...(identity.brands || [])]
      .map(nameKey).filter(key => key.length >= 4 && !common.has(key)))];
    return { ...identity, identityKey: identity.ticker ? `ticker:${String(identity.ticker).toUpperCase()}` : identity.isin ? `isin:${identity.isin}` : `name:${nameKey(identity.name)}`,
      names, expandedNames: [...new Set(names.flatMap(expandedNameKeys))],
      symbol: normalizeNewsText(identity.ticker) };
  };
  const entries = identities.map(makeEntry);
  const universe = identityUniverse === identities ? entries : identityUniverse.map(makeEntry);
  const nameOwners = new Map();
  for (const entry of [...entries, ...universe]) for (const key of [...entry.names, ...entry.expandedNames]) {
    if (!nameOwners.has(key)) nameOwners.set(key, new Set());
    nameOwners.get(key).add(entry.identityKey);
  }
  for (const entry of new Set([...entries, ...universe])) entry.names = [...new Set([...entry.names,
    ...entry.expandedNames.filter(key => nameOwners.get(key).size === 1)])];
  // Resolve ambiguity against the whole known estate, even when the question requests only the
  // parent company. Keep just potentially competing longer names in the per-post matcher; asking
  // about one company should not scan thousands of unrelated identities for every archived post.
  const requested = new Set(entries.map(entry => entry.identityKey));
  const requestedKeys = [...new Set(entries.flatMap(entry => [...entry.names, entry.symbol].filter(Boolean)))];
  const competitors = universe.filter(entry => !requested.has(entry.identityKey) &&
    entry.names.some(name => requestedKeys.some(key => name.length > key.length && phrase(name, key))));
  const matchingEntries = [...entries, ...competitors];
  const rows = [];
  for (const post of posts) {
    const original = [post.text, ...(post.attachments || []).map(a => a.name)].filter(Boolean).join('\n');
    if (!original) continue;
    const text = normalizeNewsText(original);
    const capitals = new Set(original.match(/\b[A-Z][A-Z0-9&.-]+\b/g) || []);
    const matches = matchingEntries.flatMap(entry => entry.names.filter(key => phrase(text, key)).map(key => ({ entry, key })));
    for (const entry of entries) {
      const name = matches.find(match => match.entry === entry && !matches.some(other => other.entry !== entry &&
        other.key.length > match.key.length && phrase(other.key, match.key) && !phrase(text.replaceAll(other.key, ''), match.key)));
      const qualified = entry.symbol && (phrase(text, `nse ${entry.symbol}`) || phrase(text, `bse ${entry.symbol}`));
      const symbol = entry.symbol && entry.symbol.length >= 4 && !common.has(entry.symbol) && capitals.has(entry.ticker) && phrase(text, entry.symbol);
      // A short parent name inside a longer company name is not an independent symbol mention.
      const independentSymbol = symbol && !matches.some(match => match.entry !== entry && phrase(match.key, entry.symbol) && !phrase(text.replaceAll(match.key, ''), entry.symbol));
      if (!name && !qualified && !independentSymbol) continue;
      rows.push({ ...post, ticker: entry.ticker || null, isin: entry.isin || null, company: entry.name,
        mentionMatch: name?.key || entry.ticker, identityBasis: name ? 'explicit company name in captured text or filename' : 'explicit company symbol in captured text or filename' });
    }
  }
  return rows;
}

/** Keep the portion that actually mentions the issuer, including matches late in a long post. */
export function postExcerpt(text, terms = [], max = 700) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return { text: value, textTruncated: false };
  const lower = value.toLowerCase();
  const needles = [...new Set(terms.filter(Boolean).map(term => String(term).toLowerCase()))];
  const hits = needles.flatMap((needle, termIndex) => {
    const found = [];
    let index = lower.indexOf(needle);
    // Bounded even for a very long repetitive post. Multiple occurrences allow the excerpt to
    // prefer a later company-and-event passage over a company mention in an opening paragraph.
    while (index >= 0 && found.length < 128) {
      found.push({ index, end: index + needle.length, termIndex });
      index = lower.indexOf(needle, index + Math.max(1, needle.length));
    }
    return found;
  });
  const candidates = hits.map(hit => {
    const start = Math.max(0, Math.min(value.length - max, hit.index - 140));
    const present = new Set(hits.filter(other => other.index >= start && other.end <= start + max).map(other => other.termIndex));
    return { start, hit, score: [...present].reduce((sum, termIndex) => sum + (termIndex ? 3 : 2), 0) };
  }).sort((a, b) => b.score - a.score || a.start - b.start);
  const best = candidates[0];
  let start = best?.start || 0;
  const company = hits.find(hit => hit.termIndex === 0);
  const fragment = (from, to) => `${from ? '…' : ''}${value.slice(from, to)}${to < value.length ? '…' : ''}`;
  // A long single-company report can name its issuer at the start and discuss the requested
  // event much later. Preserve both literal passages with explicit omissions, within one budget.
  if (company && best && !hits.some(hit => hit.termIndex === 0 && hit.index >= start && hit.end <= start + max)) {
    const identityLength = Math.min(180, Math.floor(max / 3));
    const identityStart = Math.max(0, company.index - 40);
    const identityEnd = Math.min(value.length, identityStart + identityLength);
    const remaining = Math.max(1, max - identityLength - 6);
    start = Math.max(0, Math.min(value.length - remaining, best.hit.index - Math.min(140, Math.floor(remaining / 3))));
    const ranges = [[identityStart, identityEnd], [start, Math.min(value.length, start + remaining)]].sort((a, b) => a[0] - b[0]);
    return { text: ranges.map(([from, to]) => fragment(from, to)).join(' '), textTruncated: true };
  }
  return { text: fragment(start, start + max), textTruncated: true };
}

export async function chatterPostEvidence(chatter, entries, plan) {
  const requested = entries.filter(entry => !plan.companies.length || plan.tickers.has(entry.ticker));
  // One topic for each requested issuer before taking a second topic for any issuer.
  const seen = new Map();
  const ranked = [...requested].sort((a, b) => (b.mentions || 0) - (a.mentions || 0)).map(entry => {
    const pass = seen.get(entry.ticker) || 0; seen.set(entry.ticker, pass + 1); return { entry, pass };
  }).sort((a, b) => a.pass - b.pass);
  const selected = ranked.slice(0, CHATTER_TOPIC_LIMIT).map(item => item.entry);
  const results = await Promise.allSettled(selected.map(async entry => {
    // A mentions popup may already own a request with a longer deadline. Research must not
    // inherit that wait; the shared reader may finish and cache it for a subsequent question.
    let timer;
    try {
      return await Promise.race([chatter.postsFor(entry.slug, { maxAgeMs: 60_000, timeoutMs: SOCIAL_READ_TIMEOUT_MS }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chatter posts are still updating.')), SOCIAL_READ_TIMEOUT_MS); })]);
    } finally { clearTimeout(timer); }
  }));
  const failures = results.filter(result => result.status === 'rejected').length;
  const groups = chatter.loadedPosts().filter(group => requested.some(entry => entry.slug === group.slug));
  const rows = groups.flatMap(group => {
    const entry = requested.find(item => item.slug === group.slug);
    return group.posts.map(post => ({ ...post, ticker: entry.ticker, company: entry.matchedName || entry.name,
      topic: group.slug, capturedAt: group.generatedAt, checkedAt: group.checkedAt,
      ...postExcerpt(post.text, [entry.name, entry.ticker, ...plan.tokens]) }));
  });
  return { rows, failures, asOf: groups.map(group => group.generatedAt).filter(Boolean).sort().at(-1) || null,
    coverage: { topicsInScope: entries.length, relevantTopics: requested.length, topicsRequested: selected.length,
      topicsRead: groups.length, failedTopics: failures, topicsNotRead: requested.length - groups.length,
      reportedPosts: groups.reduce((sum, group) => sum + group.total, 0), availablePosts: rows.length,
      partialTopics: groups.filter(group => group.posts.length < group.total).length } };
}
