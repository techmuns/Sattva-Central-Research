// THE SHARED RELEVANCE FEEDBACK — one fixed object (relevance-feedback:v1) on the provisioned
// CaptureRegistry class. Every Important / Not important vote from Corporate Announcements, News and
// All Alerts lands here and trains ONE preference for the whole deployment (relevance-feedback-shared.js).
//
// ONE VOTE PER BROWSER PER ITEM. A browser keeps a random device id; casting a second vote on the same
// item replaces the first, and `clear` withdraws it. No name, address or account is stored — the id
// only stops one browser counting twice. Every vote carries the features of the item it was cast on,
// so the model is rebuilt from the votes alone and needs nothing else to explain itself.
//
// THE MODEL IS DERIVED, NEVER EDITED. It is rebuilt from the stored votes whenever one changes and held
// in memory between requests; a restart rebuilds it on first read. A vote is the only write.
import { normaliseVote, aggregateModel, EMPTY_MODEL } from '../public/js/data/relevance-feedback-shared.js';

export const RELEVANCE_FEEDBACK_OBJECT = 'relevance-feedback:v1';
// A ceiling on what one deployment's desk can store; far above a desk's lifetime of votes.
export const MAX_VOTES = 50_000;
export const MINE_MAX = 2_000;

export class RelevanceFeedbackStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
    this.cached = null;
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS relevance_votes (
      device TEXT NOT NULL, item TEXT NOT NULL, surface TEXT NOT NULL, vote TEXT NOT NULL, event TEXT,
      features TEXT NOT NULL, why TEXT, label TEXT, company TEXT, categories TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (device, item))`);
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS relevance_votes_at ON relevance_votes (at)');
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  /** Record (or withdraw) one vote. Returns the device's vote as stored and the model's new revision. */
  apply(raw) {
    const vote = normaliseVote(raw);
    this.init();
    if (vote.vote === 'clear') {
      this.rows('DELETE FROM relevance_votes WHERE device = ? AND item = ?', vote.device, vote.itemKey);
    } else {
      const count = this.rows('SELECT COUNT(*) AS n FROM relevance_votes')[0]?.n || 0;
      const exists = this.rows('SELECT 1 AS x FROM relevance_votes WHERE device = ? AND item = ?', vote.device, vote.itemKey).length;
      if (!exists && count >= MAX_VOTES) throw Object.assign(new Error('The feedback store is full'), { reason: 'full' });
      this.rows(`INSERT INTO relevance_votes (device, item, surface, vote, event, features, why, label, company, categories, at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device, item) DO UPDATE SET surface=excluded.surface, vote=excluded.vote,
        event=excluded.event, features=excluded.features, why=excluded.why, label=excluded.label, company=excluded.company,
        categories=excluded.categories, at=excluded.at`,
      vote.device, vote.itemKey, vote.surface, vote.vote, vote.eventKey, JSON.stringify(vote.features), vote.why, vote.label, vote.company,
      JSON.stringify(vote.categories), this.now());
    }
    this.cached = null;
    const model = this.model();
    return { ok: true, vote: vote.vote === 'clear' ? null : { vote: vote.vote, why: vote.why }, revision: model.revision, votes: model.votes };
  }

  /** The shared model, rebuilt from every stored vote when one has changed. */
  model() {
    if (this.cached) return this.cached;
    const votes = this.rows('SELECT surface, vote, item, event, features, why, label, company, categories, at FROM relevance_votes ORDER BY at ASC')
      .map((r) => ({ surface: r.surface, vote: r.vote, itemKey: r.item, eventKey: r.event, features: safeList(r.features), why: r.why,
        label: r.label, company: r.company, categories: safeList(r.categories), at: r.at }));
    this.cached = votes.length ? aggregateModel(votes, { now: this.now() }) : { ...EMPTY_MODEL, builtAt: new Date(this.now()).toISOString() };
    return this.cached;
  }

  /** One browser's own votes, so its controls show what it already chose. */
  mine(device) {
    if (!/^[a-z0-9-]{8,64}$/.test(String(device || ''))) throw Object.assign(new Error('Invalid feedback device'), { reason: 'invalid-request' });
    const votes = {};
    for (const r of this.rows('SELECT item, vote, why, surface FROM relevance_votes WHERE device = ? ORDER BY at DESC LIMIT ?', device, MINE_MAX)) {
      votes[r.item] = { vote: r.vote, why: r.why || null, surface: r.surface };
    }
    return { ok: true, votes };
  }
}

function safeList(text) {
  try { const value = JSON.parse(text); return Array.isArray(value) ? value.map(String) : []; } catch { return []; }
}
