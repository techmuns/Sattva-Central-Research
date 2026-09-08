import { normaliseAnnouncement, pickField } from './filings-shared.js';

export function announcementRange(fromDate, toDate) {
  const day = (value) => {
    const compact = String(value || '').replaceAll('-', '');
    if (!/^\d{8}$/.test(compact)) throw new Error('Choose valid start and end dates.');
    const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) throw new Error('Choose valid start and end dates.');
    return { compact, iso };
  };
  const from = day(fromDate), to = day(toDate);
  if (from.iso > to.iso) throw new Error('The start date must be on or before the end date.');
  return { from: from.iso, to: to.iso, fromDate: from.compact, toDate: to.compact };
}

// A merge checks the same link for provenance and document identity several times.
// Cache only bounded string inputs; this is derived metadata, never retained source history.
const urlInfoCache = new Map();
const urlInfoKeys = new Array(16_384);
let nextUrlInfoKey = 0;
function announcementUrlInfo(value) {
  if (value == null || value === '') return null;
  const cacheable = typeof value === 'string' && value.length <= 256;
  if (cacheable && urlInfoCache.has(value)) return urlInfoCache.get(value);
  let info = null;
  try {
    const u = new URL(value);
    if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) {
      const pdf = /(^|\.)bseindia\.com$/i.test(u.hostname)
        && u.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf/i);
      info = { url: u.href, document: pdf ? `bse:${pdf[0].toLowerCase()}`
        : `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname}${u.search}` };
    }
  } catch { /* Invalid links have no source or document identity. */ }
  if (cacheable && (!info || info.url.length <= 256 && info.document.length <= 256)) {
    // Direct FIFO eviction avoids repeatedly scanning Map iterator tombstones on long histories.
    urlInfoCache.delete(urlInfoKeys[nextUrlInfoKey]);
    urlInfoKeys[nextUrlInfoKey] = value;
    nextUrlInfoKey = (nextUrlInfoKey + 1) % urlInfoKeys.length;
    urlInfoCache.set(value, info);
  }
  return info;
}
export function announcementUrl(value) {
  return announcementUrlInfo(value)?.url || null;
}

const SOURCE_ORDER = new Map(['BSE', 'NSE', 'DRHP'].map((source, index) => [source, index]));
const groupName = (value) => /^(BSE|NSE|DRHP)(?:$|[\s_-])/i.exec(String(value || ''))?.[1]?.toUpperCase() || String(value || '').trim() || null;
export const announcementSources = (row) => [...new Set((row.sources || [row.source]).filter(Boolean))]
  .sort((a, b) => (SOURCE_ORDER.get(a) ?? 99) - (SOURCE_ORDER.get(b) ?? 99) || String(a).localeCompare(String(b)));

function sourceUrlsFor(row, sources) {
  const links = [];
  for (const item of Array.isArray(row?.sourceUrls) ? row.sourceUrls : []) {
    const url = announcementUrl(item?.url);
    const source = groupName(item?.source);
    if (url && source) links.push({ source, url });
  }
  const url = announcementUrl(row?.url);
  if (url && sources.length === 1) links.push({ source: sources[0], url });
  return [...new Map(links.map((item) => [`${item.source}|${item.url}`, item])).values()]
    .sort((a, b) => (SOURCE_ORDER.get(a.source) ?? 99) - (SOURCE_ORDER.get(b.source) ?? 99) || a.url.localeCompare(b.url));
}
export function announcementSourceUrls(row) {
  return sourceUrlsFor(row, announcementSources(row));
}
const wrappers = new Set(['data', 'results', 'items', 'records', 'announcements', 'rows']);

/** Keep exchange grouping and the requested NSE identity, including BSE numeric-symbol records. */
export function normaliseCorporateAnnouncements(body, ticker) {
  const announcements = [], groups = new Set();
  let recognized = false, skipped = 0;
  function walk(value, source = null, depth = 0) {
    if (depth > 12) { skipped++; return; }
    if (Array.isArray(value)) {
      recognized = true;
      for (const row of value) walk(row, source, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') { skipped++; return; }
    source = groupName(value.source || value.exchange || source);
    if (source) groups.add(source);
    if (value.error || value.ok === false || value.success === false) { skipped++; return; }
    let nested = false;
    for (const [key, item] of Object.entries(value)) {
      if (wrappers.has(key.toLowerCase()) || /^(bse|nse|drhp)$/i.test(key)) {
        nested = true;
        walk(item, /^(bse|nse|drhp)$/i.test(key) ? groupName(key) : source, depth + 1);
      }
    }
    if (nested) return;
    const row = normaliseAnnouncement({ ...value, source }, ticker);
    if (!row.title && !row.url && !row.summary) { skipped++; return; }
    recognized = true;
    const dateValue = pickField(value, ['date', 'announcementDate', 'submissionDate', 'newsDate', 'exchdisstime', 'timestamp']);
    const rawSymbol = String(pickField(value, ['scripCode', 'symbol']) || '');
    announcements.push({
      ...row, ticker, source, sources: source ? [source] : [],
      url: announcementUrl(row.url),
      time: /[T\s](\d{2}:\d{2}(?::\d{2})?)/.exec(String(dateValue || ''))?.[1] || null,
      company: pickField(value, ['company', 'companyName', 'securityName']) || null,
      scripCode: /^\d{6}$/.test(rawSymbol) ? rawSymbol : null,
      subCategory: pickField(value, ['subCategory']) || null,
      newsId: pickField(value, ['newsId', 'announcementId']) || null,
      providers: ['Muns corporate announcements'],
    });
  }
  walk(body);
  if (!recognized || (skipped && !announcements.length)) throw new Error('The announcements service returned an unfamiliar or failed response; no empty result has been assumed.');
  return { announcements, groups: [...groups], skipped };
}

export function announcementDocumentIdentity(value) {
  // BSE moves the same attachment from AttachLive to AttachHis and also serves it via Pname.
  return announcementUrlInfo(value)?.document || null;
}

const digestIdentity = (value) => /^sha256:[0-9a-f]{64}$/i.test(String(value || ''))
  ? String(value).toLowerCase() : null;

function identityKeys(row, sources = announcementSources(row), sourceUrls = sourceUrlsFor(row, sources)) {
  const prefix = `${row.ticker || ''}|${row.date || ''}|`;
  const keys = [];
  // A content digest alone is not an event identity: two legitimate same-day filings can reuse
  // identical PDF bytes. The collector assigns this pair-specific ID only after a one-to-one
  // BSE/NSE comparison, so it is safe to use as the shared cross-exchange key.
  const crossExchangeDocumentId = digestIdentity(row.crossExchangeDocumentId);
  if (crossExchangeDocumentId) keys.push(`${prefix}cross-exchange:${crossExchangeDocumentId}`);
  for (const value of [row.url, ...sourceUrls.map((item) => item.url)]) {
    const document = announcementDocumentIdentity(value);
    if (document) keys.push(`${prefix}document:${document}`);
  }
  if (row.newsId) keys.push(`${prefix}news:${sources.join(',')}:${row.newsId}`);
  return [...new Set(keys)];
}

function mergeAnnouncement(previous, row, sources, sourceUrls) {
  // Capture a legacy row's primary link before adding another source. Older persisted rows do
  // not have sourceUrls yet, and announcementSourceUrls intentionally cannot assign one URL to
  // multiple exchanges once the source list has been widened.
  const previousSourceUrls = sourceUrlsFor(previous, previous.sources);
  previous.sources = [...new Set([...previous.sources, ...sources])]
    .sort((a, b) => (SOURCE_ORDER.get(a) ?? 99) - (SOURCE_ORDER.get(b) ?? 99) || String(a).localeCompare(String(b)));
  previous.source = previous.sources.join(' / ');
  previous.providers = [...new Set([...(previous.providers || []), ...(row.providers || [])])];
  previous.sourceUrls = [...new Map([...previousSourceUrls, ...sourceUrls]
    .map((item) => [`${item.source}|${item.url}`, item])).values()]
    .sort((a, b) => (SOURCE_ORDER.get(a.source) ?? 99) - (SOURCE_ORDER.get(b.source) ?? 99) || a.url.localeCompare(b.url));
  for (const [field, value] of Object.entries(row)) if (previous[field] == null && value != null) previous[field] = value;
  return previous;
}

/** Append new disclosures; only proven same-document/date/company overlap collapses. */
export function mergeAnnouncements(...lists) {
  const out = [], seen = new Map();
  for (const list of lists) {
    const occurrences = new Map();
    for (const row of list || []) {
      if (!row || typeof row !== 'object') continue;
      const sources = announcementSources(row);
      const sourceUrls = sourceUrlsFor(row, sources);
      const exact = JSON.stringify([row.ticker, row.date, row.time, row.title, row.summary, row.category, row.subCategory, sources]);
      const occurrence = (occurrences.get(exact) || 0) + 1;
      occurrences.set(exact, occurrence);
      const keys = identityKeys(row, sources, sourceUrls);
      const fallback = `${exact}|${occurrence}`;
      const previous = keys.map((key) => seen.get(key)).find(Boolean) || (!keys.length ? seen.get(fallback) : null);
      if (previous) {
        mergeAnnouncement(previous, row, sources, sourceUrls);
        for (const key of [...identityKeys(previous, previous.sources, previous.sourceUrls), ...keys]) seen.set(key, previous);
      } else {
        const next = { ...row, sources, providers: [...(row.providers || [])], ...(sourceUrls.length ? { sourceUrls } : {}) };
        out.push(next);
        for (const key of keys.length ? keys : [fallback]) seen.set(key, next);
      }
    }
  }
  return out.sort((a, b) => `${b.date || ''} ${b.time || ''}`.localeCompare(`${a.date || ''} ${a.time || ''}`));
}
