// Large public/ API JSON is decoded away from the page, then materialized in small input-friendly
// slices. Small opening/health replies remain immediate. A single worker serializes preparation
// and persistence; transferred buffers avoid another clone of the complete record graph.
import { jsonBuffers, unpackJsonAsync, packJsonAsync } from './json-codec.js';
import { estimateMemoryBytes } from './memory-cache.js';

export const LARGE_JSON_BYTES = 128 * 1024;
const preparedValues = new WeakSet();
const pending = new Map();
let worker = null, sequence = 0, idleTimer = null;
const idle = () => {
  clearTimeout(idleTimer);
  if (!pending.size) idleTimer = setTimeout(() => { worker?.terminate(); worker = null; }, 10000);
};
function fail(error) {
  worker?.terminate(); worker = null; clearTimeout(idleTimer);
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
  pending.clear();
}
function getWorker() {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  if (worker) return worker;
  try { worker = new Worker(new URL('./json-worker.js', import.meta.url), { type: 'module' }); }
  catch { return null; }
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    clearTimeout(job.timer);
    data.error ? job.reject(new Error(data.error)) : job.resolve(data.value);
    idle();
  };
  worker.onerror = () => fail(new Error('JSON preparation worker unavailable'));
  worker.onmessageerror = () => fail(new Error('JSON preparation reply could not be read'));
  return worker;
}
function request(data, buffers) {
  const target = getWorker();
  if (!target) return null;
  clearTimeout(idleTimer);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('JSON preparation timed out')), 60000);
    pending.set(id, { resolve, reject, timer });
    try { target.postMessage({ ...data, id }, buffers); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); idle(); }
  });
}

export async function parseJsonBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < LARGE_JSON_BYTES || !getWorker())
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  // A subarray's other bytes may belong to a caller's integrity check. Only an exact buffer moves.
  const transferable = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  const packed = await request({ kind: 'parse', bytes: transferable }, [transferable.buffer]);
  const value = await unpackJsonAsync(packed);
  if (value && typeof value === 'object') preparedValues.add(value);
  return value;
}
export function readJsonResponse(response) {
  return typeof window === 'undefined' || typeof Worker === 'undefined' ? response.json()
    : response.arrayBuffer().then(parseJsonBytes);
}

// Caller validates and adopts the value before this can publish its cache. Disk rows retain
// exactly the old tag/savedAt/value semantics; the binary representation is private to the store.
export async function persistJsonEntry(key, row) {
  if (!getWorker()) return null;
  // Encode the adopted value now, rather than retaining the parse's representation: a validator
  // or source adapter may have added/corrected a field, and a cached wire copy would lose it.
  const packed = await packJsonAsync(row.value);
  return request({ kind: 'persist', key, row: { ...row, value: packed, jsonEncoding: 1 } }, jsonBuffers(packed));
}
export const canPrepareJson = value => estimateMemoryBytes(value, LARGE_JSON_BYTES) >= LARGE_JSON_BYTES && !!getWorker();
export const isPreparedJson = value => preparedValues.has(value);
export const jsonPreparationState = () => ({ worker: !!worker, pending: pending.size });
