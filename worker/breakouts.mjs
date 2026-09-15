import { BREAKOUT_ORIGIN, BREAKOUT_OBJECT, liveCoverage } from '../public/js/data/breakout-live-shared.js';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { breakoutCollectorIdentity } from './breakout-auth.mjs';
import { withTag, tagged, revalidate } from './http.mjs';
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function conditional(request, payload, age = 0) {
  const { body, tag } = withTag(payload);
  return revalidate(request, tagged(body, tag, age), 'capture');
}

export async function handleBreakouts(request, env, { fetcher = fetch, now = Date.now, identity = breakoutCollectorIdentity, edgeCache = globalThis.caches?.default } = {}) {
  const url = new URL(request.url);
  if (!env.CAPTURE_REGISTRY) return reply({ ok: false, reason: 'storage-unavailable' }, 503);
  const store = env.CAPTURE_REGISTRY.getByName(BREAKOUT_OBJECT);
  if (url.pathname === '/api/breakouts/collector') {
    if (request.method !== 'POST') return reply({ ok: false, reason: 'method' }, 405);
    if (url.origin !== BREAKOUT_ORIGIN) return reply({ ok: false, reason: 'collector-origin' }, 403);
    let run;
    try { run = await identity(request, { fetcher, now: now() }); }
    catch { return reply({ ok: false, reason: 'collector-identity' }, 403); }
    try {
      const body = await boundedJson(new Response(request.body), 2 * 1024 * 1024);
      if (body.action === 'begin') return reply(await store.breakoutBegin(run, body.targets, body.discoveryFailed));
      if (body.action === 'checkpoint') return reply(await store.breakoutCheckpoint(run, body.rows, body.failures));
      if (body.action === 'recovery') return reply(await store.breakoutRecovery(run,body.ticker,body.from,body.to,body.rows));
      if (body.action === 'finish') return reply(await store.breakoutFinish(run));
      return reply({ ok: false, reason: 'invalid-action' }, 400);
    } catch { return reply({ ok: false, reason: 'checkpoint-unavailable' }, 503); }
  }
  if (request.method !== 'GET') return reply({ ok: false, reason: 'method' }, 405);
  try {
    const cacheKey = new Request(new URL('/api/breakouts', request.url));
    if (url.pathname === '/api/breakouts' && edgeCache) {
      const cached = await edgeCache.match(cacheKey);
      if (cached) return revalidate(request,cached,'edge');
    }
    if (url.pathname === '/api/breakouts/history') return reply(await store.breakoutHistory(url.searchParams.get('ticker'), url.searchParams.get('before')));
    const capture = await store.breakoutRead();
    const health = liveCoverage(capture, capture.targets || [], now());
    const schedule = await store.breakoutScheduleStatus();
    if (url.pathname === '/api/breakouts/health') return reply({ ...health, runId: capture.runId, captureStartedAt: capture.captureStartedAt, schedule }, health.partial || !health.total || schedule.overdue ? 503 : 200);
    const {body,tag} = withTag({...capture,health,schedule});
    const response = tagged(body,tag,30);
    if (edgeCache) await edgeCache.put(cacheKey,response.clone()).catch(()=>{});
    return revalidate(request,response,'capture');
  } catch { return reply({ ok: false, reason: 'capture-unavailable' }, 503); }
}

// Read current main data without coupling price delivery to a website rebuild. The URL and file
// are fixed; credentials are never forwarded. A failed read keeps its separately dated fallback.
export async function handleTechnicals(request, env, { fetcher = fetch } = {}) {
  if (request.method !== 'GET') return reply({ ok: false, reason: 'method' }, 405);
  try {
    const response = await fetcher('https://raw.githubusercontent.com/techmuns/Sattva-Central-Research/main/public/data/technicals.json', {
      redirect: 'error', cache: 'no-cache', signal: AbortSignal.timeout(12000) });
    const data = await boundedJson(response, 16 * 1024 * 1024);
    if (!Array.isArray(data.companies) || !data.companies.length || !Number.isFinite(Date.parse(data.generated_at))) throw Error('Invalid technicals capture');
    return conditional(request, { ...data, delivery: 'repository' }, 30);
  } catch {
    const data = await boundedJson(await env.ASSETS.fetch(new Request(new URL('/data/technicals.json', request.url))), 16 * 1024 * 1024);
    return reply({ ...data, delivery: 'deployed-fallback', deliveryFailed: true });
  }
}
