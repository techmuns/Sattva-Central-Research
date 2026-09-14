// Device-only evidence cache, not a new Cloudflare asset or a second source of truth.
// Parts and manifest commit in one transaction; no count ceiling discards a busy fortnight.
import { readEntry, writeEntryBatch } from '../core/store.js';

export const ALERT_WINDOW_CACHE_KEY = 'ai-alerts:public-window:v1';
export const ALERT_CACHE_PART_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const yieldForInput = () => typeof window === 'undefined' ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 0));

export function createAlertWindowCache({ read = readEntry, write = writeEntryBatch, partBytes = ALERT_CACHE_PART_BYTES } = {}) {
  let pending = Promise.resolve(), state = { status: 'unchecked', persistent: null, events: 0, parts: 0 };
  const listeners = new Set();
  const update = value => { state = value; for (const fn of listeners) { try { fn(); } catch { /* A view cannot break persistence. */ } } };
  const fail = () => update({ ...state, status: 'unavailable', persistent: false,
    message: 'The offline alert copy could not be verified. Available live evidence remains visible.' });
  let activeReaders = 0;
  let obsoleteParts = new Set();

  async function load() {
    activeReaders++;
    try {
      const entry = await read(ALERT_WINDOW_CACHE_KEY);
      if (!entry) return null;
      const manifest = entry.value;
      if (manifest?.version === 1) return entry; // Older intact caches remain readable.
      if (manifest?.version !== 2 || !Array.isArray(manifest.parts) ||
          !Number.isSafeInteger(manifest.count) || manifest.count < 0) throw Error('Invalid alert cache');
      const events = [];
      for (const part of manifest.parts) {
        if (!/^[a-f0-9]{64}$/.test(part.hash || '') || !Number.isSafeInteger(part.count) || part.count < 1 ||
            !Number.isSafeInteger(part.bytes) || part.bytes < 2) throw Error('Invalid alert cache part');
        const saved = await read(`${ALERT_WINDOW_CACHE_KEY}:part:${part.hash}`);
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
        const deletes = Array.from(obsoleteParts).map(h => `${ALERT_WINDOW_CACHE_KEY}:part:${h}`);
        obsoleteParts.clear();
        write(new Map(), deletes).catch(() => {});
      }
    }
  }
  
  let pendingWrite = Promise.resolve();
  async function save(value) {
    try {
      const { events, ...metadata } = value;
      const entries = new Map(), parts = [];
      let batch = [], bytes = 2;
      const flush = async () => {
        if (!batch.length) return;
        const json = `[${batch.join(',')}]`, digest = await hash(json);
        parts.push({ hash: digest, count: batch.length, bytes: encoder.encode(json).byteLength });
        entries.set(`${ALERT_WINDOW_CACHE_KEY}:part:${digest}`, { value: { json } });
        batch = []; bytes = 0;
        await yieldForInput();
      };
      for (let i = 0; i < events.length; i++) {
        const json = JSON.stringify(events[i]), size = encoder.encode(json).byteLength;
        if (batch.length && bytes + size + 1 > partBytes) await flush();
        bytes += size + (batch.length ? 1 : 0); batch.push(json);
        if (i % 256 === 255) await yieldForInput();
      }
      await flush();
      
      const oldManifestEntry = await read(ALERT_WINDOW_CACHE_KEY);
      const oldManifest = oldManifestEntry?.value;
      const newPartHashes = new Set(parts.map(p => p.hash));
      
      entries.set(ALERT_WINDOW_CACHE_KEY, { value: { ...metadata, version: 2, count: events.length, parts } });
      
      // Do not use prunePrefix, so we do not delete parts that might be in use by a concurrent reader.
      const deletes = [];
      if (oldManifest?.version === 2 && Array.isArray(oldManifest.parts)) {
        for (const oldPart of oldManifest.parts) {
          if (oldPart.hash && !newPartHashes.has(oldPart.hash)) {
            if (activeReaders > 0) obsoleteParts.add(oldPart.hash);
            else deletes.push(`${ALERT_WINDOW_CACHE_KEY}:part:${oldPart.hash}`);
          }
        }
      }
      
      const result = await write(entries, obsoleteParts);
      const isSaved = result.persistent || !!oldManifest;
      update({ status: isSaved ? 'saved' : 'session-only', persistent: isSaved,
        events: events.length, parts: parts.length, message: isSaved ? null :
          'Alerts remain available in this session. This browser could not save an offline copy; reopening requires a source check.' });
      return result;
    } catch { fail(); return { persistent: false }; }
  }
  return { async read() { return load(); }, write(value) { pendingWrite = pendingWrite.then(() => save(value)); return pendingWrite; },
    status: () => ({ ...state }), onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}

export const alertWindowCache = createAlertWindowCache();
