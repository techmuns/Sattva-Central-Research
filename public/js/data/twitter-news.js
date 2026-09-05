// data/twitter-news.js — X/Twitter posts, normalised into the EXISTING news article shape.
//
//   twitterNews.load()        the committed capture, from this device first
//   twitterNews.rows()        posts as news articles, newest first, filtered to monitored handles
//   twitterNews.meta()        counts, capture time, when we last checked, where the paint came from
//   twitterNews.refresh()     re-check for a newer capture
//   twitterNews.failedByKey() handles the job could not read, by lower-cased handle
//
// THIS IS NOT A SECOND NEWS SYSTEM. Every post is converted here into the shape
// js/data/market-news.js already produces — `{ id, title, summary, url, image, publishedAt,
// section }` — and joins the same list, the same sort, the same search and the same export. The
// only additions are the fields a table of publisher stories has no use for and a post does:
// `kind: 'twitter'`, the account's display name and its handle. The card renderer branches on
// `kind` and nothing else does.
//
// THE SAME CAPTURE PATTERN AS MARKET NEWS, AND FOR THE SAME REASON. x.com cannot be read from the
// browser or from a Worker, so a scheduled Action reads it and commits `public/data/twitter-posts
// .json`; this module reads that file with one conditional GET. `capturedAt` (when X was last read)
// and `checkedAt` (when this browser last confirmed it holds the newest capture) stay separate,
// because a 304 moves the second and not the first.
//
// A POST IS SOMEBODY'S OWN WORDS AND IS REPRODUCED, NEVER SUMMARISED. The text is theirs, the
// display name is theirs, the link goes to their post. Nothing here scores, ranks, extracts a
// ticker or infers a sentiment — see the scope limits in docs/DATA-CONTRACTS.md.
//
// A HANDLE THE JOB COULD NOT READ IS ABSENT, NOT EMPTY. It goes under `failed` with a reason, which
// is what lets the Twitter Sources screen say "account not found" rather than showing a monitored
// account that simply never posts. Reporting an outage as an absence of posts is the error class
// this codebase keeps closing.

import { conditionalJson, KEYS } from '../core/store.js';
import * as handles from '../core/twitter-handles.js';

const SNAPSHOT = 'data/twitter-posts.json';

/** The one value that marks a row as a post rather than a publisher story, in one place. */
export const SECTION = 'twitter-x';
export const KIND = 'twitter';

let state = fresh();
let loading = null;
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

function fresh() {
  return {
    loaded: false,
    posts: [],
    byId: new Map(),
    failed: new Map(),
    capturedAt: null,
    checkedAt: null,
    baseline: null,
    arrivals: [],
    reason: null,
    message: null,
    origin: null,
    archive: [],
    archived: new Map(),
  };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const httpUrl = (v) => (/^https?:\/\//i.test(String(v || '')) ? String(v) : null);

/**
 * One post -> one article in the existing news shape.
 *
 * `title` is the post's own text, unedited: a tweet has no headline, and writing one would be this
 * dashboard putting words on somebody's post. The card gives the text the headline's weight and
 * clamps it visually, which is a display decision rather than an edit — the full text stays in the
 * row, so search and export see all of it.
 */
export function toArticle(post) {
  const handle = str(post?.handle);
  const id = str(post?.tweet_id) || str(post?.id);
  if (!handle || !id) return null;
  const text = str(post?.text);
  const url = httpUrl(post?.url) || `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(id)}`;
  return {
    // Namespaced so a numeric tweet id can never collide with a Moneycontrol article id in the
    // merged list. Content-derived, never positional — see *Performance on large tables*.
    id: `tw:${id}`,
    tweetId: id,
    kind: KIND,
    handle,
    handleKey: handle.toLowerCase(),
    displayName: str(post?.display_name) || `@${handle}`,
    title: text || '',
    // Deliberately null: the card shows the post's text once. A `summary` repeating it would be
    // the same words twice in one row, and inventing a different standfirst is not on the table.
    summary: null,
    url,
    image: httpUrl(post?.image) || httpUrl(post?.media) || null,
    publishedAt: str(post?.created_at) || null,
    section: SECTION,
    premium: false,
    sourceUrl: httpUrl(post?.source_url) || null,
    matchedQueries: Array.isArray(post?.matchedQueries) ? post.matchedQueries : [],
  };
}

function absorb(body, { fromStore = false } = {}) {
  const list = Array.isArray(body?.posts) ? body.posts : [];
  const next = new Map();
  for (const p of list) {
    const a = toArticle(p);
    if (a) next.set(a.id, a);
  }

  const before = state.byId;
  if (state.baseline === null) {
    state.baseline = new Set(next.keys());
  } else {
    const added = [...next.keys()].filter((k) => !before.has(k) && !state.baseline.has(k));
    if (added.length) state.arrivals = [...added.map((k) => next.get(k)), ...state.arrivals].slice(0, 80);
  }

  state.byId = next;
  state.posts = [...next.values()];
  state.archive = Array.isArray(body?.archive) ? body.archive : [];
  state.failed = new Map(
    (Array.isArray(body?.failed) ? body.failed : [])
      .map((f) => [String(f?.handle || '').toLowerCase(), str(f?.reason) || 'could not be read'])
      .filter(([k]) => k),
  );
  state.capturedAt = str(body?.capturedAt);
  state.origin = fromStore ? 'store' : 'snapshot';
  const collection = body?.collection;
  state.reason = collection?.status && collection.status !== 'ok' ? collection.reason || 'unavailable' : null;
  state.message = collection?.status === 'disabled'
    ? 'X coverage is optional and is not connected.'
    : state.reason ? 'X collection is unavailable or partial. Previously captured posts remain available.' : null;
  return true;
}

async function read() {
  try {
    const res = await conditionalJson(SNAPSHOT, { key: KEYS.twitterPosts, optional: true });
    state.checkedAt = Date.now();
    state.lastReadFailed = !Array.isArray(res?.value?.posts);
    if (!state.lastReadFailed) return absorb(res.value, { fromStore: !!res.fromStore });
    if (!state.posts.length) {
      state.reason = 'no-capture';
      state.message = 'No X capture has been committed yet.';
    }
    return false;
  } catch (err) {
    state.checkedAt = Date.now();
    state.lastReadFailed = true;
    if (!state.posts.length) {
      state.reason = 'unreachable';
      state.message = String(err?.message || err);
    }
    return false;
  }
}

async function readArchive() {
  const queue = state.archive.filter(item => /^twitter-archive\/(?:\d{4}-\d{2}|undated)\.json$/.test(item.file || ''));
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        const result = await conditionalJson(`data/${item.file}`, { key: `twitter-archive:${item.file}`, optional: true });
        if (!Array.isArray(result?.value?.posts)) throw Error('Archive unavailable');
        for (const row of result.value.posts) {
          const article = toArticle(row);
          if (article) state.archived.set(article.id, article);
        }
      } catch {
        state.reason ||= 'archive-unavailable';
        state.message = 'Some retained X history could not be read. Available posts remain visible.';
      }
    }
  }));
}

export function load() {
  if (loading) return loading;
  loading = (async () => {
    // The handle list decides which posts are shown, so both are read before the first paint.
    await Promise.all([read(), handles.load()]);
    await readArchive();
    state.loaded = true;
    emit();
    return state;
  })();
  return loading;
}

/**
 * Posts from handles that are monitored RIGHT NOW.
 *
 * A capture is only rewritten when the job next runs, so removing a handle would otherwise leave
 * its posts on screen until then — a control that appears not to work. Filtering here makes the
 * removal immediate, and re-adding brings them back with no fetch at all.
 */
export function rows() {
  const active = handles.activeKeys();
  return [...new Map([...state.archived.values(), ...state.posts].map(p => [p.id, p])).values()]
    .filter((p) => active.has(p.handleKey) || p.matchedQueries.length)
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
}

export async function refresh() {
  const before = new Set(state.byId.keys());
  await read();
  await readArchive();
  const added = [...state.byId.keys()].filter((k) => !before.has(k)).length;
  emit();
  return { added, total: rows().length, capturedAt: state.capturedAt };
}

export const isLoaded = () => state.loaded;
export const failedByKey = () => state.failed;
export const newArrivals = () => state.arrivals.filter((p) => handles.activeKeys().has(p.handleKey));

/** Post counts per lower-cased handle, for the Twitter Sources screen. */
export function countsByHandle() {
  const out = new Map();
  for (const p of state.posts) out.set(p.handleKey, (out.get(p.handleKey) || 0) + 1);
  return out;
}

export function meta() {
  const visible = rows();
  const captured = Date.parse(state.capturedAt || '');
  const stale = Number.isFinite(captured) && Date.now() - captured > 2 * 3600000;
  return {
    lastReadFailed: !!state.lastReadFailed,
    loaded: state.loaded,
    count: visible.length,
    held: state.posts.length,
    handles: handles.all({ failed: state.failed, collected: !!state.capturedAt }).length,
    failed: state.failed.size,
    capturedAt: state.capturedAt,
    checkedAt: state.checkedAt,
    origin: state.origin,
    reason: state.reason || (stale ? 'stale' : !state.capturedAt ? 'no-capture' : null),
    message: state.message || (stale ? 'X collection is overdue. Previously captured posts remain available.' : null),
  };
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function invalidate() {
  state = fresh();
  loading = null;
}
