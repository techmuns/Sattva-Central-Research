import { captureIpoFilings } from './ipo-sources.mjs';
import { validateIpoFilings, ipoSourceIsStale } from '../public/js/data/ipo-filings-shared.js';
export async function handleIpoFilings(request, { fetcher = fetch, cache = globalThis.caches?.default, now = Date.now, readBse = null } = {}) {
  const url = new URL(request.url);
  const reply = (body, status = 200, ttl = 0) => Response.json(body, { status, headers: { 'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store', 'x-content-type-options': 'nosniff' } });
  if (request.method !== 'GET') return reply({ ok: false, message: 'IPO filings are read-only.' }, 405);
  if (url.search) return reply({ ok: false, message: 'This is a fixed market-wide filing feed.' }, 400);
  // Internal revision prevents reuse of the old five-minute cached BSE failures after release.
  const key = new Request(`${url.origin}/api/ipo-filings?source-contract=bse-collector-v3`);
  const hit = await cache?.match(key).catch(() => null);
  if (hit) return hit;
  const payload = validateIpoFilings(await captureIpoFilings({ fetcher, now, readBse, signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)]) }));
  const complete = payload.sources.every((s) => s.status === 'ok' && !s.unmapped && !ipoSourceIsStale(s, now()));
  const response = reply(payload, payload.ok ? 200 : 502, payload.ok ? (complete ? 300 : 30) : 0);
  if (payload.ok) await cache?.put(key, response.clone()).catch(() => {});
  return response;
}
