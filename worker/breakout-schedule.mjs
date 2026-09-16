import { dispatchWorkflow, latestRun, isInFlight } from './github-actions.mjs';
import { BREAKOUT_INTERVAL_MS, BREAKOUT_WORKFLOW, marketWindow } from '../public/js/data/breakout-live-shared.js';
const KEY = 'breakout-timer';
const TIMER_RUN_TITLE = 'Breakout capture · durable-timer';
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
      await tx.put(KEY, { ...state, started: true, lastAttemptAt: at, nextAt, reason: 'checking' });
      await tx.setAlarm(nextAt); return {lastDispatchAt:state.lastDispatchAt || null};
    });
    if (!claimed) return;
    let reason = 'closed', overdue = false, dueAt = nextAt, lastDispatchAt = claimed.lastDispatchAt;
    if (marketWindow(at).collect) {
      try {
        if (!this.env.GH_DISPATCH_TOKEN || this.env.GH_REPO !== 'techmuns/Sattva-Central-Research' || (this.env.GH_REF || 'main') !== 'main') throw Error('configuration');
        const cfg = { token: this.env.GH_DISPATCH_TOKEN, owner: 'techmuns', repo: 'Sattva-Central-Research', ref: 'main' };
        // Push runs only arm this timer; they never collect quotes.
        const recent = (await latestRun(this.fetcher, cfg, BREAKOUT_WORKFLOW, { perPage: 10 }))
          .find(run => ['schedule', 'workflow_dispatch', 'repository_dispatch'].includes(run.event));
        const createdAt = Date.parse(recent?.createdAt);
        // Timer runs carry a fixed workflow run name. Anchor those to our durable
        // dispatch time, so GitHub's creation delay cannot accumulate each cycle.
        const recentAt = recent?.event === 'workflow_dispatch' && recent.title === TIMER_RUN_TITLE &&
          lastDispatchAt && createdAt >= lastDispatchAt ? lastDispatchAt : createdAt;
        if (isInFlight(recent)) {
          reason = 'running'; overdue = !Number.isFinite(createdAt) || at - createdAt > 30 * 60000;
          dueAt = at + 60000;
        }
        else if (recentAt > at - BREAKOUT_INTERVAL_MS) {
          reason = recent.conclusion === 'success' ? 'recent-run' : 'recent-run-failed'; overdue = recent.conclusion !== 'success';
          // Independent scheduled/manual runs defer only the remaining interval.
          dueAt = Math.max(at + 1000, Math.min(nextAt, recentAt + BREAKOUT_INTERVAL_MS));
        }
        else {
          const result = await dispatchWorkflow(this.fetcher, cfg, BREAKOUT_WORKFLOW, 'main', { source: 'durable-timer' });
          reason = result.dispatched ? 'dispatched' : 'running';
          if (result.dispatched) lastDispatchAt = at;
          overdue = !result.dispatched && at - Date.parse(result.run?.createdAt) > 30 * 60000;
          if (!result.dispatched) dueAt = at + 60000;
        }
      } catch { reason = 'dispatch-unavailable'; overdue = true; }
    }
    await this.storage.transaction(async tx => {
      const state = await tx.get(KEY);
      if (state?.lastAttemptAt === at) {
        await tx.put(KEY, { ...state, nextAt: dueAt, lastDispatchAt, reason, overdue });
        if (dueAt !== nextAt) await tx.setAlarm(dueAt);
      }
    });
  }
}
