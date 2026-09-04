// Screener's authenticated, market-wide concall document index.
//
// This module is deliberately pure. The GitHub collector, the Worker and the browser tests all
// use the same row identity, validation and merge rules, so an incremental capture cannot create
// a second copy of a document that the full crawl already retained.

export const SCREENER_CONCALL_ID = 'screener-concalls';
export const SCREENER_CONCALL_REPO = 'techmuns/Sattva-Central-Research';
export const SCREENER_CONCALL_WORKFLOW = 'screener-concalls-refresh.yml';
export const SCREENER_CONCALL_ARTIFACT = 'screener-concalls-v1.json.gz';
export const SCREENER_CONCALL_LIMIT = 16 * 1024 * 1024;
export const SCREENER_CONCALL_COMPRESSED_LIMIT = 3 * 1024 * 1024;
export const SCREENER_CONCALL_MAX_ROWS = 25000;
export const SCREENER_CONCALL_FRESH_MS = 30 * 60 * 1000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^[A-Z0-9&-]{1,30}$/;
const KINDS = new Set(['Transcript', 'Recording', 'Presentation', 'Other']);

export function safeDocumentUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://www.screener.in');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function safeHttpsUrl(value, { screener = false } = {}) {
  const safe = safeDocumentUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  if (url.protocol !== 'https:' || url.port) return null;
  if (screener && !['www.screener.in', 'screener.in'].includes(url.hostname)) return null;
  return url.href;
}

export function screenerConcallKey(row) {
  return row?.url || row?.summaryUrl || `${row?.companyKey || row?.name || ''}|${row?.publishedDate || ''}|${row?.kind || ''}`;
}

export function mergeScreenerConcallRows(...groups) {
  const byKey = new Map();
  for (const row of groups.flat()) {
    if (!row) continue;
    const key = screenerConcallKey(row);
    const old = byKey.get(key);
    if (!old || String(row.observedAt || '') >= String(old.observedAt || '')) byKey.set(key, { ...old, ...row, id: key });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      String(b.publishedDate || '').localeCompare(String(a.publishedDate || '')) ||
      String(a.name || '').localeCompare(String(b.name || '')) ||
      String(a.kind || '').localeCompare(String(b.kind || '')) ||
      String(a.id || '').localeCompare(String(b.id || '')),
  );
}

export function validateScreenerConcallRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > SCREENER_CONCALL_MAX_ROWS) throw Error('Invalid Screener concall rows');
  const ids = new Set();
  for (const row of rows) {
    const id = screenerConcallKey(row);
    if (
      !row ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 300 ||
      typeof row.companyKey !== 'string' ||
      !row.companyKey ||
      row.companyKey.length > 80 ||
      (row.ticker !== null && row.ticker !== undefined && (typeof row.ticker !== 'string' || !TICKER.test(row.ticker))) ||
      !DAY.test(row.publishedDate || '') ||
      !KINDS.has(row.kind) ||
      !safeHttpsUrl(row.companyUrl, { screener: true }) ||
      !safeDocumentUrl(row.url) ||
      (row.summaryUrl && !safeHttpsUrl(row.summaryUrl, { screener: true })) ||
      !Number.isFinite(Date.parse(row.observedAt)) ||
      ids.has(id)
    ) {
      throw Error('Invalid Screener concall record');
    }
    const company = new URL(row.companyUrl);
    const summary = row.summaryUrl ? new URL(row.summaryUrl) : null;
    if (!/^\/company\/[^/]+\/(?:consolidated\/)?$/.test(company.pathname) || (summary && !/^\/concalls\/summary\/\d+\/$/.test(summary.pathname))) {
      throw Error('Invalid Screener concall route');
    }
    ids.add(id);
  }
  return rows;
}

export function validateScreenerConcallCapture(capture, now = Date.now()) {
  const checkedAt = Date.parse(capture?.checkedAt);
  if (
    capture?.version !== 1 ||
    capture.sourceId !== SCREENER_CONCALL_ID ||
    !Number.isFinite(checkedAt) ||
    checkedAt > now + 60000 ||
    !Number.isSafeInteger(capture.publishedTotal) ||
    capture.publishedTotal < 1 ||
    typeof capture.fullHistory !== 'boolean' ||
    !Number.isSafeInteger(capture.pagesFetched) ||
    capture.pagesFetched < 1 ||
    !Number.isSafeInteger(capture.duplicatesRemoved) ||
    capture.duplicatesRemoved < 0
  ) {
    throw Error('Invalid Screener concall capture');
  }
  validateScreenerConcallRows(capture.rows);
  if (capture.fullHistory && capture.rows.length + capture.duplicatesRemoved < capture.publishedTotal) throw Error('Incomplete Screener concall history');
  if (mergeScreenerConcallRows(capture.rows).length !== capture.rows.length) throw Error('Duplicate Screener concall history');
  return capture;
}

export function mergeScreenerConcallCapture(current, previous = null, now = Date.now()) {
  validateScreenerConcallCapture(current, now);
  if (!previous) return current;
  validateScreenerConcallCapture(previous, now);

  // A full crawl is authoritative for the current catalogue. An incremental crawl adds new rows
  // over the last complete history; it never replaces that history with its one-page head.
  if (current.fullHistory) return current;
  if (!previous.fullHistory) throw Error('Incremental Screener crawl has no complete baseline');
  if (current.publishedTotal < previous.publishedTotal) throw Error('Screener count shrank; a full crawl is required');
  const rows = mergeScreenerConcallRows(previous.rows, current.rows);
  return validateScreenerConcallCapture(
    {
      ...current,
      fullHistory: true,
      // `publishedTotal` counts source entries, while `rows` intentionally collapses repeated
      // document URLs. Carry that full-history difference forward; the head crawl's local
      // duplicate count cannot describe duplicates that live only in the retained tail.
      duplicatesRemoved: Math.max(0, current.publishedTotal - rows.length),
      rows,
    },
    now,
  );
}

const callIdentity = (row) => String(row.ticker || `screener:${row.companyKey || row.name}`).toUpperCase();
const daysApart = (a, b) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000;

function documentOf(row) {
  const documents = [{ type: row.kind, url: row.url }];
  if (row.summaryUrl) documents.push({ type: 'Summary', url: row.summaryUrl });
  return documents;
}

function mergeDocuments(...groups) {
  const seen = new Set();
  const out = [];
  for (const document of groups.flat()) {
    if (!document?.url || seen.has(document.url)) continue;
    seen.add(document.url);
    out.push(document);
  }
  return out.sort((a, b) => ['Transcript', 'Recording', 'Presentation', 'Summary', 'Other'].indexOf(a.type) - ['Transcript', 'Recording', 'Presentation', 'Summary', 'Other'].indexOf(b.type));
}

/** One visible row per company/publication date, with every distinct document preserved. */
export function groupScreenerConcalls(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${callIdentity(row)}|${row.publishedDate}`;
    const old = groups.get(key);
    if (!old) {
      groups.set(key, {
        key,
        companyKey: row.companyKey,
        ticker: row.ticker || null,
        name: row.name,
        companyUrl: row.companyUrl,
        publishedDate: row.publishedDate,
        observedAt: row.observedAt,
        documents: documentOf(row),
      });
      continue;
    }
    old.documents = mergeDocuments(old.documents, documentOf(row));
    if (!old.ticker && row.ticker) old.ticker = row.ticker;
    if (row.observedAt > old.observedAt) old.observedAt = row.observedAt;
  }
  return [...groups.values()].sort((a, b) => b.publishedDate.localeCompare(a.publishedDate) || a.name.localeCompare(b.name));
}

/**
 * Attach Screener documents to the nearest matching StockScans call, then append the historical
 * calls StockScans' current-quarter window does not carry. A Screener group is consumed once, so
 * the enrichment cannot create a second visible company/date row.
 */
export function enrichConcallScans(scans = [], screenerRows = []) {
  const groups = groupScreenerConcalls(screenerRows);
  const scanRows = scans.map((row) => ({ ...row, analysisTracked: true, documents: mergeDocuments(row.documents || []) }));
  const scansByTicker = new Map();
  for (const row of scanRows) {
    const ticker = String(row.ticker || '').toUpperCase();
    if (!ticker || !row.date) continue;
    if (!scansByTicker.has(ticker)) scansByTicker.set(ticker, []);
    scansByTicker.get(ticker).push(row);
  }

  const unmatched = [];
  for (const group of groups) {
    const candidates = (scansByTicker.get(String(group.ticker || '').toUpperCase()) || [])
      .map((row) => ({ row, distance: daysApart(row.date, group.publishedDate) }))
      .filter((hit) => Number.isFinite(hit.distance) && hit.distance <= 5)
      .sort((a, b) => a.distance - b.distance || String(b.row.when || '').localeCompare(String(a.row.when || '')));
    // Exact dates always match. A nearby publication matches only when one call is strictly the
    // nearest; an equal-distance tie is left separate instead of guessing which call owns it.
    const hit = candidates[0] && (candidates[0].distance === 0 || !candidates[1] || candidates[0].distance < candidates[1].distance) ? candidates[0].row : null;
    if (!hit) {
      unmatched.push(group);
      continue;
    }
    hit.documents = mergeDocuments(hit.documents, group.documents);
    hit.screenerPublishedDates = [...new Set([...(hit.screenerPublishedDates || []), group.publishedDate])].sort().reverse();
  }

  for (const group of unmatched) {
    scanRows.push({
      companyKey: `screener:${group.companyKey}`,
      companyId: group.ticker ? `NSE:${group.ticker}` : `SCREENER:${group.companyKey}`,
      ticker: group.ticker || null,
      exchange: group.ticker ? 'NSE' : null,
      name: group.name,
      industry: null,
      when: `${group.publishedDate}T00:00:00+05:30`,
      date: group.publishedDate,
      publishedDate: group.publishedDate,
      ssUrl: null,
      pptSsUrl: null,
      src: null,
      notesReady: false,
      resultScore: null,
      sentimentTier: null,
      tags: [],
      analysisTracked: false,
      documents: group.documents,
      screenerCompanyUrl: group.companyUrl,
    });
  }

  return scanRows.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')) || String(a.name || '').localeCompare(String(b.name || '')));
}
