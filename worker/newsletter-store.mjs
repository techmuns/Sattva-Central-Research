import {
  EDITION_IDS, NEWSLETTER_SUBSCRIBER_LIMIT, DEFAULT_SETTINGS, REPORTED_RETENTION_MS,
  newsletterIntents, newsletterSettings, normaliseEditions, subscriberEntry,
} from '../public/js/data/newsletter-shared.js';

// THE TEAM BRIEF'S SUBSCRIBERS, SCHEDULE AND DELIVERY LOG, AS ONE DURABLE RECORD.
//
// One object, one desk, one list — `NEWSLETTER_OBJECT` below — on the already provisioned
// `CaptureRegistry` class, exactly as the shared watchlist and the Telegram timer reuse it. Its
// tables are created the first time a newsletter method is called and nothing else ever sees them.
//
// THE SERVER STAMPS EVERY TIME, for the reason the watchlist store gives: ordering two devices'
// edits by either device's clock trusts whichever is furthest wrong.
//
// A REMOVAL IS A RECORD, NOT AN ABSENCE. An unsubscribed address keeps its row with
// `state = 'removed'`, so "unsubscribed here" and "never subscribed" are different states, and a
// stale panel replaying an old add lands on a row that already says what happened.
//
// A DELIVERY IS CLAIMED BEFORE IT IS SENT. `beginDelivery` inserts the edition's key — one per
// edition per IST day — and refuses a second claim on the same key for ever. A replayed alarm, a
// Durable Object restart mid-send, or two paths asking for the same brief therefore cannot email
// the desk twice. What it costs is honesty in the other direction: a delivery the object died
// inside stays in the log with no `finishedAt`, and the panel shows it as interrupted rather than
// quietly sending again.
//
// WHAT THE DESK HAS BEEN SENT IS A RECORD TOO — `newsletter_reported`, one row per item (a filing,
// a story, a trade, a price move) that a brief sent to the list actually carried, keyed by the item's
// own identity rather than by anything the capture might restamp. It is what lets the next brief
// carry a filing captured after the previous one went out, and what stops it carrying the same
// filing twice. Only a send that REACHED somebody writes it: a test copy, a preview, and a delivery
// whose every send failed leave it alone, because "reported" has to mean the desk saw it.

export const NEWSLETTER_OBJECT = 'team-brief:v1';
export const DELIVERY_HISTORY = 12;
export const MANUAL_SEND_LIMIT = 4;
export const MANUAL_SEND_WINDOW_MS = 24 * 3600 * 1000;

const iso = (at) => new Date(at).toISOString();
const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

export class NewsletterStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS newsletter_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      email TEXT PRIMARY KEY, name TEXT, editions TEXT NOT NULL, state TEXT NOT NULL,
      added_at TEXT, added_by TEXT, removed_at TEXT, removed_by TEXT,
      updated_at TEXT NOT NULL, seq INTEGER NOT NULL)`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS newsletter_deliveries (
      key TEXT PRIMARY KEY, edition TEXT NOT NULL, day TEXT NOT NULL, scheduled_at TEXT,
      started_at TEXT NOT NULL, finished_at TEXT, source TEXT NOT NULL,
      recipients INTEGER NOT NULL, sent INTEGER, failed INTEGER, reason TEXT,
      subject TEXT, outcomes TEXT, summary TEXT)`);
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS newsletter_state ON newsletter_subscribers(state, seq)');
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS newsletter_delivery_time ON newsletter_deliveries(started_at)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS newsletter_reported (
      item TEXT PRIMARY KEY, published_at TEXT, delivery TEXT NOT NULL, reported_at TEXT NOT NULL)`);
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS newsletter_reported_time ON newsletter_reported(reported_at)');
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS newsletter_manual_attempts (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS newsletter_documents (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL,
      delivery_key TEXT, delivery_state TEXT NOT NULL DEFAULT 'pending')`);
    // Added after the table shipped: a deployment whose log predates it gains the column in place.
    const columns = this.storage.sql.exec('PRAGMA table_info(newsletter_deliveries)').toArray();
    if (!columns.some((c) => c.name === 'stories')) this.storage.sql.exec('ALTER TABLE newsletter_deliveries ADD COLUMN stories TEXT');
    const documentColumns = this.storage.sql.exec('PRAGMA table_info(newsletter_documents)').toArray();
    if (!documentColumns.some(c => c.name === 'delivery_key')) this.storage.sql.exec('ALTER TABLE newsletter_documents ADD COLUMN delivery_key TEXT');
    if (!documentColumns.some(c => c.name === 'delivery_state')) this.storage.sql.exec("ALTER TABLE newsletter_documents ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'");
    this.initialised = true;
    // Migrate acknowledged Sattva story identities in place, once. Preserve subscribers,
    // delivery claims and documents, including interrupted/partially acknowledged editions.
    const meta = this.meta();
    if (!meta.reportedMigrated) this.storage.transactionSync(() => {
      const cutoff = iso(this.now() - REPORTED_RETENTION_MS);
      const deliveries = this.rows("SELECT key,started_at,stories FROM newsletter_deliveries WHERE stories IS NOT NULL AND source != 'test' AND started_at >= ? ORDER BY started_at", cutoff);
      for (const d of deliveries) for (const key of parseJson(d.stories, [])) {
        if (typeof key !== 'string' || key.length > 512) continue;
        this.rows('INSERT OR IGNORE INTO newsletter_reported(item,published_at,delivery,reported_at) VALUES (?,NULL,?,?)', key, d.key, d.started_at);
      }
      this.putMeta({ ...meta, reportedMigrated: true, ...(deliveries.length && !meta.reportedSince ? { reportedSince: iso(Date.parse(deliveries[0].started_at) - 26*3600000) } : {}) });
    });
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  meta() {
    const found = this.rows("SELECT value FROM newsletter_meta WHERE key = 'state'")[0];
    const value = found ? parseJson(found.value, null) : null;
    return value && typeof value === 'object' ? value : { revision: 0, updatedAt: null, seq: 0, settings: null };
  }

  putMeta(value) {
    this.rows("INSERT INTO newsletter_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  }

  /** The desk-wide schedule, always valid: a corrupt stored value falls back to the defaults. */
  settings() {
    try { return newsletterSettings(this.meta().settings || {}); } catch { return newsletterSettings(DEFAULT_SETTINGS); }
  }

  setSettings(input) {
    const next = newsletterSettings(input);
    const meta = this.meta();
    const current = this.settings();
    if (JSON.stringify(current) === JSON.stringify(next)) return { changed: false, snapshot: this.snapshot() };
    const at = iso(this.now());
    this.putMeta({ ...meta, settings: next, revision: (meta.revision || 0) + 1, updatedAt: at });
    return { changed: true, snapshot: this.snapshot() };
  }

  subscriberRows() {
    return this.rows(
      "SELECT email, name, editions, added_at, added_by FROM newsletter_subscribers WHERE state = 'active' ORDER BY seq ASC",
    ).map((row) => subscriberEntry({
      email: row.email, name: row.name, editions: parseJson(row.editions, EDITION_IDS),
      addedAt: row.added_at, addedBy: row.added_by,
    })).filter(Boolean);
  }

  /** Everyone who receives one edition, in the order they were added. */
  recipients(edition) {
    return this.subscriberRows().filter((row) => row.editions.includes(edition));
  }

  snapshot() {
    const meta = this.meta();
    const subscribers = this.subscriberRows();
    return {
      version: 1,
      revision: meta.revision || 0,
      updatedAt: meta.updatedAt || null,
      settings: this.settings(),
      count: subscribers.length,
      limit: NEWSLETTER_SUBSCRIBER_LIMIT,
      subscribers,
      deliveries: this.deliveries(DELIVERY_HISTORY),
    };
  }

  apply(input) {
    const intents = newsletterIntents(input);
    this.init();
    return this.storage.transactionSync(() => {
      const meta = this.meta();
      let seq = meta.seq || 0;
      let changed = false;
      const at = iso(this.now());
      const outcomes = [];
      for (const intent of intents) {
        const existing = this.rows('SELECT email, name, editions, state FROM newsletter_subscribers WHERE email = ?', intent.email)[0];
        const active = existing?.state === 'active';
        if (intent.op === 'subscribe') {
          if (active) {
            const sameEditions = JSON.stringify(parseJson(existing.editions, [])) === JSON.stringify(intent.editions);
            const sameName = (existing.name || null) === (intent.name || existing.name || null);
            if (sameEditions && sameName) { outcomes.push({ email: intent.email, outcome: 'unchanged' }); continue; }
            this.rows('UPDATE newsletter_subscribers SET editions = ?, name = ?, updated_at = ? WHERE email = ?',
              JSON.stringify(intent.editions), intent.name || existing.name || null, at, intent.email);
            outcomes.push({ email: intent.email, outcome: 'updated' });
            changed = true;
            continue;
          }
          if (!existing) {
            const count = this.rows("SELECT COUNT(*) AS count FROM newsletter_subscribers WHERE state = 'active'")[0].count;
            // Refused for capacity NEVER reads as subscribed, or the panel would report an address
            // that will receive nothing.
            if (count >= NEWSLETTER_SUBSCRIBER_LIMIT) { outcomes.push({ email: intent.email, outcome: 'full' }); continue; }
          }
          seq += 1;
          this.rows(
            `INSERT INTO newsletter_subscribers (email, name, editions, state, added_at, added_by, removed_at, removed_by, updated_at, seq)
             VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)
             ON CONFLICT(email) DO UPDATE SET name = excluded.name, editions = excluded.editions, state = 'active',
               added_at = excluded.added_at, added_by = excluded.added_by, removed_at = NULL, removed_by = NULL,
               updated_at = excluded.updated_at, seq = excluded.seq`,
            intent.email, intent.name, JSON.stringify(intent.editions), at, intent.by, at, seq,
          );
          outcomes.push({ email: intent.email, outcome: 'subscribed' });
          changed = true;
        } else if (intent.op === 'editions') {
          if (!active) { outcomes.push({ email: intent.email, outcome: 'not-subscribed' }); continue; }
          if (JSON.stringify(parseJson(existing.editions, [])) === JSON.stringify(intent.editions)) { outcomes.push({ email: intent.email, outcome: 'unchanged' }); continue; }
          this.rows('UPDATE newsletter_subscribers SET editions = ?, updated_at = ? WHERE email = ?', JSON.stringify(intent.editions), at, intent.email);
          outcomes.push({ email: intent.email, outcome: 'updated' });
          changed = true;
        } else {
          if (!active) { outcomes.push({ email: intent.email, outcome: 'unchanged' }); continue; }
          this.rows("UPDATE newsletter_subscribers SET state = 'removed', removed_at = ?, removed_by = ?, updated_at = ? WHERE email = ?",
            at, intent.by, at, intent.email);
          outcomes.push({ email: intent.email, outcome: 'unsubscribed' });
          changed = true;
        }
      }
      if (changed) this.putMeta({ ...meta, seq, revision: (meta.revision || 0) + 1, updatedAt: at });
      return { outcomes, snapshot: this.snapshot() };
    });
  }

  /**
   * Claim one delivery. False when the key is already claimed — which is the whole point: a
   * scheduled edition's key is `<day>:<edition>` and is claimed once, ever.
   */
  beginDelivery({ key, edition, day, scheduledAt = null, source, recipients }) {
    this.init();
    return this.storage.transactionSync(() => {
      const existing = this.rows('SELECT key FROM newsletter_deliveries WHERE key = ?', key)[0];
      if (existing) return false;
      this.rows(
        'INSERT INTO newsletter_deliveries (key, edition, day, scheduled_at, started_at, finished_at, source, recipients) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        key, edition, day, scheduledAt != null ? iso(scheduledAt) : null, iso(this.now()), source, recipients,
      );
      return true;
    });
  }

  finishDelivery(key, values = {}) {
    this.recordDeliveryProgress(key, values, true);
    this.pruneDeliveries();
  }

  recordDeliveryProgress(key, { sent = 0, failed = 0, reason = null, outcomes = [], subject = null, summary = null, reported = [], windowFrom = null } = {}, finished = false) {
    this.init();
    this.storage.transactionSync(() => {
      this.rows(
        'UPDATE newsletter_deliveries SET finished_at = ?, sent = ?, failed = ?, reason = ?, subject = ?, outcomes = ?, summary = ? WHERE key = ?',
        finished ? iso(this.now()) : null, sent, failed, reason, subject, JSON.stringify(outcomes), summary ? JSON.stringify(summary) : null, key,
      );
      // Write acknowledged identities in the same transaction as their part outcomes.
      if (reported.length) this.markReportedRows(reported, key, { windowFrom });
    });
  }

  // Reserve a manual attempt before any model, PDF, or email work. This desk-wide rolling
  // budget survives object restarts and cannot be bypassed with another address or client IP.
  // Scheduled editions use their existing once-per-edition claims and do not spend this budget.
  claimManualDelivery(now = this.now()) {
    this.init();
    return this.storage.transactionSync(() => {
      this.rows('DELETE FROM newsletter_manual_attempts WHERE at <= ?', now - MANUAL_SEND_WINDOW_MS);
      const budget = this.rows('SELECT COUNT(*) AS count, MIN(at) AS first FROM newsletter_manual_attempts')[0];
      if (budget.count >= MANUAL_SEND_LIMIT) return { ok: false, retryAt: iso(budget.first + MANUAL_SEND_WINDOW_MS) };
      this.rows('INSERT INTO newsletter_manual_attempts (id, at) VALUES (?, ?)', crypto.randomUUID(), now);
      return { ok: true };
    });
  }

  // Immutable PDFs have opaque bearer links and no subscriber addresses. Keep them independently
  // of the short delivery log: pruning that log must not break a previously emailed download.
  saveDocument(body, filename, deliveryKey) {
    if (!(body instanceof Uint8Array) || body.byteLength > 1_500_000) throw new Error('Invalid newsletter PDF');
    const id = crypto.randomUUID();
    this.rows('INSERT INTO newsletter_documents (id, filename, body, created_at, delivery_key) VALUES (?, ?, ?, ?, ?)', id, filename, body, iso(this.now()), deliveryKey);
    return id;
  }

  finishDocument(id, outcomes) {
    if (outcomes.some(o => o.ok)) {
      this.rows("UPDATE newsletter_documents SET delivery_state = 'sent' WHERE id = ?", id);
    } else if (outcomes.length && outcomes.every(o => ['unauthorised', 'rate-limited', 'refused', 'no-token'].includes(o.reason))) {
      this.rows('DELETE FROM newsletter_documents WHERE id = ?', id);
    } else {
      // A timeout, connection loss, 5xx or malformed response can follow an accepted email.
      // Keep its link usable, but track that state and the delivery key independently of log
      // pruning, so uncertain/interrupted documents remain identifiable rather than orphaned.
      this.rows("UPDATE newsletter_documents SET delivery_state = 'delivery-uncertain' WHERE id = ?", id);
    }
  }

  document(id) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id || '')) return null;
    const row = this.rows('SELECT filename, body FROM newsletter_documents WHERE id = ?', id)[0];
    return row ? { filename: row.filename, body: new Uint8Array(row.body) } : null;
  }

  pruneDeliveries() {
    const keep = 200;
    const total = this.rows('SELECT COUNT(*) AS count FROM newsletter_deliveries')[0].count;
    if (total <= keep) return;
    this.rows('DELETE FROM newsletter_deliveries WHERE key IN (SELECT key FROM newsletter_deliveries ORDER BY started_at ASC LIMIT ?)', total - keep);
  }

  delivery(key) {
    return this.rows('SELECT * FROM newsletter_deliveries WHERE key = ?', key).map(deliveryRow)[0] || null;
  }

  deliveries(limit = DELIVERY_HISTORY) {
    return this.rows('SELECT * FROM newsletter_deliveries ORDER BY started_at DESC LIMIT ?', limit).map(deliveryRow);
  }

  /**
   * What the desk has already been sent, as one read: `has(key)` answers for any item key, and
   * `empty` says the ledger holds nothing at all — which the brief treats as "unknown" and reads no
   * late arrivals against, so the first send after this ledger exists is an ordinary window rather
   * than three days of everything the desk had seen without it.
   */
  reportedLookup() {
    const keys = new Set(this.rows('SELECT item FROM newsletter_reported').map((row) => row.item));
    const since = this.meta().reportedSince;
    return {
      empty: keys.size === 0,
      size: keys.size,
      // The window start of the first delivery this ledger recorded. Nothing published before it can
      // be judged "not sent": briefs before the ledger existed carried it, and the ledger cannot know.
      since: Number.isFinite(Date.parse(since || '')) ? Date.parse(since) : null,
      has: (key) => keys.has(String(key)),
    };
  }

  /**
   * Record every item a delivery carried. Idempotent: a key already held keeps its first delivery.
   * `windowFrom` is the delivery's own window start; the first one recorded is where the ledger's
   * knowledge begins, and `reportedLookup().since` reports it.
   */
  markReported(items, delivery, { windowFrom = null } = {}) {
    this.init();
    return this.storage.transactionSync(() => this.markReportedRows(items, delivery, { windowFrom }));
  }

  markReportedRows(items, delivery, { windowFrom = null } = {}) {
    const at = iso(this.now());
    const meta = this.meta();
    if (!meta.reportedSince && Number.isFinite(windowFrom)) this.putMeta({ ...meta, reportedSince: iso(windowFrom) });
    let added = 0;
    for (const item of items || []) {
      const key = String(item?.key || '');
      if (!key) continue;
      const publishedAt = Number.isFinite(item.publishedAt) ? iso(item.publishedAt) : null;
      this.rows('INSERT OR IGNORE INTO newsletter_reported (item, published_at, delivery, reported_at) VALUES (?, ?, ?, ?)', key, publishedAt, String(delivery || ''), at);
      added += this.rows('SELECT changes() AS n')[0].n;
    }
    this.rows('DELETE FROM newsletter_reported WHERE reported_at < ?', iso(this.now() - REPORTED_RETENTION_MS));
    return { added };
  }

  sentStoryKeys() {
    return new Set(this.rows('SELECT item FROM newsletter_reported').map(row => row.item));
  }

  reportedCount() {
    return this.rows('SELECT COUNT(*) AS count FROM newsletter_reported')[0].count;
  }
}

/** A delivery as the panel reads it. Per-recipient outcomes travel; upstream error text never does. */
function deliveryRow(row) {
  return {
    key: row.key,
    edition: EDITION_IDS.includes(row.edition) ? row.edition : null,
    day: row.day,
    scheduledAt: row.scheduled_at || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    source: row.source,
    recipients: row.recipients,
    sent: row.sent ?? null,
    failed: row.failed ?? null,
    reason: row.reason || null,
    subject: row.subject || null,
    outcomes: parseJson(row.outcomes, []),
    summary: row.summary ? parseJson(row.summary, null) : null,
  };
}

export { normaliseEditions };
