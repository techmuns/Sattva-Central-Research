import { dispatchWorkflow, isInFlight, latestRun, TELEGRAM_WORKFLOW } from './github-actions.mjs';

export const TELEGRAM_INTERVAL_MS = 10 * 60 * 1000;
// The workflow has a 15-minute execution timeout; also allow 15 minutes for queueing.
export const TELEGRAM_RUN_OVERDUE_MS = 30 * 60 * 1000;
export const TELEGRAM_SCHEDULER_NAME = 'researchreportss-main-v1';
export const TELEGRAM_PRODUCTION_HOST = 'sattva-central-research.tech-441.workers.dev';
const KEY = 'schedule';
const REPO = 'techmuns/Sattva-Central-Research';
const REASONS = new Set(['unauthorised', 'forbidden', 'rate-limited', 'refused', 'not-found', 'invalid-runs', 'unreachable']);
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const activeRun = (run, previous, at) => isInFlight(run) ? {
  id: run.id, status: run.status,
  createdAt: Number.isFinite(Date.parse(run.createdAt)) ? run.createdAt : null,
  firstObservedAt: previous?.id === run.id ? previous.firstObservedAt : iso(at),
} : null;
const overdue = (run, at) => !!run && at - Date.parse(run.createdAt || run.firstObservedAt) > TELEGRAM_RUN_OVERDUE_MS;

// One object coordinates this channel's timer and reader requests. Durable claims precede all
// external I/O: replaying an alarm or losing a POST response must not immediately dispatch again.
export class TelegramSchedule {
  constructor(storage, env, { fetcher = fetch, now = Date.now } = {}) {
    this.storage = storage;
    this.env = env;
    this.fetcher = fetcher;
    this.now = now;
  }

  async status() {
    // Read the actual alarm with its intended deadline. A GET never repairs or arms anything.
    const { state, alarm } = await this.storage.transaction(async tx => ({
      state: await tx.get(KEY) || {}, alarm: await tx.getAlarm(),
    }));
    return { enabled: state.enabled === true, intervalSeconds: TELEGRAM_INTERVAL_MS / 1000,
      alarmAt: iso(alarm),
      nextAttemptAt: iso(state.nextAttemptAt), lastAttemptAt: iso(state.lastAttemptAt),
      lastResult: state.lastResult || 'not-started', reason: state.reason || null,
      failures: state.failures || 0, activeRun: state.activeRun || null,
      runOverdue: overdue(state.activeRun, this.now()) };
  }

  async finish(claim, values, nextAttemptAt = claim + TELEGRAM_INTERVAL_MS) {
    await this.storage.transaction(async tx => {
      const state = await tx.get(KEY);
      // A delayed response cannot overwrite a later durable claim.
      if (state?.lastAttemptAt !== claim) return;
      await tx.put(KEY, { ...state, ...values, nextAttemptAt });
      await tx.setAlarm(nextAttemptAt);
    });
  }

  async request(source = 'auto') {
    source = ['cron', 'auto', 'button'].includes(source) ? source : 'button';
    if (this.env.TELEGRAM_SCHEDULER_DISABLED === 'true') {
      await this.storage.transaction(async tx => {
        const state = await tx.get(KEY) || {};
        await tx.put(KEY, { ...state, enabled: false, nextAttemptAt: null, activeRun: null, lastResult: 'disabled', reason: 'operator-disabled' });
        await tx.deleteAlarm();
      });
      return { ok: false, dispatched: false, reason: 'operator-disabled' };
    }

    const at = this.now();
    const claimed = await this.storage.transaction(async tx => {
      const state = await tx.get(KEY) || {};
      if (state.enabled && state.nextAttemptAt > at) {
        // Also repairs a lost alarm without moving an existing deadline forward on every visit.
        if (await tx.getAlarm() === null) await tx.setAlarm(state.nextAttemptAt);
        return false;
      }
      await tx.put(KEY, { ...state, enabled: true, lastAttemptAt: at,
        nextAttemptAt: at + TELEGRAM_INTERVAL_MS, lastResult: 'checking', reason: null });
      await tx.setAlarm(at + TELEGRAM_INTERVAL_MS);
      return true;
    });
    if (!claimed) return { ok: true, dispatched: false, reason: 'cooling-down', cooldownS: TELEGRAM_INTERVAL_MS / 1000 };

    try {
      if (this.env.GH_REPO !== REPO || (this.env.GH_REF || 'main') !== 'main' || !this.env.GH_DISPATCH_TOKEN)
        throw Object.assign(new Error('Scheduler configuration unavailable'), { code: 'configuration' });
      // Request parameters and preview configuration can never choose the destination or API host.
      const cfg = { token: this.env.GH_DISPATCH_TOKEN, owner: 'techmuns', repo: 'Sattva-Central-Research', ref: 'main' };
      const recent = (await latestRun(this.fetcher, cfg, TELEGRAM_WORKFLOW, { perPage: 1 }))[0];
      const started = Date.parse(recent?.createdAt);
      if (Number.isFinite(started) && started > at - TELEGRAM_INTERVAL_MS && started <= at + 60000) {
        const failed = recent.status === 'completed' && recent.conclusion !== 'success';
        await this.finish(at, { lastResult: failed ? 'recent-run-failed' : 'recent-run',
          reason: failed ? 'latest-run-failed' : null, failures: 0, activeRun: activeRun(recent, null, at) },
        Math.max(at + 60000, started + TELEGRAM_INTERVAL_MS));
        return { ok: !failed, dispatched: false, reason: failed ? 'latest-run-failed' : 'cooling-down', run: recent, cooldownS: TELEGRAM_INTERVAL_MS / 1000 };
      }
      const out = await dispatchWorkflow(this.fetcher, cfg, TELEGRAM_WORKFLOW, 'main', { source });
      const previous = await this.storage.get(KEY) || {};
      const running = activeRun(out.run, previous.activeRun, at);
      const stalled = overdue(running, at);
      const reason = out.dispatched ? 'dispatched' : 'already-running';
      // Keep exclusion and the next check, but never describe an indefinitely queued run as
      // healthy. Recovery does not cancel jobs or bypass approval/account-review gates.
      await this.finish(at, { lastResult: stalled ? 'blocked' : reason, reason: stalled ? 'run-overdue' : null,
        failures: 0, activeRun: running });
      return { ok: !stalled, dispatched: out.dispatched, reason: stalled ? 'run-overdue' : reason, run: out.run,
        workflow: TELEGRAM_WORKFLOW, source, requestedAt: iso(at) };
    } catch (error) {
      const state = await this.storage.get(KEY) || {};
      const failures = Math.min(10, (state.failures || 0) + 1);
      const reason = error?.code === 'configuration' ? 'configuration' : REASONS.has(error?.code) ? error.code : 'upstream';
      // Publish a bounded reason, never upstream error text, headers or credentials. An outage
      // retains a future alarm rather than exhausting Cloudflare's six immediate retries.
      await this.finish(at, { lastResult: 'failed', reason, failures }, at + Math.min(3600000, TELEGRAM_INTERVAL_MS * 2 ** (failures - 1)));
      return { ok: false, dispatched: false, reason, message: 'Telegram collection could not be started. The background timer will retry.' };
    }
  }
}
