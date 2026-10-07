// POST /api/announcement-read  { id, url, sourceUrls, title, company, ticker, date, … } -> one AI Read
//
// CORPORATE ANNOUNCEMENTS ONLY, AND ONLY WHEN A READER ASKS. Nothing is read upfront: a click on a
// filing opens the popup and the popup asks for that one filing. The object
// (worker/announcement-read-store.mjs) answers from its store when the document was read before, and
// reads it in full otherwise. ONLY POST, AND ONLY FROM THE DASHBOARD'S OWN PAGE — the answer can cost
// a model request, so nothing a prefetcher or a link preview can fire may start one.
//
// A FAILURE IS NEVER AN EMPTY READING. `state: 'failed'` carries a reason the popup states in words,
// and the popup keeps the exchange's own subject, details and the Open Original Filing link either way.
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { READ_REQUEST_BYTES } from '../public/js/data/announcement-read-shared.js';
import { ANNOUNCEMENT_READ_OBJECT } from './announcement-read-store.mjs';
import { sameOrigin } from './relevance-feedback.mjs';

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (reason, status) => json({ ok: false, reason }, status);

export async function handleAnnouncementRead(request, env) {
  const url = new URL(request.url);
  if (!env.CAPTURE_REGISTRY) return fail('read-unconfigured', 503);
  if (url.pathname === '/api/announcement-read/status') {
    if (request.method !== 'GET') return fail('method', 405);
    try { return json(await env.CAPTURE_REGISTRY.getByName(ANNOUNCEMENT_READ_OBJECT).announcementReadStatus()); } catch { return fail('read-unavailable', 503); }
  }
  if (request.method !== 'POST') return fail('method', 405);
  if (!sameOrigin(request, url)) return fail('origin', 403);
  if (!env.ANNOUNCEMENT_READ_LIMITER) return fail('read-unconfigured', 503);
  const limit = await env.ANNOUNCEMENT_READ_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  if (!limit.success) return json({ ok: false, reason: 'rate-limited-local' }, 429, { 'retry-after': '60' });
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415);
  let input;
  try { input = await boundedJson(new Response(request.body), READ_REQUEST_BYTES); } catch { return fail('invalid-request', 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid-request', 400);
  let result;
  try {
    result = await env.CAPTURE_REGISTRY.getByName(ANNOUNCEMENT_READ_OBJECT).announcementRead(input);
  } catch (error) {
    console.error('[announcement-read] the read store failed:', error?.message || error);
    return fail('read-unavailable', 503);
  }
  if (result?.ok === false) return fail(result.reason || 'read-unavailable', result.reason === 'invalid-request' ? 400 : 503);
  return json({ ...result, checkedAt: new Date().toISOString() });
}
