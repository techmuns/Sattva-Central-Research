import { DEFAULT_TAB_ORDER, workspaceSnapshot, workspaceIntent } from '../data/workspace-shared.js';
const KEY = 'sattva:shared-workspace:v1', QUEUE = `${KEY}:outbox`;
let confirmed = false, error = null, storageFailed = false, running = null, started = false;
let current = { version: 1, revision: 0, updatedAt: null, tabs: [], order: [...DEFAULT_TAB_ORDER] }, pending = [];
const unstored = new Set();
const rejected = new Map(), results = new Map();
try {
  const rows = JSON.parse(localStorage.getItem(`${KEY}:rejected`) || '[]');
  if (Array.isArray(rows)) for (const row of rows) rejected.set(row.intent.id, { intent: workspaceIntent(row.intent), outcome: row.outcome });
} catch { /* Retained shared definitions remain usable. */ }
try { const value = localStorage.getItem(KEY); if (value) current = workspaceSnapshot(JSON.parse(value)); } catch { /* No cache must never prevent navigation. */ }
function readQueue() {
  try {
    const found = new Map(pending.map(intent => [intent.id, intent]));
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(QUEUE + ':')) continue;
      try { const intent = workspaceIntent(JSON.parse(localStorage.getItem(key))); found.set(intent.id, intent); } catch { /* Preserve unreadable entries for diagnosis; never reinterpret them as edits. */ }
    }
    pending = [...found.values()];
  } catch { storageFailed = true; }
}
readQueue();
const listeners = new Set();
const emit = () => listeners.forEach(fn => fn());
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export function snapshot() {
  if (!pending.length) return current;
  const value = { ...current, order: [...current.order], tabs: [...current.tabs] };
  for (const intent of pending) {
    if (intent.op === 'put') {
      const old = value.tabs.find(tab => tab.id === intent.tab.id);
      const tab = { ...intent.tab, revision: old?.revision || 0 };
      const index = value.tabs.findIndex(item => item.id === tab.id);
      if (index >= 0) value.tabs[index] = tab; else value.tabs.push(tab);
      if (!value.order.includes(tab.id)) value.order.push(tab.id);
    } else if (intent.op === 'remove') {
      value.tabs = value.tabs.filter(tab => tab.id !== intent.tabId); value.order = value.order.filter(id => id !== intent.tabId);
    } else if (intent.op === 'reset') value.order = [...DEFAULT_TAB_ORDER, ...value.tabs.map(tab => tab.id)];
    else if (value.order.includes(intent.tabId) && value.order.includes(intent.targetId)) {
      value.order = value.order.filter(id => id !== intent.tabId);
      value.order.splice(value.order.indexOf(intent.targetId) + (intent.after ? 1 : 0), 0, intent.tabId);
    }
  }
  return value;
}
export const status = () => ({ confirmed, pending: pending.length, error, storageFailed, rejected: [...rejected.values()] });
export function dismissRejected(id) { rejected.delete(id); persist(); error = rejected.size ? message([...rejected.values()].at(-1).outcome) : null; emit(); }
const persist = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
    localStorage.setItem(`${KEY}:rejected`, JSON.stringify([...rejected.values()]));
    for (const id of [...unstored]) {
      const intent = pending.find(intent => intent.id === id);
      if (intent) localStorage.setItem(`${QUEUE}:${id}`, JSON.stringify(intent));
      unstored.delete(id);
    }
    storageFailed = false;
  }
  catch { storageFailed = true; }
};
function adopt(value) {
  const next = workspaceSnapshot(value);
  if (next.revision < current.revision) throw Error('Workspace revision regressed');
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  current = next; confirmed = true; error = rejected.size ? message([...rejected.values()].at(-1).outcome) : null; persist();
  if (changed) emit();
}
const message = outcome => outcome === 'conflict' ? 'This shared tab changed elsewhere. Review its latest settings before saving again.'
  : outcome === 'missing' ? 'This tab was removed elsewhere. Choose another tab.'
    : outcome === 'full' ? 'The workspace has reached its limit of 50 saved tabs.' : outcome === 'capacity' ? 'These saved settings are too large for the shared workspace. Use fewer selections or shorter search text.' : 'The shared workspace could not be reached. Changes are waiting to be shared.';
export function sync() {
  if (running) return running;
  running = (async () => {
    try {
      readQueue();
      const response = await fetch('/api/workspace', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const value = await response.json();
      if (!response.ok || !value.ok) throw Error(message());
      adopt(value);
      while (pending.length) {
        const intent = pending[0];
        const write = await fetch('/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: JSON.stringify(intent), signal: AbortSignal.timeout(12000) });
        const result = await write.json();
        if (['conflict', 'missing', 'full', 'capacity'].includes(result.outcome)) {
          rejected.set(intent.id, { intent, outcome: result.outcome }); results.set(intent.id, { confirmed: false, error: message(result.outcome) });
          adopt(result); acknowledge(intent.id); persist(); error = message(result.outcome); emit();
          return { confirmed: false, error, rejected: intent.id };
        }
        if (!write.ok || !result.ok) throw Error(message());
        adopt(result); results.set(intent.id, { confirmed: true }); acknowledge(intent.id); emit(); readQueue();
      }
      confirmed = true; error = rejected.size ? message([...rejected.values()].at(-1).outcome) : null; emit(); return { confirmed: true };
    } catch { confirmed = false; persist(); error = message() + (unstored.size ? ' Browser storage is unavailable; keep this page open until sharing completes.' : ''); emit(); return { confirmed: false, error }; }
    finally { running = null; }
  })();
  return running;
}
export async function edit(value) {
  const tabId = value.tab?.id || value.tabId;
  const prior = [...pending].reverse().find(intent => intent.op === 'put' && intent.tab.id === tabId);
  const intent = workspaceIntent({ ...value, afterIntent: prior?.id || null, id: crypto.randomUUID() });
  pending.push(intent);
  try { localStorage.setItem(`${QUEUE}:${intent.id}`, JSON.stringify(intent)); } catch { storageFailed = true; unstored.add(intent.id); }
  emit();
  // An edit arriving during a read/flush is sent before this call resolves.
  await sync();
  if (pending.some(item => item.id === intent.id) && !error) await sync();
  return { ...(results.get(intent.id) || { confirmed: false, error }), storageFailed };
}
function acknowledge(id) {
  unstored.delete(id);
  pending = pending.filter(intent => intent.id !== id);
  try { localStorage.removeItem(`${QUEUE}:${id}`); } catch { storageFailed = true; }
}
export function start() {
  if (started) return;
  started = true; void sync();
  const check = () => { if (!document.hidden) void sync(); };
  setInterval(check, 30000);
  window.addEventListener('focus', check); window.addEventListener('online', check);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('storage', event => {
    if (event.key?.startsWith(QUEUE + ':') && event.newValue === null) pending = pending.filter(intent => `${QUEUE}:${intent.id}` !== event.key);
    if (event.key === KEY || event.key?.startsWith(QUEUE + ':')) { readQueue(); check(); }
  });
}
