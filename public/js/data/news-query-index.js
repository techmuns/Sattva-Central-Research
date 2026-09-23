// Shared by capture publication and the browser; changing this shape requires a new version.
import { newsPublicationDay, newsDay } from './news-window.js';
import { canonicalArticleUrl, articleStoryKey } from './filings-shared.js';
export const NEWS_QUERY_INDEX_VERSION = 4;
// A compact candidate fingerprint, NEVER a record/deduplication identity. A collision can only
// fetch extra companions: final canonicalization still compares the complete original URLs.
// This keeps the index much smaller than repeating long publisher URLs beside every version.
function fingerprint(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
export function newsQueryIdentities(row) {
  const story = articleStoryKey(row);
  // A republished copy shares neither address nor TradingView id with its original, only the
  // headline `dedupeArticles` folds it on. Past midnight IST the copy lands on the next day, so
  // without this a one-day read kept a copy the full history drops (Mint's Pine Labs story of
  // 21 September 2026, republished by TradingView at 00:06 IST on the 22nd).
  return [row?.url ? `url:${canonicalArticleUrl(row.url)}` : '',
    row?.tradingViewId ? `tv:${row.tradingViewId}` : '',
    story ? `story:${story}` : ''].filter(Boolean).map(fingerprint);
}
export const newsQueryIdentity = row => newsQueryIdentities(row)[0] || '';
export function newsQueryIndexRow(row) {
  const day = newsPublicationDay(row), instantDay = row?.publishedAt ? newsDay(row.publishedAt) : null;
  return [day, instantDay === day ? null : instantDay, newsQueryIdentities(row)];
}
export const validNewsQueryIndex = (rows, count) => Array.isArray(rows) && rows.length === count && rows.every(row =>
  Array.isArray(row) && row.length === 3 && row.slice(0, 2).every(day => day === null || /^\d{4}-\d{2}-\d{2}$/.test(day)) && Array.isArray(row[2]) && row[2].length <= 3 && row[2].every(id => typeof id === 'string'));
