// Public posts are discussion evidence, never verified company disclosures.
import { normalizeNewsText } from '../data/company-news-attribution.js';
import { reviewedNewsIdentity } from '../data/company-news-reviewed.js';

export const CHATTER_TOPIC_LIMIT = 6;
export const SOCIAL_READ_TIMEOUT_MS = 1500;
const common = new Set('india indian global international industries industry company corporation holdings finance financial capital energy steel power technologies services idea sail gail page rain star pearl zen cera fine just next one man can vip max rise jet clean prime focus united sun gem food life nest key fit safe sharp polo home force time best more team gold silver pilot quick ready total happy'.split(' '));
const nameKey = value => normalizeNewsText(value).replace(/(?:\s+(?:limited|ltd|private|pvt|plc))+$/, '');
const phrase = (text, key) => ` ${text} `.includes(` ${key} `);

// Full reviewed names/aliases or qualified symbols only. A distinctive first word is useful for
// understanding a question, but cannot establish the identity of an unsolicited channel post.
export function telegramCompanyRows(posts, identities) {
  const entries = identities.map(raw => {
    const identity = reviewedNewsIdentity(raw);
    return { ...identity, names: [...new Set([identity.name, identity.legalName,
      ...(identity.aliases || []), ...(identity.formerNames || []), ...(identity.brands || [])]
      .map(nameKey).filter(key => key.length >= 4 && !common.has(key)))],
    symbol: normalizeNewsText(identity.ticker) };
  });
  const rows = [];
  for (const post of posts) {
    const original = [post.text, ...(post.attachments || []).map(a => a.name)].filter(Boolean).join('\n');
    if (!original) continue;
    const text = normalizeNewsText(original);
    const capitals = new Set(original.match(/\b[A-Z][A-Z0-9&.-]+\b/g) || []);
    const matches = entries.flatMap(entry => entry.names.filter(key => phrase(text, key)).map(key => ({ entry, key })));
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
  const hits = terms.filter(Boolean).map(term => lower.indexOf(String(term).toLowerCase())).filter(index => index >= 0);
  const start = hits.length ? Math.max(0, Math.min(...hits) - 140) : 0;
  return { text: `${start ? '…' : ''}${value.slice(start, start + max)}${start + max < value.length ? '…' : ''}`, textTruncated: true };
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
