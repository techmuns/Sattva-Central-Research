import { renderBriefPdf, pdfFilename } from './newsletter-pdf.mjs';
import { buildBrief, briefSubject, briefSummary, renderBriefHtml, renderBriefText, PRODUCTION_ORIGIN } from './newsletter-brief.mjs';
import { EMAIL_HTML_BYTES, emailBytes, renderBriefEmails, acceptedStoryKeys } from './newsletter-email.mjs';
import { EDITIONS, editionKey, istDay, nextScheduled, normaliseEmail, scheduledEditions } from '../public/js/data/newsletter-shared.js';

// THE TIMER THAT SENDS THE BRIEF, AND THE ONE PLACE AN EMAIL LEAVES THIS DASHBOARD.
//
// Cloudflare's cron cannot drive this — the account's five cron slots are spent, see
// wrangler.jsonc — and GitHub's scheduler measurably drops most of a dense schedule. A Durable
// Object alarm is neither: it is a durable, exact-time wake-up on the object that holds the
// subscriber list, the same mechanism the Telegram and breakout timers already run on. The alarm
// is armed for the next enabled weekday send whenever the list or the schedule changes, and
// re-armed at the end of every wake.
//
// DURABLE CLAIMS PRECEDE EXTERNAL I/O. `wake()` moves `lastCheckedAt` forward in a transaction
// before it reads a single quote, and `deliver()` claims the edition's key in SQLite before the
// first email goes out. A replayed alarm, a retried RPC or a second path asking for the same brief
// finds the claim and sends nothing. That is what makes "one morning brief a day" a property of
// the store rather than a hope about the scheduler.
//
// THE CREDENTIAL IS THE WORKER'S, AND A MISSING ONE IS A NAMED STATE. Scheduled sends use
// `env.MUNS_TOKEN`; a reader's own session token may stand in for a send they press themselves,
// exactly as `withCallerToken` lets it elsewhere. Without either, the delivery is recorded as
// `no-token` against every recipient and the panel says which secret an operator installs.
// Nothing here ever logs, stores or returns upstream error text or a token.

export const NEWSLETTER_TIMER_KEY = 'newsletter-timer';
export const EMAIL_SEND_URL = 'https://devde.muns.io/email/send/raw';
export const SEND_POOL = 3;
export const SEND_TIMEOUT_MS = 15000;
// An edition the timer could not deliver within this long of its time is recorded as missed, not
// sent late: a morning brief that arrives at lunch is a different product, and stating the miss
// beats pretending the schedule held.
export const CATCH_UP_MS = 3 * 3600 * 1000;
export const LOOKBACK_MS = 26 * 3600 * 1000;
export const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;

const iso = (value) => (Number.isFinite(value) ? new Date(value).toISOString() : null);

async function pooled(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/**
 * One email through the Muns raw-send endpoint. Exactly one of `text` / `html` is sent, as the
 * endpoint requires. The answer is a small named outcome and never the upstream's own words.
 */
export async function sendEmail({ fetcher = fetch, token, email, subject, html = null, text = null, signal, base = EMAIL_SEND_URL }) {
  if ((html == null) === (text == null)) throw new Error('sendEmail takes exactly one of html or text');
  if (emailBytes(html ?? text) > EMAIL_HTML_BYTES) return { ok: false, status: null, reason: 'email-too-large' };
  const body = html != null ? { email, subject, html } : { email, subject, text };
  let res;
  try {
    res = await fetcher(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'manual',
    });
  } catch (error) {
    return { ok: false, status: null, reason: /abort|timeout/i.test(String(error?.name || '')) ? 'timeout' : 'unreachable' };
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, reason: 'unauthorised' };
  if (res.status === 429) return { ok: false, status: res.status, reason: 'rate-limited' };
  if (res.status >= 500) return { ok: false, status: res.status, reason: 'upstream' };
  if (!res.ok) return { ok: false, status: res.status, reason: 'refused' };
  if (parsed?.success !== true) return { ok: false, status: res.status, reason: 'invalid-response' };
  return { ok: true, status: res.status, reason: null };
}

export class NewsletterSchedule {
  constructor(storage, env, store, { fetcher = fetch, now = Date.now } = {}) {
    this.storage = storage;
    this.env = env;
    this.store = store;
    this.fetcher = fetcher;
    this.now = now;
  }

  dashboardUrl() {
    const origin = String(this.env?.DASHBOARD_ORIGIN || PRODUCTION_ORIGIN).replace(/\/+$/, '');
    return /^https:\/\/[a-z0-9.-]+$/i.test(origin) ? origin : PRODUCTION_ORIGIN;
  }

  /**
   * What every render of the sheet needs besides the brief itself. Two of these are here because
   * leaving them out is invisible: `productName` is a declared Worker var, so a deployment that
   * sets it and never sees it change would read as a var that does not work; and `settings` is
   * what the footer's "every weekday at 8:00 AM IST" is built from, so without it a desk that
   * moved its send time is told the old one by the very email that arrived at the new one.
   */
  renderOptions(recipient = null) {
    const productName = String(this.env?.NEWSLETTER_PRODUCT_NAME || '').trim();
    return {
      dashboardUrl: this.dashboardUrl(),
      settings: this.store.settings(),
      ...(productName ? { productName } : {}),
      ...(recipient ? { recipient } : {}),
    };
  }

  async status() {
    const { state, alarm } = await this.storage.transaction(async (tx) => ({ state: (await tx.get(NEWSLETTER_TIMER_KEY)) || {}, alarm: await tx.getAlarm() }));
    const next = nextScheduled(this.store.settings(), this.now());
    return {
      tokenConfigured: !!this.env?.MUNS_TOKEN,
      armed: alarm != null,
      alarmAt: iso(alarm),
      next: next ? { edition: next.edition, day: next.day, at: iso(next.at), key: next.key } : null,
      lastCheckedAt: iso(state.lastCheckedAt),
      lastWakeAt: iso(state.lastWakeAt),
      lastResult: state.lastResult || 'not-started',
      reason: state.reason || null,
    };
  }

  /** Point the alarm at the next enabled weekday send; drop it when both editions are off. */
  async arm() {
    const next = nextScheduled(this.store.settings(), this.now());
    await this.storage.transaction(async (tx) => {
      const state = (await tx.get(NEWSLETTER_TIMER_KEY)) || {};
      const alarm = await tx.getAlarm();
      if (!next) {
        await tx.put(NEWSLETTER_TIMER_KEY, { ...state, nextAt: null, nextKey: null });
        if (alarm != null) await tx.deleteAlarm();
        return;
      }
      await tx.put(NEWSLETTER_TIMER_KEY, { ...state, nextAt: next.at, nextKey: next.key, lastCheckedAt: state.lastCheckedAt ?? this.now() });
      if (alarm !== next.at) await tx.setAlarm(next.at);
    });
  }

  /** The alarm handler. Never throws: a failure is recorded and the next alarm is still armed. */
  async wake() {
    const now = this.now();
    let since;
    try {
      since = await this.storage.transaction(async (tx) => {
        const state = (await tx.get(NEWSLETTER_TIMER_KEY)) || {};
        const from = Number.isFinite(state.lastCheckedAt) ? state.lastCheckedAt : now - 60000;
        await tx.put(NEWSLETTER_TIMER_KEY, { ...state, lastCheckedAt: now, lastWakeAt: now, lastResult: 'checking', reason: null });
        return from;
      });
      const settings = this.store.settings();
      const due = scheduledEditions(settings, Math.max(since, now - LOOKBACK_MS), now);
      const results = [];
      for (const item of due) {
        if (now - item.at > CATCH_UP_MS) {
          if (this.store.beginDelivery({ key: item.key, edition: item.edition, day: item.day, scheduledAt: item.at, source: 'timer', recipients: 0 })) {
            this.store.finishDelivery(item.key, { reason: 'missed', outcomes: [] });
          }
          results.push({ key: item.key, reason: 'missed' });
          continue;
        }
        results.push(await this.deliver({ ...item, source: 'timer', now }));
      }
      const last = results.at(-1);
      await this.record({ lastResult: !due.length ? 'nothing-due' : last?.reason ? last.reason : 'sent', reason: last?.reason || null });
    } catch {
      await this.record({ lastResult: 'failed', reason: 'wake-failed' });
    }
    try { await this.arm(); } catch { /* the next GET repairs the alarm */ }
  }

  async record(values) {
    await this.storage.transaction(async (tx) => {
      const state = (await tx.get(NEWSLETTER_TIMER_KEY)) || {};
      await tx.put(NEWSLETTER_TIMER_KEY, { ...state, ...values });
    });
  }

  /**
   * Build one edition and email it. `recipients` defaults to the list; `token` to the Worker's own.
   * Returns a small record of what happened; the same record is written to the delivery log.
   */
  async deliver({ edition, day, at, key, source, now = this.now(), recipients = null, token = null, to = null }) {
    const list = recipients ?? this.store.recipients(edition);
    if (!this.store.beginDelivery({ key, edition, day, scheduledAt: at, source, recipients: list.length })) {
      return { ok: true, key, reason: 'already-sent', sent: 0, failed: 0, outcomes: [] };
    }
    const finish = (values) => {
      this.store.finishDelivery(key, values);
      return { ok: values.reason == null, key, ...values };
    };
    if (!list.length) return finish({ sent: 0, failed: 0, reason: 'no-recipients', outcomes: [] });
    const credential = token || this.env?.MUNS_TOKEN || null;
    if (!credential) return finish({ sent: 0, failed: list.length, reason: 'no-token', outcomes: list.map((r) => ({ email: r.email, ok: false, reason: 'no-token' })) });

    let brief;
    try {
      // What earlier briefs already carried, so a capture that landed after the previous edition
      // went out is sent once — in this edition — and never twice.
      brief = await buildBrief({ edition, day, settings: this.store.settings(), env: this.env, fetcher: this.fetcher, now, to, sent: this.store.sentStoryKeys() });
    } catch (error) {
      const reason = error?.code === 'book-unavailable' ? 'book-unavailable' : 'build-failed';
      return finish({ sent: 0, failed: list.length, reason, outcomes: list.map((r) => ({ email: r.email, ok: false, reason })) });
    }
    // Plan for the longest personalised footer so all recipients receive identical boundaries.
    // PDF UUIDs have a fixed length: use a placeholder to validate the complete plan before
    // storing a document or sending anything. No render/oversize failure can send half a plan.
    // All non-test footers share one sentence, plus optional escaped attribution. A test
    // footer is always shorter. Avoid rendering the whole edition for each of 100 readers.
    const footerBytes = r => r.test ? 0 : 100 + emailBytes(r.addedBy ? ` Added by ${String(r.addedBy).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}.` : '');
    const footerRecipient = list.reduce((largest, r) => footerBytes(r) > footerBytes(largest) ? r : largest, list[0]);
    const placeholder = `${this.dashboardUrl()}/api/newsletter/pdf/00000000-0000-0000-0000-000000000000`;
    let messages;
    try {
      messages = renderBriefEmails(brief, { ...this.renderOptions(footerRecipient), pdfUrl: placeholder });
    } catch (error) {
      const reason = error?.code === 'email-too-large' ? 'email-too-large' : 'build-failed';
      return finish({ sent: 0, failed: list.length, reason, outcomes: list.map(r => ({ email: r.email, ok: false, reason })) });
    }
    let pdfUrl, documentId;
    try {
      documentId = this.store.saveDocument(renderBriefPdf(brief, this.renderOptions()), pdfFilename(brief), key);
      pdfUrl = `${this.dashboardUrl()}/api/newsletter/pdf/${documentId}`;
    } catch {
      return finish({ sent: 0, failed: list.length, reason: 'pdf-failed', outcomes: list.map(r => ({ email: r.email, ok: false, reason: 'pdf-failed' })) });
    }
    const subject = briefSubject(brief);
    const summary = { ...briefSummary(brief), emailParts: messages.length, htmlBytes: messages.map(m => m.bytes) };
    const acceptedParts = new Set();
    const deliveredStories = () => {
      const keys = source !== 'test' ? acceptedStoryKeys(messages, acceptedParts) : [];
      return keys.length ? keys : null;
    };
    const outcomes = list.map(recipient => ({ email: recipient.email, ok: false, status: null, reason: 'not-attempted',
      parts: messages.map((message, i) => ({ part: i + 1, total: messages.length, bytes: message.bytes, ok: false, status: null, reason: 'not-attempted' })) }));
    const progress = () => this.store.recordDeliveryProgress(key, { outcomes, subject, summary,
      sent: outcomes.filter(o => o.ok).length, reason: 'sending',
      stories: deliveredStories() });
    progress();
    await pooled(list.map((recipient, i) => ({ recipient, outcome: outcomes[i] })), SEND_POOL, async ({ recipient, outcome }) => {
      // Sequence parts for each reader; a failed part does not discard later updates. The
      // edition claim prevents duplicate sends, including after uncertain upstream timeouts.
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i], part = outcome.parts[i];
        const html = renderBriefHtml(brief, { ...this.renderOptions(recipient), pdfUrl, part: message.part });
        part.reason = 'sending';
        part.bytes = emailBytes(html);
        progress();
        const result = await sendEmail({ fetcher: this.fetcher, token: credential, email: recipient.email, subject: message.subject, html, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        Object.assign(part, result);
        if (result.ok) acceptedParts.add(i);
        outcome.ok = outcome.parts.every(p => p.ok);
        const unfinished = outcome.parts.find(p => !p.ok);
        outcome.status = unfinished ? unfinished.status : result.status;
        outcome.reason = outcome.ok ? null : outcome.parts.some(p => p.ok) ? 'partial-send' : outcome.parts.find(p => !p.ok)?.reason;
        progress();
      }
    });
    const sent = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - sent;
    const partOutcomes = outcomes.flatMap(o => o.parts);
    this.store.finishDocument(documentId, partOutcomes);
    const stories = deliveredStories();
    const reason = !failed ? null : partOutcomes.some(p => p.ok) ? 'partial-send' : outcomes[0]?.reason || 'failed';
    return finish({ sent, failed, reason, outcomes, subject, summary, stories });
  }

  /** A send somebody pressed: a test copy to one address, or the edition to everyone, built now. */
  async sendNow({ edition, to, email = null }, token = null) {
    if (!EDITIONS[edition]) return { ok: false, reason: 'invalid-edition' };
    const now = this.now();
    const day = istDay(now);
    let recipients;
    if (to === 'me') {
      const address = normaliseEmail(email);
      if (!address) return { ok: false, reason: 'invalid-email' };
      recipients = [{ email: address, name: null, addedBy: null, test: true }];
    } else if (to === 'all') {
      const recent = this.store.deliveries(10).find((d) => d.source === 'button' && d.edition === edition && now - Date.parse(d.startedAt) < MANUAL_COOLDOWN_MS);
      if (recent) return { ok: false, reason: 'cooling-down', cooldownS: MANUAL_COOLDOWN_MS / 1000, key: recent.key };
      recipients = this.store.recipients(edition);
    } else {
      return { ok: false, reason: 'invalid-target' };
    }
    const budget = this.store.claimManualDelivery(now);
    if (!budget.ok) return { ok: false, reason: 'manual-send-budget', retryAt: budget.retryAt };
    const key = `manual:${edition}:${day}:${now}:${to}`;
    return this.deliver({ edition, day, at: now, key, source: to === 'me' ? 'test' : 'button', now, recipients, token, to: now });
  }

  /** The edition as it would be sent now, rendered but not sent. */
  async preview({ edition, format = 'html', part = 1 } = {}) {
    if (!EDITIONS[edition]) return { ok: false, reason: 'invalid-edition' };
    const now = this.now();
    let brief;
    try {
      brief = await buildBrief({ edition, day: istDay(now), settings: this.store.settings(), env: this.env, fetcher: this.fetcher, now, to: now, sent: this.store.sentStoryKeys(), includeAi: false });
    } catch (error) {
      return { ok: false, reason: error?.code === 'book-unavailable' ? 'book-unavailable' : 'build-failed' };
    }
    if (format === 'html') {
      let messages;
      try { messages = renderBriefEmails(brief, this.renderOptions()); }
      catch (error) { return { ok: false, reason: error?.code || 'build-failed' }; }
      const message = messages[part - 1];
      if (!message) return { ok: false, reason: 'invalid-part' };
      return { ok: true, edition, subject: message.subject, builtAt: iso(now), summary: briefSummary(brief),
        part, parts: messages.length, body: renderBriefHtml(brief, { ...this.renderOptions(), part: message.part, preview: true }) };
    }
    return {
      ok: true, edition, subject: briefSubject(brief), builtAt: iso(now), summary: briefSummary(brief),
      filename: format === 'pdf' ? pdfFilename(brief) : undefined,
      body: format === 'pdf' ? renderBriefPdf(brief, this.renderOptions()) : format === 'text' ? renderBriefText(brief, this.renderOptions()) : renderBriefHtml(brief, this.renderOptions()),
    };
  }
}

export { editionKey };
