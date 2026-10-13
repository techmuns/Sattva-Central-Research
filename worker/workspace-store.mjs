import { DEFAULT_TAB_ORDER, WORKSPACE_LIMIT, WORKSPACE_TOTAL_BYTES, workspaceIntent } from '../public/js/data/workspace-shared.js';

export class WorkspaceStore {
  constructor(storage, { now = Date.now } = {}) { this.storage = storage; this.now = now; }
  init() {
    if (this.initialised) return;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace_edits (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, outcome TEXT NOT NULL)');
    this.initialised = true;
  }
  snapshot() {
    this.init();
    const row = this.storage.sql.exec("SELECT value FROM workspace_state WHERE key='research'").toArray()[0];
    return row ? JSON.parse(row.value) : { version: 1, revision: 0, updatedAt: null, order: [...DEFAULT_TAB_ORDER], tabs: [] };
  }
  apply(input) {
    const intent = workspaceIntent(input);
    this.init();
    return this.storage.transactionSync(() => {
      const state = this.snapshot();
      const previous = this.storage.sql.exec('SELECT outcome FROM workspace_edits WHERE id=?', intent.id).toArray()[0];
      if (previous) return { snapshot: state, outcome: previous.outcome, replay: true };
      let outcome = 'unchanged';
      let expected = intent.expected;
      if (intent.afterIntent) {
        const prior = this.storage.sql.exec('SELECT revision FROM workspace_edits WHERE id=?', intent.afterIntent).toArray()[0];
        if (!prior) return { snapshot: state, outcome: 'conflict' };
        expected = prior.revision;
      }
      if (intent.op === 'put') {
        const index = state.tabs.findIndex(tab => tab.id === intent.tab.id), old = state.tabs[index];
        if ((old && old.revision !== expected) || (!old && expected !== null)) return { snapshot: state, outcome: 'conflict' };
        if (!old && state.tabs.length >= WORKSPACE_LIMIT) return { snapshot: state, outcome: 'full' };
        const tab = { ...intent.tab, revision: state.revision + 1 };
        if (old) state.tabs[index] = tab;
        else { state.tabs.push(tab); state.order.push(tab.id); }
        outcome = old ? 'updated' : 'created';
      } else if (intent.op === 'remove') {
        const old = state.tabs.find(tab => tab.id === intent.tabId);
        if (old && old.revision !== expected) return { snapshot: state, outcome: 'conflict' };
        if (old) { state.tabs = state.tabs.filter(tab => tab.id !== intent.tabId); state.order = state.order.filter(id => id !== intent.tabId); outcome = 'removed'; }
      } else if (intent.op === 'reset') {
        const order = [...DEFAULT_TAB_ORDER, ...state.tabs.map(tab => tab.id)];
        if (JSON.stringify(order) !== JSON.stringify(state.order)) { state.order = order; outcome = 'moved'; }
      } else if (intent.op === 'move') {
        if (!state.order.includes(intent.tabId) || !state.order.includes(intent.targetId)) return { snapshot: state, outcome: 'missing' };
        const before = JSON.stringify(state.order);
        // The first intentional reorder can carry the reader's pre-existing local layout.
        if (state.revision === 0 && intent.seedOrder.length) state.order = [...intent.seedOrder.filter(id => state.order.includes(id)), ...state.order.filter(id => !intent.seedOrder.includes(id))];
        state.order = state.order.filter(id => id !== intent.tabId);
        state.order.splice(state.order.indexOf(intent.targetId) + (intent.after ? 1 : 0), 0, intent.tabId);
        if (before !== JSON.stringify(state.order)) outcome = 'moved';
      }
      if (outcome !== 'unchanged') {
        state.revision++; state.updatedAt = new Date(this.now()).toISOString();
        if (new TextEncoder().encode(JSON.stringify(state)).byteLength > WORKSPACE_TOTAL_BYTES) return { snapshot: this.snapshot(), outcome: 'capacity' };
        this.storage.sql.exec("INSERT INTO workspace_state(key,value) VALUES ('research',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(state));
      }
      this.storage.sql.exec('INSERT INTO workspace_edits(id,revision,outcome) VALUES (?,?,?)', intent.id, state.revision, outcome);
      return { snapshot: state, outcome };
    });
  }
}
