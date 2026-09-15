// Public Chatter: paint validated device data first, then revalidate the public API.
// Source publication/check times are never replaced by a browser cache or transport timestamp.
// The API is called directly: same-account workers.dev proxy calls require service bindings.
import { readEntry, writeEntry, revalidatedJson, KEYS } from '../core/store.js';
import { buildResolverIndex, resolveAll, normaliseDashboard, normalisePosts, SOURCE_LABEL } from './sentiment-shared.js';
import { chatterHealth } from './chatter-health.js';
import * as coverage from './coverage.js';
import { filterByScope } from './scope.js';

export const LIVE_ID = 'chatter-live';
const POLL_MS = 5 * 60000;
const DEFAULT_BASE = 'https://sentimentdash-api.tech-441.workers.dev/v1';
function baseUrl() {
  try { const override = localStorage.getItem('sattva:chatter-base'); if (override) return override.replace(/\/+$/, ''); } catch {}
  return String(globalThis.window?.SATTVA_CHATTER_URL || DEFAULT_BASE).replace(/\/+$/, '');
}
const storeKey = () => baseUrl() === DEFAULT_BASE ? KEYS.chatter : `${KEYS.chatter}:${baseUrl()}`;
const resourceKey = path => `${storeKey()}:${path}`;
const INDEX_KEY = 'chatter:public-resolver';
let cache = null, rawDashboard = null, loadPromise = null, refreshPromise = null, indexPromise = null;
let publicNames = [], resolverIndex = null, entriesRevision = '', seenSlugs = null, arrivals = [];
const listeners = new Set(), postsCache = new Map(), resourceFlights = new Map();
let catalogue = null;
function emit() { for (const fn of listeners) { try { fn(cache); } catch (error) { console.error('[chatter-live] listener failed', error); } } }
function rebuildResolver() {
  resolverIndex = buildResolverIndex([...publicNames, ...coverage.holdings().filter(row => row.ticker).map(row => ({ ticker: row.ticker, name: row.name }))]);
}
function refreshIndex() {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    const [uni, mc] = await Promise.all([
      revalidatedJson('data/universe.json', { optional: true, allowCached: true }),
      revalidatedJson('data/mc-ticker-map.json', { optional: true, allowCached: true }),
    ]);
    if (Array.isArray(uni) && mc?.map) {
      publicNames = [...uni.flatMap(row => {
        const ticker = String(row['Screener URL'] || '').match(/\/company\/([^/]+)/)?.[1];
        return ticker ? [{ ticker, name: row.Company }] : [];
      }), ...Object.values(mc.map).filter(row => row?.ticker).map(row => ({ ticker: row.ticker, name: row.fullName }))];
      await writeEntry(INDEX_KEY, { value: publicNames, tag: null });
    }
    rebuildResolver();
    if (rawDashboard) {
      const { origin, checkedAt, checking, ok, error, reason } = cache.meta;
      adopt(rawDashboard, { origin, checkedAt, checking, ok, error, reason, resolving: false });
    }
    emit();
  })().catch(() => { if (cache) cache.meta.resolving = false; emit(); }).finally(() => { indexPromise = null; });
  return indexPromise;
}
function validateDashboard(body, { complete = false } = {}) {
  if (!body || !Array.isArray(body.stocks) || !body.overview || !Number.isFinite(Date.parse(body.generatedAt)) ||
      !Number.isInteger(body.pagination?.total) || body.pagination.total < 0 ||
      normaliseDashboard(body).entries.length !== body.stocks.length ||
      new Set(body.stocks.map(row => row.ticker)).size !== body.stocks.length) throw new Error('The chatter summary returned an invalid response.');
  if (complete && (body.stocks.length !== body.pagination.total || body.pagination.hasMore)) throw new Error('The chatter summary is incomplete.');
}
async function jsonResponse(response) {
  if (!response.ok) throw new Error(`The chatter source returned HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error('The chatter page exceeds the supported size.');
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('The chatter page exceeds the supported size.');
  return JSON.parse(text);
}
async function fetchDashboard() {
  const base = baseUrl();
  if (!/^https?:\/\//i.test(base)) throw new Error('The chatter feed has no usable address.');
  const stored = await readEntry(storeKey());
  let validStored = false;
  try { validateDashboard(stored?.value, { complete: true }); validStored = true; } catch {}
  const response = await fetch(`${base}/dashboard?limit=all`, { cache: 'no-cache',
    headers: { accept: 'application/json', ...(validStored && stored.tag ? { 'if-none-match': stored.tag } : {}) }, signal: AbortSignal.timeout(8000) });
  if (response.status === 304 && validStored) return { value: stored.value, tag: stored.tag };
  const body = await jsonResponse(response);
  validateDashboard(body);
  const stocks = [...body.stocks];
  let pagination = body.pagination;
  for (let page = 1; pagination.hasMore; page++) {
    if (page > 100 || stocks.length >= pagination.total) throw new Error('The chatter summary pagination did not complete.');
    const next = await jsonResponse(await fetch(`${base}/dashboard?limit=1000&offset=${stocks.length}`, { headers: { accept: 'application/json' }, cache: 'no-cache', signal: AbortSignal.timeout(8000) }));
    validateDashboard(next);
    if (next.generatedAt !== body.generatedAt || next.pagination.total !== body.pagination.total || next.pagination.offset !== stocks.length || !next.stocks.length) throw new Error('The chatter summary changed while loading; it will be checked again.');
    stocks.push(...next.stocks);
    pagination = next.pagination;
  }
  const value = { ...body, stocks, pagination: { ...body.pagination, count: stocks.length, hasMore: false } };
  validateDashboard(value, { complete: true });
  if (rawDashboard && Date.parse(value.generatedAt) < Date.parse(rawDashboard.generatedAt)) throw new Error('The source returned an older chatter snapshot.');
  const tag = response.headers.get('etag');
  await writeEntry(storeKey(), { value, tag });
  return { value, tag };
}
function adopt(body, details) {
  const shaped = normaliseDashboard(body);
  rebuildResolver();
  const resolved = resolveAll(shaped.entries, resolverIndex);
  const revision = JSON.stringify(resolved);
  const entries = revision === entriesRevision && cache ? cache.entries : resolved;
  entriesRevision = revision;
  if (!seenSlugs) seenSlugs = new Set(entries.map(row => row.slug));
  else for (const row of entries) if (!seenSlugs.has(row.slug)) { seenSlugs.add(row.slug); arrivals.unshift({ ...row, seenAt: Date.now() }); }
  arrivals = arrivals.slice(0, 40);
  const same = entries === cache?.entries;
  const companies = same ? cache.companies : entries.filter(row => row.ticker).sort(byMentions);
  const uncovered = same ? cache.uncovered : entries.filter(row => !row.ticker).sort(byMentions);
  rawDashboard = body;
  cache = { ok: true, entries, companies, uncovered, overview: shaped.overview,
    byTicker: new Map(companies.map(row => [row.ticker.toUpperCase(), row])),
    meta: { generatedAt: shaped.generatedAt, window: shaped.window, total: entries.length, companies: companies.length,
      uncovered: uncovered.length, totalPosts: shaped.overview?.totalPosts ?? null, sourceTotals: shaped.overview?.sourceTotals || null,
      collection: body.collection || null, readable: true, ok: true, reason: null, error: null, ...details } };
}
const byMentions = (a, b) => b.mentions - a.mentions || String(a.name).localeCompare(String(b.name));
export function load() {
  if (cache) { if (!refreshPromise && (!cache.meta.ok || Date.now() - (cache.meta.checkedAt || 0) >= POLL_MS)) void refresh(); return Promise.resolve(cache); }
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const [saved, index] = await Promise.all([readEntry(storeKey()), readEntry(INDEX_KEY)]);
    if (Array.isArray(index?.value)) publicNames = index.value;
    rebuildResolver();
    void refreshIndex();
    try { validateDashboard(saved?.value, { complete: true }); adopt(saved.value, { origin: 'store', checkedAt: null, checking: true, resolving: !!indexPromise }); } catch {}
    const checking = refresh();
    if (cache?.meta.readable) return cache;
    return checking;
  })().finally(() => { loadPromise = null; });
  return loadPromise;
}
export function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    if (!resolverIndex) rebuildResolver();
    if (cache) { cache.meta.checking = true; emit(); }
    try {
      const { value } = await fetchDashboard();
      adopt(value, { origin: 'live', checkedAt: Date.now(), checking: false, resolving: !!indexPromise });
    } catch (error) {
      const details = { ok: false, checking: false, reason: 'unreachable', error: String(error.message || error), lastAttemptAt: Date.now(), url: `${baseUrl()}/dashboard` };
      if (cache) { cache.ok = false; cache.meta = { ...cache.meta, ...details }; }
      else cache = { entries: [], companies: [], uncovered: [], byTicker: new Map(), overview: null, meta: { readable: false, ...details } };
    }
    emit();
    return cache;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
export const isLoaded = () => !!cache;
export const all = () => cache?.entries || [];
export const companies = () => cache?.companies || [];
export const uncovered = () => cache?.uncovered || [];
export const overview = () => cache?.overview || null;
export const meta = () => {
  if (!cache) return null;
  const value = { ...cache.meta, ageSeconds: rawDashboard ? Math.max(0, (Date.now() - Date.parse(rawDashboard.generatedAt)) / 1000) : null };
  return { ...value, health: chatterHealth(value) };
};
export const byTicker = ticker => ticker ? cache?.byTicker.get(String(ticker).toUpperCase()) || null : null;
export const newArrivals = () => arrivals;
export const sourceLabel = key => SOURCE_LABEL[key] || key;
export function forScope(scope, rows = companies()) { return filterByScope(rows, scope, coverage.tracked()); }
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, { intervalMs: POLL_MS, fetcher: async () => {
    const value = await refresh();
    if (!value.meta.ok) throw new Error(value.meta.error || 'Chatter revalidation failed.');
    return { ...value, partial: meta().health.state !== 'updated' };
  } });
  live.start(LIVE_ID, { fresh: !!cache?.meta.checkedAt });
  const resume = () => { if (!document.hidden && (!cache?.meta.ok || Date.now() - (cache?.meta.checkedAt || 0) >= POLL_MS)) void refresh(); else emit(); };
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', resume);
  return () => {
    live.stop(LIVE_ID);
    window.removeEventListener('focus', resume); window.removeEventListener('online', resume);
    window.removeEventListener('pageshow', resume); document.removeEventListener('visibilitychange', resume);
  };
}
export const stopLive = live => live?.stop?.(LIVE_ID);

// Details and archive indices also survive reloads. Cache reads never advance checkedAt.
async function cachedResource(path, { validate, fetchValue, onUpdate, maxAgeMs = 60000, force = false, requireFresh = false }) {
  const key = resourceKey(path);
  const stored = await readEntry(key);
  let saved = null;
  try { validate(stored?.value); saved = stored.value; } catch {}
  let flight = resourceFlights.get(key);
  if (flight) { if (onUpdate) flight.callbacks.add(onUpdate); return saved && !requireFresh ? { ...saved, checking: true } : flight.promise; }
  if (saved && !force && Date.now() - Date.parse(saved.checkedAt || '') < maxAgeMs) return saved;
  const callbacks = new Set(onUpdate ? [onUpdate] : []);
  let partial = null;
  const notify = value => {
    if (value.posts && !value.complete) {
      partial = value;
      if (saved?.posts) value = { ...value, posts: [...new Map([...saved.posts, ...value.posts].map(post => [post.id, post])).values()] };
    }
    for (const callback of callbacks) callback(value);
  };
  const promise = (async () => {
    try {
      const value = { ...await fetchValue(notify), checkedAt: new Date().toISOString(), checking: false, error: null };
      validate(value);
      await writeEntry(key, { value, tag: null });
      notify(value);
      return value;
    } catch (error) {
      if (saved) { const value = { ...saved, checking: false, error: String(error.message || error) }; notify(value); return value; }
      if (partial) { const value = { ...partial, checking: false, error: String(error.message || error) }; notify(value); return value; }
      throw error;
    }
  })().finally(() => resourceFlights.delete(key));
  resourceFlights.set(key, { promise, callbacks });
  if (saved && !requireFresh) { void promise.catch(() => {}); return { ...saved, checking: true }; }
  return promise;
}
async function readPostPages(path, slug, notify) {
  const posts = new Map();
  let first = null, offset = 0;
  for (let page = 0; page < 100; page++) {
    const body = await jsonResponse(await fetch(`${baseUrl()}${path}?limit=1000&sort=newest&offset=${offset}`, { headers: { accept: 'application/json' }, cache: 'no-cache', signal: AbortSignal.timeout(8000) }));
    if (body?.ticker !== slug || !Array.isArray(body.posts) || !Number.isInteger(body.pagination?.total)) throw new Error('The mentions endpoint returned an unexpected topic or payload.');
    const normal = normalisePosts(body);
    if (normal.posts.length !== body.posts.length || (body.pagination.offset ?? 0) !== offset) throw new Error('The mentions endpoint returned incomplete post records.');
    if (first && (body.generatedAt !== first.generatedAt || body.pagination.total !== first.pagination.total)) throw new Error('The mention list changed while loading; please check again.');
    first ||= body;
    for (const post of normal.posts) {
      if (posts.has(post.id)) throw new Error('The mention pages overlap; please check again.');
      posts.set(post.id, post);
    }
    const value = { ...normal, posts: [...posts.values()], slug, endpoint: `${baseUrl()}${path}`, complete: !body.pagination.hasMore, archive: body.archive || null };
    if (!body.pagination.hasMore) {
      if (posts.size !== body.pagination.total) throw new Error('The mentions endpoint returned an incomplete list.');
      postsCache.set(path, value); emit();
      return value;
    }
    if (!body.posts.length) throw new Error('The mention pagination did not advance.');
    notify({ ...value, checking: true });
    offset += body.posts.length;
  }
  throw new Error('The mention list exceeds the supported page limit; the source total has not been fully loaded.');
}
export function postsFor(slug, options = {}) {
  const key = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,160}$/.test(key)) return Promise.reject(new Error('No usable chatter topic was supplied.'));
  const path = options.month ? `/archive/${encodeURIComponent(key)}/${encodeURIComponent(options.month)}` : `/stocks/${encodeURIComponent(key)}/posts`;
  return cachedResource(path, { ...options,
    validate: value => { if (value?.slug !== key || !Array.isArray(value.posts) || !value.complete) throw new Error('No complete cached mentions'); },
    fetchValue: notify => readPostPages(path, key, notify),
  }).then(value => {
    postsCache.set(path, value);
    if (options.requireFresh && (value.error || !value.complete)) throw new Error(value.error || 'The mention read is incomplete.');
    return value;
  });
}
export function loadedPosts() {
  const groups = new Map();
  for (const value of postsCache.values()) {
    const group = groups.get(value.slug) || { ...value, posts: new Map() };
    for (const post of value.posts) group.posts.set(post.id, post);
    groups.set(value.slug, group);
  }
  return [...groups.values()].map(group => ({ ...group, total: Math.max(group.total || 0, group.posts.size), posts: [...group.posts.values()] }));
}
export function archiveTopics(options = {}) {
  return cachedResource('/archive', { ...options, maxAgeMs: POLL_MS,
    validate: value => {
      if (value?.available !== true || !Array.isArray(value.topics) || value.topics.some(topic => !topic.ticker || !topic.name || !Number.isInteger(topic.count) || !topic.months)) throw new Error('Captured history is not available yet.');
    },
    fetchValue: async () => jsonResponse(await fetch(`${baseUrl()}/archive`, { headers: { accept: 'application/json' }, cache: 'no-cache', signal: AbortSignal.timeout(8000) })),
  }).then(value => { catalogue = value; return value; });
}
export function resolveArchiveTopics(value = catalogue) {
  rebuildResolver();
  return resolveAll((value?.topics || []).map(topic => ({ slug: topic.ticker, name: topic.name, mentions: topic.count, archiveTopic: topic })), resolverIndex);
}
