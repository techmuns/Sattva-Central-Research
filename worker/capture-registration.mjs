import { createAnnouncementIdentity, mergeExchangeIdentities } from '../public/js/data/announcement-identity.js';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { CAPTURE_REGISTRY_SHARDS, CAPTURE_REGISTRATION_BATCH, captureRegistryShard, registeredCompany } from '../public/js/data/capture-registration-shared.js';

const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const shard = (env, i) => env.CAPTURE_REGISTRY.getByName(`requested-company-capture:${i}`);
async function identities(request, env) {
  const read = async path => boundedJson(await env.ASSETS.fetch(new Request(new URL(path, request.url))), 2 * 1024 * 1024);
  const results = await Promise.allSettled([read('/data/announcement-identities.json'), read('/data/filing-capture/nse-identities.json')]);
  const bse = results[0].status === 'fulfilled' ? results[0].value.entries || [] : [];
  const nse = results[1].status === 'fulfilled' ? results[1].value.directories || {} : {};
  const entries = mergeExchangeIdentities(bse, nse.sme?.entries || [], nse.equity?.entries || []);
  if (!entries.length) throw new Error('Exchange identities unavailable');
  return createAnnouncementIdentity(entries);
}
export async function handleCaptureRegistration(request, env) {
  if (!['GET', 'POST'].includes(request.method)) return reply({ ok: false, reason: 'method' }, 405);
  if (!env.CAPTURE_REGISTRY) return reply({ ok: false, reason: 'registry-unavailable' }, 503);
  try {
    if (request.method === 'GET') {
      const companies = (await Promise.all(Array.from({ length: CAPTURE_REGISTRY_SHARDS }, (_, i) => shard(env, i).list()))).flat();
      return reply({ ok: true, version: 1, checkedAt: new Date().toISOString(), count: companies.length, companies });
    }
    // This endpoint enrolls public issuer identities, never a caller's account or watchlist record.
    if (request.headers.get('origin') !== new URL(request.url).origin ||
        (request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) return reply({ ok: false, reason: 'origin' }, 403);
    if (!env.CAPTURE_REGISTRATION_LIMITER) return reply({ ok: false, reason: 'registry-unavailable' }, 503);
    const limit = await env.CAPTURE_REGISTRATION_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
    if (!limit.success) return new Response(JSON.stringify({ ok: false, reason: 'rate-limit' }), { status: 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' } });
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return reply({ ok: false, reason: 'content-type' }, 415);
    let body;
    try { body = await boundedJson(new Response(request.body), 8192); } catch { return reply({ ok: false, reason: 'invalid-request' }, 400); }
    if (!Array.isArray(body?.tickers) || !body.tickers.length || body.tickers.length > CAPTURE_REGISTRATION_BATCH || body.tickers.some(t => typeof t !== 'string' || !/^[A-Z0-9&._-]{1,50}$/.test(t))) return reply({ ok: false, reason: 'invalid-request' }, 400);
    const index = await identities(request, env), resolved = new Map(), unresolved = [];
    for (const ticker of new Set(body.tickers)) {
      const hit = index.find(/^\d{6}$/.test(ticker) ? { scripCode: ticker } : { ticker });
      if (!hit) { unresolved.push(ticker); continue; }
      resolved.set(ticker, registeredCompany({ isin: hit.isin, ticker: hit.ticker || hit.bseSymbol, name: hit.name }));
    }
    const groups = new Map();
    for (const company of resolved.values()) {
      const group = captureRegistryShard(company.isin);
      if (!groups.has(group)) groups.set(group, new Map());
      groups.get(group).set(company.isin, company);
    }
    const writes = await Promise.allSettled([...groups].map(async ([i, group]) => shard(env, i).register([...group.values()])));
    const accepted = new Set(writes.filter(r => r.status === 'fulfilled').flatMap(r => r.value.accepted));
    const full = new Set(writes.filter(r => r.status === 'fulfilled').flatMap(r => r.value.full));
    const registered = [], pending = [], capacity = [];
    for (const [ticker, company] of resolved) {
      if (accepted.has(company.isin)) registered.push(ticker);
      else if (full.has(company.isin)) capacity.push(ticker);
      else pending.push(ticker);
    }
    // Only durable acknowledgements are reported as registered; failed shards remain retryable.
    return reply({ ok: true, registered, unresolved, pending, capacity });
  } catch { return reply({ ok: false, reason: 'registry-unavailable' }, 503); }
}
