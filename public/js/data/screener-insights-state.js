// Public operational facts only. Never persist browser sessions, response bodies or error text.
export const INSIGHTS_STATE_ARTIFACT = 'screener-insights-state-v1.json.gz';
export const INSIGHTS_STATE_LIMIT = 256 * 1024;
export const INSIGHTS_FAILURE_CODES = Object.freeze([
  'rate-limited', 'access-denied', 'session-expired', 'source-unavailable',
  'navigation', 'structure-changed', 'identity', 'oversized', 'timeout',
  'deadline', 'interrupted', 'inventory', 'configuration', 'internal',
]);
export const INSIGHTS_STOP_CODES = Object.freeze(['rate-limited', 'access-denied', 'session-expired', 'source-unavailable']);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000;
const only = (value, keys) => value && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

export function validateInsightState(state, now = Date.now()) {
  if (!only(state, ['version', 'attemptedAt', 'outcome', 'reason', 'cooldownUntil', 'consecutiveBlocks', 'failures', 'counts']) ||
      state.version !== 1 || !iso(state.attemptedAt) || Date.parse(state.attemptedAt) > now + 60_000 ||
      !['running', 'ok', 'partial', 'blocked', 'failed'].includes(state.outcome) ||
      !(state.reason === null || INSIGHTS_FAILURE_CODES.includes(state.reason)) ||
      !(state.cooldownUntil === null || (iso(state.cooldownUntil) && Date.parse(state.cooldownUntil) >= Date.parse(state.attemptedAt))) ||
      !count(state.consecutiveBlocks) || !Array.isArray(state.failures) || state.failures.length > 1000 ||
      !only(state.counts, ['attempted', 'succeeded', 'failed', 'deferred', 'skippedFresh', 'unresolved']) ||
      Object.keys(state.counts).length !== 6 || !Object.values(state.counts).every(count) ||
      state.counts.attempted !== state.counts.succeeded + state.counts.failed ||
      state.counts.attempted + state.counts.deferred + state.counts.skippedFresh + state.counts.unresolved > 1000 ||
      (['running', 'blocked', 'failed'].includes(state.outcome) && (!state.reason || !state.cooldownUntil)) ||
      (state.outcome === 'blocked' && !INSIGHTS_STOP_CODES.includes(state.reason)) ||
      new Set(state.failures.map(f => f.companyKey)).size !== state.failures.length) throw Error('Invalid Insights collection state');
  for (const failure of state.failures) {
    if (!only(failure, ['companyKey', 'attemptedAt', 'reason', 'nextEligibleAt']) ||
        typeof failure.companyKey !== 'string' || !/^[A-Z0-9&:-]{1,80}$/.test(failure.companyKey) ||
        !iso(failure.attemptedAt) || Date.parse(failure.attemptedAt) > Date.parse(state.attemptedAt) + 60_000 ||
        !INSIGHTS_FAILURE_CODES.includes(failure.reason) || !iso(failure.nextEligibleAt) ||
        Date.parse(failure.nextEligibleAt) < Date.parse(failure.attemptedAt)) throw Error('Invalid Insights failure state');
  }
  return state;
}

export const insightCoolingDown = (state, now = Date.now()) => !!state?.cooldownUntil && Date.parse(state.cooldownUntil) > now;
export const insightCollectionFailed = state => !!state && (['running', 'blocked', 'failed'].includes(state.outcome) || state.counts.failed > 0);
