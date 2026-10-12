// Browser-local JSON preparation and cache writes. This worker makes no network requests and
// keeps no source/session data after a job. The reader terminates it after the queue becomes idle.
import { packJson, jsonBuffers } from './json-codec.js';

async function persist(key, row) {
  return new Promise(resolve => {
    const request = indexedDB.open('sattva-cache', 1);
    let expired = false;
    const timeout = setTimeout(() => { expired = true; resolve(null); }, 6000);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('payloads')) request.result.createObjectStore('payloads');
    };
    request.onerror = () => { clearTimeout(timeout); resolve(null); };
    request.onsuccess = () => {
      clearTimeout(timeout);
      const db = request.result;
      if (expired) { db.close(); return; }
      try {
        const transaction = db.transaction('payloads', 'readwrite');
        transaction.objectStore('payloads').put(row, key);
        transaction.oncomplete = () => { db.close(); resolve(key); };
        transaction.onabort = transaction.onerror = () => { db.close(); resolve(null); };
      } catch { db.close(); resolve(null); }
    };
  });
}

let tail = Promise.resolve();
self.onmessage = ({ data }) => {
  tail = tail.then(async () => {
    try {
      if (data.kind === 'parse') {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.bytes));
        const packed = packJson(value);
        self.postMessage({ id: data.id, value: packed }, jsonBuffers(packed));
      } else if (data.kind === 'persist') {
        self.postMessage({ id: data.id, value: await persist(data.key, data.row) });
      } else throw Error('Unknown JSON preparation request');
    } catch (error) { self.postMessage({ id: data.id, error: String(error?.message || error) }); }
  });
};
