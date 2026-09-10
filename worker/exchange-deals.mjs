import { latestExchangeArtifact } from './exchange-artifact.mjs';
import { CORS, revalidate } from './http.mjs';

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
