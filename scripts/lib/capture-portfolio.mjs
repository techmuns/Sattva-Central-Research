import { join } from 'node:path';
import { loadActivePortfolio } from './active-portfolio.mjs';
import { readJson, writeJson } from './company-capture.mjs';
import { assertBookChange, validateResolvedPortfolio } from '../../public/js/data/family-book-contract.js';

// Public capture state contains names/identifiers only, never the API's unknown future fields.
function project(book) {
  const fields = ['ok', 'syncStatus', 'storage', 'sourceRevision', 'asOf', 'syncedAt', 'count', 'resolved'];
  return { ...Object.fromEntries(fields.map(key => [key, book[key]])),
    sourceWorkbook: { fileKey: book.sourceWorkbook.fileKey, label: book.sourceWorkbook.label, uploadedAt: book.sourceWorkbook.uploadedAt },
    holdings: book.holdings.map(h => ({ isin: h.isin, name: h.name, ticker: h.ticker,
      ...(h.reason ? { reason: h.reason } : {}) })) };
}

export async function loadCapturePortfolio(dataDir, { live = process.env.FAMILY_HOLDINGS_LIVE === 'true', fetcher = fetch, now = Date.now,
  cachePath = join(dataDir, 'filing-capture/portfolio.json') } = {}) {
  const path = join(dataDir, 'portfolio-companies.json'), cache = cachePath;
  let book = readJson(path), origin = 'snapshot';
  if (live) {
    try {
      const saved = validateResolvedPortfolio(readJson(cache), { fresh: false });
      assertBookChange(saved, book);
      const newerWorkbook = book.storage !== 'shared' || saved.asOf > book.asOf ||
        Date.parse(saved.sourceWorkbook.uploadedAt) > Date.parse(book.sourceWorkbook?.uploadedAt);
      if (newerWorkbook || Date.parse(saved.syncedAt) >= (Date.parse(book.syncedAt) || 0)) { book = project(saved); origin = 'last-verified'; }
    } catch { /* A missing/corrupt cache cannot replace the reviewed fallback. */ }
  }
  let error = null;
  if (live) {
    try {
      const incoming = await loadActivePortfolio(path, { live: true, fetcher, previous: book });
      book = project(incoming);
      writeJson(cache, book);
      origin = 'live';
    } catch {
      error = 'Active portfolio could not be verified; retaining the last known holdings. New additions may be missing until the connection recovers.';
    }
  }
  return { holdings: book.holdings,
    portfolio: { status: origin, liveRequested: live, error, attemptedAt: new Date(now()).toISOString(),
      checkedAt: book.syncedAt || null, revision: book.sourceRevision || null, count: book.holdings.length } };
}
