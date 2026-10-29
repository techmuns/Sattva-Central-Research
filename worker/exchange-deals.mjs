import { latestExchangeArtifact, latestExchangeArtifactInfo } from './exchange-artifact.mjs';
import { CORS, revalidate } from './http.mjs';
import { boundedJson } from '../public/js/data/family-book-contract.js';

const STATUS_TTL_S = 30;

/** Verify the input a cold bulk/block read would select without transferring its entire archive. */
export async function exchangeCaptureStatus(request, env, { fetchImpl = fetch, cache = caches.default, now = Date.now() } = {}) {
  try {
    const held = await cache.match(new Request(new URL('/api/bulk-block-deals', request.url)));
    if (held) {
      const artifactId = Number(/^"exchange-(\d+)"$/.exec(held.headers.get('etag') || '')?.[1]);
      // A cached Response may be a tee (for example in a local cache adapter); cancellation of
      // one branch need not settle until its sibling is consumed. Do not hold status behind it.
      void held.body?.cancel().catch(() => {});
      // A cached fallback is exactly what the route is serving. It cannot stand in for an artifact.
      return Number.isSafeInteger(artifactId) && artifactId > 0
        ? { ok: true, capturedAt: null, artifactId }
        : { ok: false, capturedAt: null, artifactId: null, reason: 'retained-fallback' };
    }
    // Keep the former status route's 30-second upstream budget independently of
    // prepared files. Always prefer the actual served bulk response above.
    const key = new Request(new URL(`/api/_exchange-status-v1/${encodeURIComponent(env.GH_REPO || '')}`, request.url));
    try {
      const hit = await cache.match(key);
      if (hit) {
        const value = await boundedJson(hit, 4096), status = value?.status;
        if (Number.isFinite(value?.checkedAt) && value.checkedAt <= now && now - value.checkedAt < STATUS_TTL_S * 1000 &&
          status?.capturedAt === null && (status.ok === true && Number.isSafeInteger(status.artifactId) && status.artifactId > 0 ||
            status.ok === false && status.artifactId === null && ['no-artifact', 'unverified'].includes(status.reason))) return status;
      }
    } catch { /* An unavailable metadata cache must not prevent a bounded live check. */ }
    let status;
    try {
      const artifact = await latestExchangeArtifactInfo({ repo: env.GH_REPO, token: env.GH_DISPATCH_TOKEN, fetchImpl,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]) });
      status = artifact ? { ok: true, capturedAt: null, artifactId: artifact.id }
        : { ok: false, capturedAt: null, artifactId: null, reason: 'no-artifact' };
    } catch { status = { ok: false, capturedAt: null, artifactId: null, reason: 'unverified' }; }
    try { await cache.put(key, Response.json({ checkedAt: now, status }, { headers: { 'cache-control': `max-age=${STATUS_TTL_S}` } })); }
    catch { /* Cache storage is an optimization; retain the verified result or honest failure. */ }
    return status;
  } catch {
    // Status is a small, bounded check. Failure cannot make the pool current or advance a date.
    return { ok: false, capturedAt: null, artifactId: null, reason: 'unverified' };
  }
}

export async function handleExchangeDeals(request, env, ctx, { fetchImpl = fetch, cache = caches.default } = {}) {
  if (request.method !== 'GET') return new Response('Use GET', { status: 405, headers: { allow: 'GET' } });
  const key = new Request(new URL('/api/bulk-block-deals', request.url));
  const hit = await cache.match(key);
  if (hit) return answer(request, hit, 'hit');
  let response;
  try {
    const latest = await latestExchangeArtifact({ repo: env.GH_REPO, token: env.GH_DISPATCH_TOKEN, fetchImpl, compressed: true });
    if (!latest) throw new Error('No scheduled exchange archive yet');
    // The producer validates the complete capture; the reader verifies its signed artifact digest.
    // Deliver gzip unchanged: parsing and hashing a year of JSON at the edge wastes CPU/memory.
    response = new Response(latest.gzip, { encodeBody: 'manual', headers: { ...CORS, 'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip', etag: `"exchange-${latest.id}"`, 'cache-control': 'public, max-age=300' } });
  } catch (error) {
    console.log(`[exchange-deals] retained fallback: ${error.message}`);
    const fallback = await env.ASSETS.fetch(new Request(new URL('/data/exchange-deals.json', request.url)));
    if (!fallback.ok) return Response.json({ error: 'Exchange capture unavailable' }, { status: 503 });
    const headers = new Headers(fallback.headers);
    for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
    headers.set('access-control-expose-headers', 'etag, x-sattva-exchange-fallback');
    headers.set('x-sattva-exchange-fallback', '1');
    headers.set('cache-control', 'public, max-age=60');
    response = new Response(fallback.body, { headers });
  }
  const saved = response.clone();
  ctx.waitUntil(cache.put(key, new Response(saved.body, { headers: saved.headers, encodeBody: 'manual' })));
  return answer(request, response, 'miss');
}

function answer(request, response, state) {
  const out = revalidate(request, response, state);
  // Cache API responses lose the constructor's encodeBody setting. Reapply it after cloning.
  return out.status !== 304 && out.headers.get('etag')?.startsWith('"exchange-')
    ? new Response(out.body, { status: out.status, headers: out.headers, encodeBody: 'manual' }) : out;
}
