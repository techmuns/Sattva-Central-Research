import { boundedJson } from '../public/js/data/family-book-contract.js';
import { NOTE_REQUEST_BYTES, NOTE_REQUEST_ITEMS } from '../public/js/data/alert-notes-shared.js';
import { ALERT_NOTES_OBJECT } from './alert-notes-store.mjs';

// POST /api/alert-notes  -> { items: [{ id, kind, company, line, … }] } -> the "So what?" notes
//
// THE ALERTS' SECOND BULLET. The page asks about the developments on screen — at most
// `NOTE_REQUEST_ITEMS` in one request — and the object answers from its store where a note was
// already written and asks the model once for the rest (worker/alert-notes-store.mjs). The model's
// credential is the Worker's `CLAUDE_KEY`, the same Bedrock key Ask Research and the brief use; it
// never reaches the browser.
//
// A FAILURE IS NEVER AN EMPTY NOTE. `ok: false` carries a reason and no `notes` key, and an item the
// model could not be asked about travels under `missing` with its own reason — so a card can say why
// its second bullet is absent instead of drawing nothing, and a reader never mistakes "we could not
// ask" for "there is nothing to say".
//
// ONLY POST, AND ONLY FROM THE DASHBOARD'S OWN PAGE. The answer costs a model request, so nothing a
// prefetcher or a link preview can fire may start one; the same-origin test is the watchlist's.

const fail = (reason, status) => Response.json({ ok: false, reason }, { status, headers: { 'cache-control': 'no-store' } });

const sameOrigin = (request, url) =>
  request.headers.get('origin') === url.origin &&
  (!request.headers.get('sec-fetch-site') || request.headers.get('sec-fetch-site') === 'same-origin');

export async function handleAlertNotes(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return fail('method', 405);
  if (!sameOrigin(request, url)) return fail('origin', 403);
  if (!env.ALERT_NOTES) return fail('notes-unavailable', 503);
  // Unauthenticated, as every write-like route here is: a per-address ceiling well above what a
  // reader scrolling a screen of cards produces, and the object's daily allowance behind it.
  if (!env.ALERT_NOTES_LIMITER) return fail('notes-unavailable', 503);
  const limit = await env.ALERT_NOTES_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  if (!limit.success) {
    return new Response(JSON.stringify({ ok: false, reason: 'rate-limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' },
    });
  }
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415);
  let input;
  try {
    input = await boundedJson(new Response(request.body), NOTE_REQUEST_BYTES);
  } catch {
    return fail('invalid-request', 400);
  }
  const items = input?.items;
  if (!Array.isArray(items) || !items.length || items.length > NOTE_REQUEST_ITEMS) return fail('invalid-request', 400);
  let result;
  try {
    result = await env.ALERT_NOTES.getByName(ALERT_NOTES_OBJECT).alertNotesRead(items);
  } catch (error) {
    if (/Invalid notes request/.test(String(error?.message || ''))) return fail('invalid-request', 400);
    return fail('notes-unavailable', 503);
  }
  return Response.json({ ok: true, ...result, checkedAt: new Date().toISOString() }, { headers: { 'cache-control': 'no-store' } });
}
