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
      if (body.action === 'arm') return reply({ok:true,schedule:await store.breakoutArm()});
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

// Stream the fixed daily file: parsing and hashing its ~3 MB on every request exceeds
// the free Worker's CPU budget. The browser validates it before replacing its daily cache.
async function dailyResponse(source, delivery, ttl, revision = null) {
  const maximum = 16*1024*1024;
  if (!source.ok || Number(source.headers.get('content-length')) > maximum) {
    await source.body?.cancel(); throw Error('Daily file unavailable');
  }
  const reader = source.body?.getReader();
  let bytes = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        if (!reader) throw Error('Daily body unavailable');
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        bytes += next.value.byteLength;
        if (bytes > maximum) { await reader.cancel(); throw Error('Daily file too large'); }
        controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader?.cancel(reason); },
  });
  const headers = {'content-type':'application/json','cache-control':ttl ? `public, max-age=${ttl}` : 'no-store','x-sattva-delivery':delivery};
  if (revision) headers['x-sattva-revision'] = revision;
  if (source.headers.has('etag')) headers.etag = source.headers.get('etag');
  return new Response(body,{headers});
}
const REVISION = /^[a-f0-9]{40}$/;
const DAILY_FILES = {'/api/technicals':'technicals.json','/api/technicals/atr-history':'atr-history.json','/api/technicals/source':'technicals-source.json'};
async function dailyRevision(origin,fetcher,edgeCache) {
  const key=new Request(new URL('/api/technicals/revision',origin));
  try { const cached=await edgeCache?.match(key);if(cached){const value=await boundedJson(cached,2000);if(REVISION.test(value.sha))return value.sha;} } catch { /* Recheck the fixed repository. */ }
  const commits=await boundedJson(await fetcher('https://api.github.com/repos/techmuns/Sattva-Central-Research/commits?path=public%2Fdata%2Ftechnicals.json&per_page=1&sha=main',{
    headers:{accept:'application/vnd.github+json','user-agent':'SattvaResearch'},redirect:'manual',signal:AbortSignal.timeout(10000)}),64000);
  const sha=commits?.[0]?.sha;if(!REVISION.test(sha || ''))throw Error('Daily revision unavailable');
  if(edgeCache)await edgeCache.put(key,Response.json({sha},{headers:{'cache-control':'public, max-age=900'}})).catch(()=>{});
  return sha;
}
export async function handleTechnicals(request, env, { fetcher = fetch, edgeCache = globalThis.caches?.default } = {}) {
  if (request.method !== 'GET') return reply({ ok: false, reason: 'method' }, 405);
  const url=new URL(request.url),file=DAILY_FILES[url.pathname],companion=url.pathname!=='/api/technicals';
  if(!file || (companion && !REVISION.test(url.searchParams.get('revision') || ''))) return reply({ok:false,reason:'daily-revision-required'},400);
  const keyUrl=new URL(url.pathname,url.origin);
  if(companion)keyUrl.searchParams.set('revision',url.searchParams.get('revision'));
  const key = new Request(keyUrl);
  try {
    const cached = await edgeCache?.match(key).catch(()=>null);
    if (cached) return revalidate(request,cached,'edge');
    const revision=companion ? url.searchParams.get('revision') : await dailyRevision(url.origin,fetcher,edgeCache);
    const source = await fetcher(`https://raw.githubusercontent.com/techmuns/Sattva-Central-Research/${revision}/public/data/${file}`, {
      // Workerd supports manual redirects, not redirect:'error'. Non-2xx responses
      // are rejected by dailyResponse; never follow a different source location.
      redirect: 'manual', cache: 'no-cache', signal: AbortSignal.timeout(12000) });
    const response = await dailyResponse(source,'repository',companion ? 86400 : 60,revision);
    if (edgeCache) await edgeCache.put(key,response.clone()).catch(()=>{});
    const result = revalidate(request,response,'repository');
    if (result.status === 304) await response.body.cancel();
    return result;
  } catch {
    if(companion)return reply({ok:false,reason:'daily-companion-unavailable'},503);
    try { return await dailyResponse(await env.ASSETS.fetch(new Request(new URL('/data/technicals.json',request.url))),'deployed-fallback',0); }
    catch { return reply({ok:false,reason:'daily-file-unavailable'},503); }
  }
}
