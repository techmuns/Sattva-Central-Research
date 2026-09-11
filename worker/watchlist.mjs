import { boundedJson } from '../public/js/data/family-book-contract.js';
import { WATCHLIST_REQUEST_BYTES } from '../public/js/data/watchlist-shared.js';
import { SHARED_WATCHLIST_OBJECT } from './watchlist-store.mjs';
import { revalidate, tagged, withTag } from './http.mjs';

// GET  /api/watchlist  -> the shared list + the contributor roster, conditionally
// POST /api/watchlist  -> { intents: [{ op, ticker, name, by }] } -> the list as it now stands
//
// THE LIST IS SHARED STATE, SO IT IS NEVER HELD AT THE EDGE.
//   Every other GET here is market data — the same filings, the same books, whoever asks — which
//   is what makes a shared `caches.default` entry safe for them. This one changes the moment
//   somebody stars a company, and a reader on the other side of the country seeing a 60-second-old
//   copy would be looking at a list that no longer exists. So `no-store` for the shared copy, and
//   the saving comes from the ETag instead: an unchanged poll is a bodyless 304 because `revision`
//   only moves when a row actually changed.
//
// WHY A FAILURE IS NEVER AN EMPTY LIST.
//   `ok: false` travels with no `companies` key at all, so a browser cannot read a failed read as
//   a desk that watches nothing. Same rule as `failed` rather than empty books in the investor
//   snapshot and `portfolioUpcoming: null` on the con-call route: a read that did not happen is
//   absent; only a successful read may be empty.

const fail = (reason, status) => Response.json({ ok: false, reason }, { status, headers: { 'cache-control': 'no-store' } });

// A WRITE MUST CARRY OUR OWN ORIGIN — present and matching, not merely "not contradicting".
//
// This is the same test `handleCaptureRegistration` applies, and it matters more here: that route
// enrols public issuer identities, while this one changes a list every reader sees. A missing
// `Origin` is not evidence of a same-origin caller, and `/api/*` answers an OPTIONS preflight with
// `access-control-allow-origin: *`, so a cross-site POST does get as far as this check and has to
// be refused by it. Browsers send `Origin` on every POST, so nothing legitimate is turned away.
const sameOrigin = (request, url) =>
  request.headers.get('origin') === url.origin &&
  (!request.headers.get('sec-fetch-site') || request.headers.get('sec-fetch-site') === 'same-origin');

export async function handleWatchlist(request, env) {
  const url = new URL(request.url);
  if (!['GET', 'POST'].includes(request.method)) return fail('method', 405);
  if (!env.SHARED_WATCHLIST) return fail('watchlist-unavailable', 503);
  const store = env.SHARED_WATCHLIST.getByName(SHARED_WATCHLIST_OBJECT);

  if (request.method === 'GET') {
    let snapshot;
    try {
      snapshot = await store.watchlistSnapshot();
    } catch {
      return fail('watchlist-unavailable', 503);
    }
    // NO `checkedAt` IN THE TAGGED BODY, and that is not a detail.
    //
    // `withTag` hashes the payload minus `VOLATILE_KEYS`, and `checkedAt` is not one of them — so
    // stamping the current time into this body gave every response a different tag while the list
    // was identical, and the 304 this route exists to serve could never fire. Measured before the
    // fix: an unchanged poll carrying a matching If-None-Match still came back 200 with the whole
    // body. The client does not need it either: `conditionalJson` reports when IT checked, which is
    // the honest answer to "when was this confirmed" anyway — a server-stamped time would be the
    // response describing its own freshness.
    const { body, tag } = withTag({ ok: true, ...snapshot });
    // `private` keeps this out of every shared cache — the edge, a proxy, anything that could hand
    // one desk's list to another reader — while still letting the BROWSER keep a copy to revalidate
    // against. That pairing is what makes an unchanged poll cost headers instead of the whole list,
    // and it is why this is not `no-store`: `no-store` forbids the reuse the ETag exists to enable.
    return revalidate(request, tagged(body, tag, 0, { 'cache-control': 'private, max-age=0, must-revalidate' }), 'shared');
  }

  // A write is same-origin only. The read is not restricted the same way — it carries no
  // credential and answers the dashboard's own page — but an edit reaches a list everybody sees.
  if (!sameOrigin(request, url)) return fail('origin', 403);
  // The route is unauthenticated, as every write route here is: this dashboard has no account
  // system to key one on. So the bound on what one caller can do to a shared list is a rate limit,
  // set well above what a person starring companies produces and well below a script's.
  if (!env.SHARED_WATCHLIST_LIMITER) return fail('watchlist-unavailable', 503);
  const limit = await env.SHARED_WATCHLIST_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  if (!limit.success) {
    return new Response(JSON.stringify({ ok: false, reason: 'rate-limit' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' },
    });
  }
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415);

  let input;
  try {
    input = await boundedJson(new Response(request.body), WATCHLIST_REQUEST_BYTES);
  } catch {
    return fail('invalid-request', 400);
  }

  let result;
  try {
    result = await store.watchlistApply(input?.intents);
  } catch (error) {
    // A rejected BATCH is the caller's mistake and says so; a failed OBJECT is ours and is
    // retryable. Collapsing them would send somebody to fix a request that was already correct.
    const message = String(error?.message || '');
    if (/Invalid watchlist|Duplicate company/.test(message)) return fail('invalid-request', 400);
    return fail('watchlist-unavailable', 503);
  }
  return Response.json(
    { ok: true, ...result.snapshot, outcomes: result.outcomes, checkedAt: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
