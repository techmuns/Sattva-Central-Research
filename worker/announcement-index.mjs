// THE CORPORATE ANNOUNCEMENTS INDEX ROUTES — the browser's one door to the server-side index
// (worker/announcement-index-store.mjs, one fixed object on the provisioned CaptureRegistry class).
//
//   POST /api/announcement-index/query    { period, scope, companies?, categories?, mcap?, q?, company?, offset?, limit? }
//                                         -> one ranked page, the total, and the category / size facets
//   GET  /api/announcement-index/event?id=&first=&last=   -> every filing stitched into one event
//   GET  /api/announcement-index/profiles -> market cap, size band and sector group per company (ranking input)
//   GET  /api/announcement-index/status   -> which build is served, how fresh, what it holds
//
// THE ROUTE ONLY VALIDATES. The public Worker's CPU budget is milliseconds; decoding and ranking a
// month of filings happens in the object, which keeps decoded days warm between readers.
//
// A FAILED READ IS NEVER AN EMPTY PAGE. With no build published yet (or the object unreachable) the
// answer is `ok: false, reason: 'index-unavailable'` — and the browser reads the captures itself,
// exactly as it did before this index existed. Nothing here ever answers "no announcements" for a
// question it could not ask.
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { contentTag, stableJson } from './http.mjs';
import { ANNOUNCEMENT_INDEX_OBJECT } from './announcement-index-store.mjs';
import { sameOrigin } from './relevance-feedback.mjs';

export const QUERY_REQUEST_BYTES = 256 * 1024;
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (reason, status, message = null) => json({ ok: false, reason, ...(message ? { message } : {}) }, status);
const index = (env) => env.CAPTURE_REGISTRY.getByName(ANNOUNCEMENT_INDEX_OBJECT);

async function limited(request, env) {
  if (!env.ANNOUNCEMENT_INDEX_LIMITER) return false;
  const limit = await env.ANNOUNCEMENT_INDEX_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  return !limit.success;
}

// The object answers a failure as `{ ok: false, reason, message }` rather than throwing: an RPC
// error crosses the boundary with its message only, and the reason is what the browser acts on.
function failure(result) {
  if (result.reason === 'invalid-request') return fail('invalid-request', 400, result.message || null);
  return fail('index-unavailable', 503, String(result.message || 'The announcement index is not available'));
}
const answer = (result, ok) => (result?.ok === false ? failure(result) : ok(result));

/** A conditional JSON answer: the body's own content tag is the validator. */
function conditional(request, payload, maxAge) {
  const tag = `"${contentTag(stableJson(payload))}"`;
  const headers = { etag: tag, 'cache-control': `private, max-age=${maxAge}` };
  if (request.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers });
  return json(payload, 200, headers);
}

export async function handleAnnouncementIndex(request, env) {
  const url = new URL(request.url);
  if (!env.CAPTURE_REGISTRY) return fail('index-unavailable', 503, 'This deployment has no index object');
  const path = url.pathname.slice('/api/announcement-index/'.length);
  try {
    if (path === 'query') {
      if (request.method !== 'POST') return fail('method', 405);
      if (!sameOrigin(request, url)) return fail('origin', 403);
      if (await limited(request, env)) return json({ ok: false, reason: 'rate-limited' }, 429, { 'retry-after': '30' });
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415);
      let input;
      try { input = await boundedJson(new Response(request.body), QUERY_REQUEST_BYTES); } catch { return fail('invalid-request', 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid-request', 400);
      return answer(await index(env).annIndexQuery(input), (result) => json(result));
    }
    if (request.method !== 'GET') return fail('method', 405);
    if (await limited(request, env)) return json({ ok: false, reason: 'rate-limited' }, 429, { 'retry-after': '30' });
    if (path === 'event') {
      const id = url.searchParams.get('id') || '';
      const result = await index(env).annIndexEvent(id, { first: url.searchParams.get('first'), last: url.searchParams.get('last') });
      return answer(result, (body) => conditional(request, body, 300));
    }
    if (path === 'profiles') return answer(await index(env).annIndexProfiles(), (body) => conditional(request, body, 900));
    if (path === 'status') return json(await index(env).annIndexStatus());
  } catch (error) {
    console.error('[announcement-index] the index object failed:', error?.message || error);
    return fail('index-unavailable', 503, 'The announcement index could not be read');
  }
  return fail('not-found', 404);
}
