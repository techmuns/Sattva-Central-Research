import { captureIpoFilings } from './ipo-sources.mjs';
import { validateIpoFilings, mergeIpoFilings, ipoSourceIsStale } from '../public/js/data/ipo-filings-shared.js';
export async function handleIpoFilings(request, { fetcher = fetch, cache = globalThis.caches?.default, now = Date.now, readPlatform = null } = {}) {
  const url = new URL(request.url);
  const reply = (body, status = 200, ttl = 0) => Response.json(body, { status, headers: { 'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store', 'x-content-type-options': 'nosniff' } });
  if (request.method !== 'GET') return reply({ ok: false, message: 'IPO filings are read-only.' }, 405);
  if (url.search) return reply({ ok: false, message: 'This is a fixed market-wide filing feed.' }, 400);
  const key = new Request(`${url.origin}/api/ipo-filings?contract=ipo-platform-v1`);
  const hit = await cache?.match(key).catch(() => null);
  if (hit) return hit;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
  const [payload, platform] = await Promise.all([
    captureIpoFilings({ fetcher, now, signal }),
    readPlatform ? readPlatform({ signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }).catch(() => ({ rows: [], companies: [], source: {
      id: 'ipo-platform', label: 'IPOPlatform catalogue & DRHPs', url: 'https://www.ipoplatform.com/ipo', status: 'failed',
      checkedAt: new Date(now()).toISOString(), count: 0, delivery: 'scheduled',
      note: 'Scheduled capture unavailable. Retained directory and filings are not a fresh confirmation.',
    } })) : null,
  ]);
  if (platform) {
    payload.sources.push(platform.source); payload.rows = mergeIpoFilings(payload.rows, platform.rows);
    payload.companies = platform.companies; payload.ok ||= platform.source.status === 'ok';
  }
  validateIpoFilings(payload);
  const complete = payload.sources.every((s) => s.status === 'ok' && !s.unmapped && !ipoSourceIsStale(s, now()));
  const response = reply(payload, payload.ok ? 200 : 502, payload.ok ? (complete ? 300 : 30) : 0);
  if (payload.ok) await cache?.put(key, response.clone()).catch(() => {});
  return response;
}
