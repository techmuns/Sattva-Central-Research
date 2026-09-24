// Dollar admission control for news reading/review/grouping only. Existing filing/PDF and
// Ask Research spending is separate. Reserve before I/O; uncertain calls keep their reserve.
import { istDay } from '../public/js/data/newsletter-shared.js';
export const NEWS_DAILY_MICRO_USD = 1_000_000;
export const NEWS_MONTHLY_MICRO_USD = 25_000_000;
export class NewsletterNewsBudget {
  constructor(storage, { now = Date.now } = {}) { this.storage = storage; this.now = now; }
  rows(sql, ...args) {
    if (!this.initialised) {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS newsletter_news_ai_calls (
        id TEXT PRIMARY KEY, job TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL,
        model TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER NOT NULL,
        state TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER)`);
      this.storage.sql.exec('CREATE INDEX IF NOT EXISTS newsletter_news_ai_day ON newsletter_news_ai_calls(day,job)');
      this.storage.sql.exec('CREATE INDEX IF NOT EXISTS newsletter_news_ai_month ON newsletter_news_ai_calls(month)');
      this.storage.sql.exec('CREATE TABLE IF NOT EXISTS newsletter_news_ai_cache (id TEXT PRIMARY KEY, result TEXT NOT NULL)');
      this.initialised = true;
    }
    return this.storage.sql.exec(sql, ...args).toArray();
  }
  status(now = Date.now()) {
    const day = istDay(now), month = day.slice(0,7);
    const dayUsed = this.rows('SELECT COALESCE(SUM(charged),0) AS amount FROM newsletter_news_ai_calls WHERE day=?', day)[0].amount;
    const monthUsed = this.rows('SELECT COALESCE(SUM(charged),0) AS amount FROM newsletter_news_ai_calls WHERE month=?', month)[0].amount;
    return { day, month, dailyLimitUsd: NEWS_DAILY_MICRO_USD / 1e6, monthlyLimitUsd: NEWS_MONTHLY_MICRO_USD / 1e6, dayUsedUsd: dayUsed / 1e6, monthUsedUsd: monthUsed / 1e6,
      includesUncertainReservations: true, scope: 'news-reading-review-and-grouping' };
  }
  reserve({ job, model, amount, now = Date.now() }) {
    this.rows('SELECT 1');
    return this.storage.transactionSync(() => {
      const status = this.status(now), day = status.day;
      if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'unpriced-model' };
      if (Math.round(status.dayUsedUsd * 1e6) + amount > NEWS_DAILY_MICRO_USD || Math.round(status.monthUsedUsd * 1e6) + amount > NEWS_MONTHLY_MICRO_USD)
        return { ok: false, reason: 'news-budget' };
      const attempts = this.rows('SELECT COUNT(*) AS n FROM newsletter_news_ai_calls WHERE job=? AND day=?', job, day)[0].n;
      if (attempts >= 3) return { ok: false, reason: 'news-attempt-limit' };
      const id = crypto.randomUUID();
      this.rows("INSERT INTO newsletter_news_ai_calls(id,job,day,month,model,reserved,charged,state) VALUES (?,?,?,?,?,?,?,'reserved')",
        id, job, day, status.month, model, amount, amount);
      return { ok: true, id };
    });
  }
  settle(id, { amount, input, output }) {
    if (![amount, input, output].every(n => Number.isSafeInteger(n) && n >= 0)) return;
    this.rows("UPDATE newsletter_news_ai_calls SET charged=?,state='measured',input_tokens=?,output_tokens=? WHERE id=? AND state='reserved'", amount, input, output, id);
  }
  cached(id) { const raw = this.rows('SELECT result FROM newsletter_news_ai_cache WHERE id=?', id)[0]?.result; return raw ? JSON.parse(raw) : null; }
  save(id, result) { this.rows('INSERT INTO newsletter_news_ai_cache(id,result) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result', id, JSON.stringify(result)); }
}
