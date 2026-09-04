import { DurableObject } from 'cloudflare:workers';
import { XChatterEngine } from './x-chatter-engine.mjs';
import { boundedJson } from './x-chatter-api.mjs';

// One coordinated cache for the deployed portfolio; browsers cannot select another tenant/key.
export class XChatterPortfolio extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const store = {
      get: (key) => { const row = sql.exec('SELECT value FROM cache WHERE key = ?', key).toArray()[0]; return row ? JSON.parse(row.value) : null; },
      put: (key, value) => sql.exec('INSERT INTO cache (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)),
      delete: (key) => sql.exec('DELETE FROM cache WHERE key = ?', key),
      entries: (prefix) => sql.exec('SELECT key, value FROM cache WHERE key LIKE ?', `${prefix}%`).toArray().map((r) => [r.key, JSON.parse(r.value)]),
      setAlarm: (at) => ctx.storage.setAlarm(at), deleteAlarm: () => ctx.storage.deleteAlarm(),
    };
    this.engine = new XChatterEngine(store, env);
  }
  snapshot(params) { return this.engine.snapshot(params); }
  start(holdings) { return this.engine.start(holdings); }
  pause() { return this.engine.pause(); }
  remove(ids) { return this.engine.remove(ids); }
  alarm() { return this.engine.alarm(); }
}

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
async function authorised(request, secret) {
  if (!secret || secret.length < 32) return false;
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 512) return false;
  const encode = (value) => new TextEncoder().encode(value);
  const [a, b] = await Promise.all([supplied, `Bearer ${secret}`].map((value) => crypto.subtle.digest('SHA-256', encode(value))));
  return new Uint8Array(a).reduce((diff, byte, i) => diff | (byte ^ new Uint8Array(b)[i]), 0) === 0;
}

export async function handleXChatter(request, env) {
  const url = new URL(request.url);
  if (!['/api/x-chatter', '/api/x-chatter/admin'].includes(url.pathname)) return json({ error: 'not-found' }, 404);
  const admin = url.pathname.endsWith('/admin');
  if (request.method !== (admin ? 'POST' : 'GET')) return json({ error: 'method-not-allowed' }, 405);
  if (admin && !(await authorised(request, env.X_CHATTER_OPERATOR_TOKEN))) return json({ error: 'unauthorised' }, 401);
  if (!env.X_CHATTER) return json({ source: 'X API', status: 'setup-required', companies: [], posts: [], total: 0 });
  const object = env.X_CHATTER.getByName('committed-portfolio-v1');
  try {
    if (!admin) return json(await object.snapshot(Object.fromEntries(url.searchParams)));
    const body = await boundedJson(request, 16000);
    let result;
    if (body.action === 'start') {
      const asset = await env.ASSETS.fetch(new Request(new URL('/data/portfolio-companies.json', url)));
      if (!asset.ok) return json({ error: 'portfolio-unavailable' }, 503);
      const portfolio = await boundedJson(asset, 512000);
      if (!Array.isArray(portfolio.holdings)) return json({ error: 'portfolio-unavailable' }, 503);
      result = await object.start(portfolio.holdings);
    } else if (body.action === 'pause') result = await object.pause();
    else if (body.action === 'remove') result = await object.remove(body.ids);
    else return json({ error: 'unknown-action' }, 400);
    return json(result, result.ok ? 200 : 409);
  } catch (err) {
    // Upstream payloads, headers and secrets must never reach logs or clients.
    return json({ error: err?.code === 'invalid-response' ? 'invalid-request' : 'temporarily-unavailable' }, err?.code === 'invalid-response' ? 400 : 503);
  }
}
