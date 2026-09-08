// Retained public Telegram messages. Source dates, collector checks and browser reads stay separate.
import { conditionalJson, readEntry, writeEntry, KEYS } from '../core/store.js';
const LIVE = 'api/telegram/posts';
const SNAPSHOT = 'data/telegram-posts.json';
const ARTIFACT_KEY = 'telegram-artifact-v1';
const RETAINED_KEY = 'telegram-retained-v1';
const str = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
const date = (v) => str(v) && Number.isFinite(Date.parse(v)) ? v : null;
const int = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0;
let state = { loaded: false, ok: false, posts: [], byId: new Map(), count: 0 };
let loading = null;
let retainedCapture = null;
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

function validateCapture(v) {
  if (!v || !Array.isArray(v.posts) || v.posts.length > 150000 || v.channel !== 'researchreportss') throw new Error('Telegram capture could not be read');
  if (!v.posts.length && state.count) throw new Error('Empty Telegram refresh; previous archive retained');
  for (const value of [v.lastRun?.at, v.lastCheckedAt]) {
    if (value != null && (!date(value) || Date.parse(value) > Date.now() + 300000))
      throw new Error('Invalid Telegram check time; previous archive retained');
  }
  const ids = new Set();
  for (const p of v.posts) {
    if (!int(p?.id) || ids.has(Number(p.id)) || (!str(p.text) && !date(p.publishedAt)) ||
        (p.text != null && (typeof p.text !== 'string' || p.text.length > 65536))) throw new Error('Malformed Telegram posts; previous archive retained');
    ids.add(Number(p.id));
  }
}

async function hydrateSaved() {
  const saved = await Promise.all([readEntry(KEYS.telegramPosts), readEntry(ARTIFACT_KEY), readEntry(RETAINED_KEY)]);
  for (const entry of saved.filter(Boolean).sort((a, b) => Date.parse(a.value.lastRun?.at || a.value.lastCheckedAt || a.value.capturedAt || 0) - Date.parse(b.value.lastRun?.at || b.value.lastCheckedAt || b.value.capturedAt || 0))) {
    try { validateCapture(entry.value); await apply({ ...entry, checkedAt: null, fromStore: true }, false); } catch { /* Ignore old corrupt cache entries. */ }
  }
  // Do not overwrite the retained key with an older entry midway through hydration.
  await persistRetained();
}

async function persistRetained() {
  if (retainedCapture) await writeEntry(RETAINED_KEY, { value: { ...retainedCapture, posts: state.posts } });
}

function postMetadata(posts, byId) {
  const spanFrom = posts.at(-1)?.id || 0, spanTo = posts[0]?.id || 0;
  return { posts, byId, count: posts.length, spanFrom, spanTo,
    span: spanFrom ? spanTo - spanFrom + 1 : 0,
    readable: posts.length, unreadable: spanFrom ? spanTo - spanFrom + 1 - posts.length : 0,
    limited: posts.filter((p) => p.contentStatus === 'telegram-only').length,
    listed: posts.filter((p) => p.text).length,
    newestPublishedAt: posts.find((p) => p.publishedAt)?.publishedAt || null,
    newestReadableAt: posts.find((p) => p.publishedAt && p.text)?.publishedAt || null,
    undated: posts.filter((p) => !p.publishedAt).length };
}

// Public responses can expose only a date/link for a post whose text was captured earlier.
// Enrich missing fields from the other copy; only the newer copy may replace non-empty text.
function retainContent(older, newer) {
  if (!older) return newer;
  const merged = { ...older, ...newer,
    text: newer.text || older.text,
    firstSeenAt: older.firstSeenAt || newer.firstSeenAt,
    attachments: newer.attachments.length ? newer.attachments : older.attachments,
    mediaType: newer.mediaType || older.mediaType };
  merged.contentStatus = merged.text || merged.attachments.length || ['photo', 'video'].includes(merged.mediaType) ? 'available' : 'telegram-only';
  return merged;
}

async function apply(res, persist = true) {
  const v = res?.value;
  validateCapture(v);
  if (state.ok && state.channel !== v.channel) throw new Error('Unexpected Telegram channel; previous archive retained');
  if (state.ok && state.channel === v.channel && !v.posts.length && state.count) throw new Error('Empty Telegram refresh; previous archive retained');
  const rows = v.posts.map((raw) => {
    const id = int(raw?.id), text = str(raw?.text);
    if (!id || (!text && !date(raw.publishedAt))) return null;
    const attachments = (Array.isArray(raw.attachments) ? raw.attachments : [])
      .filter((a) => a?.type === 'document' && str(a.name)).map((a) => ({ type: 'document', name: str(a.name), size: str(a.size) }));
    return { id, key: `tg:${v.channel}:${id}`, text, url: `https://t.me/${v.channel}/${id}`,
      publishedAt: date(raw.publishedAt), firstSeenAt: date(raw.firstSeenAt), attachments,
      mediaType: ['document', 'photo', 'video'].includes(raw.mediaType) ? raw.mediaType : null,
      contentStatus: text || attachments.length || ['photo', 'video'].includes(raw.mediaType) ? 'available' : 'telegram-only' };
  }).filter(Boolean);
  if (rows.length !== v.posts.length) throw new Error('Malformed Telegram posts; previous archive retained');
  // A static fallback or out-of-order response cannot roll back a newer artifact.
  if (state.ok && Date.parse(v.lastRun?.at || v.lastCheckedAt || 0) < Date.parse(state.lastRun?.at || state.lastCheckedAt || 0)) {
    const byId = new Map(state.byId);
    let changed = false;
    for (const row of rows) {
      const current = byId.get(row.id);
      const merged = current ? retainContent(row, current) : row;
      if (JSON.stringify(merged) !== JSON.stringify(current)) { byId.set(row.id, merged); changed = true; }
    }
    if (changed) {
      state = { ...state, ...postMetadata([...byId.values()].sort((a, b) => b.id - a.id), byId) };
      emit();
    }
    if (v.delivery?.degraded || v.delivery?.collectorLatestFailed) {
      state = { ...state, delivery: v.delivery, reason: 'Latest collection unavailable; newer saved archive retained.' };
      retainedCapture = { ...retainedCapture, delivery: v.delivery }; emit();
    }
    if (persist) await persistRetained();
    return;
  }
  const byId = new Map(state.byId);
  for (const row of rows) byId.set(row.id, retainContent(byId.get(row.id), row));
  const posts = [...byId.values()].sort((a, b) => b.id - a.id);
  // Keep additive retained history separate from exact HTTP payloads and their ETags. A valid
  // older fallback may replace the transport cache but cannot erase newer captured rows offline.
  retainedCapture = { ...v, posts };
  state = { loaded: true, ok: true, reason: null, ...postMetadata(posts, byId),
    channel: v.channel, channelUrl: `https://t.me/${v.channel}`, route: str(v.route),
    publishesTime: posts.some((p) => p.publishedAt), capturedAt: date(v.capturedAt),
    lastCheckedAt: date(v.lastCheckedAt), checkedAt: res.checkedAt ? new Date(res.checkedAt).toISOString() : null,
    lastRun: v.lastRun || null, apiSafety: v.apiSafety || null, publicSafety: v.publicSafety || null, latestVerifiedAt: v.route === 'mtproto' ? date(v.latestVerifiedAt) : null, delivery: v.delivery || null, historyNextId: int(v.historyNextId), historyComplete: v.historyComplete === true,
    origin: res.fromStore ? 'store' : 'live', headId: int(v.headId),
    pending: Array.isArray(v.retryIds) ? v.retryIds.length : 0 };
  emit();
  if (persist) await persistRetained();
}
export function load() {
  if (loading) return loading;
  loading = (state.loaded ? Promise.resolve() : hydrateSaved())
    .then(() => conditionalJson(SNAPSHOT, { key: KEYS.telegramPosts, optional: true, validate: validateCapture }))
    .then(async (res) => { await apply(res); return state; })
    .catch((err) => {
      // A temporary or malformed refresh keeps the last usable archive on screen.
      state = { ...state, loaded: true, reason: String(err?.message || err) };
      loading = null; emit(); return state;
    });
  return loading;
}
export async function refresh() {
  const before = new Set(state.byId.keys());
  loading = null; await load();
  try {
    const res = await conditionalJson(LIVE, { key: ARTIFACT_KEY, optional: true, validate: validateCapture });
    if (res.value) await apply(res);
    else if (![404, 405, 501].includes(res.status)) {
      state = { ...state, reason: 'Latest collection unavailable; saved archive retained.' }; emit();
    }
  } catch { state = { ...state, reason: 'Latest collection could not be read; archive retained.' }; emit(); }
  return [...state.byId.keys()].filter((id) => !before.has(id));
}
export const isLoaded = () => state.loaded;
export const posts = () => state.posts;
export const byId = (id) => state.byId.get(Number(id)) || null;
export const meta = () => { const { posts, byId, ...metadata } = state; return metadata; };
// ASKING THE RUNNER TO GO AND READ, BECAUSE NO CLOCK HERE CAN.
//
// Measured over 24 hours on this repository, GitHub delivers 7-9 scheduled runs a DAY whatever the
// cron asks for: telegram-refresh at */30 and corporate-actions at */15 both landed 8, across a
// 4x range of requested density. So a denser expression buys nothing and only makes the workflow
// file dishonest, while `workflow_dispatch` is not throttled at all. The cadence therefore comes
// from the reader opening the tab — the same demand signal market news already runs on.
//
// The source word matters: a refresh nobody pressed is filed as `auto`, because `lastAutomatic` is
// the field that answers whether this feed keeps itself current, and filing an unattended fetch
// under `button` would hide it from the one measurement that can see it.
const DISPATCH_SOURCES = new Set(['button', 'auto', 'cron']);

export async function startScrape(source = 'auto') {
  const word = DISPATCH_SOURCES.has(source) ? source : 'auto';
  try {
    const res = await fetch(`api/telegram/refresh?source=${word}`, { method: 'POST', headers: { accept: 'application/json' } });
    // Read the SHAPE of the reply, not the status. A static origin answers a POST with 501 rather
    // than 404 — measured — and no Worker is not a failure of this feed: the committed capture is
    // exactly as good, there is simply nothing here to ask.
    const body = await res.json().catch(() => null);
    return body && typeof body === 'object' ? body : { ok: false, reason: 'no-worker' };
  } catch {
    return { ok: false, reason: 'no-worker' };
  }
}

export function onChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

export function startLive(live) {
  live.register('telegram-posts', { intervalMs: 60000, fetcher: async () => {
    const arrived = await refresh();
    if (state.reason) throw new Error(state.reason);
    return arrived;
  } });
  live.start('telegram-posts');
  return () => live.stop('telegram-posts');
}
