import { boundedJson } from '../public/js/data/family-book-contract.js';
import { FILINGS_HEALTH_FILES, FILINGS_HEALTH_LIMITS } from '../public/js/data/filings-health-shared.js';
import { CORS } from './http.mjs';
import { exchangeCaptureStatus } from './exchange-deals.mjs';
import { CAPTURE_FILES, CAPTURE_STATUS_FILE, FILINGS_HEALTH_PLAN_FILE, STATUS_BYTES, HEALTH_PLAN_BYTES } from './capture-status-contract.mjs';

const reply = (body, status = 200) => Response.json(body, { status, headers: { ...CORS, 'cache-control': 'no-store', 'x-sattva-status': 'github-prepared' } });
async function prepared(request, env, file, limit, now) {
  // A clean internal asset request cannot forward a reader credential or select
  // another deployment. Static assets belong to this exact uploaded generation.
  const value = await boundedJson(await env.ASSETS.fetch(new Request(new URL(file, request.url))), limit);
  if (value?.version !== 1 || !Number.isFinite(Date.parse(value.preparedAt)) || Date.parse(value.preparedAt) > now) throw Error('Prepared status unavailable');
  return value;
}
export async function handleCaptureStatus(request, env, ctx, { now = Date.now(), exchange = exchangeCaptureStatus } = {}) {
  if (request.method !== 'GET') return reply({ ok: false, reason: 'method' }, 405);
  try {
    const value = await prepared(request, env, CAPTURE_STATUS_FILE, STATUS_BYTES, now);
    if (!value.captures || Object.keys(CAPTURE_FILES).some(name => typeof value.captures[name]?.ok !== 'boolean')) throw Error('Prepared captures unavailable');
    // The exchange artifact can advance independently of the static deployment.
    // Keep its small live identity check; a prepared artifact id could hide news.
    const exchangeDeals = await exchange(request, env);
    return reply({ ok: true, captures: { ...value.captures, exchangeDeals }, servedAt: new Date(now).toISOString(), preparedAt: value.preparedAt, sourceRevision: value.sourceRevision });
  } catch { return reply({ ok: false, reason: 'prepared-status-unavailable' }, 503); }
}
export function healthFromPlan(plan, { now = Date.now() } = {}) {
  const findings = [], sources = Object.keys(FILINGS_HEALTH_FILES);
  for (const source of sources) {
    const steps = plan.sources?.[source];
    if (!Array.isArray(steps) || !steps.length || !Number.isFinite(steps[0].at) || steps[0].at > now) throw Error('Prepared health unavailable');
    let lo = 0, hi = steps.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (steps[mid].at <= now) lo = mid; else hi = mid; }
    if (!Number.isFinite(steps[lo].at) || steps[lo].at > now || !Array.isArray(steps[lo].findings)) throw Error('Prepared health unavailable');
    for (const ref of steps[lo].findings) {
      if (!Array.isArray(ref) || ref.length !== 2 || !Number.isSafeInteger(ref[0]) || !Number.isSafeInteger(ref[1]) || ref[1] < 1) throw Error('Prepared health unavailable');
      const finding = plan.definitions?.[ref[0]];
      if (!finding || !['critical', 'warning'].includes(finding.severity) || typeof finding.source !== 'string' || typeof finding.code !== 'string' || !Array.isArray(finding.affected) || finding.affected.length > 20) throw Error('Prepared health unavailable');
      findings.push({ ...finding, count: ref[1] });
    }
  }
  const critical = findings.filter(f => f.severity === 'critical').length, warnings = findings.length - critical;
  return { version: 1, ok: critical === 0, status: critical ? 'critical' : warnings ? 'degraded' : 'healthy', checkedAt: new Date(now).toISOString(), limits: FILINGS_HEALTH_LIMITS, sources, critical, warnings, findings };
}
export async function handleFilingsHealth(request, env, ctx, { now = Date.now() } = {}) {
  if (request.method !== 'GET') return reply({ ok: false, reason: 'method' }, 405);
  try {
    const value = await prepared(request, env, FILINGS_HEALTH_PLAN_FILE, HEALTH_PLAN_BYTES, now);
    const report = healthFromPlan(value, { now });
    return reply(report, report.ok ? 200 : 503);
  } catch { return reply({ version: 1, ok: false, status: 'critical', reason: 'prepared-health-unavailable', checkedAt: new Date(now).toISOString() }, 503); }
}
