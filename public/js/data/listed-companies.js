import { capturedJson } from './company-captures.js';
import { buildExchangeUniverseAsync } from './exchange-universe.js';
import { readEntries, writeEntry } from '../core/store.js';
export { buildExchangeUniverse } from './exchange-universe.js';

let bse = null, nse = null, pending = null, nextCheck = null;
let recheckNeeded = false;
let companies = [], status = { sources: [], errors: [] };
let builtInputs = null, counts = {};
const SAVED_KEY = 'snapshot:listed-companies:verified-sources:v1';
let restored = false, restoring = null, savedInputs = null;
const subscribers = new Set();
export const onChange = fn => { subscribers.add(fn); return () => subscribers.delete(fn); };
const emit = () => subscribers.forEach(fn => fn());
export const all = () => companies;
export const meta = () => status;

const validBse = value => value?.version === 1 && Array.isArray(value.entries) &&
  value.entries.length >= 1000 && Number.isFinite(Date.parse(value.capturedAt));
const validNse = (d, kind) => Array.isArray(d?.entries) &&
  d.entries.length >= (kind === 'equity' ? 1000 : 100) && Number.isFinite(Date.parse(d.checkedAt));
function sourceStatus(bse, nse) {
  return [{ label: 'BSE', checkedAt: bse?.capturedAt || null, cadenceMs: 2 * 3600000 },
    ...['equity', 'sme'].map(kind => ({ label: kind === 'sme' ? 'NSE SME' : 'NSE main board',
      checkedAt: nse?.directories?.[kind]?.checkedAt || null, cadenceMs: 6 * 3600000 }))];
}

// Restore verified source identities without waiting for the network. Older sessions can use
// their existing capture cache too; malformed cache entries still pass the full identity build.
// Network reads start concurrently, and wait here before adopting so a late disk read cannot
// overwrite newer directory data. Nothing moves onto the app's startup critical path.
export function restore({ build = buildExchangeUniverseAsync } = {}) {
  if (restored || companies.length) return Promise.resolve(companies);
  if (restoring) return restoring;
  restoring = (async () => {
    const bseKey = 'capture:data/announcement-identities.json', nseKey = 'capture:data/filing-capture/nse-identities.json';
    const entries = await readEntries([SAVED_KEY, bseKey, nseKey]);
    const saved = entries.get(SAVED_KEY)?.value;
    const snapshots = saved?.version === 1 ? saved : {};
    // Per-source responses can finish saving before the joined snapshot. Reconcile every
    // exchange independently by its actual check time, including a missing half or NSE segment.
    async function newest(candidates, valid, timeOf, prepare, sizeOf) {
      const baseline = valid(candidates[0]) ? sizeOf(candidates[0]) : 0;
      const ordered = [...new Set(candidates)].filter(c => valid(c) && sizeOf(c) >= baseline * 0.8)
        .sort((a, b) => Date.parse(timeOf(b)) - Date.parse(timeOf(a)));
      for (const candidate of ordered) {
        try { await prepare(candidate); return candidate; } catch { /* Try the preceding valid source. */ }
      }
      return null;
    }
    const savedBse = await newest([snapshots.bse, entries.get(bseKey)?.value], validBse,
      c => c.capturedAt, c => build(c, {}), c => c.entries.length);
    const nseCandidates = [snapshots.nse, entries.get(nseKey)?.value].filter(c => c?.version === 1);
    const directories = {};
    for (const kind of ['equity', 'sme']) {
      const d = await newest([snapshots.nse?.version === 1 ? snapshots.nse.directories?.[kind] : null,
        ...nseCandidates.map(c => c.directories?.[kind])],
        d => validNse(d, kind), d => d.checkedAt, d => build({}, { directories: { [kind]: d } }), d => d.entries.length);
      if (d) directories[kind] = d;
    }
    const savedNse = Object.keys(directories).length ? { version: 1, directories } : null;
    if (!savedBse && !savedNse) return companies;
    const built = await build(savedBse || {}, savedNse || {});
    bse = savedBse; nse = savedNse;
    companies = built.companies; counts = built.counts;
    builtInputs = { bse, equity: nse?.directories?.equity, sme: nse?.directories?.sme };
    status = { ...counts, sources: sourceStatus(bse, nse), errors: ['Saved company list; checking exchange directories.'] };
    emit();
    return companies;
  })().catch(() => companies).finally(() => { restored = true; restoring = null; });
  return restoring;
}

// Revalidate on every editor opening and every visible poll. Failed sources retain their last
// verified identities and original check times; a partial directory is never called complete.
export function load({ read = capturedJson, build = buildExchangeUniverseAsync, recheck = false } = {}) {
  if (pending) {
    if (!recheck) return pending;
    // A return/focus event can follow a source change while an older request is still running.
    // Recheck after it settles. Events during each read share one subsequent check, including
    // events arriving while a queued check is running. Every caller waits for the whole chain.
    recheckNeeded = true;
    if (!nextCheck) {
      nextCheck = (async () => {
        try { await pending; } catch { /* A return can recover the preceding failed read. */ }
        for (;;) {
          recheckNeeded = false;
          let value, failed = false, failure;
          try { value = await load({ read, build }); }
          catch (error) { failed = true; failure = error; }
          if (recheckNeeded) continue;
          nextCheck = null;
          if (failed) throw failure;
          return value;
        }
      })();
    }
    return nextCheck;
  }
  let previous = null;
  pending = (async () => {
    const saved = restore({ build });
    const replies = await Promise.allSettled([
      read('data/announcement-identities.json'), read('data/filing-capture/nse-identities.json'),
    ]);
    await saved;
    previous = { bse, nse, companies, counts, builtInputs };
    const reply = i => { if (replies[i].status === 'rejected') throw replies[i].reason; return replies[i].value; };
    const errors = [], sources = [];
    await Promise.all([
      (async () => {
        try {
          const { value, stale } = reply(0);
          if (!validBse(value) || value.entries.length < (bse?.entries.length || 0) * 0.8 ||
            bse && Date.parse(value.capturedAt) < Date.parse(bse.capturedAt)) throw Error('Invalid BSE directory');
          if (value !== bse) await build(value, {}); // Validate before replacing saved identities.
          bse = value;
          if (stale) errors.push('BSE directory could not be revalidated; saved identities retained.');
        } catch { errors.push('BSE directory unavailable; any saved identities are retained.'); }
        sources.push({ label: 'BSE', checkedAt: bse?.capturedAt || null, cadenceMs: 2 * 3600000 });
      })(),
      (async () => {
        try {
          const { value, stale } = reply(1);
          if (value?.version !== 1 || !value.directories) throw Error('Invalid NSE directory');
          const directories = { ...(nse?.directories || {}) };
          for (const kind of ['equity', 'sme']) {
            const d = value.directories[kind];
            if (!validNse(d, kind) || d.entries.length < (directories[kind]?.entries?.length || 0) * 0.8 ||
              directories[kind] && Date.parse(d.checkedAt) < Date.parse(directories[kind].checkedAt)) {
              errors.push(`NSE ${kind === 'sme' ? 'SME' : 'main board'} directory incomplete; saved identities retained.`);
              continue;
            }
            if (d !== directories[kind]) await build({}, { directories: { [kind]: d } });
            directories[kind] = d;
          }
          nse = { ...value, directories };
          if (stale) errors.push('NSE directories could not be revalidated; saved identities retained.');
        } catch { errors.push('NSE directories unavailable; any saved identities are retained.'); }
        for (const kind of ['equity', 'sme']) {
          const d = nse?.directories?.[kind];
          if (!Array.isArray(d?.entries) || !Number.isFinite(Date.parse(d?.checkedAt)) || d.error) errors.push(`NSE ${kind === 'sme' ? 'SME' : 'main board'} directory has not been fully checked.`);
          sources.push({ label: kind === 'sme' ? 'NSE SME' : 'NSE main board', checkedAt: d?.checkedAt || null, cadenceMs: 6 * 3600000 });
        }
      })(),
    ]);
    if (!bse && !nse) {
      status = { ...counts, sources, errors };
      emit();
      throw Error('The exchange company directories could not be read.');
    }
    // Conditional reads retain the verified object on a 304. Recheck both sources every time,
    // but keep the derived rows (and consumers' row caches) while all three inputs are unchanged.
    const inputs = { bse, equity: nse?.directories?.equity, sme: nse?.directories?.sme };
    if (!builtInputs || Object.keys(inputs).some(key => inputs[key] !== builtInputs[key])) {
      const built = await build(bse || {}, nse || {});
      companies = built.companies;
      counts = built.counts;
      builtInputs = inputs;
    }
    status = { ...counts, sources, errors };
    // Keep a separate last-verified cache: an invalid 200 must not poison offline recovery.
    if (savedInputs !== builtInputs) {
      savedInputs = builtInputs;
      void writeEntry(SAVED_KEY, { value: { version: 1, bse, nse } });
    }
    emit();
    return companies;
  })().catch(error => {
    if (!previous?.companies.length) throw error;
    // Individually valid directories can still conflict when joined. Adoption is atomic:
    // keep both verified sources, their check times and their derived rows together.
    ({ bse, nse, companies, counts, builtInputs } = previous);
    status = { ...counts, sources: sourceStatus(bse, nse), errors: ['Exchange directories could not be combined; saved companies retained.'] };
    emit();
    return companies;
  }).finally(() => { pending = null; });
  return pending;
}
