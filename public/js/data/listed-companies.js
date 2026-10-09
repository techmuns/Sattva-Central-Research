import { capturedJson } from './company-captures.js';
import { buildExchangeUniverseAsync } from './exchange-universe.js';
export { buildExchangeUniverse } from './exchange-universe.js';

let bse = null, nse = null, pending = null;
let companies = [], status = { sources: [], errors: [] };
let builtInputs = null, counts = {};
export const all = () => companies;
export const meta = () => status;

// Revalidate on every editor opening and every visible poll. Failed sources retain their last
// verified identities and original check times; a partial directory is never called complete.
export function load({ read = capturedJson, build = buildExchangeUniverseAsync } = {}) {
  if (pending) return pending;
  pending = (async () => {
    const errors = [], sources = [];
    await Promise.all([
      (async () => {
        try {
          const { value, stale } = await read('data/announcement-identities.json');
          if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length < 1000 || value.entries.length < (bse?.entries.length || 0) * 0.8 || !Number.isFinite(Date.parse(value.capturedAt))) throw Error('Invalid BSE directory');
          if (value !== bse) await build(value, {}); // Validate before replacing saved identities.
          bse = value;
          if (stale) errors.push('BSE directory could not be revalidated; saved identities retained.');
        } catch { errors.push('BSE directory unavailable; any saved identities are retained.'); }
        sources.push({ label: 'BSE', checkedAt: bse?.capturedAt || null, cadenceMs: 2 * 3600000 });
      })(),
      (async () => {
        try {
          const { value, stale } = await read('data/filing-capture/nse-identities.json');
          if (value?.version !== 1 || !value.directories) throw Error('Invalid NSE directory');
          const directories = { ...(nse?.directories || {}) };
          for (const kind of ['equity', 'sme']) {
            const d = value.directories[kind];
            if (!Array.isArray(d?.entries) || d.entries.length < (kind === 'equity' ? 1000 : 100) || d.entries.length < (directories[kind]?.entries?.length || 0) * 0.8 || !Number.isFinite(Date.parse(d.checkedAt))) {
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
    if (!bse && !nse) throw Error('The exchange company directories could not be read.');
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
    return companies;
  })().finally(() => { pending = null; });
  return pending;
}
