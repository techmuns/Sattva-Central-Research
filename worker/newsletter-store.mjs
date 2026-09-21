import {
  EDITION_IDS, NEWSLETTER_SUBSCRIBER_LIMIT, DEFAULT_SETTINGS,
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
// A DELIVERY ALSO RECORDS WHAT IT CARRIED. `stories` is the list of keys every story in a sent
// brief travelled under (a filing's URL on each exchange, a headline, a session move), and
// `sentStoryKeys()` is the union over the last few sent deliveries. The brief builder reaches back
// over the previous edition's window for captures that landed after that edition went out, and
// this is how it knows which of those rows the desk has already read. Keys, never rows: the log
// holds nothing the exchanges or publishers wrote. A test copy records nothing, because it went to
// one person and not to the desk.

export const NEWSLETTER_OBJECT = 'team-brief:v1';
export const DELIVERY_HISTORY = 12;
// Three weekdays of editions: a story that fell out of two consecutive windows is old news, and a
// capture that lands later than that is an outage the sources line already reports.
export const SENT_HISTORY = 6;

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
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS newsletter_documents (id TEXT PRIMARY KEY, filename TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL)');
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS newsletter_state ON newsletter_subscribers(state, seq)');
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS newsletter_delivery_time ON newsletter_deliveries(started_at)');
    // Added after the table shipped: a deployment whose log predates it gains the column in place.
    const columns = this.storage.sql.exec('PRAGMA table_info(newsletter_deliveries)').toArray();
    if (!columns.some((c) => c.name === 'stories')) this.storage.sql.exec('ALTER TABLE newsletter_deliveries ADD COLUMN stories TEXT');
    this.initialised = true;
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

  finishDelivery(key, { sent = 0, failed = 0, reason = null, outcomes = [], subject = null, summary = null, stories = null } = {}) {
    const keys = Array.isArray(stories) ? stories.filter((k) => typeof k === 'string' && k.length <= 512).slice(0, 2000) : null;
    this.rows(
      'UPDATE newsletter_deliveries SET finished_at = ?, sent = ?, failed = ?, reason = ?, subject = ?, outcomes = ?, summary = ?, stories = ? WHERE key = ?',
      iso(this.now()), sent, failed, reason, subject, JSON.stringify(outcomes || []), summary ? JSON.stringify(summary) : null, keys ? JSON.stringify(keys) : null, key,
    );
    this.pruneDeliveries();
  }

  /** The keys of every story the last few SENT deliveries carried — what the next brief may treat as read. */
  sentStoryKeys(limit = SENT_HISTORY) {
    const out = new Set();
    for (const row of this.rows('SELECT stories FROM newsletter_deliveries WHERE stories IS NOT NULL AND sent > 0 ORDER BY started_at DESC LIMIT ?', limit)) {
      for (const key of parseJson(row.stories, [])) if (typeof key === 'string') out.add(key);
    }
    return out;
  }

  // Immutable PDFs have opaque bearer links and no subscriber addresses. Keep them independently
  // of the short delivery log: pruning that log must not break a previously emailed download.
  saveDocument(body, filename) {
    if (!(body instanceof Uint8Array) || body.byteLength > 1_500_000) throw new Error('Invalid newsletter PDF');
    const id = crypto.randomUUID();
    this.rows('INSERT INTO newsletter_documents (id, filename, body, created_at) VALUES (?, ?, ?, ?)', id, filename, body, iso(this.now()));
    return id;
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
