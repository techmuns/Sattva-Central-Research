import { DurableObject } from 'cloudflare:workers';
import { TelegramSchedule } from './telegram-scheduler.mjs';
import { CAPTURE_REGISTRY_LIMIT, CAPTURE_REGISTRATION_BATCH, registeredCompany } from '../public/js/data/capture-registration-shared.js';

// Each shard coordinates one bounded set of issuer registrations. No reader identity is stored.
export class CaptureRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // The timer's fixed researchreportss-main-v1 object has its own storage, separate from every
    // company-registry shard. Reuse the provisioned class so preview version uploads need no
    // namespace migration. Construction and company operations never arm a timer.
    this.schedule = new TelegramSchedule(ctx.storage, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS companies (isin TEXT PRIMARY KEY, ticker TEXT NOT NULL, name TEXT NOT NULL)');
  }
  status() { return this.schedule.status(); }
  request(source) { return this.schedule.request(source); }
  async alarm() { await this.schedule.request('cron'); }
  list() {
    return this.ctx.storage.sql.exec('SELECT isin, ticker, name FROM companies ORDER BY isin').toArray();
  }
  register(companies) {
    if (!Array.isArray(companies) || companies.length > CAPTURE_REGISTRATION_BATCH) throw new Error('Invalid registration batch');
    const clean = companies.map(registeredCompany);
    return this.ctx.storage.transactionSync(() => {
      let count = this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM companies').one().count;
      const accepted = [], full = [];
      for (const company of clean) {
        const existing = this.ctx.storage.sql.exec('SELECT ticker, name FROM companies WHERE isin = ?', company.isin).toArray()[0];
        if (!existing && count >= CAPTURE_REGISTRY_LIMIT) { full.push(company.isin); continue; }
        if (!existing || existing.ticker !== company.ticker || existing.name !== company.name) {
          this.ctx.storage.sql.exec('INSERT INTO companies (isin, ticker, name) VALUES (?, ?, ?) ON CONFLICT(isin) DO UPDATE SET ticker = excluded.ticker, name = excluded.name', company.isin, company.ticker, company.name);
        }
        if (!existing) count++;
        accepted.push(company.isin);
      }
      return { accepted, full };
    });
  }
}
