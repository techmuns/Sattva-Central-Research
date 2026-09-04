import { authHeaders } from '../core/host-context.js';
import { readEntry, writeEntry, KEYS } from '../core/store.js';
import { DOMESTIC_FORMS, documentUrl } from './domestic-filings-shared.js';

const loaded = new Map();
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
    for (const row of [...(previous?.value?.documents || []), ...body.documents]) {
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
    if (previous?.value) {
      const result = { ...previous.value, stale: true, error: err.message };
      loaded.set(key, result);
      return result;
    }
    throw err;
  }
}
