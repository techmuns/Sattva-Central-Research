import { DurableObject } from 'cloudflare:workers';
import { TelegramSchedule } from './telegram-scheduler.mjs';

export class TelegramScheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.schedule = new TelegramSchedule(ctx.storage, env);
  }
  status() { return this.schedule.status(); }
  request(source) { return this.schedule.request(source); }
  async alarm() { await this.schedule.request('cron'); }
}
