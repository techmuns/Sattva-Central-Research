// data/relevance-feedback.js — THE BROWSER'S HALF OF THE SHARED RELEVANCE PREFERENCE.
//
// Corporate Announcements, News and All Alerts each offer Important / Not important with an optional
// "Why?". Every vote goes to ONE shared preference for the whole desk (worker/relevance-feedback.mjs),
// and the published model re-orders all three surfaces within each day. This module holds that model,
// this browser's own votes (so a control shows what it already chose), and an outbox for votes the
// server could not take yet.
//
// A VOTE IS NEVER SILENTLY LOST. A vote the server refuses with a reason is reported in words; a vote
// that could not reach it (offline, a static copy with no Worker) waits on this device and is sent
// again on the next load — and until then it already moves the item it was cast on, here, so the
// reader sees their own vote take effect. The shared model only changes when the server accepts it.
//
// NOTHING IDENTIFIES A PERSON. A random id per browser lets the server replace a browser's earlier
// vote on the same item instead of counting it twice; no name, address or account travels.
import { EMPTY_MODEL, directWeight, VOTES } from './relevance-feedback-shared.js';

const DEVICE_KEY = 'sattva:relevance-device';
const OUTBOX_KEY = 'sattva:relevance-outbox:v1';
const MODEL_KEY = 'sattva:relevance-model:v1';
const MODEL_TTL_MS = 60_000;
const OUTBOX_MAX = 200;

const read = (key, fallback) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

let model = read(MODEL_KEY, null)?.version ? read(MODEL_KEY, null) : EMPTY_MODEL;
let modelCheckedAt = 0;
let modelPending = null;
let mine = {};
let mineLoaded = false;
let outbox = read(OUTBOX_KEY, []);
let flushing = null;
let serverState = 'unknown'; // 'live' | 'unreachable' | 'unknown'
const listeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* a listener's failure is its own */ } });

export function deviceId() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch { /* storage blocked */ }
  if (!/^[a-z0-9-]{8,64}$/.test(id || '')) {
    id = (globalThis.crypto?.randomUUID?.() || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`).toLowerCase();
    try { localStorage.setItem(DEVICE_KEY, id); } catch { /* a session-only id still works */ }
  }
  return id;
}

export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const serverStatus = () => serverState;

/**
 * The model to rank with: the shared one, plus — for votes still waiting in this browser's outbox —
 * the direct nudge on the item voted on, so the reader's own vote shows at once.
 */
export function currentModel() {
  if (!outbox.length) return model;
  const items = { ...(model.items || {}) };
  for (const vote of outbox) if (!(vote.itemKey in (model.items || {}))) items[vote.itemKey] = vote.vote === 'clear' ? 0 : directWeight(VOTES[vote.vote] || 0);
  return { ...model, votes: Math.max(1, model.votes || 0), items, revision: `${model.revision || 'local'}+${outbox.length}` };
}
export const modelRevision = () => currentModel().revision || 'none';
/** The shared model's own revision, without this browser's unsent votes — what the server can match. */
export const serverModelRevision = () => model.revision || null;

/** Fetch the shared model when the held copy is older than a minute. Never throws. */
export function loadModel({ force = false } = {}) {
  if (!force && Date.now() - modelCheckedAt < MODEL_TTL_MS) return Promise.resolve(currentModel());
  if (modelPending) return modelPending;
  modelPending = (async () => {
    try {
      const response = await fetch('api/relevance/model', { cache: 'no-cache', headers: { accept: 'application/json' } });
      modelCheckedAt = Date.now();
      if (!response.ok || !/json/.test(response.headers.get('content-type') || '')) { serverState = 'unreachable'; return currentModel(); }
      const body = await response.json();
      serverState = 'live';
      if (body?.ok && body.model?.version && body.model.revision !== model.revision) {
        model = body.model;
        write(MODEL_KEY, model);
        emit();
      }
      if (outbox.length) void flush();
    } catch { modelCheckedAt = Date.now(); serverState = 'unreachable'; }
    finally { modelPending = null; }
    return currentModel();
  })();
  return modelPending;
}

/** This browser's own votes, keyed by item: { vote, why } — the outbox's pending ones included. */
export function myVote(itemKey) {
  const pending = [...outbox].reverse().find((v) => v.itemKey === itemKey);
  if (pending) return pending.vote === 'clear' ? null : { vote: pending.vote, why: pending.why || null, pending: true };
  return mine[itemKey] || null;
}

export async function loadMine() {
  if (mineLoaded) return mine;
  mineLoaded = true;
  try {
    const response = await fetch(`api/relevance/mine?device=${encodeURIComponent(deviceId())}`, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (response.ok && /json/.test(response.headers.get('content-type') || '')) {
      const body = await response.json();
      if (body?.ok && body.votes && typeof body.votes === 'object') { mine = body.votes; emit(); }
    }
  } catch { /* the controls simply start unselected */ }
  return mine;
}

/**
 * Cast (or withdraw, with vote 'clear') a vote. Resolves to { state: 'saved' | 'queued' | 'refused', reason? }.
 *
 * @param {object} v
 * @param {'announcements'|'news'|'alerts'} v.surface
 * @param {'important'|'not-important'|'clear'} v.vote
 * @param {string} v.itemKey       the item's stable id on its surface
 * @param {string} [v.eventKey]    the stitched event, so related filings move with it
 * @param {string[]} v.features    relevance feature keys (relevance.js)
 * @param {string} [v.why] [v.label] [v.company] [v.categories]
 */
export async function vote(v) {
  const entry = { surface: v.surface, vote: v.vote, itemKey: v.itemKey, eventKey: v.eventKey || null, device: deviceId(),
    features: v.features || [], why: v.why || null, label: v.label || null, company: v.company || null, categories: v.categories || [] };
  const result = await send(entry);
  if (result.state === 'queued') {
    outbox = [...outbox.filter((o) => o.itemKey !== entry.itemKey), entry].slice(-OUTBOX_MAX);
    write(OUTBOX_KEY, outbox);
  } else if (result.state === 'saved') {
    if (entry.vote === 'clear') delete mine[entry.itemKey];
    else mine[entry.itemKey] = { vote: entry.vote, why: entry.why, surface: entry.surface };
    void loadModel({ force: true });
  }
  emit();
  return result;
}

async function send(entry) {
  try {
    const response = await fetch('api/relevance/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(entry),
    });
    const isJson = /json/.test(response.headers.get('content-type') || '');
    const body = isJson ? await response.json().catch(() => null) : null;
    if (response.ok && body?.ok) { serverState = 'live'; return { state: 'saved', revision: body.revision }; }
    // A static copy (404/405/501) or an unreachable Worker: keep the vote here and send it later.
    if (!isJson || [404, 405, 501, 502, 503, 504].includes(response.status) || body?.reason === 'rate-limited') {
      serverState = 'unreachable';
      return { state: 'queued', reason: body?.reason || 'unreachable' };
    }
    return { state: 'refused', reason: body?.reason || `HTTP ${response.status}` };
  } catch {
    serverState = 'unreachable';
    return { state: 'queued', reason: 'unreachable' };
  }
}

/** Send what waited in the outbox, oldest first; stop at the first one that still cannot go. */
export function flush() {
  if (flushing || !outbox.length) return flushing || Promise.resolve();
  flushing = (async () => {
    while (outbox.length) {
      const [next] = outbox;
      const result = await send(next);
      if (result.state === 'queued') break;
      outbox = outbox.slice(1);
      write(OUTBOX_KEY, outbox);
      if (result.state === 'saved') {
        if (next.vote === 'clear') delete mine[next.itemKey];
        else mine[next.itemKey] = { vote: next.vote, why: next.why, surface: next.surface };
      }
    }
    void loadModel({ force: true });
    emit();
  })().finally(() => { flushing = null; });
  return flushing;
}

export const pendingVotes = () => outbox.length;
