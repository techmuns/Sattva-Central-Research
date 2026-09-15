import { dispatchWorkflow, latestRun, isInFlight } from './github-actions.mjs';
import { BREAKOUT_INTERVAL_MS, BREAKOUT_WORKFLOW, marketWindow } from '../public/js/data/breakout-live-shared.js';
const KEY = 'breakout-timer';
export class BreakoutSchedule {
  constructor(storage, env, { now = Date.now, fetcher = fetch } = {}) { this.storage = storage; this.env = env; this.now = now; this.fetcher = fetcher; }
  async status() {
    const state = await this.storage.get(KEY) || {started:false};
    const alarmAt = await this.storage.getAlarm();
    return {...state, alarmAt, overdue: state.overdue === true || (state.started && (alarmAt === null || this.now() > state.nextAt + 120000))};
  }
  async arm() {
    await this.storage.transaction(async tx => {
      const state = await tx.get(KEY);
      if (!state) await tx.put(KEY, { started: true, nextAt: this.now() + BREAKOUT_INTERVAL_MS });
      if (await tx.getAlarm() === null) await tx.setAlarm(Math.max(this.now() + 60000, state?.nextAt || this.now() + BREAKOUT_INTERVAL_MS));
    });
  }
  async wake() {
    const at = this.now(), nextAt = at + BREAKOUT_INTERVAL_MS;
    const claimed = await this.storage.transaction(async tx => {
      const state = await tx.get(KEY) || {};
      if (state.lastAttemptAt && state.nextAt > at) { await tx.setAlarm(state.nextAt); return false; }
      await tx.put(KEY, { started: true, lastAttemptAt: at, nextAt, reason: 'checking' });
      await tx.setAlarm(nextAt); return true;
    });
    if (!claimed) return;
    let reason = 'closed', overdue = false;
    if (marketWindow(at).collect) {
      try {
        if (!this.env.GH_DISPATCH_TOKEN || this.env.GH_REPO !== 'techmuns/Sattva-Central-Research' || (this.env.GH_REF || 'main') !== 'main') throw Error('configuration');
        const cfg = { token: this.env.GH_DISPATCH_TOKEN, owner: 'techmuns', repo: 'Sattva-Central-Research', ref: 'main' };
        // Push runs only arm this timer; they never collect quotes.
        const recent = (await latestRun(this.fetcher, cfg, BREAKOUT_WORKFLOW, { perPage: 10 }))
          .find(run => ['schedule', 'workflow_dispatch', 'repository_dispatch'].includes(run.event));
        if (isInFlight(recent)) { reason = 'running'; overdue = at - Date.parse(recent.createdAt) > 30 * 60000; }
        else if (Date.parse(recent?.createdAt) > at - BREAKOUT_INTERVAL_MS) { reason = recent.conclusion === 'success' ? 'recent-run' : 'recent-run-failed'; overdue = recent.conclusion !== 'success'; }
        else {
          const result = await dispatchWorkflow(this.fetcher, cfg, BREAKOUT_WORKFLOW, 'main', { source: 'durable-timer' });
          reason = result.dispatched ? 'dispatched' : 'running';
          overdue = !result.dispatched && at - Date.parse(result.run?.createdAt) > 30 * 60000;
        }
      } catch { reason = 'dispatch-unavailable'; overdue = true; }
    }
    await this.storage.transaction(async tx => {
      const state = await tx.get(KEY);
      if (state?.lastAttemptAt === at) await tx.put(KEY, { ...state, reason, overdue });
    });
  }
}
