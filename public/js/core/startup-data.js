// Start the two small opening reads while the interface's module graph is downloading.
// A fulfilled promise is consumed once; later reads use the normal source revalidation.
import { revalidatedJson } from './store.js';

const opening = new Map();
const REUSE_MS = 30_000;
export function warmStartupData() {
  for (const [path, options] of [
    ['data/portfolio-companies.json', { allowCached: true }],
    ['data/sector-kpis.json', { optional: true }],
  ]) {
    if (opening.has(path)) continue;
    const pending = revalidatedJson(path, options);
    opening.set(path, { pending, startedAt: Date.now() });
    // A failed opening read is still delivered to its consumer's existing failure policy.
    pending.catch(() => {});
  }
}

export function startupJson(path, options = {}) {
  const entry = opening.get(path);
  opening.delete(path);
  return entry && Date.now() - entry.startedAt < REUSE_MS ? entry.pending : revalidatedJson(path, options);
}
