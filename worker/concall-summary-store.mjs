import { SUMMARY_WINDOW_MS, SUMMARY_REQUEST_BUDGET, SUMMARY_GAP_MS, SUMMARY_INITIAL_STOP,
  SUMMARY_RECORD_LIMIT, SUMMARY_FAILURES, summaryId, validateSummaryBody } from '../public/js/data/concall-summaries-shared.js';

const iso = at => new Date(at).toISOString();
const json = value => JSON.stringify(value);
const goodTime = value => Number.isFinite(Date.parse(value));
const MINUTE = 60000;

// One durable coordination unit per subscribed Screener account. Public company registries use
// different object names; these tables are initialised only when a summary method is called.
export class ConcallSummaryStore {
  constructor(storage, { now = Date.now, uuid = () => crypto.randomUUID() } = {}) {
    this.storage = storage;
    this.now = now;
    this.uuid = uuid;
  }
  init() {
    if (this.initialised) return;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS summary_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS summary_records (
      id TEXT PRIMARY KEY, isin TEXT NOT NULL, target TEXT NOT NULL, active INTEGER NOT NULL,
      rank INTEGER NOT NULL, published_date TEXT NOT NULL, body TEXT, fetched_at TEXT,
      status TEXT NOT NULL, next_attempt REAL NOT NULL DEFAULT 0)`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS summary_attempts (
      id TEXT PRIMARY KEY, run TEXT NOT NULL, record_id TEXT NOT NULL, token TEXT NOT NULL,
      started REAL NOT NULL, expires REAL NOT NULL, outcome TEXT NOT NULL)`);
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS summary_attempt_time ON summary_attempts(started)');
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS summary_queue ON summary_records(active, rank, next_attempt)');
    this.initialised = true;
  }
  rows(sql, ...args) { this.init(); return this.storage.sql.exec(sql, ...args).toArray(); }
  state() {
    const found = this.rows("SELECT value FROM summary_meta WHERE key = 'state'")[0];
    return found ? JSON.parse(found.value) : { version: 1, discoveryStatus: 'not-started',
      cooldownUntil: SUMMARY_INITIAL_STOP, stopReason: 'rate-limited', holdings: [] };
  }
  putState(value) {
    this.rows("INSERT INTO summary_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", json(value));
  }
  sync(inventory) {
    const at = this.now();
    if (inventory?.version !== 1 || !/^[a-f0-9]{64}$/.test(inventory.portfolioRevision || '') ||
        !goodTime(inventory.portfolioCheckedAt) || !goodTime(inventory.sourceCheckedAt) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(inventory.portfolioAsOf || '') || !goodTime(inventory.portfolioAsOf) ||
        !goodTime(inventory.portfolioWorkbookUploadedAt) ||
        at - Date.parse(inventory.portfolioCheckedAt) > 90000 || Date.parse(inventory.portfolioCheckedAt) > at + MINUTE ||
        at - Date.parse(inventory.sourceCheckedAt) > 30 * MINUTE || Date.parse(inventory.sourceCheckedAt) > at + MINUTE ||
        !Array.isArray(inventory.holdings) || !inventory.holdings.length || inventory.holdings.length > 5000 ||
        !Array.isArray(inventory.targets) || inventory.targets.length > 25000) throw Error('Invalid inventory');
    const holdings = new Set();
    for (const holding of inventory.holdings) {
      if (!/^INE[A-Z0-9]{9}$/.test(holding.isin || '') || holdings.has(holding.isin) ||
          typeof holding.name !== 'string' || !holding.name.trim() || holding.name.length > 200 ||
          !['matched', 'ambiguous-identity', 'no-matching-source-company', 'no-published-summary'].includes(holding.discovery)) throw Error('Invalid holding');
      holdings.add(holding.isin);
    }
    const ids = new Set();
    for (const target of inventory.targets) {
      if (summaryId(target.url) !== target.id || ids.has(target.id) || !holdings.has(target.isin) ||
          typeof target.companyKey !== 'string' || !target.companyKey || target.companyKey.length > 80 ||
          !/^https:\/\/www\.screener\.in\/company\/[^/?#]+\/(?:consolidated\/)?$/.test(target.companyUrl || '') ||
          !/^\d{4}-\d{2}-\d{2}$/.test(target.publishedDate || '') || !goodTime(target.publishedDate) ||
          typeof target.name !== 'string' || !target.name || target.name.length > 200 ||
          typeof target.sourceName !== 'string' || !target.sourceName || target.sourceName.length > 300 ||
          !['Transcript', 'Recording', 'Presentation', 'Other'].includes(target.kind) ||
          !Number.isInteger(target.rank) || target.rank < 0 || target.rank > 25000 || json(target).length > 4000) throw Error('Invalid summary target');
      ids.add(target.id);
    }
    this.init();
    return this.storage.transactionSync(() => {
      const previous = this.state();
      if (Date.parse(inventory.portfolioCheckedAt) < Date.parse(previous.portfolioCheckedAt || '') ||
          Date.parse(inventory.sourceCheckedAt) < Date.parse(previous.sourceCheckedAt || '') ||
          (previous.portfolioAsOf && (inventory.portfolioAsOf < previous.portfolioAsOf ||
            (inventory.portfolioAsOf === previous.portfolioAsOf && Date.parse(inventory.portfolioWorkbookUploadedAt) < Date.parse(previous.portfolioWorkbookUploadedAt)))))
        throw Error('Inventory reconciliation required');
      // Do not load every full target (or any body) into Worker memory to check identities.
      const existing = new Map(this.rows("SELECT id,isin,json_extract(target,'$.companyKey') AS company_key FROM summary_records").map(row => [row.id, row]));
      if (new Set([...existing.keys(), ...ids]).size > SUMMARY_RECORD_LIMIT) throw Error('Summary archive capacity reached');
      for (const target of inventory.targets) {
        const old = existing.get(target.id);
        if (old && (old.isin !== target.isin || old.company_key !== target.companyKey)) throw Error('Source summary identity changed');
      }
      this.rows('UPDATE summary_records SET active=0 WHERE active=1');
      for (const target of inventory.targets) this.rows(`INSERT INTO summary_records(id,isin,target,active,rank,published_date,status)
        VALUES (?,?,?,1,?,?,'queued') ON CONFLICT(id) DO UPDATE SET target=excluded.target,active=1,rank=excluded.rank,published_date=excluded.published_date`,
      target.id, target.isin, json(target), target.rank, target.publishedDate);
      this.putState({ ...previous, ...inventory, targets: undefined, discoveryStatus: 'ok',
        discoveryAttemptedAt: iso(at), discoveredAt: iso(at), discoveryReason: null });
      return this.status();
    });
  }
  discoveryFailed() {
    this.putState({ ...this.state(), discoveryStatus: 'failed', discoveryReason: 'portfolio-or-catalogue-unavailable', discoveryAttemptedAt: iso(this.now()) });
    return this.status();
  }
  status() {
    const at = this.now(), state = this.state();
    const counts = this.rows(`SELECT isin,COUNT(*) AS total,SUM(CASE WHEN body IS NOT NULL THEN 1 ELSE 0 END) AS ready
      FROM summary_records WHERE active=1 GROUP BY isin`);
    const byIsin = new Map(counts.map(row => [row.isin, row]));
    const totals = this.rows('SELECT COUNT(*) AS total,SUM(CASE WHEN body IS NOT NULL THEN 1 ELSE 0 END) AS ready FROM summary_records')[0];
    const attempts = this.rows('SELECT COUNT(*) AS count,MIN(started) AS oldest FROM summary_attempts WHERE started>?', at - SUMMARY_WINDOW_MS)[0];
    return { ...state, discoveryStatus: state.discoveryStatus === 'ok' && at - Date.parse(state.discoveredAt) > 90 * MINUTE ? 'stale' : state.discoveryStatus,
      ready: totals.ready || 0, retained: totals.total, pending: counts.reduce((n, row) => n + row.total - row.ready, 0),
      automatedRequestsLast24h: attempts.count, requestBudget: SUMMARY_REQUEST_BUDGET,
      nextBudgetAt: attempts.count >= SUMMARY_REQUEST_BUDGET ? iso(attempts.oldest + SUMMARY_WINDOW_MS) : null,
      holdings: state.holdings.map(holding => ({ ...holding, ready: byIsin.get(holding.isin)?.ready || 0,
        pending: (byIsin.get(holding.isin)?.total || 0) - (byIsin.get(holding.isin)?.ready || 0) })) };
  }
  reserve(run, requestId) {
    if (!/^\d+:\d+$/.test(run || '') || !/^[a-f0-9-]{36}$/.test(requestId || '')) throw Error('Invalid claim');
    this.init();
    return this.storage.transactionSync(() => {
      const at = this.now(), state = this.state();
      const duplicate = this.rows('SELECT * FROM summary_attempts WHERE id=?', requestId)[0];
      if (duplicate) {
        if (duplicate.run !== run) throw Error('Claim owner mismatch');
        return { ok: true, reserved: false, reason: 'already-attempted' };
      }
      if (Date.parse(state.cooldownUntil) > at) return { ok: true, reserved: false, reason: state.stopReason, retryAt: state.cooldownUntil };
      if (state.discoveryStatus !== 'ok' || at - Date.parse(state.discoveredAt || 0) > 90 * MINUTE)
        return { ok: true, reserved: false, reason: 'inventory-unavailable' };
      if (this.rows("SELECT id FROM summary_attempts WHERE outcome='reserved' AND expires>? LIMIT 1", at).length)
        return { ok: true, reserved: false, reason: 'busy' };
      const attempts = this.rows('SELECT COUNT(*) AS count,MIN(started) AS oldest,MAX(started) AS latest FROM summary_attempts WHERE started>?', at - SUMMARY_WINDOW_MS)[0];
      if (attempts.count >= SUMMARY_REQUEST_BUDGET) return { ok: true, reserved: false, reason: 'daily-budget', retryAt: iso(attempts.oldest + SUMMARY_WINDOW_MS) };
      if (attempts.latest != null && attempts.latest + SUMMARY_GAP_MS > at)
        return { ok: true, reserved: false, reason: 'spacing', retryAt: iso(attempts.latest + SUMMARY_GAP_MS) };
      const record = this.rows(`SELECT * FROM summary_records WHERE active=1 AND body IS NULL AND next_attempt<=?
        ORDER BY rank,published_date DESC,id LIMIT 1`, at)[0];
      if (!record) return { ok: true, reserved: false, reason: 'no-due-summaries' };
      const token = this.uuid();
      // Count before issuing the request. A crash/ambiguous response still consumes its slot and
      // leaves a day-long retry delay; neither a runner restart nor midnight can reset the budget.
      this.rows("INSERT INTO summary_attempts VALUES (?,?,?,?,?,?,'reserved')", requestId, run, record.id, token, at, at + 5 * MINUTE);
      this.rows("UPDATE summary_records SET status='interrupted',next_attempt=? WHERE id=?", at + SUMMARY_WINDOW_MS, record.id);
      return { ok: true, reserved: true, requestId, token, target: JSON.parse(record.target) };
    });
  }
  complete(run, input) {
    const at = this.now();
    const body = input?.outcome === 'ready' ? validateSummaryBody(input.body) : null;
    if (!body && !SUMMARY_FAILURES.has(input?.outcome)) throw Error('Invalid outcome');
    this.init();
    return this.storage.transactionSync(() => {
      const attempt = this.rows('SELECT * FROM summary_attempts WHERE id=?', input.requestId)[0];
      if (!attempt || attempt.run !== run || attempt.token !== input.token) throw Error('Claim owner mismatch');
      if (attempt.outcome !== 'reserved') return { ok: true, saved: attempt.outcome === 'ready', duplicate: true };
      // A late completion can save its original exact-ID body, but cannot replace another result.
      this.rows('UPDATE summary_attempts SET outcome=? WHERE id=?', input.outcome, input.requestId);
      if (body) {
        this.rows("UPDATE summary_records SET body=COALESCE(body,?),fetched_at=COALESCE(fetched_at,?),status='ready' WHERE id=?", json(body), iso(at), attempt.record_id);
      } else {
        this.rows('UPDATE summary_records SET status=?,next_attempt=? WHERE id=? AND body IS NULL', input.outcome,
          at + (input.outcome === 'not-published' ? 7 : 1) * SUMMARY_WINDOW_MS, attempt.record_id);
        if (input.outcome !== 'not-published') {
          const requestedRetry = Date.parse(input.retryAt);
          const retryAt = Number.isFinite(requestedRetry) ? requestedRetry : at;
          const state = this.state();
          this.putState({ ...state, stopReason: input.outcome, stoppedAt: iso(at),
            cooldownUntil: iso(Math.max(at + SUMMARY_WINDOW_MS, retryAt, Date.parse(state.cooldownUntil) || 0)) });
        }
      }
      return { ok: true, saved: !!body };
    });
  }
  read(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10 || ids.some(id => !/^[1-9]\d{0,19}$/.test(id))) throw Error('Invalid summary IDs');
    return [...new Set(ids)].map(id => {
      const row = this.rows('SELECT target,body,fetched_at,status FROM summary_records WHERE id=?', id)[0];
      if (!row) return { id, status: 'not-collected' };
      const target = JSON.parse(row.target);
      return { id, status: row.body ? 'ready' : row.status, name: target.name, ticker: target.ticker,
        publishedDate: target.publishedDate, kind: target.kind, url: target.url, fetchedAt: row.fetched_at,
        ...(row.body ? { body: JSON.parse(row.body) } : {}) };
    });
  }
}
