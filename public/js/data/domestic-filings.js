import { authHeaders } from '../core/host-context.js';
import { readEntry, writeEntry, KEYS } from '../core/store.js';
import { DOMESTIC_FORMS, documentUrl } from './domestic-filings-shared.js';
import { capturedCompany, loadCompanyCaptureIndex, companyCaptureStatus } from './company-captures.js';

const loaded = new Map();
export async function loadCapturedDomesticFilings(ticker, form = 'all') {
  const t = String(ticker || '').trim().toUpperCase();
  if (!Object.hasOwn(DOMESTIC_FORMS, form)) throw new Error('Choose a valid document type.');
  await loadCompanyCaptureIndex();
  const entry = companyCaptureStatus('domestic').entries[t];
  const saved = await capturedCompany('domestic', t);
  const previous = await readEntry(KEYS.domesticFilings(t, form));
  const retained = new Map();
  for (const row of [...(previous?.value?.documents || []), ...(loaded.get(KEYS.domesticFilings(t, form))?.documents || []), ...saved.value.rows]) {
    const url = documentUrl(row.url);
    if (url && (form === 'all' || row.form === form)) retained.set(`${row.form}|${url}`, { ...row, ticker: t, url });
  }
  const documents = [...retained.values()];
  const stale = saved.stale || !!entry?.error || !entry?.lastSuccessAt || Date.now() - Date.parse(entry.lastSuccessAt) > 48 * 3600000;
  const result = { ticker: t, form, documents, fetchedAt: entry?.lastResponseAt || saved.value.fetchedAt || entry?.lastSuccessAt,
    skipped: entry?.skipped || 0, unavailableLinks: entry?.unavailableLinks || 0, stale,
    error: entry?.error?.message || (stale ? 'The scheduled source check is overdue or could not be verified.' : null), origin: 'snapshot' };
  loaded.set(KEYS.domesticFilings(t, form), result);
  return result;
}
export function domesticFilingsEvidence() {
  const rows = new Map();
  for (const result of loaded.values()) for (const row of result.documents) rows.set(`${row.ticker}|${row.form}|${row.url}`, row);
  return { rows: [...rows.values()], lookups: loaded.size, stale: [...loaded.values()].filter((result) => result.stale).length };
}

export async function loadDomesticFilings(ticker, form = 'all', { signal } = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z0-9&._-]{1,80}$/.test(t) || !Object.hasOwn(DOMESTIC_FORMS, form)) throw new Error('Choose a valid company ticker and document type.');
  const key = KEYS.domesticFilings(t, form);
  const previous = await readEntry(key);
  const path = `api/domestic-filings/${encodeURIComponent(t)}?form=${form}`;
  try {
    const res = await fetch(path, { headers: { accept: 'application/json', ...authHeaders(path) }, cache: 'no-cache', signal });
    let body;
    try { body = await res.json(); } catch { throw new Error('The document feed is unavailable at this origin.'); }
    if (!res.ok || body?.ok !== true) throw new Error(body?.message || 'The document feed could not be read.');
    if (!Array.isArray(body.documents)) throw new Error('The document feed returned an unfamiliar response.');
    const documents = new Map();
    for (const row of [...(loaded.get(key)?.documents || []), ...(previous?.value?.documents || []), ...body.documents]) {
      const url = documentUrl(row.url);
      if (url) documents.set(`${row.form || ''}|${url}`, { ...row, ticker: t, url });
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const result = { ticker: t, form, documents: [...documents.values()], fetchedAt: body.fetchedAt || null, skipped: body.skipped || 0, unavailableLinks: body.unavailableLinks || 0, stale: false };
    await writeEntry(key, { value: result });
    loaded.set(key, result);
    return result;
  } catch (err) {
    if (signal?.aborted || err.name === 'AbortError') throw err;
    const fallback = loaded.get(key) || previous?.value;
    if (fallback) {
      const result = { ...fallback, stale: true, error: err.message };
      loaded.set(key, result);
      return result;
    }
    throw err;
  }
}
