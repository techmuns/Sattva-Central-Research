import { readEntry, writeEntry } from '../core/store.js';
import { mergeIpoFilings, validateIpoFilings, IPO_POLL_MS, MAX_IPO_ROWS, ipoSourceIsStale } from './ipo-filings-shared.js';
import { mergePlatformCompanies, validatePlatformCompanies } from './ipo-platform-shared.js';
const KEY = 'ipo-filings:history:v1';
const readJson = async (path) => {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error('IPO feed unavailable');
  return validateIpoFilings(await response.json());
};
export function createIpoFilingsFeed({
  readLive = () => readJson('api/ipo-filings'), readSnapshot = () => readJson('data/ipo-filings.json'),
  readSaved = () => readEntry(KEY), save = (value) => writeEntry(KEY, { value }), now = Date.now,
} = {}) {
  let rows = [], companies = [], sources = [], checkedAt = null, loaded = false, pending = null, generation = 0;
  let liveFailed = true, snapshotFailed = false, capped = false;
  const subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn());
  const safe = async (reader) => { try { const p = validateIpoFilings(await reader()); validatePlatformCompanies(p.companies || []); return p; } catch { return null; } };
  function ingest(payload) {
    if (!payload) return;
    rows = mergeIpoFilings(rows, payload.rows); capped = rows.length > MAX_IPO_ROWS;
    rows = rows.slice(0, MAX_IPO_ROWS);
    companies = mergePlatformCompanies(companies, validatePlatformCompanies(payload.companies || []));
  }
  async function run() {
    const gen = generation;
    if (!loaded) {
      const saved = await readSaved().catch(() => null);
      if (gen !== generation) return;
      try { ingest(validateIpoFilings(saved?.value)); } catch { /* A cache miss is normal. */ }
    }
    const snapshot = await safe(readSnapshot);
    if (gen !== generation) return;
    snapshotFailed = !snapshot; ingest(snapshot);
    if (!checkedAt && snapshot) { sources = snapshot.sources; checkedAt = snapshot.checkedAt; }
    // Paint the dated archive while official reads finish; it is explicitly not yet live.
    emit();
    const live = await safe(readLive);
    if (gen !== generation) return;
    ingest(live); liveFailed = !live?.ok;
    if (live) { sources = live.sources; checkedAt = live.checkedAt; }
    loaded = true; emit();
    if (checkedAt && sources.length) await save({ version: 1, rows, companies, sources, checkedAt }).catch(() => {});
  }
  function refresh() {
    if (pending) return pending;
    pending = run().finally(() => { pending = null; }); return pending;
  }
  function meta() {
    const stale = !checkedAt || now() - Date.parse(checkedAt) > IPO_POLL_MS * 2 || Date.parse(checkedAt) > now() + 60000;
    const failed = sources.filter((s) => s.status !== 'ok');
    return { sources, checkedAt, liveFailed, stale, snapshotFailed, capped, loaded,
      degraded: liveFailed || stale || snapshotFailed || failed.length > 0 || sources.some((s) => s.unmapped || ipoSourceIsStale(s, now())) || capped,
      count: rows.length, companyCount: companies.length, undated: rows.filter((r) => !r.filingDate).length };
  }
  return {
    rows: () => rows, companies: () => companies, meta, load: () => loaded ? Promise.resolve() : refresh(), refresh,
    onChange: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    startLive: (live) => { live.register('ipo-filings', { intervalMs: IPO_POLL_MS, fetcher: async () => { await refresh(); return null; } }); live.start('ipo-filings', { fresh: true }); },
    stopLive: (live) => live.stop('ipo-filings'),
    invalidate: () => { generation++; rows = []; companies = []; sources = []; checkedAt = null; loaded = false; liveFailed = true; },
  };
}
export const { rows, companies, meta, load, refresh, onChange, startLive, stopLive } = createIpoFilingsFeed();
