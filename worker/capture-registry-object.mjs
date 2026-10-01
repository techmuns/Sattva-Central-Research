import {PriceLevelStore} from './price-levels-store.mjs';
import {PriceLevelSchedule,PRICE_LEVEL_TIMER} from './price-levels-schedule.mjs';
import { AlertNotesStore } from './alert-notes-store.mjs';
import { AlertStoriesStore } from './alert-stories-store.mjs';
import { MutualFundsStore } from './mutual-funds-store.mjs';
import { MutualFundsScannerStore } from './mutual-funds-scanner-store.mjs';
import { MutualFundsSchedule, MF_TIMER } from './mutual-funds-schedule.mjs';
import { DurableObject } from 'cloudflare:workers';
import { TelegramSchedule } from './telegram-scheduler.mjs';
import { TelegramDelivery } from './telegram-delivery.mjs';
import { ConcallSummaryStore } from './concall-summary-store.mjs';
import { ConcallSummarySchedule } from './concall-summary-schedule.mjs';
import { SharedWatchlistStore } from './watchlist-store.mjs';
import { BreakoutStore } from './breakout-store.mjs';
import { BreakoutSchedule } from './breakout-schedule.mjs';
import { BreakoutPrimary, PRIMARY_OBJECT, PRIMARY_TIMER } from './breakout-primary.mjs';
import { NewsletterStore } from './newsletter-store.mjs';
import { NewsletterSchedule, NEWSLETTER_TIMER_KEY } from './newsletter-schedule.mjs';
import { CAPTURE_REGISTRY_LIMIT, CAPTURE_REGISTRATION_BATCH, registeredCompany } from '../public/js/data/capture-registration-shared.js';
import { AnnouncementIndexStore } from './announcement-index-store.mjs';
import { RelevanceFeedbackStore } from './relevance-feedback-store.mjs';
import { AnnouncementReadStore } from './announcement-read-store.mjs';

// An RPC error crosses the boundary with its message only, so the three announcement objects answer
// a failure as a plain `{ ok: false, reason, message }` the route can act on.
async function settled(work) {
  try { return await work(); } catch (error) {
    const message = String(error?.message || error);
    const reason = error?.reason || (/^Invalid /.test(message) ? 'invalid-request' : 'index-unavailable');
    return { ok: false, reason, message };
  }
}

// Each shard coordinates one bounded set of issuer registrations. No reader identity is stored.
export class CaptureRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // The timer's fixed researchreportss-main-v1 object has its own storage, separate from every
    // company-registry shard. Reuse the provisioned class so preview version uploads need no
    // namespace migration. Construction and company operations never arm a timer.
    this.schedule = new TelegramSchedule(ctx.storage, env);
    this.telegramDelivery = new TelegramDelivery(env);
    this.summaries = new ConcallSummaryStore(ctx.storage);
    this.summarySchedule = new ConcallSummarySchedule(ctx.storage, env);
    // The shared watchlist lives in its own fixed object (shared-watchlist:v1), so these tables
    // are only ever created on that one. A company-registry shard never calls a watchlist method.
    this.priceLevels = new PriceLevelStore(ctx.storage);
    this.priceLevelSchedule = new PriceLevelSchedule(ctx.storage,env,this.priceLevels);
    this.watchlist = new SharedWatchlistStore(ctx.storage);
    this.alertNotes = new AlertNotesStore(ctx.storage, env);
    this.alertStories = new AlertStoriesStore(ctx.storage);
    this.mutualFunds = new MutualFundsStore(ctx.storage);
    this.mutualFundsScanner = new MutualFundsScannerStore(ctx.storage,this.mutualFunds);
    this.mutualFunds.scanner = this.mutualFundsScanner;
    this.mutualFundsSchedule = new MutualFundsSchedule(ctx.storage, env);
    this.breakouts = new BreakoutStore(ctx.storage);
    this.breakoutSchedule = new BreakoutSchedule(ctx.storage, env);
    this.breakoutPrimary = new BreakoutPrimary(ctx.storage, env);
    // The team brief lives in its own fixed object (team-brief:v1): subscribers and the delivery
    // log in SQLite, the send timer in KV, and the alarm below is what actually emails the desk.
    this.newsletter = new NewsletterStore(ctx.storage);
    this.newsletterSchedule = new NewsletterSchedule(ctx.storage, env, this.newsletter);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS companies (isin TEXT PRIMARY KEY, ticker TEXT NOT NULL, name TEXT NOT NULL)');
  }
  // The Corporate Announcements index (announcement-index:v1), the shared relevance feedback
  // (relevance-feedback:v1) and AI Read (announcement-read:v1) each live on their own fixed object.
  // Built on first use, so no other object ever creates their tables or holds their memory.
  get announcementIndex() { return (this._announcementIndex ||= new AnnouncementIndexStore(this.ctx.storage, this.env)); }
  get relevanceFeedback() { return (this._relevanceFeedback ||= new RelevanceFeedbackStore(this.ctx.storage)); }
  get announcementReads() { return (this._announcementReads ||= new AnnouncementReadStore(this.ctx.storage, this.env)); }
  annIndexQuery(input) { return settled(() => this.announcementIndex.query(input)); }
  annIndexEvent(id, range) { return settled(() => this.announcementIndex.event(id, range || {})); }
  annIndexProfiles() { return settled(() => this.announcementIndex.profiles()); }
  annIndexStatus() { return settled(() => this.announcementIndex.status()); }
  feedbackApply(vote) { return this.relevanceFeedback.apply(vote); }
  feedbackModel() { return this.relevanceFeedback.model(); }
  feedbackMine(device) { return this.relevanceFeedback.mine(device); }
  announcementRead(input) { return settled(() => this.announcementReads.read(input)); }
  announcementReadStatus() { return settled(() => this.announcementReads.status()); }
  priceLevelsSnapshot(cursor) { return this.priceLevelSchedule.snapshot(cursor); }
  async priceLevelsApply(intents) { const result=this.priceLevels.apply(intents);await this.priceLevelSchedule.arm();return {...result.snapshot,outcomes:result.outcomes,check:await this.priceLevelSchedule.status()}; }
  status() { return this.schedule.status(); }
  telegramPosts() { return this.telegramDelivery.response(); }
  summaryBeginInventory(run, syncId, manifest) { return this.summaries.beginInventory(run, syncId, manifest); }
  summaryInventoryBatch(run, syncId, offset, targets) { return this.summaries.inventoryBatch(run, syncId, offset, targets); }
  async summaryFinishInventory(run, syncId) { const result = this.summaries.finishInventory(run, syncId); await this.summarySchedule.arm(); return result; }
  async summaryDiscoveryFailed() { const result = this.summaries.discoveryFailed(); await this.summarySchedule.arm(); return result; }
  async summaryStatus() { return { ...this.summaries.status(), schedule: await this.summarySchedule.status() }; }
  summaryReserve(run, requestId) { return this.summaries.reserve(run, requestId); }
  summaryComplete(run, input) { return this.summaries.complete(run, input); }
  summaryRead(ids) { return this.summaries.read(ids); }
  alertNotesRead(items) { return this.alertNotes.read(items); }
  storyReviewReserve(key) { return this.alertStories.reserve(key); }
  storyReviewComplete(key, token, result) { return this.alertStories.complete(key, token, result); }
  watchlistSnapshot() { return this.watchlist.watchlistSnapshot(); }
  watchlistApply(intents) { return this.watchlist.watchlistApply(intents); }
  request(source) { return this.schedule.request(source); }
  async breakoutArm() {
    await this.breakoutSchedule.arm();
    await this.env.CAPTURE_REGISTRY.getByName(PRIMARY_OBJECT).upstoxArm();
    return this.breakoutSchedule.status();
  }
  upstoxArm() { return this.breakoutPrimary.arm(); }
  upstoxInventory(targets,failed) { return this.breakoutPrimary.inventory(targets,failed); }
  upstoxStatus() { return this.breakoutPrimary.status(); }
  breakoutPrimaryPrune() { return this.breakouts.primaryPrune(); }
  breakoutPrimarySave(input) { return this.breakouts.primarySave(input); }
  breakoutReadFallback() { return this.breakouts.readFallback(); }
  async breakoutBegin(run, targets, failed) { const out = this.breakouts.begin(run, targets, failed); await this.breakoutSchedule.arm(); return out; }
  breakoutRecovery(run, ticker, from, to, rows) { return this.breakouts.recovery(run,ticker,from,to,rows); }
  breakoutCheckpoint(run, rows, failures) { return this.breakouts.checkpoint(run, rows, failures); }
  breakoutFinish(run) { return this.breakouts.finish(run); }
  breakoutRead() { return this.breakouts.read(); }
  breakoutHistory(ticker, before) { return this.breakouts.history(ticker, before); }
  breakoutScheduleStatus() { return this.breakoutSchedule.status(); }
  newsletterSnapshot() { return this.newsletter.snapshot(); }
  async newsletterStatus() { await this.newsletterSchedule.arm(); return this.newsletterSchedule.status(); }
  async newsletterApply({ intents = null, settings = null } = {}) {
    const out = { outcomes: [], settingsChanged: false };
    if (settings) out.settingsChanged = this.newsletter.setSettings(settings).changed;
    if (intents) out.outcomes = this.newsletter.apply(intents).outcomes;
    await this.newsletterSchedule.arm();
    return { ...out, snapshot: this.newsletter.snapshot(), schedule: await this.newsletterSchedule.status() };
  }
  newsletterSend(input, token) { return this.newsletterSchedule.sendNow(input, token); }
  newsletterPdf(id) { return this.newsletter.document(id); }
  newsletterPreview(input) { return this.newsletterSchedule.preview(input); }
  mfReports(run,reports) { return this.mutualFunds.reports(run,reports); }
  mfFragment(run,fragment) { return this.mutualFunds.fragment(run,fragment); }
  mfBegin(run,manifest) { return this.mutualFunds.begin(run,manifest); }
  mfCheckpoint(run,companies) { return this.mutualFunds.checkpoint(run,companies); }
  mfConfirm(run,companies) { return this.mutualFunds.confirm(run,companies); }
  mfFinish(run) { return this.mutualFunds.finish(run); }
  mfRead(isins,cursor) { return this.mutualFunds.read(isins,cursor); }
  mfDetail(isin,month) { return this.mutualFunds.detail(isin,month); }
  mfArm() { return this.mutualFundsSchedule.arm(); }
  mfScheduleStatus() { return this.mutualFundsSchedule.status(); }
  mfScannerInventory(companies) { return this.mutualFundsScanner.inventory(companies); }
  mfScannerReserve(run,id,kind) { return this.mutualFundsScanner.reserve(run,id,kind); }
  mfScannerComplete(run,input) { return this.mutualFundsScanner.complete(run,input); }
  mfScannerStatus() { return this.mutualFundsScanner.status(); }
  mfPrivateRead(isins,cursor) { return this.mutualFundsScanner.read(isins,cursor); }
  mfPrivateDetail(isin,month) { return this.mutualFundsScanner.detail(isin,month); }
  async alarm() {
    if(await this.ctx.storage.get(PRICE_LEVEL_TIMER)){await this.priceLevelSchedule.wake();return;}
    if (await this.ctx.storage.get(MF_TIMER)) { await this.mutualFundsSchedule.wake(); return; }
    if (await this.ctx.storage.get(PRIMARY_TIMER)) await this.breakoutPrimary.wake();
    else if (await this.ctx.storage.get(NEWSLETTER_TIMER_KEY)) await this.newsletterSchedule.wake();
    else if (await this.ctx.storage.get('breakout-timer')) await this.breakoutSchedule.wake();
    else if (await this.ctx.storage.get('summary-timer')) await this.summarySchedule.wake();
    else await this.schedule.request('cron');
  }
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
