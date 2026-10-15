import {exportPriceLevels} from './price-levels-export.mjs';
import {PriceLevelStore} from './price-levels-store.mjs';
import {PriceLevelSchedule,PRICE_LEVEL_TIMER} from './price-levels-schedule.mjs';
import { AlertNotesStore } from './alert-notes-store.mjs';
import { AlertStoriesStore } from './alert-stories-store.mjs';
import { MutualFundsStore } from './mutual-funds-store.mjs';
import { MutualFundsScannerStore } from './mutual-funds-scanner-store.mjs';
import { MF_TIMER } from './mutual-funds-schedule.mjs';
import { exportMutualFunds } from './mutual-funds-export.mjs';
import { DurableObject } from 'cloudflare:workers';
import { TelegramSchedule } from './telegram-scheduler.mjs';
import { TelegramDelivery } from './telegram-delivery.mjs';
import { ConcallSummaryStore } from './concall-summary-store.mjs';
import { ConcallSummarySchedule } from './concall-summary-schedule.mjs';
import { SharedWatchlistStore } from './watchlist-store.mjs';
import { WorkspaceStore } from './workspace-store.mjs';
import {exportBreakouts} from './breakout-export.mjs';
import {exportSummaries} from './summaries-export.mjs';
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
  announcementReadStream(input) { return this.announcementReads.stream(input, (work) => this.ctx.waitUntil(work)); }
  announcementReadStatus() { return settled(() => this.announcementReads.status()); }
  priceLevelsExport(input) { return exportPriceLevels(this.ctx.storage,input); }
  async priceLevelsSnapshot(cursor) { const value=await this.priceLevelSchedule.snapshot(cursor);return {...value,check:{...value.check,runtime:'github-actions',current:!value.pending,nextAt:null,state:value.pending?'waiting':'idle'}}; }
  async priceLevelsApply(intents) { const result=this.priceLevels.apply(intents);return {...await this.priceLevelsSnapshot(),outcomes:result.outcomes}; }
  status() { return this.schedule.status(); }
  telegramPosts() { return this.telegramDelivery.response(); }
  summaryExport(input) { return exportSummaries(this.ctx.storage,input); }
  summaryBeginInventory() { throw Error('Summary collection moved to GitHub Actions'); }
  summaryInventoryBatch() { throw Error('Summary collection moved to GitHub Actions'); }
  summaryFinishInventory() { throw Error('Summary collection moved to GitHub Actions'); }
  summaryDiscoveryFailed() { throw Error('Summary collection moved to GitHub Actions'); }
  summaryStatus() { return {...this.summaries.status(),schedule:{runtime:'github-actions',started:false}}; }
  summaryReserve() { throw Error('Summary collection moved to GitHub Actions'); }
  summaryComplete() { throw Error('Summary collection moved to GitHub Actions'); }
  summaryRead(ids) { return this.summaries.read(ids); }
  alertNotesRead(items) { return this.alertNotes.read(items); }
  storyReviewReserve(key) { return this.alertStories.reserve(key); }
  storyReviewComplete(key, token, result) { return this.alertStories.complete(key, token, result); }
  watchlistSnapshot() { return this.watchlist.watchlistSnapshot(); }
  watchlistApply(intents) { return this.watchlist.watchlistApply(intents); }
  get workspaceStore() { return (this._workspaceStore ||= new WorkspaceStore(this.ctx.storage)); }
  workspaceSnapshot() { return this.workspaceStore.snapshot(); }
  workspaceApply(intent) { return this.workspaceStore.apply(intent); }
  request(source) { return this.schedule.request(source); }
  breakoutExport(input) { return exportBreakouts(this.ctx.storage,input); }
  breakoutArm() { return {runtime:'github-actions',started:false}; }
  upstoxArm() { return {runtime:'github-actions',started:false}; }
  upstoxInventory() { throw Error('Quote collection moved to GitHub Actions'); }
  upstoxStatus() { return this.breakoutPrimary.status(); }
  breakoutPrimaryPrune() { throw Error('Quote collection moved to GitHub Actions'); }
  breakoutPrimarySave() { throw Error('Quote collection moved to GitHub Actions'); }
  breakoutReadFallback() { return this.breakouts.readFallback(); }
  breakoutBegin() { throw Error('Quote collection moved to GitHub Actions'); }
  breakoutRecovery() { throw Error('Quote collection moved to GitHub Actions'); }
  breakoutCheckpoint() { throw Error('Quote collection moved to GitHub Actions'); }
  breakoutFinish() { throw Error('Quote collection moved to GitHub Actions'); }
  breakoutRead() { return this.breakouts.read(); }
  breakoutHistory(ticker, before) { return this.breakouts.history(ticker, before); }
  breakoutScheduleStatus() { return {runtime:'github-actions',started:false}; }
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
  mfReports(run,reports) { throw Error('Mutual Funds capture moved to GitHub Actions'); }
  mfFragment(run,fragment) { throw Error('Mutual Funds capture moved to GitHub Actions'); }
  mfBegin(run,manifest) { throw Error('Mutual Funds capture moved to GitHub Actions'); }
  mfCheckpoint(run,companies) { throw Error('Mutual Funds capture moved to GitHub Actions'); }
  mfConfirm(run,companies) { throw Error('Mutual Funds capture moved to GitHub Actions'); }
  mfFinish(run) { throw Error('Mutual Funds capture moved to GitHub Actions'); }
  mfRead(isins,cursor) { return this.mutualFunds.read(isins,cursor); }
  mfDetail(isin,month) { return this.mutualFunds.detail(isin,month); }
  mfArm() { return {runtime:'github-actions',started:false}; }
  mfExport(table,cursor) { return exportMutualFunds(this.ctx.storage.sql,table,cursor); }
  mfScheduleStatus() { return {runtime:'github-actions',started:false}; }
  mfScannerInventory(companies) { throw Error('Mutual Funds capture moved to GitHub Actions'); }
  mfScannerReserve(run,id,kind) { throw Error('Mutual Funds capture moved to GitHub Actions'); }
  mfScannerComplete(run,input) { throw Error('Mutual Funds capture moved to GitHub Actions'); }
  mfScannerStatus() { return this.mutualFundsScanner.status(); }
  mfPrivateRead(isins,cursor) { return this.mutualFundsScanner.read(isins,cursor); }
  mfPrivateDetail(isin,month) { return this.mutualFundsScanner.detail(isin,month); }
  async alarm() {
    if(await this.ctx.storage.get(PRICE_LEVEL_TIMER)){await this.ctx.storage.deleteAlarm();return;}
    if (await this.ctx.storage.get(MF_TIMER)) {
      await this.ctx.storage.deleteAlarm();return;
    }
    if (await this.ctx.storage.get(PRIMARY_TIMER)) await this.ctx.storage.deleteAlarm();
    else if (await this.ctx.storage.get(NEWSLETTER_TIMER_KEY)) await this.newsletterSchedule.wake();
    else if (await this.ctx.storage.get('breakout-timer')) await this.ctx.storage.deleteAlarm();
    else if (await this.ctx.storage.get('summary-timer')) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.deleteAlarm(); // Retire the old Telegram dispatch alarm.
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
