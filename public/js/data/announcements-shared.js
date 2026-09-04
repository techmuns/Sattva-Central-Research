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

export function announcementUrl(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

export const announcementSources = (row) => [...new Set((row.sources || [row.source]).filter(Boolean))];
const groupName = (value) => /^(BSE|NSE|DRHP)(?:$|[\s_-])/i.exec(String(value || ''))?.[1]?.toUpperCase() || String(value || '').trim() || null;
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

function documentIdentity(value) {
  const url = announcementUrl(value);
  if (!url) return null;
  const u = new URL(url);
  // BSE moves the same attachment from AttachLive to AttachHis and also serves it via Pname.
  if (/(^|\.)bseindia\.com$/i.test(u.hostname)) {
    const pdf = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf/i);
    if (pdf) return `bse:${pdf[0].toLowerCase()}`;
  }
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname}${u.search}`;
}

/** Append new disclosures; only proven same-document/date/company overlap collapses. */
export function mergeAnnouncements(...lists) {
  const out = [], seen = new Map();
  for (const list of lists) {
    const occurrences = new Map();
    for (const row of list || []) {
      if (!row || typeof row !== 'object') continue;
      const sources = announcementSources(row);
      const document = documentIdentity(row.url);
      const identity = document || (row.newsId ? `${sources.join(',')}:${row.newsId}` : null);
      const exact = JSON.stringify([row.ticker, row.date, row.time, row.title, row.summary, row.category, row.subCategory, sources]);
      const occurrence = (occurrences.get(exact) || 0) + 1;
      occurrences.set(exact, occurrence);
      const key = identity ? `${row.ticker || ''}|${row.date || ''}|${identity}` : `${exact}|${occurrence}`;
      const previous = key && seen.get(key);
      if (previous) {
        previous.sources = [...new Set([...announcementSources(previous), ...sources])];
        previous.providers = [...new Set([...(previous.providers || []), ...(row.providers || [])])];
        for (const [field, value] of Object.entries(row)) if (previous[field] == null && value != null) previous[field] = value;
      } else {
        const next = { ...row, sources, providers: [...(row.providers || [])] };
        out.push(next);
        if (key) seen.set(key, next);
      }
    }
  }
  return out.sort((a, b) => `${b.date || ''} ${b.time || ''}`.localeCompare(`${a.date || ''} ${a.time || ''}`));
}
