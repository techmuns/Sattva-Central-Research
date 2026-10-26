import { announcementDocumentIdentity } from '../public/js/data/announcements-shared.js';

const discovery = url => url.hostname === 'news.google.com' && /^\/(?:rss\/)?articles\//.test(url.pathname);

function sourceUrl(value) {
  try {
    const url = new URL(typeof value === 'object' ? value?.url : value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        (url.pathname === '/' && ![...url.searchParams.keys()].some(key => /^(?:p|id|article_id|storyid|newsid)$/i.test(key))) ||
        url.pathname.startsWith('/api/newsletter')) return null;
    return url;
  } catch { return null; }
}

// Validate a retained redirect without rediscovering or changing its destination.
export const exactNewsletterSourceUrl = value => sourceUrl(value)?.href || null;

// Older discovery links contain the literal publisher URL. Opaque modern links remain
// exact captured report links; never invent a publisher destination or fetch on render.
function publisherUrl(url) {
  if (!discovery(url)) return url;
  try {
    const token = url.pathname.split('/').at(-1).replace(/-/g, '+').replace(/_/g, '/');
    if (token.length > 4096) return url;
    const decoded = atob(token + '='.repeat((4 - token.length % 4) % 4));
    const candidates = [...new Set(decoded.match(/https?:\/\/[^\s\x00-\x20<>"\\\x7f-\xff]+/g) || [])]
      .map(sourceUrl).filter(value => value && !discovery(value));
    if (candidates.length === 1) return candidates[0];
  } catch { /* The captured discovery link remains available. */ }
  return url;
}

export function newsletterSourceUrls(item) {
  return [...new Set([item.content?.sourceUrl, item.url, ...(item.sourceUrls || [])]
    .map(sourceUrl).filter(Boolean).map(publisherUrl).map(url => url.href))];
}

export function newsletterSourceUrl(item) {
  const urls = newsletterSourceUrls(item);
  return urls.find(value => !discovery(new URL(value))) || urls[0] || null;
}

export function newsletterSourceIdentity(value) {
  const url = sourceUrl(value);
  if (!url) return null;
  const resolved = publisherUrl(url);
  resolved.hash = '';
  for (const key of [...resolved.searchParams.keys()]) {
    if (/^utm_|^(?:gclid|fbclid|mc_cid|mc_eid)$/i.test(key) || discovery(resolved) && key === 'oc') resolved.searchParams.delete(key);
  }
  if (discovery(resolved)) resolved.pathname = resolved.pathname.replace(/^\/rss\//, '/');
  resolved.searchParams.sort();
  return announcementDocumentIdentity(resolved.href);
}

export function changedDocumentVersion(a, b) {
  // Raw article HTML can change because of ads or page chrome. Existing news
  // fact/stage checks handle material changes; byte versions apply to filings.
  if (a.kind !== 'filing' || b.kind !== 'filing') return false;
  const x = a.content, y = b.content;
  if (x?.state !== 'ready' || y?.state !== 'ready' || !x.hash || !y.hash || x.hash === y.hash) return false;
  return !!newsletterSourceIdentity(a.url) && newsletterSourceIdentity(a.url) === newsletterSourceIdentity(b.url);
}

/** Compare captured source identity before generated wording. A changed read version
 * stays separate, and a shared publisher homepage never establishes an article copy. */
export function sameNewsletterSource(a, b) {
  if (a.ticker !== b.ticker || a.kind !== b.kind || !!a.related !== !!b.related || changedDocumentVersion(a, b)) return false;
  if (a.content?.state === 'ready' && b.content?.state === 'ready' && a.content.hash && a.content.hash === b.content.hash) return true;
  // A filing may reference an earlier/supporting document. Only its own document
  // identifies an unread filing copy; shared attachments cannot merge new orders.
  if (a.kind === 'filing') return !!newsletterSourceIdentity(a.url) && newsletterSourceIdentity(a.url) === newsletterSourceIdentity(b.url);
  const left = new Set(newsletterSourceUrls(a).map(newsletterSourceIdentity).filter(Boolean));
  return newsletterSourceUrls(b).some(url => left.has(newsletterSourceIdentity(url)));
}
