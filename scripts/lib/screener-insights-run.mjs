import { mergeScreenerInsightsCapture, validateScreenerInsightsCapture } from '../../public/js/data/screener-insights-shared.js';
import { insightCoolingDown } from '../../public/js/data/screener-insights-state.js';
import { beginInsightState, finishInsightState, insightFailureCode, selectDueInsightTargets } from './screener-insights-control.mjs';
import { collectInsightBatch } from './screener-insights-batch.mjs';

// Dependency injection keeps the actual restore -> cooldown -> login -> checkpoint path testable
// without any account, source request or production workflow dispatch.
export async function runInsightCollection({ restore, openSession, inventory, readCompany, publishCapture, publishState,
  now = Date.now, batchOptions = {}, onProgress = () => {} }) {
  const restored = await restore(); // fail closed: never log in if control-state restore fails
  const previous = restored?.capture || null;
  const oldState = restored?.state || null;
  if (previous) publishCapture(previous);
  if (insightCoolingDown(oldState, now())) {
    publishState(oldState); // no timestamps or cooldown extensions on a no-read run
    return { capture: previous, state: oldState, skipped: true };
  }
  let state = beginInsightState(oldState, now());
  publishState(state);
  let targets = [], fresh = [], waiting = [], unresolved = [];
  let capture = previous;
  let lastBatch = { succeeded: [], failures: [], deferredKeys: [], stop: null };
  const persist = (batch, final = false) => {
    lastBatch = batch;
    const deferred = [...waiting.map(t => t.companyKey), ...batch.deferredKeys];
    state = finishInsightState(oldState, { succeeded: batch.succeeded, failures: batch.failures, deferred, fresh, unresolved,
      targetKeys: targets.map(t => t.companyKey), stop: batch.stop, interrupted: batch.interrupted }, now());
    if (!final && !batch.stop) state = { ...state, outcome: 'running', reason: 'interrupted', cooldownUntil: new Date(now() + 60 * 60_000).toISOString() };
    // Persist the stop first. Losing a data-write cannot erase an observed rate-limit instruction.
    publishState(state);
    if (batch.succeeded.length || previous) {
      const checkedAt = batch.succeeded.at(-1)?.checkedAt || previous.checkedAt;
      const failedKeys = [...unresolved, ...batch.failures.map(f => f.companyKey)];
      const current = { version: 1, sourceId: 'screener-insights', checkedAt, targetCount: targets.length,
        targetKeys: targets.map(t => t.companyKey).sort(), checkedCount: batch.succeeded.length + failedKeys.length,
        failedCount: failedKeys.length, failedKeys, deferredCount: deferred.length, deferredKeys: deferred,
        fullCoverage: failedKeys.length === 0 && batch.succeeded.length === targets.length, companies: batch.succeeded };
      capture = mergeScreenerInsightsCapture(current, previous, now());
      const byKey = new Map(targets.map(t => [t.companyKey, t]));
      capture.companies = capture.companies.map(company => ({ ...company,
        inPortfolio: byKey.get(company.companyKey).inPortfolio, inUniverse: byKey.get(company.companyKey).inUniverse }));
      publishCapture(validateScreenerInsightsCapture(capture, now()));
    }
  };
  try {
    const session = await openSession();
    targets = await inventory(session);
    const plan = selectDueInsightTargets(targets.filter(t => !t.unresolved), previous, oldState, now());
    fresh = plan.fresh;
    waiting = plan.waiting;
    unresolved = targets.filter(t => t.unresolved).map(t => t.companyKey);
    const previousByKey = new Map((previous?.companies || []).map(c => [c.companyKey, c]));
    const batch = await collectInsightBatch(plan.due, (target, options) => readCompany(session, target, new Date(now()).toISOString(),
      { ...options, previousCompany: previousByKey.get(target.companyKey) }), {
      ...batchOptions, onProgress, onCheckpoint: batch => persist(batch),
    });
    persist(batch, true);
    return { capture, state, skipped: false };
  } catch (error) {
    const code = insightFailureCode(error);
    state = finishInsightState(oldState, { succeeded: lastBatch.succeeded, failures: lastBatch.failures,
      deferred: lastBatch.deferredKeys, fresh, unresolved, stop: lastBatch.stop || { code, retryAt: error?.retryAt || null } }, now());
    publishState(state);
    return { capture, state, skipped: false };
  }
}
