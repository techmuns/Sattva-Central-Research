// Retained public Telegram messages. Source dates, collector checks and browser reads stay separate.
import { conditionalJson, KEYS } from '../core/store.js';
const SNAPSHOT = 'data/telegram-posts.json';
const str = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
const date = (v) => str(v) && Number.isFinite(Date.parse(v)) ? v : null;
const int = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0;
let state = { loaded: false, ok: false, posts: [], byId: new Map(), count: 0 };
let loading = null;
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

function apply(res) {
  const v = res?.value;
  if (!v || !Array.isArray(v.posts) || !/^[A-Za-z0-9_]{5,32}$/.test(v.channel)) throw new Error('Telegram capture could not be read');
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
  const byId = new Map(rows.map((p) => [p.id, p]));
  const posts = [...byId.values()].sort((a, b) => b.id - a.id);
  const spanFrom = posts.at(-1)?.id || 0, spanTo = posts[0]?.id || 0;
  state = { loaded: true, ok: true, reason: null, posts, byId, count: posts.length,
    channel: v.channel, channelUrl: `https://t.me/${v.channel}`, route: str(v.route),
    publishesTime: posts.some((p) => p.publishedAt), capturedAt: date(v.capturedAt),
    lastCheckedAt: date(v.lastCheckedAt), checkedAt: res.checkedAt ? new Date(res.checkedAt).toISOString() : null,
    lastRun: v.lastRun || null, historyNextId: int(v.historyNextId), historyComplete: v.historyComplete === true,
    origin: res.fromStore ? 'store' : 'live', headId: int(v.headId), spanFrom, spanTo,
    span: spanFrom ? spanTo - spanFrom + 1 : 0,
    readable: posts.length, unreadable: spanFrom ? spanTo - spanFrom + 1 - posts.length : 0,
    pending: Array.isArray(v.retryIds) ? v.retryIds.length : 0,
    limited: posts.filter((p) => p.contentStatus === 'telegram-only').length,
    undated: posts.filter((p) => !p.publishedAt).length };
  emit();
}
export function load() {
  if (loading) return loading;
  loading = conditionalJson(SNAPSHOT, { key: KEYS.telegramPosts, optional: true })
    .then((res) => { apply(res); return state; })
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
  return [...state.byId.keys()].filter((id) => !before.has(id));
}
export const isLoaded = () => state.loaded;
export const posts = () => state.posts;
export const byId = (id) => state.byId.get(Number(id)) || null;
export const meta = () => { const { posts, byId, ...metadata } = state; return metadata; };
export function onChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
