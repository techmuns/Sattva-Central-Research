import { captureIpoFilings } from './ipo-sources.mjs';
import { validateIpoFilings } from '../public/js/data/ipo-filings-shared.js';
import { boundedIpoText, IPO_HEADERS } from './ipo-sources.mjs';
export async function handleIpoFilings(request, { fetcher = fetch, cache = globalThis.caches?.default, now = Date.now } = {}) {
  const url = new URL(request.url);
  // Temporary, fixed-destination diagnostic for this branch preview only. Removed before merge.
  if (url.hostname === 'codex-fix-bse-ipo-fetch-sattva-central-research.tech-441.workers.dev' && url.search === '?probe=bse' && request.method === 'GET') {
    const probes = [
      ['https-documents', 'https://www.bsesme.com/PublicIssues/SMEIPODRHP.aspx'],
      ['https-history', 'https://www.bsesme.com/PublicIssues/PublicIssues.aspx?id=2'],
      ['http-documents', 'http://www.bsesme.com/PublicIssues/SMEIPODRHP.aspx'],
      ['https-root-domain', 'https://bsesme.com/PublicIssues/SMEIPODRHP.aspx'],
      ['https-referer', 'https://www.bsesme.com/PublicIssues/SMEIPODRHP.aspx'],
    ];
    const out = []; let next = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < probes.length) {
        const [name, target] = probes[next++], start = Date.now();
        try {
          const signal = AbortSignal.any([request.signal, AbortSignal.timeout(21000)]);
          const r = await fetcher(target, { redirect: 'manual', signal, headers: name === 'https-referer' ? { ...IPO_HEADERS, referer: 'https://www.bsesme.com/' } : IPO_HEADERS });
          const body = await boundedIpoText(r, signal);
          out.push({ name, status: r.status, ms: Date.now() - start, location: r.headers.get('location'), table: body.includes('ContentPlaceHolder1_gvData'), title: body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim(), bytes: body.length });
        } catch (error) { out.push({ name, ms: Date.now() - start, error: String(error.message).slice(0, 150) }); }
      }
    }));
    return Response.json(out, { headers: { 'cache-control': 'no-store' } });
  }
  const reply = (body, status = 200, ttl = 0) => Response.json(body, { status, headers: { 'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store', 'x-content-type-options': 'nosniff' } });
  if (request.method !== 'GET') return reply({ ok: false, message: 'IPO filings are read-only.' }, 405);
  if (url.search) return reply({ ok: false, message: 'This is a fixed market-wide filing feed.' }, 400);
  const key = new Request(`${url.origin}/api/ipo-filings`);
  const hit = await cache?.match(key).catch(() => null);
  if (hit) return hit;
  const payload = validateIpoFilings(await captureIpoFilings({ fetcher, now, signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)]) }));
  const response = reply(payload, payload.ok ? 200 : 502, payload.ok ? 300 : 0);
  if (payload.ok) await cache?.put(key, response.clone()).catch(() => {});
  return response;
}
