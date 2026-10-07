// AI READ — one fixed object (announcement-read:v1) on the provisioned CaptureRegistry class.
//
// A reader clicks a Corporate Announcement; this object fetches the exchange's own document, has the
// model read all of it, and stores the answer under the document's identity so every later reader
// gets it for nothing (announcement-read-shared.js has the shape and the instructions).
//
// THE SAME GUARANTEES AS THE ALERT NOTES (alert-notes-store.mjs), because the same things can go
// wrong with a paid call on an unauthenticated route:
//   1. A reading is stored under the hash of the DOCUMENT it was read from (its exchange identity) and
//      the instructions version — never under an id the caller chose — so nobody can file a reading
//      against somebody else's filing.
//   2. Two readers asking at once pay once: the request in flight is shared inside the object.
//   3. Spend is bounded by day and by document. The attempt is reserved before any I/O; a temporary
//      failure backs off and stops after three attempts; a rejected answer is not bought again.
//
// ONLY EXCHANGE DOCUMENTS ARE FETCHED (bseindia.com, nseindia.com archives — newsletter-content.mjs
// contentUrl), with no credential, bounded in size and time. The model key goes only to the AWS-owned
// Bedrock endpoint (research-claude.mjs). Nothing here reads private records.
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { announcementDocumentIdentity } from '../public/js/data/announcements-shared.js';
import { isXbrlFilingUrl, parseXbrlFiling } from '../public/js/data/nse-xbrl-shared.js';
import { READ_VERSION, READ_INSTRUCTIONS, readRequest, readContext, parseRead } from '../public/js/data/announcement-read-shared.js';
import { contentUrl, fetchContent, contentReason, articleText, CONTENT_TEXT_CHARS } from './newsletter-content.mjs';
import { bedrockConfig, bedrockConfigured, claudeCredential } from './research-claude.mjs';

export const ANNOUNCEMENT_READ_OBJECT = 'announcement-read:v1';
// Reads per IST day across every reader. A stored reading costs nothing and does not count.
export const READ_DAILY_LIMIT = 150;
export const READ_MAX_ATTEMPTS = 3;
export const READ_TIMEOUT_MS = 75_000;
export const READ_MAX_TOKENS = 1800;
const RETRY_MS = { upstream: 120_000, timeout: 120_000, 'rate-limited': 90_000, refused: 900_000, unreachable: 180_000, 'access-limited': 900_000 };
// Answers that are a property of the document, not of the moment: asking again will not change them.
const FINAL = new Set(['unsupported-source', 'missing-link', 'no-document', 'too-large', 'unsupported-format', 'issuer-mismatch', 'redirect-limit', 'unsupported-redirect', 'empty']);

const istDay = (at) => new Date(at + 5.5 * 3_600_000).toISOString().slice(0, 10);
async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const base64 = (bytes) => {
  let value = '';
  for (let i = 0; i < bytes.length; i += 16384) value += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(value);
};
const failure = (reason) => Object.assign(new Error(reason), { reason });
const statusReason = (status) => (status === 401 || status === 403 ? 'refused' : status === 429 ? 'rate-limited' : status === 413 ? 'too-large' : 'upstream');

export class AnnouncementReadStore {
  constructor(storage, env = {}, { fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
    this.storage = storage;
    this.env = env;
    this.fetcher = fetcher;
    this.now = now;
    this.inflight = new Map();
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS announcement_reads (
      key TEXT PRIMARY KEY, reading TEXT NOT NULL, source_url TEXT, format TEXT, hash TEXT, model TEXT, created_at TEXT NOT NULL)`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS announcement_read_attempts (
      key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reason TEXT NOT NULL, retry_at INTEGER)`);
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS announcement_read_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  budget() {
    const found = this.rows("SELECT value FROM announcement_read_meta WHERE key = 'budget'")[0];
    const today = istDay(this.now());
    const value = found ? JSON.parse(found.value) : null;
    return value?.day === today ? value : { day: today, used: 0 };
  }

  status() {
    const stored = this.rows('SELECT COUNT(*) AS count FROM announcement_reads')[0]?.count || 0;
    const { day, used } = this.budget();
    return { ok: true, stored, day, used, limit: READ_DAILY_LIMIT, configured: bedrockConfigured(this.env), model: bedrockConfigured(this.env) ? bedrockConfig(this.env).model : null };
  }

  /**
   * One filing's reading: `{ ok, state: 'ready', reading, … }` when there is one, otherwise
   * `{ ok, state: 'failed' | 'pending', reason, retryAt }`. Never an empty reading.
   */
  async read(raw) {
    const item = readRequest(raw);
    const url = item.urls.map((u) => contentUrl(u, 'filing')).find(Boolean);
    if (!url) return { ok: true, state: 'failed', reason: item.urls.length ? 'unsupported-source' : 'no-document', retryAt: null };
    const document = announcementDocumentIdentity(url) || url;
    const key = await sha256(JSON.stringify([READ_VERSION, document]));
    const stored = this.rows('SELECT reading, source_url, format, model, created_at FROM announcement_reads WHERE key = ?', key)[0];
    if (stored) return { ok: true, state: 'ready', reading: JSON.parse(stored.reading), sourceUrl: stored.source_url, format: stored.format, model: stored.model, readAt: stored.created_at, stored: true };
    const attempt = this.rows('SELECT attempts, reason, retry_at FROM announcement_read_attempts WHERE key = ?', key)[0];
    if (!this.inflight.has(key) && attempt && (FINAL.has(attempt.reason) || attempt.attempts >= READ_MAX_ATTEMPTS || (attempt.retry_at && attempt.retry_at > this.now()))) {
      const exhausted = !FINAL.has(attempt.reason) && attempt.attempts >= READ_MAX_ATTEMPTS && !(attempt.retry_at && attempt.retry_at > this.now());
      return { ok: true, state: 'failed', reason: exhausted ? 'retry-exhausted' : attempt.reason, retryAt: exhausted || FINAL.has(attempt.reason) ? null : attempt.retry_at };
    }
    if (!this.inflight.has(key)) {
      const job = this.generate({ key, url, item }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return this.inflight.get(key);
  }

  async generate({ key, url, item }) {
    if (!bedrockConfigured(this.env)) return { ok: true, state: 'failed', reason: 'no-key', retryAt: null };
    const { used } = this.budget();
    if (used >= READ_DAILY_LIMIT) return { ok: true, state: 'failed', reason: 'budget', retryAt: null };
    // Reserve the day's allowance and this document's attempt before any I/O. A lost response or a
    // restart must not erase the charge; no network work happens inside the transaction.
    const attempts = (this.rows('SELECT attempts FROM announcement_read_attempts WHERE key = ?', key)[0]?.attempts || 0) + 1;
    this.storage.transactionSync(() => {
      const value = this.budget();
      value.used += 1;
      this.rows("INSERT INTO announcement_read_meta(key,value) VALUES ('budget',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
      this.rows(`INSERT INTO announcement_read_attempts(key, attempts, reason, retry_at) VALUES (?, ?, 'timeout', ?)
        ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts, reason=excluded.reason, retry_at=excluded.retry_at`,
      key, attempts, this.now() + READ_TIMEOUT_MS + RETRY_MS.timeout * attempts);
    });
    const failed = (reason) => {
      const final = FINAL.has(reason);
      const exhausted = !final && attempts >= READ_MAX_ATTEMPTS;
      const retryAt = final || exhausted ? null : this.now() + (RETRY_MS[reason] || RETRY_MS.upstream) * attempts;
      this.rows('UPDATE announcement_read_attempts SET reason = ?, retry_at = ? WHERE key = ?', reason, retryAt, key);
      return { ok: true, state: 'failed', reason: exhausted ? 'retry-exhausted' : reason, retryAt };
    };
    try {
      const source = await fetchContent({ url, kind: 'filing' }, this.fetcher);
      const content = this.documentContent(source, item);
      content.push({ type: 'text', text: readContext(item) });
      const config = bedrockConfig(this.env);
      const response = await this.fetcher(config.url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        headers: { 'x-api-key': claudeCredential(this.env), 'anthropic-version': '2023-06-01', accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, max_tokens: READ_MAX_TOKENS, thinking: { type: 'disabled' },
          system: [{ type: 'text', text: READ_INSTRUCTIONS }], messages: [{ role: 'user', content }] }),
      });
      if (!response.ok) { await response.body?.cancel(); return failed(statusReason(response.status)); }
      const reply = await boundedJson(response, 120_000).catch(() => null);
      if (reply?.stop_reason !== 'end_turn') return failed('unreadable');
      const parsed = parseRead((reply.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'));
      if (!parsed.ok) return failed(parsed.reason === 'issuer-mismatch' ? 'issuer-mismatch' : parsed.reason === 'unreadable' ? 'unreadable' : parsed.reason);
      const readAt = new Date(this.now()).toISOString();
      this.rows(`INSERT INTO announcement_reads(key, reading, source_url, format, hash, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO NOTHING`, key, JSON.stringify(parsed.reading), source.url, source.format, source.hash, config.model, readAt);
      this.rows('DELETE FROM announcement_read_attempts WHERE key = ?', key);
      return { ok: true, state: 'ready', reading: parsed.reading, sourceUrl: source.url, format: source.format, model: config.model, readAt, stored: false };
    } catch (error) {
      return failed(error?.reason || contentReason(error));
    }
  }

  /** The document as the model receives it: a PDF whole, an XBRL filing as its own facts, a page as text. */
  documentContent(source, item) {
    const prefix = new TextDecoder().decode(source.bytes.subarray(0, 1024));
    if (isXbrlFilingUrl(source.url) || /^\s*<\?xml|<xbrl/i.test(prefix)) {
      const parsed = parseXbrlFiling(new TextDecoder().decode(source.bytes));
      if (!parsed.ok) throw failure('unreadable');
      const facts = parsed.blocks.flatMap((block) => block.facts.map((f) => ({ section: block.key, label: f.label, value: f.value, unit: f.unit || undefined })));
      const text = JSON.stringify({ XBRL_FILING_FACTS: facts });
      if (!facts.length) throw failure('unreadable');
      if (text.length > CONTENT_TEXT_CHARS) throw failure('too-large');
      source.format = 'xbrl';
      return [{ type: 'text', text }];
    }
    if (/^%PDF-/.test(prefix)) {
      source.format = 'pdf';
      return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64(source.bytes) } }];
    }
    if (/html/i.test(source.contentType || '') || /<html|<body/i.test(prefix)) {
      const html = new TextDecoder().decode(source.bytes);
      const article = articleText(html);
      const text = article?.text || String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 80) throw failure('unreadable');
      if (text.length > CONTENT_TEXT_CHARS) throw failure('too-large');
      source.format = 'html';
      return [{ type: 'text', text: JSON.stringify({ DOCUMENT_TEXT: text }) }];
    }
    void item;
    throw failure('unsupported-format');
  }
}
