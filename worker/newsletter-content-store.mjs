import { NewsletterNewsBudget } from './newsletter-news-budget.mjs';
import { CONTENT_BATCH, readDocumentFacts } from './newsletter-content.mjs';

export const CONTENT_SCAN_MS = 60 * 60 * 1000;
export const CONTENT_TICK_MS = 60 * 1000;
export const CONTENT_LEASE_MS = 5 * 60 * 1000;
const json = text => { try { return JSON.parse(text); } catch { return null; } };

// The newsletter object's reading queue, independent of its sent-item ledger. No subscriber
// data, credentials, PDF bytes or full publisher articles are stored here. Jobs and source
// passages survive restarts and date rollovers; an email acknowledgement never deletes a job.
export class NewsletterContentStore {
  constructor(storage) { this.storage = storage; this.newsBudget = new NewsletterNewsBudget(storage); }

  rows(sql, ...args) {
    if (!this.initialised) {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS newsletter_content (
        id TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL, first_seen INTEGER NOT NULL,
        next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, result TEXT)`);
      this.storage.sql.exec('CREATE INDEX IF NOT EXISTS newsletter_content_due ON newsletter_content(state,next_at,first_seen)');
      this.storage.sql.exec('CREATE TABLE IF NOT EXISTS newsletter_content_meta (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      this.initialised = true;
    }
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  meta() { return json(this.rows('SELECT value FROM newsletter_content_meta WHERE id=1')[0]?.value) || {}; }
  setMeta(value) { this.rows('INSERT INTO newsletter_content_meta(id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(value)); }

  enqueue(items, now) {
    this.rows('SELECT 1');
    this.storage.transactionSync(() => {
      for (const item of items) {
        const { row, id, ...input } = item;
        if (!/^[a-f0-9]{64}$/.test(id) || !input.ticker || !['filing', 'news'].includes(input.kind)) throw new Error('Invalid content job');
        this.rows(`INSERT INTO newsletter_content(id,input,state,first_seen,next_at) VALUES (?,?,'pending',?,?) ON CONFLICT(id) DO NOTHING`,
          id, JSON.stringify(input), now, now);
      }
    });
  }

  get(id) {
    const row = this.rows('SELECT state,result FROM newsletter_content WHERE id=?', id)[0];
    return row ? json(row.result) || { state: 'pending', reason: row.state === 'reading' ? 'reading' : 'queued' } : null;
  }

  claim(now, preferred = []) {
    this.rows('SELECT 1');
    return this.storage.transactionSync(() => {
      let row;
      for (const id of preferred) {
        row = this.rows("SELECT * FROM newsletter_content WHERE id=? AND state!='ready' AND next_at<=?", id, now)[0];
        if (row) break;
      }
      row ||= this.rows("SELECT * FROM newsletter_content WHERE state!='ready' AND next_at<=? ORDER BY first_seen,id LIMIT 1", now)[0];
      if (!row) return null;
      const lease = crypto.randomUUID();
      this.rows("UPDATE newsletter_content SET state='reading',next_at=?,attempts=attempts+1,lease=? WHERE id=?", now + CONTENT_LEASE_MS, lease, row.id);
      return { id: row.id, item: json(row.input), attempts: row.attempts + 1, lease };
    });
  }

  complete(job, result, now) {
    const slow = ['unsupported-source', 'unsupported-format', 'missing-link', 'too-large', 'access-limited', 'issuer-mismatch', 'news-budget', 'news-attempt-limit', 'company-evidence-unconfirmed', 'refused'].includes(result.reason);
    const retry = slow ? 86400000 : Math.min(6 * 3600000, CONTENT_TICK_MS * 2 ** Math.min(job.attempts, 12));
    this.rows('UPDATE newsletter_content SET state=?,result=?,next_at=?,lease=NULL WHERE id=? AND lease=?',
      result.state, JSON.stringify(result), now + retry, job.id, job.lease);
  }

  async process({ env, fetcher = fetch, now = Date.now(), preferred = [], limit = CONTENT_BATCH }) {
    // Claim the whole bounded batch before yielding; other wakes cannot start the same jobs.
    const jobs = [];
    for (let i = 0; i < limit; i++) { const job = this.claim(now, preferred); if (!job) break; jobs.push(job); }
    const queue = [...jobs];
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
      while (queue.length) {
        const job = queue.shift();
        const result = await readDocumentFacts({ item: job.item, env, fetcher, now, newsBudget: this.newsBudget });
        this.complete(job, result, now);
      }
    }));
    return { attempted: jobs.length, ...this.status() };
  }

  nextAt(now) {
    const due = this.rows("SELECT MIN(next_at) AS at FROM newsletter_content WHERE state!='ready'")[0]?.at;
    const scan = this.meta().nextScanAt || now + CONTENT_TICK_MS;
    return Math.max(now + CONTENT_TICK_MS, Math.min(scan, due ?? Infinity));
  }

  status() {
    const counts = Object.fromEntries(this.rows('SELECT state,COUNT(*) AS count FROM newsletter_content GROUP BY state').map(r => [r.state, r.count]));
    const meta = this.meta();
    return { ready: counts.ready || 0, partial: counts.partial || 0, pending: (counts.pending || 0) + (counts.reading || 0),
      captureStartedAt: meta.captureStartedAt || null, lastDiscoveryAt: meta.lastDiscoveryAt || null,
      sources: meta.sources || null, reason: meta.reason || null };
  }
}
