// Personal records are independent of the evictable feed cache and all date/scope windows.
// One atomic record per bookmark; no whole-notebook read/overwrite race between browser tabs.
import { normalizeBookmark, parseBackup } from './bookmark-record.js';

const DATABASE = 'sattva-notebook';
const STORE = 'bookmarks';
let opening = null, loading = null, loaded = false, generation = 0;
let entries = new Map();
const listeners = new Set();
let channel;
const notify = () => { for (const fn of listeners) fn(); };
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const all = () => [...entries.values()];
export const has = id => entries.has(id);
export const get = id => entries.get(id);

function db() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    let request, settled = false;
    const fail = () => { if (settled) return; settled = true; clearTimeout(timer); reject(new Error('Notebook storage is unavailable. Enable browser storage and try again.')); };
    const timer = setTimeout(fail, 6000);
    try { request = indexedDB.open(DATABASE, 1); } catch { fail(); return; }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onerror = fail;
    request.onblocked = fail;
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(timer);
      request.result.onversionchange = () => { request.result.close(); opening = null; loaded = false; };
      resolve(request.result);
    };
  }).catch(error => { opening = null; throw error; });
  return opening;
}

async function transaction(mode, operation) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    let result;
    tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
    tx.onerror = tx.onabort = () => reject(new Error('The notebook could not be saved. Your existing bookmarks are unchanged. Free browser storage and try again.'));
    try { result = operation(tx.objectStore(STORE)); }
    catch (error) { tx.abort(); reject(error); }
  });
}

export function load({ force = false } = {}) {
  if (!force && loading) return loading;
  if (!force && loaded) return Promise.resolve(all());
  const token = ++generation;
  const pending = transaction('readonly', store => { const request = store.getAll(); return () => request.result; })
    .then(records => {
      if (token === generation) { entries = new Map(records.map(entry => [entry.id, entry])); loaded = true; notify(); }
      return all();
    }).finally(() => { if (loading === pending) loading = null; });
  loading = pending;
  return pending;
}

async function changed() {
  await load({ force: true });
  channel?.postMessage('changed');
}

export async function save(value) {
  const entry = normalizeBookmark(value);
  await transaction('readwrite', store => {
    const request = store.get(entry.id);
    request.onsuccess = () => { if (!request.result) store.add(entry); };
  });
  await changed();
  // The browser may decline; backups remain available and the UI never claims cloud sync.
  try { void navigator.storage?.persist?.().catch(() => {}); } catch { /* optional browser capability */ }
  return entries.get(entry.id) || entry;
}
export async function remove(id) {
  await transaction('readwrite', store => store.delete(id));
  await changed();
}
export async function updateNote(id, note) {
  let found = false;
  await transaction('readwrite', store => {
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) return;
      found = true; store.put({ ...request.result, note: String(note).trim() });
    };
  });
  if (!found) throw new Error('This bookmark was removed in another tab. Close this note and save the event again.');
  await changed();
}
export async function exportBackup() {
  await load({ force: true });
  return JSON.stringify({ format: 'sattva-bookmarked-notebook', version: 1, exportedAt: new Date().toISOString(), entries: all() }, null, 2);
}
export async function importBackup(value) {
  const incoming = parseBackup(value);
  let added = 0;
  await transaction('readwrite', store => {
    // Deduplicate before requests so two entries in the backup cannot race their own add().
    for (const entry of new Map(incoming.map(entry => [entry.id, entry])).values()) {
      const request = store.get(entry.id);
      request.onsuccess = () => { if (!request.result) { store.add(entry); added++; } };
    }
  });
  await changed();
  return added;
}

if (typeof window !== 'undefined') {
  try { channel = new BroadcastChannel('sattva-notebook'); channel.onmessage = () => { void load({ force: true }).catch(() => {}); }; } catch { /* focus refresh covers older browsers */ }
  window.addEventListener('focus', () => { if (loaded) void load({ force: true }).catch(() => {}); });
}
