import { POOL_CAPTURES, captureRevision } from '../public/js/data/alert-pool-shared.js';

export const CAPTURE_STATUS_FILE = '/data/capture-status.json';
export const FILINGS_HEALTH_PLAN_FILE = '/data/filings-health-plan.json';
export const STATUS_BYTES = 128 * 1024;
export const HEALTH_PLAN_BYTES = 1024 * 1024;
export const CAPTURE_FILES = {
  companyFilings: '/data/filing-capture/index.json',
  companyNews: '/data/news.json',
  insider: '/data/insider-trades.json',
  announcements: '/data/corp-announcements.json',
  corporateActions: '/data/corporate-actions.json',
  technicals: '/data/technicals.json',
  marketNews: '/data/market-news.json',
  ...Object.fromEntries(Object.entries(POOL_CAPTURES).filter(([, source]) => source.path).map(([name, source]) => [name, source.path])),
};

// Preserve the watchdog and alert-pool identity contract. Only delivery changes;
// preparation time is never substituted for a source's own check time.
export function captureStatus(body) {
  const perSource = Array.isArray(body.sources)
    ? Object.fromEntries(body.sources.map(s => [s.id, { capturedAt: s.capturedAt || null, ok: s.ok !== false }]))
    : body.sources && typeof body.sources === 'object'
      ? Object.fromEntries(Object.entries(body.sources).map(([id, source]) => [id, {
        capturedAt: source?.capturedAt || null,
        ok: source?.state ? source.state === 'live' : source?.ok !== false,
      }])) : null;
  return {
    ok: true,
    capturedAt: body.capturedAt || body.generated_at || body.fetchedAt || body.lastRunFinishedAt || null,
    revision: captureRevision(body),
    ...(perSource ? { sources: perSource } : {}),
    covered: Number.isFinite(body.covered) ? body.covered : Number.isFinite(body.company_count) ? body.company_count : null,
    failed: Number.isFinite(body.failedCount) ? body.failedCount : Number.isFinite(body.failures) ? body.failures : null,
    fallback: Number.isFinite(body.fallbackCount) ? body.fallbackCount : 0,
  };
}
