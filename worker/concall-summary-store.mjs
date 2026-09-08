import { SUMMARY_WINDOW_MS, SUMMARY_REQUEST_BUDGET, SUMMARY_GAP_MS, SUMMARY_INITIAL_STOP,
  SUMMARY_RECORD_LIMIT, SUMMARY_FAILURES, SUMMARY_INVENTORY_BATCH, summaryId, validateSummaryBody } from '../public/js/data/concall-summaries-shared.js';

const iso = at => new Date(at).toISOString();
const json = value => JSON.stringify(value);
const goodTime = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
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
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS summary_inventory (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, target TEXT NOT NULL)');
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS summary_attempt_time ON summary_attempts(started)');
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS summary_queue ON summary_records(active, rank, next_attempt)');
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS summary_ready_ids ON summary_records(id) WHERE body IS NOT NULL');
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
  // Convenience for local contracts; production sends the same protocol as bounded RPC batches.
  sync(inventory) {
    if (!Array.isArray(inventory?.targets)) throw Error('Invalid inventory');
    const { targets, ...manifest } = inventory, run = '0:1', syncId = this.uuid();
    this.beginInventory(run, syncId, { ...manifest, targetCount: targets.length });
    for (let offset = 0; offset < targets.length; offset += SUMMARY_INVENTORY_BATCH)
      this.inventoryBatch(run, syncId, offset, targets.slice(offset, offset + SUMMARY_INVENTORY_BATCH));
    return this.finishInventory(run, syncId);
  }
  beginInventory(run, syncId, inventory) {
    const at = this.now();
    if (!/^\d+:\d+$/.test(run || '') || !/^[a-f0-9-]{36}$/.test(syncId || '') ||
        inventory?.version !== 1 || !/^[a-f0-9]{64}$/.test(inventory.portfolioRevision || '') ||
        !goodTime(inventory.portfolioCheckedAt) || !goodTime(inventory.sourceCheckedAt) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(inventory.portfolioAsOf || '') || !goodTime(inventory.portfolioAsOf) ||
        !goodTime(inventory.portfolioWorkbookUploadedAt) ||
        at - Date.parse(inventory.portfolioCheckedAt) > 90000 || Date.parse(inventory.portfolioCheckedAt) > at + MINUTE ||
        at - Date.parse(inventory.sourceCheckedAt) > 30 * MINUTE || Date.parse(inventory.sourceCheckedAt) > at + MINUTE ||
        !Array.isArray(inventory.holdings) || !inventory.holdings.length || inventory.holdings.length > 5000 ||
        !Number.isInteger(inventory.targetCount) || inventory.targetCount < 0 || inventory.targetCount > 25000) throw Error('Invalid inventory');
    const identities = new Set();
    const holdings = inventory.holdings.map(holding => {
      if (!/^INE[A-Z0-9]{9}$/.test(holding.isin || '') || identities.has(holding.isin) ||
          typeof holding.name !== 'string' || !holding.name.trim() || holding.name.length > 200 ||
          /[\u0000-\u001f]/.test(holding.name) ||
          (holding.ticker != null && !/^[A-Z0-9&.\-]{1,50}$/.test(holding.ticker)) ||
          (holding.companyKey != null && !/^[A-Za-z0-9&._\-]{1,80}$/.test(holding.companyKey)) ||
          !['matched', 'ambiguous-identity', 'no-matching-source-company', 'no-published-summary'].includes(holding.discovery)) throw Error('Invalid holding');
      identities.add(holding.isin);
      return { isin: holding.isin, ticker: holding.ticker || null, name: holding.name,
        companyKey: holding.companyKey || null, discovery: holding.discovery };
    });
    const manifest = { version: 1, portfolioRevision: inventory.portfolioRevision, portfolioCheckedAt: inventory.portfolioCheckedAt,
      portfolioAsOf: inventory.portfolioAsOf, portfolioWorkbookUploadedAt: inventory.portfolioWorkbookUploadedAt,
      sourceCheckedAt: inventory.sourceCheckedAt, targetCount: inventory.targetCount, holdings };
    this.init();
    return this.storage.transactionSync(() => {
      const old = this.inventoryStage();
      if (old && old.syncId === syncId && old.run === run) {
        if (json(old.manifest) !== json(manifest)) throw Error('Inventory manifest changed');
        return { ok: true };
      }
      if (old && old.run !== run && at - old.startedAt < 15 * MINUTE) throw Error('Inventory upload is busy');
      this.rows('DELETE FROM summary_inventory');
      this.rows("INSERT INTO summary_meta(key,value) VALUES ('inventory',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        json({ run, syncId, startedAt: at, manifest }));
      this.putState({ ...this.state(), discoveryStatus: 'checking', discoveryAttemptedAt: iso(at) });
      return { ok: true };
    });
  }
  inventoryStage() {
    const row = this.rows("SELECT value FROM summary_meta WHERE key='inventory'")[0];
    return row ? JSON.parse(row.value) : null;
  }
  requireInventory(run, syncId) {
    const stage = this.inventoryStage();
    if (!stage || stage.run !== run || stage.syncId !== syncId || this.now() - stage.startedAt > 15 * MINUTE)
      throw Error('Inventory upload unavailable');
    return stage;
  }
  inventoryBatch(run, syncId, offset, targets) {
    this.init();
    return this.storage.transactionSync(() => {
      const stage = this.requireInventory(run, syncId);
      if (!Number.isInteger(offset) || offset < 0 || offset % SUMMARY_INVENTORY_BATCH !== 0 ||
          !Array.isArray(targets) || !targets.length || targets.length !== Math.min(SUMMARY_INVENTORY_BATCH, stage.manifest.targetCount - offset))
        throw Error('Invalid inventory batch');
      const holdings = new Set(stage.manifest.holdings.map(holding => holding.isin));
      for (const [index, target] of targets.entries()) {
        const value = json(target);
        if (summaryId(target.url) !== target.id || !holdings.has(target.isin) ||
            typeof target.companyKey !== 'string' || !target.companyKey || target.companyKey.length > 80 ||
            !/^https:\/\/www\.screener\.in\/company\/[^/?#]+\/(?:consolidated\/)?$/.test(target.companyUrl || '') ||
            !/^\d{4}-\d{2}-\d{2}$/.test(target.publishedDate || '') || !goodTime(target.publishedDate) ||
            typeof target.name !== 'string' || !target.name || target.name.length > 200 ||
            typeof target.sourceName !== 'string' || !target.sourceName || target.sourceName.length > 300 ||
            !['Transcript', 'Recording', 'Presentation', 'Other'].includes(target.kind) ||
            !Number.isInteger(target.rank) || target.rank < 0 || target.rank > 25000 || new TextEncoder().encode(value).length > 4096)
          throw Error('Invalid summary target');
        const seq = offset + index;
        const old = this.rows('SELECT target FROM summary_inventory WHERE seq=?', seq)[0];
        if (old && old.target !== value) throw Error('Inventory batch changed');
        if (!old) this.rows('INSERT INTO summary_inventory(seq,id,target) VALUES (?,?,?)', seq, target.id, value);
      }
      return { ok: true };
    });
  }
  finishInventory(run, syncId) {
    this.init();
    return this.storage.transactionSync(() => {
      const completed = this.rows("SELECT value FROM summary_meta WHERE key='inventory-complete'")[0];
      if (completed && completed.value === json({ run, syncId })) return this.status();
      const stage = this.requireInventory(run, syncId), inventory = stage.manifest, at = this.now(), previous = this.state();
      if (this.rows('SELECT COUNT(*) AS n FROM summary_inventory')[0].n !== inventory.targetCount) throw Error('Inventory upload is incomplete');
      if (Date.parse(inventory.portfolioCheckedAt) < Date.parse(previous.portfolioCheckedAt || '') ||
          Date.parse(inventory.sourceCheckedAt) < Date.parse(previous.sourceCheckedAt || '') ||
          (previous.portfolioAsOf && (inventory.portfolioAsOf < previous.portfolioAsOf ||
            (inventory.portfolioAsOf === previous.portfolioAsOf && Date.parse(inventory.portfolioWorkbookUploadedAt) < Date.parse(previous.portfolioWorkbookUploadedAt)))))
        throw Error('Inventory reconciliation required');
      const existing = this.rows('SELECT COUNT(*) AS n FROM summary_records')[0].n;
      const added = this.rows('SELECT COUNT(*) AS n FROM summary_inventory i WHERE NOT EXISTS (SELECT 1 FROM summary_records r WHERE r.id=i.id)')[0].n;
      if (existing + added > SUMMARY_RECORD_LIMIT) throw Error('Summary archive capacity reached');
      if (this.rows(`SELECT i.id FROM summary_inventory i JOIN summary_records r ON r.id=i.id
        WHERE r.isin!=json_extract(i.target,'$.isin') OR json_extract(r.target,'$.companyKey')!=json_extract(i.target,'$.companyKey') LIMIT 1`).length)
        throw Error('Source summary identity changed');
      // One atomic SQL publication: partial/duplicate/missing batches cannot retire any record.
      this.rows('UPDATE summary_records SET active=0 WHERE active=1');
      this.rows(`INSERT INTO summary_records(id,isin,target,active,rank,published_date,status)
        SELECT id,json_extract(target,'$.isin'),target,1,json_extract(target,'$.rank'),json_extract(target,'$.publishedDate'),'queued'
        FROM summary_inventory WHERE 1 ON CONFLICT(id) DO UPDATE SET target=excluded.target,active=1,rank=excluded.rank,published_date=excluded.published_date`);
      this.putState({ ...previous, ...inventory, targetCount: undefined, discoveryStatus: 'ok',
        discoveryAttemptedAt: iso(at), discoveredAt: iso(at), discoveryReason: null });
      this.rows("INSERT INTO summary_meta(key,value) VALUES ('inventory-complete',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", json({ run, syncId }));
      this.rows("DELETE FROM summary_meta WHERE key='inventory'");
      this.rows('DELETE FROM summary_inventory');
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
    return { ...state, discoveryStatus: state.discoveryStatus === 'ok' && at - Date.parse(state.discoveredAt) > 90 * MINUTE ? 'stale'
      : state.discoveryStatus === 'checking' && at - Date.parse(state.discoveryAttemptedAt) > 15 * MINUTE ? 'failed' : state.discoveryStatus,
      ready: totals.ready || 0, retained: totals.total, pending: counts.reduce((n, row) => n + row.total - row.ready, 0),
      readyIds: this.rows('SELECT id FROM summary_records WHERE body IS NOT NULL ORDER BY id').map(row => row.id),
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
