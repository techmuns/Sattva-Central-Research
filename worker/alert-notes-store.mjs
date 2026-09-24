// THE "SO WHAT?" NOTES — one fixed object (alert-notes:v1) on the provisioned CaptureRegistry class.
//
// A note is written once per development and kept, so what a reader pays for is one model request
// per development the desk ever looks at, never one per paint or per reader. Three rules hold it up:
//
// 1. A NOTE IS STORED UNDER THE HASH OF EVERYTHING THE MODEL WAS GIVEN (`noteContent`), never under
//    an id the caller chose. The route is unauthenticated, so an id-keyed store would let anybody
//    file a note against somebody else's development; a content-keyed one can only ever answer the
//    text it was written from.
// 2. TWO READERS ASKING AT ONCE PAY ONCE. A request in flight is shared by key inside the object,
//    which is single-threaded, so the second asker waits on the first answer instead of a second call.
// 3. SPEND IS BOUNDED BY DAY, AND AN EXHAUSTED ALLOWANCE IS A NAMED STATE. `NOTE_DAILY_LIMIT` new
//    notes per Indian day; past it the page says the allowance is spent rather than showing nothing.
import { noteContent, noteItem, noteRequest, parseNotes, acceptNote, NOTE_REQUEST_ITEMS } from '../public/js/data/alert-notes-shared.js';
import { bedrockConfig, bedrockConfigured, claudeCredential } from './research-claude.mjs';

export const ALERT_NOTES_OBJECT = 'alert-notes:v1';
export const NOTE_DAILY_LIMIT = 1200;
export const NOTE_TIMEOUT_MS = 30_000;
/** Notes older than this are dropped; a development that old has left every alert window. */
export const NOTE_KEEP_DAYS = 60;

const istDay = (at) => new Date(at + 5.5 * 3_600_000).toISOString().slice(0, 10);

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const failureOf = (error) => (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'upstream');

export class AlertNotesStore {
  constructor(storage, env = {}, { fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
    this.storage = storage;
    this.env = env;
    this.fetcher = fetcher;
    this.now = now;
    this.inflight = new Map();
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS alert_notes (
      key TEXT PRIMARY KEY, note TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL)`);
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS alert_notes_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  budget() {
    const found = this.rows("SELECT value FROM alert_notes_meta WHERE key = 'budget'")[0];
    const today = istDay(this.now());
    const value = found ? JSON.parse(found.value) : null;
    return value?.day === today ? value : { day: today, used: 0 };
  }

  spend(count) {
    const value = this.budget();
    value.used += count;
    this.rows("INSERT INTO alert_notes_meta(key,value) VALUES ('budget',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
    // Once a day, on the first spend of it, drop what has left every window.
    if (value.used === count) {
      const cutoff = new Date(this.now() - NOTE_KEEP_DAYS * 86_400_000).toISOString();
      this.rows('DELETE FROM alert_notes WHERE created_at < ?', cutoff);
    }
    return value;
  }

  status() {
    this.init();
    const stored = this.rows('SELECT COUNT(*) AS count FROM alert_notes')[0]?.count || 0;
    const { day, used } = this.budget();
    return { stored, day, used, limit: NOTE_DAILY_LIMIT, configured: bedrockConfigured(this.env) };
  }

  /**
   * Notes for up to `NOTE_REQUEST_ITEMS` items: `{ notes: { id: { note, model, stored } },
   * missing: { id: reason } }`. An item this contract does not accept is missing as `invalid`.
   */
  async read(rawItems, { day = istDay(this.now()) } = {}) {
    if (!Array.isArray(rawItems) || rawItems.length > NOTE_REQUEST_ITEMS) throw new Error('Invalid notes request');
    const notes = {};
    const missing = {};
    const wanted = [];
    const seenIds = new Set();
    for (const raw of rawItems) {
      const item = noteItem(raw);
      if (!item || seenIds.has(item.id)) { if (raw?.id) missing[String(raw.id).slice(0, 120)] = 'invalid'; continue; }
      seenIds.add(item.id);
      wanted.push({ item, key: await sha256(noteContent(item)) });
    }
    const pending = [];
    for (const entry of wanted) {
      const found = this.rows('SELECT note, model FROM alert_notes WHERE key = ?', entry.key)[0];
      if (found) notes[entry.item.id] = { note: found.note, model: found.model, stored: true };
      else pending.push(entry);
    }
    if (!pending.length) return { notes, missing };

    // Somebody else's identical question is already with the model: wait for their answer. Nothing
    // between this check and the `set` below awaits, so two requests cannot both miss it.
    const fresh = pending.filter((entry) => !this.inflight.has(entry.key));
    if (fresh.length) {
      const batch = this.generate(fresh, day);
      for (const entry of fresh) this.inflight.set(entry.key, batch.then((result) => result[entry.key]));
      batch.catch(() => {}).finally(() => { for (const entry of fresh) this.inflight.delete(entry.key); });
    }
    const answers = await Promise.all(pending.map((entry) => this.inflight.get(entry.key)));
    pending.forEach((entry, index) => {
      const answer = answers[index] || { reason: 'error' };
      if (answer.note) notes[entry.item.id] = { note: answer.note, model: answer.model, stored: false };
      else missing[entry.item.id] = answer.reason || 'error';
    });
    return { notes, missing };
  }

  /** One model request for every fresh item; resolves to `{ [key]: { note, model } | { reason } }`. */
  async generate(entries, day) {
    const out = {};
    const refuse = (reason) => { for (const entry of entries) out[entry.key] = { reason }; return out; };
    if (!bedrockConfigured(this.env)) return refuse('no-key');
    const { used } = this.budget();
    const room = Math.max(0, NOTE_DAILY_LIMIT - used);
    const asked = entries.slice(0, room);
    for (const entry of entries.slice(room)) out[entry.key] = { reason: 'budget' };
    if (!asked.length) return out;
    this.spend(asked.length);
    const config = bedrockConfig(this.env);
    let reply;
    try {
      const response = await this.fetcher(config.url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'x-api-key': claudeCredential(this.env), 'anthropic-version': '2023-06-01', accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(noteRequest(asked.map((entry) => entry.item), config.model, day)),
        signal: AbortSignal.timeout(NOTE_TIMEOUT_MS),
      });
      if (!response.ok) {
        const reason = response.status === 401 || response.status === 403 ? 'refused' : response.status === 429 ? 'rate-limited' : 'upstream';
        for (const entry of asked) out[entry.key] = { reason };
        return out;
      }
      // A reply that is not the provider's JSON is unreadable, not an outage.
      const body = await response.json().catch(() => null);
      reply = (Array.isArray(body?.content) ? body.content : []).filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
    } catch (error) {
      for (const entry of asked) out[entry.key] = { reason: failureOf(error) };
      return out;
    }
    const parsed = parseNotes(reply, new Set(asked.map((entry) => entry.item.id)));
    if (!parsed) {
      for (const entry of asked) out[entry.key] = { reason: 'unreadable' };
      return out;
    }
    const createdAt = new Date(this.now()).toISOString();
    for (const entry of asked) {
      const raw = parsed[entry.item.id];
      if (!raw) { out[entry.key] = { reason: 'empty' }; continue; }
      const checked = acceptNote(raw, entry.item, day);
      if (!checked.ok) { out[entry.key] = { reason: checked.reason }; continue; }
      this.rows('INSERT INTO alert_notes(key, note, model, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING',
        entry.key, checked.note, config.model, createdAt);
      out[entry.key] = { note: checked.note, model: config.model };
    }
    return out;
  }
}
