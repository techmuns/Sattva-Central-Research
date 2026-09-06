import { INSIGHTS_FAILURE_CODES, INSIGHTS_STOP_CODES, validateInsightState } from '../../public/js/data/screener-insights-state.js';

export const INSIGHTS_COMPANY_PAUSE_MS = 3_000;
export const INSIGHTS_MAX_COMPANIES_PER_RUN = 120;
export const INSIGHTS_PORTFOLIO_DUE_MS = 24 * 60 * 60_000;
export const INSIGHTS_UNIVERSE_DUE_MS = 7 * 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

export function insightError(code, retryAfter = null, now = Date.now()) {
  const error = Error(INSIGHTS_FAILURE_CODES.includes(code) ? code : 'internal');
  error.insightCode = error.message;
  error.retryAt = parseInsightRetryAfter(retryAfter, now);
  return error;
}

export function parseInsightRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const input = value.trim();
  // RFC Retry-After is either a nonnegative integer number of seconds or an HTTP date.
  if (/^\d+$/.test(input)) return Math.min(8.64e15, now + Number(input) * 1000);
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(input)) return null;
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? Math.max(now, parsed) : null;
}

export function insightFailureCode(error) {
  if (INSIGHTS_FAILURE_CODES.includes(error?.insightCode)) return error.insightCode;
  if (error?.name === 'TimeoutError') return 'timeout';
  return 'internal';
}

export function insightResponseError(status, retryAfter = null, now = Date.now()) {
  if (status === 429) return insightError('rate-limited', retryAfter, now);
  if (status === 401) return insightError('session-expired', retryAfter, now);
  if (status === 403) return insightError('access-denied', retryAfter, now);
  if (status >= 500) return insightError('source-unavailable', retryAfter, now);
  if (status < 200 || status >= 400) return insightError('navigation');
  return null;
}

export function selectDueInsightTargets(targets, previous, state, now = Date.now()) {
  const companies = new Map((previous?.companies || []).map(company => [company.companyKey, company]));
  const failures = new Map((state?.failures || []).map(failure => [failure.companyKey, failure]));
  const due = [], waiting = [], fresh = [];
  for (const target of targets) {
    const old = companies.get(target.companyKey);
    const age = now - Date.parse(old?.checkedAt || '');
    if (old && old.readStatus !== 'failed' && age >= 0 && age < (target.inPortfolio ? INSIGHTS_PORTFOLIO_DUE_MS : INSIGHTS_UNIVERSE_DUE_MS)) fresh.push(target);
    else if (Date.parse(failures.get(target.companyKey)?.nextEligibleAt || '') > now) waiting.push(target);
    else due.push(target);
  }
  const attempted = target => Date.parse(failures.get(target.companyKey)?.attemptedAt || companies.get(target.companyKey)?.checkedAt || '') || 0;
  // First close never-read gaps (portfolio first on ties), then oldest due dates. A small daily
  // budget must not spend itself re-reading the same portfolio and starve the universe forever.
  const dueAt = target => {
    const company = companies.get(target.companyKey);
    return company ? Date.parse(company.checkedAt) + (target.inPortfolio ? INSIGHTS_PORTFOLIO_DUE_MS : INSIGHTS_UNIVERSE_DUE_MS) : attempted(target);
  };
  due.sort((a, b) => dueAt(a) - dueAt(b) || Number(b.inPortfolio) - Number(a.inPortfolio) || a.companyKey.localeCompare(b.companyKey));
  return { due, waiting, fresh };
}

export function beginInsightState(previous = null, now = Date.now()) {
  return validateInsightState({ version: 1, attemptedAt: new Date(now).toISOString(), outcome: 'running', reason: 'interrupted',
    // If a runner dies after checkpoint publication, do not immediately repeat its source reads.
    cooldownUntil: new Date(now + HOUR).toISOString(), consecutiveBlocks: previous?.consecutiveBlocks || 0,
    failures: previous?.failures || [], counts: { attempted: 0, succeeded: 0, failed: 0, deferred: 0, skippedFresh: 0, unresolved: 0 } }, now);
}

export function finishInsightState(previous, { succeeded = [], failures = [], deferred = [], fresh = [], unresolved = [], targetKeys, stop = null, interrupted = false }, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const retained = new Map((previous?.failures || []).filter(f => !targetKeys || targetKeys.includes(f.companyKey)).map(f => [f.companyKey, f]));
  for (const company of succeeded) retained.delete(company.companyKey);
  for (const failure of failures) retained.set(failure.companyKey, { companyKey: failure.companyKey, attemptedAt: stamp, reason: failure.code,
    nextEligibleAt: new Date(now + (['structure-changed', 'identity'].includes(failure.code) ? 24 * HOUR : HOUR)).toISOString() });
  const blocked = INSIGHTS_STOP_CODES.includes(stop?.code);
  const consecutiveBlocks = blocked ? Math.min(1000, (previous?.consecutiveBlocks || 0) + 1) : 0;
  const base = stop?.code === 'rate-limited' ? 6 * HOUR : stop?.code === 'source-unavailable' ? HOUR : 24 * HOUR;
  const cooldownUntil = blocked ? new Date(Math.max(now + Math.min(48 * HOUR, base * 2 ** Math.min(4, consecutiveBlocks - 1)), stop.retryAt || 0)).toISOString()
    : stop || interrupted ? new Date(now + HOUR).toISOString() : null;
  return validateInsightState({ version: 1, attemptedAt: stamp, outcome: blocked ? 'blocked' : stop ? 'failed' : interrupted || failures.length || deferred.length || unresolved.length ? 'partial' : 'ok',
    reason: stop?.code || (interrupted ? 'deadline' : failures[0]?.code || null), cooldownUntil, consecutiveBlocks,
    failures: [...retained.values()], counts: { attempted: succeeded.length + failures.length, succeeded: succeeded.length, failed: failures.length,
      deferred: deferred.length, skippedFresh: fresh.length, unresolved: unresolved.length } }, now);
}
