// Device-only evidence cache, not a new Cloudflare asset or a second source of truth.
// Parts and manifest commit in one transaction; no count ceiling discards a busy fortnight.
import { readEntry, writeEntryBatch } from '../core/store.js';

export const ALERT_WINDOW_CACHE_KEY = 'ai-alerts:public-window:v1';
export const ALERT_CACHE_PART_BYTES = 512 * 1024;
const encoder = new TextEncoder();
// UTF-8 length without allocating a byte array per event. `encoder.encode(json).byteLength` on
// each of 43,000 events cost 1.5s of one All Alerts save (profiled). JSON.stringify never emits a
// lone surrogate, so a high surrogate always pairs. The per-part `bytes` written to the manifest
// is still measured by the encoder itself, so the load-time integrity check reads the same number.
export function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const yieldForInput = () => typeof window === 'undefined' ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 0));

export function createAlertWindowCache({ read = readEntry, write = writeEntryBatch, partBytes = ALERT_CACHE_PART_BYTES, cacheKey = ALERT_WINDOW_CACHE_KEY } = {}) {
  let state = { status: 'unchecked', persistent: null, events: 0, parts: 0 };
  const listeners = new Set();
  const update = value => { state = value; for (const fn of listeners) { try { fn(); } catch { /* A view cannot break persistence. */ } } };
  const fail = () => update({ ...state, status: 'unavailable', persistent: false,
    message: 'The offline alert copy could not be verified. Available live evidence remains visible.' });
  let activeReaders = 0;
  const obsoleteParts = new Set();
  // Inputs are complete, already-merged views, never source deltas. Only the active
  // revision and newest waiting revision may retain an events array.
  let running = false, waiting = null, cleanupRequested = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (waiting || cleanupRequested) {
        if (waiting) {
          const job = waiting;
          waiting = null;
          const result = await save(job.value);
          job.resolve({ ...result, superseded: false });
          cleanupRequested = true;
        } else {
          cleanupRequested = false;
          await prune();
        }
      }
    } finally { running = false; }
  }
  let pruneEnabled = true;
  async function prune() {
    if (!pruneEnabled || activeReaders || !obsoleteParts.size) return;
    // Cleanup shares the writer queue. Recheck the current manifest so a later write that
    // reused an old content hash cannot lose its parts when an earlier reader finishes.
    try {
      const current = await read(cacheKey);
      if (activeReaders) return;
      const keep = new Set((current?.value?.parts || []).map(part => `${cacheKey}:part:${part.hash}`));
      const candidates = [...obsoleteParts];
      await write(new Map(), candidates.filter(key => !keep.has(key)));
      for (const key of candidates) obsoleteParts.delete(key);
    } catch { /* Retaining obsolete cache parts is safer than disturbing a committed window. */ }
  }

  async function load() {
    activeReaders++;
    try {
      const entry = await read(cacheKey);
      if (!entry) return null;
      const manifest = entry.value;
      if (manifest?.version === 1) return entry; // Older intact caches remain readable.
      if (manifest?.version !== 2 || !Array.isArray(manifest.parts) ||
          !Number.isSafeInteger(manifest.count) || manifest.count < 0) throw Error('Invalid alert cache');
      const events = [];
      for (const part of manifest.parts) {
        if (!/^[a-f0-9]{64}$/.test(part.hash || '') || !Number.isSafeInteger(part.count) || part.count < 1 ||
            !Number.isSafeInteger(part.bytes) || part.bytes < 2) throw Error('Invalid alert cache part');
        const saved = await read(`${cacheKey}:part:${part.hash}`);
        const json = saved?.value?.json;
        if (typeof json !== 'string' || encoder.encode(json).byteLength !== part.bytes || await hash(json) !== part.hash)
          throw Error('Incomplete alert cache');
        const items = JSON.parse(json);
        if (!Array.isArray(items) || items.length !== part.count) throw Error('Incomplete alert cache');
        for (const event of items) events.push(event);
        await yieldForInput();
      }
      if (events.length !== manifest.count) throw Error('Incomplete alert cache');
      const { parts, count, ...metadata } = manifest;
      return { ...entry, value: { ...metadata, version: 1, events } };
    } catch { fail(); return null; }
    finally {
      activeReaders--;
      if (activeReaders === 0 && obsoleteParts.size > 0) {
        cleanupRequested = true;
        void drain();
      }
    }
  }
  
  async function save(value) {
    try {
      const { events, ...metadata } = value;
      const entries = new Map(), parts = [];
      let batch = [], bytes = 2;
      const flush = async () => {
        if (!batch.length) return;
        const json = `[${batch.join(',')}]`, digest = await hash(json);
        parts.push({ hash: digest, count: batch.length, bytes: encoder.encode(json).byteLength });
        entries.set(`${cacheKey}:part:${digest}`, { value: { json } });
        batch = []; bytes = 2;
        await yieldForInput();
      };
      for (let i = 0; i < events.length; i++) {
        const json = JSON.stringify(events[i]), size = utf8Length(json);
        if (batch.length && bytes + size + 1 > partBytes) await flush();
        bytes += size + (batch.length ? 1 : 0); batch.push(json);
        if (i % 256 === 255) await yieldForInput();
      }
      await flush();
      
      const oldManifestEntry = await read(cacheKey);
      const oldManifest = oldManifestEntry?.value;
      const newPartHashes = new Set(parts.map(p => p.hash));
      
      entries.set(cacheKey, { value: { ...metadata, version: 2, count: events.length, parts } });
      
      // Publish first. Readers that already hold the preceding manifest still need its parts.
      const result = await write(entries);
      // A failed IndexedDB transaction still adopts the full incoming memory copy. Its old
      // durable manifest must retain every part until a later transaction really commits.
      pruneEnabled = result.persistent === true;
      if (oldManifest?.version === 2 && Array.isArray(oldManifest.parts)) {
        for (const oldPart of oldManifest.parts) {
          if (oldPart.hash && !newPartHashes.has(oldPart.hash)) {
            obsoleteParts.add(`${cacheKey}:part:${oldPart.hash}`);
          }
        }
      }
      
      const isSaved = result.persistent === true;
      update({ status: isSaved ? 'saved' : 'session-only', persistent: isSaved,
        events: events.length, parts: parts.length, message: isSaved ? null :
          'Alerts remain available in this session. This browser could not save an offline copy; reopening requires a source check.' });
      return result;
    } catch { fail(); return { persistent: false }; }
  }
  return { async read() { return load(); }, write(value) {
    // Resolving a superseded caller must never claim that its exact revision reached disk.
    waiting?.resolve({ persistent: false, superseded: true });
    const result = new Promise(resolve => { waiting = { value, resolve }; });
    void drain();
    return result;
  },
    status: () => ({ ...state }), onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}

export const alertWindowCache = createAlertWindowCache();
