import { boundedJson } from '../public/js/data/family-book-contract.js';
import { EDITION_IDS, NEWSLETTER_REQUEST_BYTES } from '../public/js/data/newsletter-shared.js';
import { NEWSLETTER_OBJECT } from './newsletter-store.mjs';
import { callerToken } from './muns.mjs';
import { CORS } from './http.mjs';

// GET  /api/newsletter            -> the subscriber list, the schedule, the timer's state, the delivery log
// POST /api/newsletter            -> { intents?: [{ op, email, name, by, editions }], settings?: {…} }
// POST /api/newsletter/send       -> { edition, to: 'me' | 'all', email? }  -> what was sent, per recipient
// GET  /api/newsletter/preview    -> ?edition=morning|evening[&format=text]  -> the brief as it would send now
//
// THE LIST IS SHARED, PRIVATE STATE AND IS NEVER HELD AT THE EDGE. Every response here is
// `no-store`: it names the desk's addresses and it changes the moment somebody subscribes.
//
// A WRITE MUST CARRY OUR OWN ORIGIN, exactly as the shared watchlist's does — `/api/*` answers a
// cross-site preflight with `*`, so a cross-site POST reaches this check and is refused by it.
//
// A SEND MAY CARRY THE READER'S OWN SESSION TOKEN. The Munshot host hands the browser a JWT that
// the email endpoint accepts as readily as the team token, and `authHeaders()` already forwards it
// to our own routes. It fills in only where the Worker holds no `MUNS_TOKEN`, is passed to the
// object as a value for THIS send, and is never stored.

const fail = (reason, status, extra = {}) => Response.json({ ok: false, reason, ...extra }, { status, headers: { 'cache-control': 'no-store', ...CORS } });
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...CORS } });

export const sameOrigin = (request, url) =>
  request.headers.get('origin') === url.origin &&
  (!request.headers.get('sec-fetch-site') || request.headers.get('sec-fetch-site') === 'same-origin');

async function guardWrite(request, env, url) {
  if (!sameOrigin(request, url)) return fail('origin', 403);
  if (!env.NEWSLETTER_LIMITER) return fail('newsletter-unavailable', 503);
  const limit = await env.NEWSLETTER_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  if (!limit.success) {
    return new Response(JSON.stringify({ ok: false, reason: 'rate-limit' }), {
      status: 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60', ...CORS },
    });
  }
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415);
  return null;
}

const pdfHeaders = filename => ({
  'content-type': 'application/pdf',
  'content-disposition': `attachment; filename="${/^sattva-[0-9-]+-(?:morning|evening)-brief\.pdf$/.test(filename || '') ? filename : 'sattva-portfolio-brief.pdf'}"`,
  'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow',
});

export async function handleNewsletter(request, env) {
  const url = new URL(request.url);
  if (!env.NEWSLETTER) return fail('newsletter-unavailable', 503);
  const object = env.NEWSLETTER.getByName(NEWSLETTER_OBJECT);
  const dashboardUrl = String(env.DASHBOARD_ORIGIN || url.origin).replace(/\/+$/, '');

  // Opaque links identify one saved edition. This path never rebuilds, calls sources, or sends.
  if (url.pathname.startsWith('/api/newsletter/pdf/')) {
    if (request.method !== 'GET') return fail('method', 405);
    const id = url.pathname.slice('/api/newsletter/pdf/'.length);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return fail('not-found', 404);
    let document;
    try { document = await object.newsletterPdf(id); } catch { return fail('newsletter-unavailable', 503); }
    if (!document) return fail('not-found', 404);
    return new Response(document.body, { headers: pdfHeaders(document.filename) });
  }

  if (url.pathname === '/api/newsletter/preview') {
    if (request.method !== 'GET') return fail('method', 405);
    const edition = url.searchParams.get('edition') || 'morning';
    if (!EDITION_IDS.includes(edition)) return fail('invalid-edition', 400);
    // Bound preview feed reads. The preview builder never runs paid AI enrichment.
    if (!env.NEWSLETTER_LIMITER) return fail('newsletter-unavailable', 503);
    const allowance = await env.NEWSLETTER_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
    if (!allowance.success) return fail('rate-limit', 429);
    const requested = url.searchParams.get('format');
    const format = ['text', 'pdf'].includes(requested) ? requested : 'html';
    let out;
    try { out = await object.newsletterPreview({ edition, format }); } catch { return fail('newsletter-unavailable', 503); }
    if (!out?.ok) return fail(out?.reason || 'preview-failed', 503);
    if (format === 'pdf') return new Response(out.body, { headers: pdfHeaders(out.filename) });
    return new Response(out.body, {
      headers: {
        'content-type': format === 'text' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'",
        'x-newsletter-subject': encodeURIComponent(out.subject || ''),
        ...CORS,
      },
    });
  }

  if (url.pathname === '/api/newsletter/send') {
    if (request.method !== 'POST') return fail('method', 405);
    const refused = await guardWrite(request, env, url);
    if (refused) return refused;
    let input;
    try { input = await boundedJson(new Response(request.body), NEWSLETTER_REQUEST_BYTES); } catch { return fail('invalid-request', 400); }
    const edition = String(input?.edition || '');
    const to = String(input?.to || '');
    if (!EDITION_IDS.includes(edition) || !['me', 'all'].includes(to)) return fail('invalid-request', 400);
    let out;
    try { out = await object.newsletterSend({ edition, to, email: input?.email ?? null }, env.MUNS_TOKEN ? null : callerToken(request)); }
    catch { return fail('newsletter-unavailable', 503); }
    return reply({ ...out, dashboardUrl }, 200);
  }

  if (url.pathname !== '/api/newsletter') return fail('not-found', 404);
  if (!['GET', 'POST'].includes(request.method)) return fail('method', 405);

  if (request.method === 'GET') {
    try {
      const [snapshot, schedule] = [await object.newsletterSnapshot(), await object.newsletterStatus()];
      return reply({ ok: true, ...snapshot, schedule, dashboardUrl });
    } catch {
      return fail('newsletter-unavailable', 503);
    }
  }

  const refused = await guardWrite(request, env, url);
  if (refused) return refused;
  let input;
  try { input = await boundedJson(new Response(request.body), NEWSLETTER_REQUEST_BYTES); } catch { return fail('invalid-request', 400); }
  const intents = Array.isArray(input?.intents) ? input.intents : null;
  const settings = input?.settings && typeof input.settings === 'object' ? input.settings : null;
  if (!intents && !settings) return fail('invalid-request', 400);
  let result;
  try {
    result = await object.newsletterApply({ intents, settings });
  } catch (error) {
    // A rejected batch is the caller's mistake and says so; a failed object is ours and is retryable.
    const message = String(error?.message || '');
    if (/Invalid newsletter|Duplicate address/.test(message)) return fail('invalid-request', 400, { message: message.replace(/^Invalid newsletter (?:intents?|schedule): /, '') });
    return fail('newsletter-unavailable', 503);
  }
  return reply({ ok: true, ...result.snapshot, outcomes: result.outcomes, settingsChanged: result.settingsChanged, schedule: result.schedule, dashboardUrl });
}
