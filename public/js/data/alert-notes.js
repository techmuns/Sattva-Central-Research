// data/alert-notes.js — THE BROWSER HALF OF THE "SO WHAT?" LINE.
//
// AI Alerts and All Alerts ask here for the second bullet of the developments on screen, and this
// batches the question to `POST /api/alert-notes` (worker/alert-notes.mjs): at most
// `NOTE_REQUEST_ITEMS` per request, one request in flight, nothing asked twice in a session. The
// Worker keeps every note it writes, so reopening a card, or a second reader, costs no model call.
//
// FOUR STATES, AND ONLY ONE OF THEM IS A NOTE. `ready` carries the note; `pending` is a question on
// its way; `missing` carries the reason the note is absent (no AI service on this copy, no key, the
// day's allowance spent, a refusal, a withheld answer — `NOTE_REASON` words each); and no entry at
// all means nobody has asked. A failed read is never an empty note, and a reason is never a note.
//
// NOTHING HERE IS PERSISTED ON THE DEVICE. A note is a derived reading that the Worker already
// keeps; holding a second copy in browser storage would be one more place for it to go stale.
import { noteItem, noteContent, acceptNote, NOTE_REQUEST_ITEMS, NOTE_REASON } from './alert-notes-shared.js';
import { storyKindOf, developmentLine } from './alert-developments.js';
import { sourceStatement } from './alert-claims.js';
import * as coverage from './coverage.js';
import * as technicals from './technicals.js';

export { NOTE_REASON } from './alert-notes-shared.js';

const ROUTE = 'api/alert-notes';
const REQUEST_TIMEOUT_MS = 45_000;
// How long a reason holds before the same question may be asked again this session.
const RETRY_MS = { 'rate-limited': 60_000, budget: 30 * 60_000, 'no-key': 10 * 60_000, refused: 10 * 60_000,
  upstream: 2 * 60_000, timeout: 2 * 60_000, error: 2 * 60_000, unreadable: 5 * 60_000, empty: 5 * 60_000 };
// Reasons that are about the deployment rather than the item: every other question would get the
// same answer, so none is sent until the hold lapses.
const DEPLOYMENT_REASONS = new Set(['no-worker', 'no-key', 'refused', 'budget', 'rate-limited']);
const KIND_OF_FEED = { earnings: 'result', insider: 'insider', investors: 'investor' };

const states = new Map(); // content key -> { state, note?, model?, reason?, retryAt? }
const handles = new Map(); // content key -> short DOM handle
const queue = new Map(); // content key -> item
const listeners = new Set();
let serial = 0;
let hold = null; // { reason, until } — the deployment cannot answer right now
let flushing = false;
let flushTimer = 0;

/** What kind of note a development can carry, or null: a price or volume reading, chatter, a
 * con-call's third-party analysis and a social post have no stated development to assess. */
export function noteKindOf(dev) {
  const lead = dev?.lead;
  if (!lead || !(lead.ticker || lead.entityId)) return null;
  const story = storyKindOf(lead);
  if (story === 'filing') return 'filing';
  if (story === 'news') return lead.feed === 'news' && lead.attribution?.status === 'confirmed' ? 'news' : null;
  return KIND_OF_FEED[lead.feed] || null;
}

const knownSector = (value) => typeof value === 'string' && !/^(unclassified|unknown|n\/a|[-—])?$/i.test(value.trim()) ? value.trim() : null;

/** The company's sector as the AI Alerts card reads it: the book's own, else the technicals capture's. */
export function noteSector(ticker) {
  const symbol = String(ticker || '').toUpperCase();
  if (!symbol) return null;
  const held = coverage.holdings().find((holding) => String(holding.ticker || '').toUpperCase() === symbol);
  if (knownSector(held?.sector)) return knownSector(held.sector);
  return knownSector(technicals.rowFor?.(symbol)?.sector) || null;
}

/**
 * The question for one development, built from its LEAD alone — the lead's own statement (LINE 1),
 * headline and detail, the company's name and sector, the development's date — so the card in AI
 * Alerts and the row in All Alerts ask the same question about the same development and share one
 * note, however many reports each surface has folded under it. `fallback` is the line a surface
 * prints for a measurement (a filed result, a disclosure), which has no statement of its own.
 */
export function noteRequestFor(dev, { fallback = null } = {}) {
  const kind = noteKindOf(dev);
  if (!kind) return null;
  const lead = dev.lead;
  const line = developmentLine({ ...dev, companyNames: [] }, { fallback: fallback || lead.headline });
  const detail = kind === 'filing' ? sourceStatement(lead.filingDescription) || lead.detail : lead.detail;
  const item = noteItem({ id: 'q', kind, company: lead.company, ticker: lead.ticker, sector: noteSector(lead.ticker),
    day: dev.day || lead.day, line, headline: lead.headline, detail });
  if (!item) return null;
  const key = noteContent(item);
  return { key, item, handle: handleOf(key) };
}

/** A short, stable name for a question, for the DOM to patch the right node when its note lands. */
export function handleOf(key) {
  let handle = handles.get(key);
  if (!handle) { handle = `n${++serial}`; handles.set(key, handle); }
  return handle;
}

/** The note's state for a request (see the header), or null when nobody has asked. */
export function noteState(request) {
  if (!request) return null;
  const found = states.get(request.key);
  if (found) return found;
  return hold && Date.now() < hold.until ? { state: 'missing', reason: hold.reason } : null;
}

export const reasonText = (reason) => NOTE_REASON[reason] || NOTE_REASON.error;

/** Subscribe to arrivals: `fn(handles)` names the handles whose state changed. */
export function onNotes(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(keys) {
  const changed = [...new Set(keys)].map(handleOf);
  if (!changed.length) return;
  for (const fn of [...listeners]) {
    try { fn(changed); } catch (error) { console.warn('[alert-notes] listener threw', error); }
  }
}

/**
 * Ask for the notes behind these requests. Anything already answered, on its way, or held by a
 * reason that has not lapsed is not asked again; the rest is queued and sent in batches.
 */
export function requestNotes(requests = []) {
  const now = Date.now();
  if (hold && now < hold.until) return;
  let queued = false;
  for (const request of requests) {
    if (!request?.key) continue;
    const found = states.get(request.key);
    if (found && (found.state !== 'missing' || now < (found.retryAt ?? Infinity))) continue;
    if (queue.has(request.key)) continue;
    queue.set(request.key, request.item);
    states.set(request.key, { state: 'pending' });
    queued = true;
  }
  if (queued && !flushing && !flushTimer) flushTimer = setTimeout(flush, 120);
}

function settle(keys, value) {
  for (const key of keys) states.set(key, value);
  notify(keys);
}

async function flush() {
  flushTimer = 0;
  if (flushing || !queue.size) return;
  flushing = true;
  try {
    while (queue.size && !(hold && Date.now() < hold.until)) {
      const batch = [...queue.entries()].slice(0, NOTE_REQUEST_ITEMS);
      for (const [key] of batch) queue.delete(key);
      await ask(batch);
    }
    // A hold that began mid-queue answers everything still waiting, rather than leaving it pending.
    if (queue.size) {
      const keys = [...queue.keys()];
      queue.clear();
      settle(keys, { state: 'missing', reason: hold?.reason || 'error', retryAt: hold?.until ?? Date.now() });
    }
  } finally {
    flushing = false;
  }
}

async function ask(batch) {
  const keys = batch.map(([key]) => key);
  const fail = (reason) => {
    const retryAt = reason === 'no-worker' ? Infinity : Date.now() + (RETRY_MS[reason] ?? RETRY_MS.error);
    if (DEPLOYMENT_REASONS.has(reason)) hold = { reason, until: retryAt };
    settle(keys, { state: 'missing', reason, retryAt });
  };
  let response;
  try {
    response = await fetch(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ items: batch.map(([, item], index) => ({ ...item, id: String(index) })) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail(error?.name === 'TimeoutError' ? 'timeout' : 'error');
    return;
  }
  // A static origin answers a POST with 404, 405 or 501 — `python3 -m http.server` says 501 — and
  // a page served without the Worker is a supported way to run this dashboard, not a fault.
  if ([404, 405, 501].includes(response.status)) { fail('no-worker'); return; }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') { fail(response.ok ? 'no-worker' : 'error'); return; }
  if (response.status === 429 || body.reason === 'rate-limited') { fail('rate-limited'); return; }
  if (!response.ok || body.ok !== true) { fail(body.reason === 'notes-unavailable' ? 'no-worker' : 'error'); return; }
  const changed = [];
  batch.forEach(([key, item], index) => {
    const id = String(index);
    const found = body.notes?.[id];
    if (found && typeof found.note === 'string') {
      // The Worker checked the note against the item; checking again here costs nothing and means a
      // note this page prints has passed the contract on the page's own side of the wire too.
      const checked = acceptNote(found.note, item, new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10));
      states.set(key, checked.ok
        ? { state: 'ready', note: checked.note, model: typeof found.model === 'string' ? found.model : null }
        : { state: 'missing', reason: checked.reason, retryAt: Infinity });
    } else {
      const reason = typeof body.missing?.[id] === 'string' ? body.missing[id] : 'empty';
      const retryAt = RETRY_MS[reason] ? Date.now() + RETRY_MS[reason] : Infinity;
      if (DEPLOYMENT_REASONS.has(reason)) hold = { reason, until: retryAt };
      states.set(key, { state: 'missing', reason, retryAt });
    }
    changed.push(key);
  });
  notify(changed);
}

/** For tests: forget every state, handle and hold. */
export function resetNotes() {
  states.clear(); handles.clear(); queue.clear(); hold = null; serial = 0;
  clearTimeout(flushTimer); flushTimer = 0;
}
