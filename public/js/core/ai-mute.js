// core/ai-mute.js — "I HAVE READ THIS ONE." A device-local mute for an AI Alerts card.
//
//   mute.hide(ticker, seenId)   stop showing this company's card
//   mute.show(ticker)           bring it back
//   mute.isHidden(ticker, id)   is it hidden RIGHT NOW, given the evidence on screen?
//   mute.count()                how many are hidden
//   mute.clear()                bring all of them back
//   mute.onChange(fn)           fires on every mutation, in this tab
//
// WHY A MUTE IS TIED TO THE EVIDENCE IT WAS GIVEN FOR, AND NOT JUST TO THE COMPANY
//   AI Alerts exists to say "this needs you today". A mute that simply hid a ticker would keep
//   hiding it after tomorrow's filing, tomorrow's block deal and tomorrow's result — the reader
//   would have silenced a company on Monday's evidence and stopped being told about Friday's, with
//   nothing on screen saying so. That is the same failure as rendering a missing value as zero:
//   an absence produced by our own bookkeeping, presented as an absence of events.
//
//   A mute records the material evidence already read. A new material item or correction brings
//   the company back even when its strongest older event is unchanged. Reordering, routine
//   observations, and evidence aging out do not wake a dismissed card.
//
// IT IS ALSO TIME-BOUNDED. Beyond the alert window itself the record is meaningless — the events
// it refers to have left the window — so it lapses rather than accumulating for ever.

import { AI_ALERT_WINDOW_MS as LAPSE_MS } from './alert-window.js';

const STORAGE_KEY = 'sattva:ai-muted:v1';

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

const normTicker = (t) => String(t ?? '').trim().toUpperCase();

let cache = null;

function read() {
  let raw = cache;
  if (!raw) {
    try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { raw = null; }
  }
  const now = Date.now();
  const clean = {};
  for (const [ticker, entry] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!entry || typeof entry !== 'object') continue;
    const at = Date.parse(entry.at || '');
    if (!Number.isFinite(at) || at > now || now - at >= LAPSE_MS) continue;
    clean[normTicker(ticker)] = { at: entry.at, seen: entry.seen == null ? null : String(entry.seen) };
  }
  cache = clean;
  return cache;
}

function write(next) {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private window or quota — the mute simply does not survive this session, which is the
    // honest degradation: nothing is hidden that the reader cannot see the count of.
  }
  emit();
}

/** Hide already-read evidence until a new material event arrives, or the window lapses. */
export function hide(ticker, seenId = null) {
  const key = normTicker(ticker);
  if (!key) return;
  write({ ...read(), [key]: { at: new Date().toISOString(), seen: seenId == null ? null : String(seenId) } });
}

/** Bring one company's card back. */
export function show(ticker) {
  const key = normTicker(ticker);
  const next = { ...read() };
  if (!(key in next)) return;
  delete next[key];
  write(next);
}

/**
 * Is this card hidden for the evidence it is currently carrying?
 *
 * `seenId` is the serialized material-evidence list. Subset comparison tolerates old events
 * leaving the rolling window. Legacy single-id dismissals cannot hide a new evidence list.
 */
export function isHidden(ticker, seenId = null) {
  const entry = read()[normTicker(ticker)];
  if (!entry) return false;
  if (entry.seen == null || !seenId) return false;
  const evidence = (value) => {
    try {
      const list = JSON.parse(value);
      return Array.isArray(list) && list.every((item) => typeof item === 'string') ? list : null;
    } catch { return null; }
  };
  const current = evidence(seenId), seen = evidence(entry.seen);
  if (current) return !!seen && current.length > 0 && current.every((item) => seen.includes(item));
  return !seen && entry.seen === String(seenId);
}

export function count() {
  return Object.keys(read()).length;
}

export function clear() {
  if (!count()) return;
  write({});
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
