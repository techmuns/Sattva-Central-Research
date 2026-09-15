import { BREAKOUT_BATCH, BREAKOUT_LIMIT, validateQuote, tickerValid, recoverySlots } from '../public/js/data/breakout-live-shared.js';

// One fixed object's SQLite tables. Every acknowledged observation survives a later failure.
export class BreakoutStore {
  constructor(storage, { now = Date.now } = {}) { this.storage = storage; this.now = now; }
  init() {
    const sql = this.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_runs (id TEXT PRIMARY KEY, started INTEGER NOT NULL, manifest TEXT NOT NULL, completed TEXT)');
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_quotes (run TEXT NOT NULL, ticker TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run,ticker))');
    sql.exec('CREATE INDEX IF NOT EXISTS breakout_quote_history ON breakout_quotes(ticker,at DESC,run DESC)');
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_recovered (ticker TEXT NOT NULL, at INTEGER NOT NULL, run TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(ticker,at,run))');
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_gaps (ticker TEXT NOT NULL, since INTEGER NOT NULL, until INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(ticker,since))');
    sql.exec('CREATE INDEX IF NOT EXISTS breakout_gap_pending ON breakout_gaps(reason,until,ticker)');
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_latest (ticker TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS breakout_failures (run TEXT NOT NULL, ticker TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(run,ticker))');
  }
  begin(run, targets, discoveryFailed = false) {
    this.init();
    if (!Array.isArray(targets) || !targets.length || targets.length > BREAKOUT_LIMIT || targets.some(t => !tickerValid(t)) || new Set(targets).size !== targets.length) throw Error('Invalid capture inventory');
    if (!/^\d+:\d+$/.test(run)) throw Error('Invalid run');
    const manifest = JSON.stringify({ targets: [...targets].sort(), discoveryFailed: discoveryFailed === true });
    return this.storage.transactionSync(() => {
      const old = this.storage.sql.exec('SELECT manifest FROM breakout_runs WHERE id=?', run).toArray()[0];
      if (old && old.manifest !== manifest) throw Error('Capture inventory changed');
      this.storage.sql.exec('INSERT OR IGNORE INTO breakout_runs VALUES(?,?,?,NULL)', run, this.now(), manifest);
      return { ok: true };
    });
  }
  checkpoint(run, rows = [], failures = []) {
    this.init();
    if (!Array.isArray(rows) || !Array.isArray(failures) || rows.length + failures.length > BREAKOUT_BATCH) throw Error('Invalid capture batch');
    const scan = this.storage.sql.exec('SELECT * FROM breakout_runs WHERE id=?', run).toArray()[0];
    if (!scan) throw Error('Capture has not begun');
    const targets = new Set(JSON.parse(scan.manifest).targets);
    const clean = rows.map(row => validateQuote(row, this.now()));
    const reasons = new Set(['unavailable', 'stale', 'rate-limited', 'no-base', 'unmapped', 'authentication']);
    if (clean.some(row => row.kind !== 'quote' || !targets.has(row.ticker)) || failures.some(row => !targets.has(row.ticker) || !reasons.has(row.reason))) throw Error('Unknown capture target');
    return this.storage.transactionSync(() => {
      for (const row of clean) {
        // Replay is identical; a conflicting payload must use another run, preserving evidence.
        const payload = JSON.stringify(row);
        const prior = this.storage.sql.exec('SELECT payload FROM breakout_quotes WHERE run=? AND ticker=?', run, row.ticker).toArray()[0];
        if (scan.completed && !prior) throw Error('Capture already completed');
        if (prior && prior.payload !== payload) throw Error('Conflicting checkpoint replay');
        this.storage.sql.exec('INSERT OR IGNORE INTO breakout_quotes VALUES(?,?,?,?)', run, row.ticker, Date.parse(row.quoteAt), payload);
        const latest = this.storage.sql.exec('SELECT at FROM breakout_latest WHERE ticker=?',row.ticker).toArray()[0];
        const until = Date.parse(row.quoteAt);
        if (latest && recoverySlots(Math.max(latest.at,until-5*86400000),until).length >= 2)
          this.storage.sql.exec("INSERT OR IGNORE INTO breakout_gaps VALUES(?,?,?,'unrecovered')",row.ticker,latest.at,until);
        this.storage.sql.exec('INSERT INTO breakout_latest VALUES(?,?,?) ON CONFLICT(ticker) DO UPDATE SET at=excluded.at,payload=excluded.payload WHERE excluded.at>=breakout_latest.at', row.ticker, Date.parse(row.quoteAt), payload);
        this.storage.sql.exec('DELETE FROM breakout_failures WHERE run=? AND ticker=?', run, row.ticker);
      }
      for (const row of failures) {
        if (scan.completed) continue;
        if (!this.storage.sql.exec('SELECT 1 FROM breakout_quotes WHERE run=? AND ticker=?', run, row.ticker).toArray().length)
          this.storage.sql.exec('INSERT OR REPLACE INTO breakout_failures VALUES(?,?,?)', run, row.ticker, row.reason);
      }
      return { ok: true, saved: clean.length };
    });
  }
  recovery(run, ticker, from, to, observations = []) {
    this.init();
    const scan = this.storage.sql.exec('SELECT manifest FROM breakout_runs WHERE id=?', run).toArray()[0];
    if (!scan || !JSON.parse(scan.manifest).targets.includes(ticker) || !Number.isFinite(from) || !Number.isFinite(to) || to > this.now() || from >= to || to-from > 7*86400000 || observations.length > 50) throw Error('Invalid recovery');
    const rows = observations.map(row => validateQuote(row, this.now()));
    const slots = new Set(recoverySlots(from, to));
    if (rows.some(row => row.ticker !== ticker || row.kind !== 'recovered-candle' || !slots.has(Date.parse(row.quoteAt)))) throw Error('Invalid recovery candle');
    return this.storage.transactionSync(() => {
      for (const row of rows) {
        const at = Date.parse(row.quoteAt), payload = JSON.stringify(row);
        const replay = this.storage.sql.exec('SELECT payload FROM breakout_recovered WHERE ticker=? AND at=? AND run=?',ticker,at,run).toArray()[0];
        if (replay && replay.payload !== payload) throw Error('Conflicting recovery replay');
        const prior = this.storage.sql.exec('SELECT payload FROM breakout_recovered WHERE ticker=? AND at=? ORDER BY rowid DESC LIMIT 1',ticker,at).toArray()[0];
        // Keep corrections as separate evidence; repeated unchanged candles need no duplicate.
        if (prior && JSON.stringify({...JSON.parse(prior.payload),checkedAt:row.checkedAt}) === payload) continue;
        this.storage.sql.exec('INSERT OR IGNORE INTO breakout_recovered VALUES(?,?,?,?)',ticker,at,run,payload);
      }
      const filled = new Set(this.storage.sql.exec('SELECT at FROM breakout_recovered WHERE ticker=? AND at>? AND at<=?',ticker,from,to).toArray().map(row=>row.at));
      const remaining = [...slots].filter(at=>!filled.has(at)).length;
      // read() groups several gaps into one retry range. Reconcile each covered
      // constituent gap as well; partial overlaps must remain outstanding.
      const gaps = this.storage.sql.exec("SELECT since,until FROM breakout_gaps WHERE ticker=? AND reason='unrecovered' AND since>=? AND until<=?",ticker,from,to).toArray();
      for (const gap of gaps) if (recoverySlots(gap.since,gap.until).every(at=>filled.has(at)))
        this.storage.sql.exec("UPDATE breakout_gaps SET reason='candles-recovered' WHERE ticker=? AND since=?",ticker,gap.since);
      this.storage.sql.exec('INSERT INTO breakout_gaps VALUES(?,?,?,?) ON CONFLICT(ticker,since) DO UPDATE SET until=MAX(breakout_gaps.until,excluded.until),reason=CASE WHEN breakout_gaps.until>excluded.until THEN breakout_gaps.reason ELSE excluded.reason END',ticker,from,to,remaining ? 'unrecovered' : 'candles-recovered');
      return {ok:true,remaining};
    });
  }
  finish(run) {
    this.init();
    return this.storage.transactionSync(() => {
      const scan = this.storage.sql.exec('SELECT * FROM breakout_runs WHERE id=?', run).toArray()[0];
      if (!scan) throw Error('Capture has not begun');
      const count = this.storage.sql.exec('SELECT COUNT(*) AS count FROM (SELECT ticker FROM breakout_quotes WHERE run=? UNION SELECT ticker FROM breakout_failures WHERE run=?)', run, run).one().count;
      if (count !== JSON.parse(scan.manifest).targets.length) throw Error('Capture is incomplete');
      this.storage.sql.exec('UPDATE breakout_runs SET completed=COALESCE(completed,?) WHERE id=?', new Date(this.now()).toISOString(), run);
      return { ok: true };
    });
  }
  read() {
    this.init();
    const scan = this.storage.sql.exec('SELECT * FROM breakout_runs ORDER BY started DESC,id DESC LIMIT 1').toArray()[0];
    if (!scan) return { version: 1, state: 'not-started', rows: [], targets: [], failures: [] };
    const manifest = JSON.parse(scan.manifest);
    const targets = new Set(manifest.targets);
    const rows = this.storage.sql.exec('SELECT payload,ticker FROM breakout_latest').toArray()
      .filter(row => targets.has(row.ticker)).map(row => JSON.parse(row.payload));
    const failures = this.storage.sql.exec('SELECT ticker,reason FROM breakout_failures WHERE run=?', scan.id).toArray();
    const checked = new Set(this.storage.sql.exec('SELECT ticker FROM breakout_quotes WHERE run=?', scan.id).toArray().map(row => row.ticker));
    const failed = new Set(failures.map(row => row.ticker));
    for (const ticker of targets) if (!checked.has(ticker) && !failed.has(ticker)) failures.push({ ticker, reason: 'unchecked' });
    const first = this.storage.sql.exec('SELECT MIN(started) AS first FROM breakout_runs').one().first;
    return { version: 1, runId: scan.id, state: scan.completed ? 'complete' : 'collecting',
      startedAt: new Date(scan.started).toISOString(), completedAt: scan.completed, ...manifest, rows, failures,
      recoveryPending: this.storage.sql.exec("SELECT ticker,MIN(since) AS since,MAX(until) AS until FROM breakout_gaps WHERE reason='unrecovered' AND until>? GROUP BY ticker", this.now()-5*86400000).toArray(),
      gaps: this.storage.sql.exec('SELECT reason,COUNT(*) AS count,MIN(since) AS earliest FROM breakout_gaps GROUP BY reason').toArray(),
      captureStartedAt: new Date(first).toISOString(), retention: 'All captured observations retained since captureStartedAt; finite storage. Checks every 15 minutes do not capture every trade. Missed intervals are retried from available 15-minute candles for five days. Recovered candles are labelled in history; gaps may remain, and older gaps cannot be recovered by this collector.' };
  }
  history(ticker, before = null) {
    this.init();
    if (!tickerValid(ticker)) throw Error('Invalid ticker');
    let cursor;
    if (before) { cursor = JSON.parse(before); if (!Number.isFinite(cursor.at) || !/^\d+:\d+$/.test(cursor.run)) throw Error('Invalid history cursor'); }
    const query = "SELECT run,at,payload FROM (SELECT run,at,payload FROM breakout_quotes WHERE ticker=? UNION ALL SELECT '0'||run AS run,at,payload FROM breakout_recovered WHERE ticker=?)";
    const data = cursor ? this.storage.sql.exec(query+' WHERE (at<? OR (at=? AND run<?)) ORDER BY at DESC,run DESC LIMIT 101', ticker,ticker,cursor.at,cursor.at,cursor.run).toArray()
      : this.storage.sql.exec(query+' ORDER BY at DESC,run DESC LIMIT 101',ticker,ticker).toArray();
    const page = data.slice(0, 100), last = page.at(-1);
    return { rows: page.map(row => JSON.parse(row.payload)), nextCursor: data.length > 100 ? JSON.stringify({ at: last.at, run: last.run }) : null };
  }
}
