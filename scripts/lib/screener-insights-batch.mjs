// Bounded company reads. A slow or stalled source must leave time for artifact publication.
export function orderInsightTargets(targets, previous = null) {
  const companies = new Map((previous?.companies || []).map(company => [company.companyKey, company]));
  const failed = new Set(previous?.failedKeys || []);
  const lastAttempt = target => Date.parse(companies.get(target.companyKey)?.checkedAt ||
    (failed.has(target.companyKey) ? previous?.checkedAt : '')) || 0;
  return [...targets].sort((a, b) => Number(b.inPortfolio) - Number(a.inPortfolio) ||
    lastAttempt(a) - lastAttempt(b) || a.companyKey.localeCompare(b.companyKey));
}

function abortable(read, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(read).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function collectInsightBatch(targets, readCompany, {
  maxDurationMs = 10 * 60_000, attemptTimeoutMs = 20_000, concurrency = 3,
  maxAttempts = 2, delayMs = 200, progressIntervalMs = 60_000, onProgress = () => {},
} = {}) {
  for (const value of [maxDurationMs, attemptTimeoutMs, concurrency, maxAttempts, progressIntervalMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid Insights batch limit');
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw Error('Invalid Insights batch delay');
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(Error('crawl-deadline')), maxDurationMs);
  const attemptedKeys = new Set();
  const succeeded = [];
  const failedKeys = [];
  const failureCounts = {};
  let cursor = 0;
  const snapshot = () => ({ targets: targets.length, attempted: attemptedKeys.size, succeeded: succeeded.length,
    failed: failedKeys.length, deferred: targets.length - attemptedKeys.size, failureCounts: { ...failureCounts } });
  const progress = () => { try { onProgress(snapshot()); } catch { /* diagnostics cannot discard data */ } };
  const progressTimer = setInterval(progress, progressIntervalMs);
  const pause = ms => new Promise(resolve => {
    if (deadline.signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); deadline.signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    deadline.signal.addEventListener('abort', finish, { once: true });
  });
  const worker = async () => {
    while (cursor < targets.length && !deadline.signal.aborted) {
      const target = targets[cursor++];
      attemptedKeys.add(target.companyKey);
      let success = false;
      let failure = 'read-or-validation';
      for (let attempt = 0; attempt < maxAttempts && !success && !deadline.signal.aborted; attempt++) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(Error('company-timeout')), attemptTimeoutMs);
        const signal = AbortSignal.any([deadline.signal, timeout.signal]);
        try {
          const company = await abortable(() => readCompany(target, { signal }), signal);
          signal.throwIfAborted();
          succeeded.push(company);
          success = true;
        } catch (error) {
          if (['source-blocked', 'session'].includes(error?.message) && !deadline.signal.aborted) deadline.abort(Error('source-blocked'));
          failure = deadline.signal.reason?.message === 'source-blocked' ? 'source-blocked' : deadline.signal.aborted ? 'deadline' : timeout.signal.aborted || error?.name === 'TimeoutError' ? 'timeout' :
            ['response', 'session', 'oversized'].includes(error?.message) ? error.message : 'read-or-validation';
        } finally {
          clearTimeout(timer);
        }
        if (!success && attempt + 1 < maxAttempts) await pause(delayMs);
      }
      if (!success) {
        failedKeys.push(target.companyKey);
        failureCounts[failure] = (failureCounts[failure] || 0) + 1;
      }
      await pause(delayMs);
    }
  };
  progress();
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(progressTimer);
    progress();
  }
  return { succeeded, failedKeys, deferredKeys: targets.filter(target => !attemptedKeys.has(target.companyKey)).map(target => target.companyKey),
    attemptedCount: attemptedKeys.size, deadlineReached: deadline.signal.reason?.message === 'crawl-deadline',
    sourceBlocked: deadline.signal.reason?.message === 'source-blocked', failureCounts };
}
