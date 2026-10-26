import {exactNewsletterSourceUrl} from './newsletter-source-links.mjs';

export const sourceId = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value || '');
export const SOURCE_LINK_FORMAT = 'newsletter-source-v1';
export const SOURCE_LOOKUP_BATCH_SIZE = 5;
export const SOURCE_INDEX_FORMAT = 'newsletter-source-index-v1';
export const SOURCE_HEAD_BYTES = 16 * 1024;
export const SOURCE_PAGE_BYTES = 12 * 1024;
export const SOURCE_RECORD_BYTES = 32 * 1024;
export const SOURCE_DIRECTORY_BYTES = 128 * 1024;
export function sourceTarget(record) {
  return record?.format === SOURCE_LINK_FORMAT && typeof record.url === 'string' &&
    exactNewsletterSourceUrl(record.url) === record.url ? record.url : null;
}
export function emailSourceUrl(original, links, origin) {
  const alias = links?.get(original);
  if (!alias) return original;
  try {
    const url = new URL(alias);
    if (url.origin === new URL(origin).origin && !url.username && !url.password && !url.search && !url.hash &&
        url.pathname.startsWith('/api/newsletter/s/') && sourceId(url.pathname.slice('/api/newsletter/s/'.length))) return url.href;
  } catch { /* A bad presentation mapping cannot replace the captured source. */ }
  return original;
}
export function emailSourceIds(html, origin) {
  const ids = new Set();
  for (const match of String(html).matchAll(/href="([^"]+)"/g)) {
    const raw = match[1].replace(/&amp;/g,'&');
    const url = new URL(raw,origin);
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/api/newsletter/s/')) continue;
    const id = url.pathname.slice('/api/newsletter/s/'.length);
    if (!sourceId(id) || url.search || url.hash) throw Error('Invalid email source shortcut');
    ids.add(id);
  }
  return [...ids];
}
