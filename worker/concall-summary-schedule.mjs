import { dispatchWorkflow, latestRun, isInFlight } from './github-actions.mjs';
import { SUMMARY_INTERVAL_MS, SUMMARY_REPO, SUMMARY_WORKFLOW } from '../public/js/data/concall-summaries-shared.js';

const KEY = 'summary-timer';
export class ConcallSummarySchedule {
  constructor(storage, env, { now = Date.now, fetcher = fetch } = {}) {
    this.storage = storage; this.env = env; this.now = now; this.fetcher = fetcher;
  }
  async status() {
    return { ...(await this.storage.get(KEY) || { started: false }), alarmAt: await this.storage.getAlarm() };
  }
  async arm() {
    if (this.env.SCREENER_SUMMARIES_ENABLED !== 'true') return;
    await this.storage.transaction(async tx => {
      const previous = await tx.get(KEY) || {};
      if (!previous.started) await tx.put(KEY, { started: true, nextAt: this.now() + SUMMARY_INTERVAL_MS });
      if (await tx.getAlarm() === null) await tx.setAlarm(Math.max(this.now() + 60000, previous.nextAt || this.now() + SUMMARY_INTERVAL_MS));
    });
  }
  async wake() {
    if (this.env.SCREENER_SUMMARIES_ENABLED !== 'true') {
      await this.storage.put(KEY, { started: false, reason: 'not-enabled' });
      await this.storage.deleteAlarm();
      return;
    }
    const at = this.now();
    const claimed = await this.storage.transaction(async tx => {
      const previous = await tx.get(KEY) || {};
      if (previous.lastAttemptAt && previous.nextAt > at) {
        await tx.setAlarm(previous.nextAt); return false;
      }
      await tx.put(KEY, { ...previous, started: true, lastAttemptAt: at, nextAt: at + SUMMARY_INTERVAL_MS, reason: 'checking' });
      // Save the next alarm before external I/O. Dispatch timeouts cannot erase recovery.
      await tx.setAlarm(at + SUMMARY_INTERVAL_MS);
      return true;
    });
    if (!claimed) return;
    let reason = 'unavailable', runOverdue = false;
    try {
      if (this.env.GH_REPO !== SUMMARY_REPO || (this.env.GH_REF || 'main') !== 'main') throw Error('Configuration unavailable');
      const cfg = { token: this.env.GH_DISPATCH_TOKEN, owner: 'techmuns', repo: 'Sattva-Central-Research', ref: 'main' };
      const recent = (await latestRun(this.fetcher, cfg, SUMMARY_WORKFLOW, { perPage: 1 }))[0];
      const started = Date.parse(recent?.createdAt);
      if (isInFlight(recent) || (Number.isFinite(started) && started > at - SUMMARY_INTERVAL_MS)) {
        runOverdue = isInFlight(recent) && Number.isFinite(started) && at - started > 45 * 60000;
        reason = runOverdue ? 'run-overdue' : isInFlight(recent) ? 'running' : recent?.conclusion === 'success' ? 'recent-run' : 'recent-run-failed';
      } else {
        const result = await dispatchWorkflow(this.fetcher, cfg, SUMMARY_WORKFLOW, 'main', { source: 'durable-timer' });
        reason = result.dispatched ? 'dispatched' : 'running';
      }
    } catch { /* Preserve the saved timer and use a controlled diagnostic only. */ }
    await this.storage.transaction(async tx => {
      const state = await tx.get(KEY);
      if (state?.lastAttemptAt === at) await tx.put(KEY, { ...state, reason, runOverdue });
    });
  }
}
