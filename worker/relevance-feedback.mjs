// THE SHARED RELEVANCE FEEDBACK ROUTES.
//
//   GET  /api/relevance/model            -> the desk's one learned preference (relevance-feedback-shared.js)
//   GET  /api/relevance/mine?device=     -> this browser's own votes, so its controls show what it chose
//   POST /api/relevance/feedback         -> { surface, vote, itemKey, eventKey?, device, features, why?, label?, company?, categories? }
//
// Every Important / Not important vote from Corporate Announcements, News and All Alerts lands on
// one fixed object (relevance-feedback:v1) and trains ONE preference for the whole deployment —
// never a model per person. The model is derived from the votes alone and carries a revision, so a
// reader re-ranks only when it actually changed.
//
// UNAUTHENTICATED, AS EVERY WRITE HERE IS. Only the dashboard's own page may vote (the same-origin
// test the watchlist and the alert notes use), a per-address ceiling sits in front of the object,
// and a vote can only ever replace the same browser's earlier vote on the same item.
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { FEEDBACK_REQUEST_BYTES } from '../public/js/data/relevance-feedback-shared.js';
import { RELEVANCE_FEEDBACK_OBJECT } from './relevance-feedback-store.mjs';

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (reason, status) => json({ ok: false, reason }, status);

export const sameOrigin = (request, url) =>
  request.headers.get('origin') === url.origin &&
  (!request.headers.get('sec-fetch-site') || request.headers.get('sec-fetch-site') === 'same-origin');

const store = (env) => env.CAPTURE_REGISTRY.getByName(RELEVANCE_FEEDBACK_OBJECT);

export async function handleRelevanceFeedback(request, env) {
  const url = new URL(request.url);
  if (!env.CAPTURE_REGISTRY) return fail('feedback-unconfigured', 503);
  if (url.pathname === '/api/relevance/model') {
    if (request.method !== 'GET') return fail('method', 405);
    let model;
    try { model = await store(env).feedbackModel(); } catch (error) {
      console.error('[relevance] the feedback store failed:', error?.message || error);
      return fail('feedback-unavailable', 503);
    }
    // The revision names everything that changes an answer, so it is the validator: an unchanged
    // model costs a reader one bodyless 304.
    const tag = `"${model.revision}"`;
    if (request.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers: { etag: tag, 'cache-control': 'no-cache' } });
    return json({ ok: true, model }, 200, { etag: tag, 'cache-control': 'no-cache' });
  }
  if (url.pathname === '/api/relevance/mine') {
    if (request.method !== 'GET') return fail('method', 405);
    const device = url.searchParams.get('device') || '';
    try { return json(await store(env).feedbackMine(device)); } catch (error) {
      if (/Invalid feedback device/.test(String(error?.message || ''))) return fail('invalid-request', 400);
      console.error('[relevance] the feedback store failed:', error?.message || error);
      return fail('feedback-unavailable', 503);
    }
  }
  if (url.pathname === '/api/relevance/feedback') {
    if (request.method !== 'POST') return fail('method', 405);
    if (!sameOrigin(request, url)) return fail('origin', 403);
    if (!env.RELEVANCE_FEEDBACK_LIMITER) return fail('feedback-unconfigured', 503);
    const limit = await env.RELEVANCE_FEEDBACK_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
    if (!limit.success) return json({ ok: false, reason: 'rate-limited' }, 429, { 'retry-after': '60' });
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415);
    let input;
    try { input = await boundedJson(new Response(request.body), FEEDBACK_REQUEST_BYTES); } catch { return fail('invalid-request', 400); }
    try {
      const result = await store(env).feedbackApply(input);
      return json({ ...result, checkedAt: new Date().toISOString() });
    } catch (error) {
      const message = String(error?.message || '');
      if (/^Invalid feedback/.test(message)) return fail('invalid-request', 400);
      if (/store is full/.test(message)) return fail('full', 507);
      console.error('[relevance] the feedback store failed:', message);
      return fail('feedback-unavailable', 503);
    }
  }
  return fail('not-found', 404);
}
