import { SUMMARY_INTERVAL_MS } from '../../public/js/data/concall-summaries-shared.js';

// All wakeups share the workflow mutex and this persisted source/discovery ledger.
// Crossing a cooldown/budget/pace boundary can wake collection before the next cron slot.
export function summaryRefreshPlan(state, { now = Date.now(), force = false } = {}) {
  const checked = Date.parse(state?.discoveryAttemptedAt);
  const eligible = Date.parse(state?.nextSourceAttemptAt);
  const knownCheck = Number.isFinite(checked) && checked <= now;
  const boundary = Number.isFinite(eligible) && eligible > checked && eligible <= now;
  const due = force || !knownCheck || now - checked >= SUMMARY_INTERVAL_MS || boundary;
  const nextCheck = knownCheck ? Math.min(checked + SUMMARY_INTERVAL_MS,
    Number.isFinite(eligible) && eligible > now ? eligible : Infinity) : now;
  return { due, nextCheckAt: new Date(Math.max(now, nextCheck)).toISOString(),
    sourceDue: state?.discoveryStatus === 'ok' && state.pending > 0 && Number.isFinite(eligible) && eligible <= now };
}
