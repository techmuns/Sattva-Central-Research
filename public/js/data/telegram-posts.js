// data/telegram-posts.js — posts from the monitored public Telegram channel.
//
//   telegram.load()      the committed capture, from this device first
//   telegram.posts()     posts, newest first BY MESSAGE ID
//   telegram.meta()      channel, coverage, capture time, when this browser last checked, origin
//   telegram.refresh()   re-check for a newer capture
//   telegram.onChange()  subscribe to arrivals
//
// THE SAME CAPTURE PATTERN AS MARKET NEWS AND THE X FEED, AND FOR THE SAME REASON. t.me cannot be
// read from the browser — verified with `curl -D-`: it sends no `access-control-allow-origin` at
// all, so a fetch from this page is refused before it starts. It sends no `ETag` and
// `cache-control: no-store` either, so there is no conditional GET to make even from a server. A
// scheduled Action reads it and commits `public/data/telegram-posts.json`; this module reads that
// file with one conditional GET, which DOES revalidate because it is served from our own origin.
//
// `capturedAt` (when Telegram was last read) and `checkedAt` (when this browser last confirmed it
// holds the newest capture) stay separate, because a 304 moves the second and not the first.
//
// THIS FEED PUBLISHES NO TIME, AND THAT IS STATED RATHER THAN PAPERED OVER.
//     The permalink pages the scraper reads carry the post's full text and no timestamp — no
//     `<time>`, no `datetime`, nothing. So `publishedAt` is null on every post, `meta().publishesTime`
//     is false, and the tab prints *Time not published by this feed* in those words. It is never an
//     em dash, which in a date column reads as data we lost, and it is never backfilled from
//     `firstSeenAt` — that is when the SCRAPER saw the post, a fact about us and not about the post,
//     which is why it lives in its own field and never reaches a date cell.
//
//     Ordering is therefore by MESSAGE ID, which increases with publication. Same reasoning as
//     market news merging on Moneycontrol's own article id rather than on a headline.
//
// A POST IS SOMEBODY'S OWN WORDS AND IS REPRODUCED, NEVER SUMMARISED. Nothing here scores, ranks,
// sentiment-tags or extracts a ticker. The table truncates the text to one line at a fixed width
// and carries the whole post in the cell's tooltip; search and export see every word either way. See the scope limits in docs/DATA-CONTRACTS.md.
//
// POSTS CARRY NO COMPANY, SO THEY ARE NOT FILTERED BY ONE — Universe only, exactly as market-wide
// news and the X posts are, and for the same reason: filtering rows that have no ticker BY ticker
// would report "your companies are not being discussed" when the truth is that nothing on the row
// says whose it is.

import { conditionalJson, KEYS } from '../core/store.js';

const SNAPSHOT = 'data/telegram-posts.json';

let state = fresh();
let loading = null;
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

function fresh() {
  return {
    loaded: false,
    ok: false,
    reason: null,
    posts: [],
    byId: new Map(),
    channel: null,
    channelUrl: null,
    route: null,
    publishesTime: false,
    capturedAt: null,
    checkedAt: null,
    origin: null,
    headId: 0,
    spanFrom: 0,
    spanTo: 0,
    pending: 0,
  };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const httpUrl = (v) => (/^https?:\/\//i.test(String(v || '')) ? String(v) : null);

// There is deliberately NO per-post image. `og:image` on a Telegram message page is the channel's
// own avatar rather than the post's media — verified identical across text posts and the channel
// page — so carrying it would put one logo on every row as though each post had a picture.
const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * One capture row -> one post.
 *
 * A row with no id or no text is DROPPED rather than rendered blank: the scraper writes an
 * unreadable id as a coverage count and never as a post, so a textless row here would be a
 * malformed capture, and drawing it would put an empty card on screen that no channel ever posted.
 * That is the "an empty search result is not an article" rule, one feed over.
 */
function normalise(raw) {
  const id = int(raw?.id);
  const text = str(raw?.text);
  if (!id || !text) return null;
  return {
    id,
    // Namespaced so a Telegram id can never collide with a row key from another feed, exactly as
    // the X posts are namespaced `tw:<id>`.
    key: `tg:${id}`,
    text,
    url: httpUrl(raw?.url),
    // Null, always, on this route. Kept as a field so a future route that DOES publish a time
    // fills it without anything downstream changing.
    publishedAt: str(raw?.publishedAt),
    // Ours, not theirs. Never rendered as the post's time.
    firstSeenAt: str(raw?.firstSeenAt),
  };
}

export function load() {
  if (loading) return loading;
  loading = conditionalJson(SNAPSHOT, { key: KEYS.telegramPosts, optional: true })
    .then((res) => {
      apply(res);
      return state;
    })
    .catch((err) => {
      state = { ...fresh(), loaded: true, ok: false, reason: String(err?.message || err) };
      // A FAILED READ IS NOT MEMOISED. `loading` is held so two callers in one tick share a
      // request, which is right for a success — but keeping a FAILURE means the first miss is
      // permanent for the life of the page: every later mount returns the rejected result without
      // asking, and the panel would be promising a retry that could never happen. Clearing it
      // makes the next mount ask again, which is what a reader switching back to the tab expects.
      loading = null;
      emit();
      return state;
    });
  return loading;
}

function apply(res) {
  // A miss is not an empty channel. `optional: true` returns null where the file is absent, and
  // rendering that as "this channel has posted nothing" would report our own missing capture as
  // somebody else's silence.
  if (!res || !res.value) {
    state = {
      ...fresh(),
      loaded: true,
      ok: false,
      reason: res?.status === 404 ? 'no-capture' : 'unreachable',
      checkedAt: res?.checkedAt || null,
    };
    // Same reason as the catch above: a miss must not be cached as though it were an answer. The
    // scheduled job commits the capture between one visit and the next, so "no capture yet" is a
    // state this page should be able to leave without a reload.
    loading = null;
    emit();
    return;
  }

  const v = res.value;
  const posts = (Array.isArray(v.posts) ? v.posts : [])
    .map(normalise)
    .filter(Boolean)
    .sort((a, b) => b.id - a.id);

  state = {
    loaded: true,
    ok: true,
    reason: null,
    posts,
    byId: new Map(posts.map((p) => [p.id, p])),
    channel: str(v.channel),
    channelUrl: httpUrl(v.channelUrl),
    route: str(v.route),
    // Read from the capture rather than assumed, because it is the ROUTE that decides whether a
    // time exists at all.
    publishesTime: v.publishesTime === true,
    capturedAt: str(v.capturedAt),
    checkedAt: res.checkedAt ? new Date(res.checkedAt).toISOString() : null,
    origin: res.fromStore ? 'store' : 'live',
    headId: int(v.headId),
    // DERIVED HERE, from the capture's own span, and never read from a tally. `spanFrom`/`spanTo`
    // are the lowest and highest message ids this capture holds; everything between them that is
    // not a post is an id this route could not read. That is a fact about the range on screen and
    // it cannot drift with the size of the last walk.
    spanFrom: int(v.spanFrom) || (posts.length ? posts[posts.length - 1].id : 0),
    spanTo: int(v.spanTo) || (posts.length ? posts[0].id : 0),
    // Ids a run could not FETCH, carried by the scraper so they are re-asked. They sit inside the
    // span and so are already counted as unreadable, but they are OUR failure rather than the
    // channel's silence, and the two should be separable rather than merely both admitted to.
    pending: Array.isArray(v.retryIds) ? v.retryIds.length : 0,
  };
  emit();
}

/**
 * Re-check for a newer capture.
 *
 * Returns the ids that ARRIVED, never a count. The capture is capped, so a new post pushes the
 * oldest off the end and the LENGTH DOES NOT MOVE — comparing sizes is the trap that had the news
 * Fetch button announcing "nothing new to publish" over a story that had genuinely landed.
 */
export async function refresh() {
  const before = new Set(state.byId.keys());
  loading = null;
  await load();
  return [...state.byId.keys()].filter((id) => !before.has(id));
}

export const isLoaded = () => state.loaded;
export const posts = () => state.posts;
export const byId = (id) => state.byId.get(Number(id)) || null;

export const meta = () => ({
  ok: state.ok,
  reason: state.reason,
  loaded: state.loaded,
  channel: state.channel,
  channelUrl: state.channelUrl,
  route: state.route,
  publishesTime: state.publishesTime,
  capturedAt: state.capturedAt,
  checkedAt: state.checkedAt,
  origin: state.origin,
  headId: state.headId,
  count: state.posts.length,
  // Coverage over the span this capture actually holds. `span` is every message id between the
  // oldest and newest post inclusive; `readable` is how many of them carried text. The remainder
  // are ids that answered with no post text — caption-less documents and deleted messages, which
  // this route genuinely cannot tell apart, so neither claim is made about them.
  spanFrom: state.spanFrom,
  spanTo: state.spanTo,
  span: state.spanFrom && state.spanTo ? state.spanTo - state.spanFrom + 1 : 0,
  readable: state.posts.length,
  unreadable:
    state.spanFrom && state.spanTo ? Math.max(0, state.spanTo - state.spanFrom + 1 - state.posts.length) : 0,
  // Of that `unreadable` figure, how many are ids a run could not fetch and will be re-asked —
  // ours, not the channel's. Normally zero, because a transport failure usually resolves on the
  // retry; when it is not zero the footnote says so rather than letting our own gap read as the
  // channel's silence.
  pending: state.pending,
});

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
