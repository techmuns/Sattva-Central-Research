// One fixed, separately named object caches exact public review requests and bounds paid work.
// Reservations commit before network I/O, survive restarts and are never refunded on failure.
export const STORY_OBJECT = 'ai-alert-story-reviews:v1';
export const STORY_DAILY_REQUESTS = 300;
const DAY = 86400000;
export class AlertStoriesStore {
  constructor(storage, now = () => Date.now()) { this.storage = storage; this.now = now; }
  rows(sql, ...args) { return this.storage.sql.exec(sql, ...args).toArray(); }
  init() {
    this.rows('CREATE TABLE IF NOT EXISTS story_reviews (key TEXT PRIMARY KEY, token TEXT, until_ms INTEGER NOT NULL, result TEXT)');
    this.rows('CREATE TABLE IF NOT EXISTS story_requests (token TEXT PRIMARY KEY, at_ms INTEGER NOT NULL)');
  }
  reserve(key) {
    this.init(); const now = this.now();
    return this.storage.transactionSync(() => {
      this.rows('DELETE FROM story_requests WHERE at_ms <= ?', now - DAY);
      this.rows('DELETE FROM story_reviews WHERE until_ms <= ?', now);
      const row = this.rows('SELECT * FROM story_reviews WHERE key = ?', key)[0];
      if (row?.result) return { result: JSON.parse(row.result) };
      if (row) return { retryAfterMs: row.until_ms - now };
      const budget = this.rows('SELECT COUNT(*) AS n, MIN(at_ms) AS oldest FROM story_requests')[0];
      if (budget.n >= STORY_DAILY_REQUESTS) return { retryAfterMs: budget.oldest + DAY - now };
      const token = crypto.randomUUID();
      this.rows('INSERT INTO story_requests (token, at_ms) VALUES (?, ?)', token, now);
      this.rows('INSERT INTO story_reviews (key, token, until_ms, result) VALUES (?, ?, ?, NULL)', key, token, now + 60000);
      return { token };
    });
  }
  complete(key, token, result) {
    this.init();
    this.rows('UPDATE story_reviews SET result = ?, until_ms = ? WHERE key = ? AND token = ?',
      JSON.stringify(result), this.now() + (result.ok ? 7 * DAY : 300000), key, token);
  }
}
