import {
  WATCHLIST_COMPANY_LIMIT, WATCHLIST_PEOPLE_LIMIT, WATCHLIST_TOMBSTONE_LIMIT,
  companyName, personName, personKey, watchlistIntents,
} from '../public/js/data/watchlist-shared.js';

// THE SHARED WATCHLIST, AS ONE DURABLE RECORD.
//
// One object, one desk, one list — `SHARED_WATCHLIST_OBJECT` below. The class is the already
// provisioned `CaptureRegistry`, reused exactly as `ConcallSummaryStore` and `TelegramSchedule`
// reuse it, so this needs no namespace migration; its tables are created the first time a
// watchlist method is called and company registries never touch them.
//
// THE SERVER STAMPS THE TIME, AND THAT IS DELIBERATE.
//   Ordering two devices' edits by a field either device filled in means trusting whichever clock
//   is furthest wrong. A phone an hour fast would win every conflict and a laptop a day slow would
//   lose edits made after it. So `addedAt` and `removedAt` are the moment THIS object accepted the
//   edit, which is the one clock both devices are actually talking to.
//
// A REMOVAL IS A RECORD, NOT AN ABSENCE.
//   Deleting the row would make "removed here" and "never added anywhere" the same state, and a
//   device holding the older list would then re-add the company on its next write because nothing
//   contradicted it. The row stays with `state = 'removed'`, so a removal is a fact the list can
//   state and a stale device cannot quietly undo.

export const SHARED_WATCHLIST_OBJECT = 'shared-watchlist:v1';

const iso = (at) => new Date(at).toISOString();

export class SharedWatchlistStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS watchlist_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS watchlist_companies (
      ticker TEXT PRIMARY KEY, name TEXT, state TEXT NOT NULL,
      added_at TEXT, added_by TEXT, removed_at TEXT, removed_by TEXT,
      updated_at TEXT NOT NULL, seq INTEGER NOT NULL)`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS watchlist_people (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL, uses INTEGER NOT NULL)`);
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS watchlist_state ON watchlist_companies(state, seq)');
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  meta() {
    const found = this.rows("SELECT value FROM watchlist_meta WHERE key = 'state'")[0];
    return found ? JSON.parse(found.value) : { revision: 0, updatedAt: null, seq: 0 };
  }

  putMeta(value) {
    this.rows("INSERT INTO watchlist_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  }

  /**
   * The whole shared list, plus the roster behind the contributor dropdown.
   *
   * `revision` only moves when a row actually changed, so an unchanged poll produces a byte-
   * identical body and the route's ETag answers it with a bodyless 304.
   */
  watchlistSnapshot() {
    const meta = this.meta();
    const companies = this.rows(
      "SELECT ticker, name, added_at, added_by FROM watchlist_companies WHERE state = 'watched' ORDER BY seq DESC",
    ).map((row) => ({ ticker: row.ticker, name: row.name || null, addedAt: row.added_at || null, addedBy: row.added_by || null }));
    // Most recently used first: the dropdown exists so nobody retypes a name, and the name most
    // likely to be wanted next is the one somebody used last. `uses` breaks a same-moment tie.
    const people = this.rows('SELECT name, last_used_at, uses FROM watchlist_people ORDER BY last_used_at DESC, uses DESC')
      .map((row) => ({ name: row.name, lastUsedAt: row.last_used_at, uses: row.uses }));
    return {
      version: 1,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
      count: companies.length,
      limit: WATCHLIST_COMPANY_LIMIT,
      companies,
      people,
    };
  }

  recordPerson(by, at) {
    const key = personKey(by);
    const name = personName(by);
    if (!key || !name) return;
    const existing = this.rows('SELECT key, uses FROM watchlist_people WHERE key = ?', key)[0];
    if (existing) {
      // The display name is refreshed to the latest spelling the same person typed, exactly as the
      // company registry refreshes a ticker's name — one identity, one current label.
      this.rows('UPDATE watchlist_people SET name = ?, last_used_at = ?, uses = ? WHERE key = ?', name, at, existing.uses + 1, key);
      return;
    }
    this.rows('INSERT INTO watchlist_people (key, name, first_seen_at, last_used_at, uses) VALUES (?,?,?,?,1)', key, name, at, at);
    const total = this.rows('SELECT COUNT(*) AS count FROM watchlist_people')[0].count;
    if (total > WATCHLIST_PEOPLE_LIMIT) {
      // Dropping a stale roster entry loses a dropdown suggestion and never loses attribution:
      // every row records the contributor's name as text on the row itself.
      this.rows(
        'DELETE FROM watchlist_people WHERE key IN (SELECT key FROM watchlist_people ORDER BY last_used_at ASC, uses ASC LIMIT ?)',
        total - WATCHLIST_PEOPLE_LIMIT,
      );
    }
  }

  pruneTombstones() {
    const total = this.rows("SELECT COUNT(*) AS count FROM watchlist_companies WHERE state = 'removed'")[0].count;
    if (total <= WATCHLIST_TOMBSTONE_LIMIT) return;
    this.rows(
      `DELETE FROM watchlist_companies WHERE ticker IN (
         SELECT ticker FROM watchlist_companies WHERE state = 'removed' ORDER BY seq ASC LIMIT ?)`,
      total - WATCHLIST_TOMBSTONE_LIMIT,
    );
  }

  /**
   * Apply a batch of edits and return the list as it now stands.
   *
   * Every intent gets a named outcome. `full` is the one that matters: a company refused for
   * capacity must never read as one that was added, or a device would report a star it does not
   * have — the same rule the capture registry follows for the same reason. `unchanged` is not a
   * failure either — two people unstarring the same company is a race, not a mistake.
   */
  watchlistApply(input) {
    const intents = watchlistIntents(input);
    const at = iso(this.now());
    this.init();
    return this.storage.transactionSync(() => {
      const meta = this.meta();
      let seq = meta.seq;
      let changed = 0;
      const outcomes = [];
      let watched = this.rows("SELECT COUNT(*) AS count FROM watchlist_companies WHERE state = 'watched'")[0].count;

      for (const intent of intents) {
        const existing = this.rows('SELECT ticker, name, state, added_at, added_by FROM watchlist_companies WHERE ticker = ?', intent.ticker)[0];
        const isWatched = existing?.state === 'watched';

        if (intent.op === 'seed') {
          // A device carrying its old local list in may only ADD WHAT NOBODY HAS DECIDED ABOUT.
          // If a row exists at all — watched or removed — the shared list has already spoken, and
          // seeding over a tombstone would let a browser that has not been opened in a month
          // resurrect a company somebody deliberately dropped. That is the whole failure this
          // branch exists to refuse, so the test is "no row", never "not currently watched".
          if (existing) {
            outcomes.push({ ticker: intent.ticker, op: 'seed', outcome: 'unchanged' });
            continue;
          }
          if (watched >= WATCHLIST_COMPANY_LIMIT) {
            outcomes.push({ ticker: intent.ticker, op: 'seed', outcome: 'full' });
            continue;
          }
          seq++;
          this.rows(
            `INSERT INTO watchlist_companies (ticker, name, state, added_at, added_by, removed_at, removed_by, updated_at, seq)
             VALUES (?,?,'watched',?,NULL,NULL,NULL,?,?)`,
            intent.ticker, companyName(intent.name), at, at, seq,
          );
          watched++;
          changed++;
          // No contributor is recorded and none is invented; the roster is untouched.
          outcomes.push({ ticker: intent.ticker, op: 'seed', outcome: 'added', addedBy: null });
          continue;
        }

        if (intent.op === 'add') {
          if (isWatched) {
            // Re-starring a company somebody else already added is not an event, and it does not
            // reassign the credit: whoever added it added it. A NAME arriving for a row that had
            // none is still worth keeping — that is how a row starred from a feed carrying no
            // company name acquires one later.
            const name = existing.name || companyName(intent.name);
            if (name !== existing.name) {
              this.rows('UPDATE watchlist_companies SET name = ?, updated_at = ? WHERE ticker = ?', name, at, intent.ticker);
              changed++;
            }
            outcomes.push({ ticker: intent.ticker, op: 'add', outcome: 'unchanged', addedBy: existing.added_by || null });
            this.recordPerson(intent.by, at);
            continue;
          }
          if (watched >= WATCHLIST_COMPANY_LIMIT) {
            outcomes.push({ ticker: intent.ticker, op: 'add', outcome: 'full' });
            continue;
          }
          seq++;
          this.rows(
            `INSERT INTO watchlist_companies (ticker, name, state, added_at, added_by, removed_at, removed_by, updated_at, seq)
             VALUES (?,?,'watched',?,?,NULL,NULL,?,?)
             ON CONFLICT(ticker) DO UPDATE SET name=excluded.name, state='watched', added_at=excluded.added_at,
               added_by=excluded.added_by, removed_at=NULL, removed_by=NULL, updated_at=excluded.updated_at, seq=excluded.seq`,
            intent.ticker, companyName(intent.name), at, intent.by, at, seq,
          );
          watched++;
          changed++;
          outcomes.push({ ticker: intent.ticker, op: 'add', outcome: 'added', addedBy: intent.by });
          this.recordPerson(intent.by, at);
          continue;
        }

        if (!isWatched) {
          // Removing what is not on the list is not a failure and not a change — two people
          // unstarring the same company is an ordinary race, not an error either of them made.
          outcomes.push({ ticker: intent.ticker, op: 'remove', outcome: 'unchanged' });
          this.recordPerson(intent.by, at);
          continue;
        }
        seq++;
        this.rows(
          "UPDATE watchlist_companies SET state = 'removed', removed_at = ?, removed_by = ?, updated_at = ?, seq = ? WHERE ticker = ?",
          at, intent.by || null, at, seq, intent.ticker,
        );
        watched--;
        changed++;
        outcomes.push({ ticker: intent.ticker, op: 'remove', outcome: 'removed' });
        // An unattributed removal records no person; `recordPerson` already refuses a blank name,
        // so nothing empty can reach the dropdown.
        this.recordPerson(intent.by, at);
      }

      if (changed) {
        this.pruneTombstones();
        this.putMeta({ revision: meta.revision + 1, updatedAt: at, seq });
      } else if (seq !== meta.seq) {
        this.putMeta({ ...meta, seq });
      }
      return { outcomes, snapshot: this.watchlistSnapshot() };
    });
  }
}
