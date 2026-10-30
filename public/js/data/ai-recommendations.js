// The AI Recommendations reader. Prepared ideas only: the catalyst engine runs on the runner
// (scripts/build-catalyst-ideas.mjs → data/ai-catalysts.json) and this module never scores a
// company or starts a collector. The verified-earnings foundation publication
// (data/ai-recommendations.json, recommendation-foundation.yml) is read beside it where a
// deployment installed one, and only adds a "verified filing" mark to an idea it agrees with.
import { filterByScope } from './scope.js';
import { readEntry, writeEntry } from '../core/store.js';

export const POLL_MS = 5 * 60_000;
export const IDEAS_FILE = '/data/ai-catalysts.json';
export const FOUNDATION_FILE = '/data/ai-recommendations.json';
const STALE_MS = 8 * 60 * 60_000;
const READ_LIMIT = 8 * 1024 * 1024;
const STANCES = new Set(['opportunity', 'mixed', 'risk', 'watch']);

/** Throws unless the publication is the shape this reader renders. */
export function validateIdeas(value) {
  if (value?.version !== 2 || value?.stage !== 'catalyst-ideas' || !Array.isArray(value.ideas) || value.rowCount !== value.ideas.length ||
      !Number.isFinite(Date.parse(value.generatedAt)) ||
      value.ideas.some((r) => !r.id || !r.ticker || !r.company || !STANCES.has(r.stance) || !Number.isFinite(r.conviction) || !Number.isFinite(r.risk) ||
        !r.pillars || !Array.isArray(r.evidence) || typeof r.headline !== 'string') ||
      new Set(value.ideas.map((r) => r.ticker)).size !== value.ideas.length) throw Error('Invalid recommendation publication');
  return value;
}

// The foundation publication is optional and older; a malformed one is ignored, never fatal.
function foundationRows(value) {
  if (value?.version !== 1 || value?.stage !== 'research-candidates' || !Array.isArray(value.rows)) return [];
  return value.rows.filter((r) => r?.ticker && r?.catalyst);
}

export function createRecommendationFeed({
  fetcher = fetch,
  now = Date.now,
  readSaved = () => readEntry('ai-catalysts:v2'),
  save = (value) => writeEntry('ai-catalysts:v2', { value }),
} = {}) {
  let held = null, verified = new Map(), checking = null, checkedAt = null, error = null, etag = null, foundationTag = null, foundationAbsent = false;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => { try { fn(); } catch {} });
  let restoring = null;
  const restore = () => restoring ||= (async () => {
    try {
      const saved = await readSaved();
      if (!held && saved?.value) { held = validateIdeas(saved.value); emit(); }
    } catch {}
  })();

  // A deployment without the foundation publication answers 404; that is an answer, asked once.
  async function readFoundation() {
    if (foundationAbsent) return;
    try {
      const response = await fetcher(FOUNDATION_FILE, { cache: 'no-store', headers: foundationTag ? { 'If-None-Match': foundationTag } : {}, signal: AbortSignal.timeout(20000) });
      if (response.status === 404) { foundationAbsent = true; return; }
      if (response.status === 304 || !response.ok) return;
      const text = await response.text();
      if (text.length > READ_LIMIT) return;
      verified = new Map(foundationRows(JSON.parse(text)).map((r) => [String(r.ticker).toUpperCase(), r]));
      foundationTag = response.headers.get('etag');
    } catch {}
  }

  async function refresh() {
    if (checking) return checking;
    checking = Promise.resolve().then(async () => {
      await restore();
      const foundation = readFoundation();
      try {
        const response = await fetcher(IDEAS_FILE, { cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {}, signal: AbortSignal.timeout(25000) });
        if (response.status === 304 && held) { checkedAt = new Date(now()).toISOString(); error = null; await foundation; return { checked: 1, total: held.ideas.length }; }
        if (!response.ok) throw Error(`Prepared recommendations unavailable (${response.status})`);
        const text = await response.text();
        if (text.length > READ_LIMIT) throw Error('Recommendation publication exceeds reader budget');
        const next = validateIdeas(JSON.parse(text));
        if (held && Date.parse(next.generatedAt) < Date.parse(held.generatedAt)) throw Error('Older recommendation publication');
        const before = new Set((held?.ideas || []).map((r) => r.id));
        held = next; etag = response.headers.get('etag'); checkedAt = new Date(now()).toISOString(); error = null;
        try { await save(held); } catch {}
        await foundation;
        return { checked: 1, total: held.ideas.length, added: held.ideas.filter((r) => !before.has(r.id)).length };
      } catch (e) {
        error = e.message;
        await foundation;
        return { checked: 0, failed: 1, total: held?.ideas.length || 0 };
      }
    }).finally(() => { checking = null; emit(); });
    return checking;
  }

  const withVerified = (rows) => rows.map((r) => {
    const v = verified.get(String(r.ticker).toUpperCase());
    return v ? { ...r, verified: { model: v.modelName || v.model, catalyst: v.catalyst, url: v.sourceUrl || null, score: v.score ?? null } } : r;
  });
  return {
    refresh,
    load: async () => { await restore(); if (!held) await refresh(); return held; },
    rows: () => withVerified(held?.ideas || []),
    forScope: (scope) => withVerified(filterByScope(held?.ideas || [], scope)),
    meta: () => ({ ...held, ideas: undefined, checking: !!checking, browserCheckedAt: checkedAt, error,
      verifiedCount: verified.size, stale: !held || now() - Date.parse(held.generatedAt) > STALE_MS }),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

export const feed = createRecommendationFeed();
export const { load, refresh, rows, forScope, meta, onChange } = feed;
