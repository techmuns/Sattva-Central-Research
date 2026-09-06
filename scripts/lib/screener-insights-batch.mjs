// Sequential bounded company reads. A source refusal stops the run without a login/retry loop.
import { INSIGHTS_STOP_CODES } from '../../public/js/data/screener-insights-state.js';
import { INSIGHTS_COMPANY_PAUSE_MS, INSIGHTS_MAX_COMPANIES_PER_RUN, insightFailureCode } from './screener-insights-control.mjs';
function abortable(read, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(read).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function collectInsightBatch(targets, readCompany, {
  maxDurationMs = 10 * 60_000, attemptTimeoutMs = 30_000, concurrency = 1,
  maxCompanies = INSIGHTS_MAX_COMPANIES_PER_RUN, delayMs = INSIGHTS_COMPANY_PAUSE_MS,
  progressIntervalMs = 60_000, onProgress = () => {}, onCheckpoint = () => {}, signal: externalSignal,
} = {}) {
  for (const value of [maxDurationMs, attemptTimeoutMs, maxCompanies, progressIntervalMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid Insights batch limit');
  }
  if (concurrency !== 1) throw Error('Insights reads must be sequential');
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw Error('Invalid Insights batch delay');
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(Error('crawl-deadline')), maxDurationMs);
  const attemptedKeys = new Set();
  const succeeded = [];
  const failedKeys = [];
  const failures = [];
  const failureCounts = {};
  let stop = null;
  let consecutiveFailures = 0;
  let cursor = 0;
  const batchSignal = externalSignal ? AbortSignal.any([deadline.signal, externalSignal]) : deadline.signal;
  const result = () => ({ succeeded: [...succeeded], failedKeys: [...failedKeys], failures: [...failures],
    deferredKeys: targets.filter(target => !attemptedKeys.has(target.companyKey)).map(target => target.companyKey),
    attemptedCount: attemptedKeys.size, deadlineReached: deadline.signal.aborted, interrupted: batchSignal.aborted,
    sourceBlocked: INSIGHTS_STOP_CODES.includes(stop?.code), stop, failureCounts: { ...failureCounts } });
  const snapshot = () => ({ targets: targets.length, attempted: attemptedKeys.size, succeeded: succeeded.length,
    failed: failedKeys.length, deferred: targets.length - attemptedKeys.size, failureCounts: { ...failureCounts } });
  const progress = () => { try { onProgress(snapshot()); } catch { /* diagnostics cannot discard data */ } };
  const progressTimer = setInterval(progress, progressIntervalMs);
  const pause = ms => new Promise(resolve => {
    if (batchSignal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); batchSignal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    batchSignal.addEventListener('abort', finish, { once: true });
  });
  const worker = async () => {
    while (cursor < targets.length && cursor < maxCompanies && !batchSignal.aborted && !stop) {
      // Include a quiet boundary after login/inventory and before every subsequent company.
      await pause(delayMs);
      if (batchSignal.aborted) break;
      const target = targets[cursor++];
      attemptedKeys.add(target.companyKey);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(Error('company-timeout')), attemptTimeoutMs);
      const signal = AbortSignal.any([batchSignal, timeout.signal]);
      try {
        const company = await abortable(() => readCompany(target, { signal }), signal);
        signal.throwIfAborted();
        succeeded.push(company);
        consecutiveFailures = 0;
      } catch (error) {
        const failure = deadline.signal.aborted ? 'deadline' : externalSignal?.aborted ? 'interrupted'
          : timeout.signal.aborted ? 'timeout' : insightFailureCode(error);
        failedKeys.push(target.companyKey);
        failures.push({ companyKey: target.companyKey, code: failure });
        failureCounts[failure] = (failureCounts[failure] || 0) + 1;
        consecutiveFailures++;
        // A timed-out read may still be closing its page; do not overlap it with a new read.
        if (INSIGHTS_STOP_CODES.includes(failure) || ['timeout', 'internal'].includes(failure) || consecutiveFailures >= 3) stop = { code: failure, retryAt: error?.retryAt || null };
      } finally {
        clearTimeout(timer);
      }
      await onCheckpoint(result());
    }
  };
  progress();
  try {
    await worker();
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(progressTimer);
    progress();
  }
  return result();
}
