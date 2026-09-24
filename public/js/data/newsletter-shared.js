// data/newsletter-shared.js — THE TEAM BRIEF'S CONTRACT, imported by the browser AND the Worker.
//
// Two emails a day to the desk, built at the edge from feeds this dashboard already reads:
//
//   morning  08:00 IST   what happened overnight — the US close, Asia this morning, Brent, gold,
//                        silver, the dollar index and USD/JPY, plus every filing and story about a
//                        DIRECT holding since the previous evening's brief
//   evening  16:00 IST   the trading day just closed — the same scan, plus the day's filings and
//                        stories since the morning brief
//
// This file is pure: no DOM, no storage, no network. It owns what an email address is, what an
// edition is, when each one sends and what window it covers, so `ui/newsletter.js`,
// `worker/newsletter-store.mjs` and `worker/newsletter-schedule.mjs` cannot drift about any of it —
// the same arrangement as `watchlist-shared.js` and `finology-shared.js`.
//
// EVERY CLOCK HERE IS IST, AND IST HAS NO DAYLIGHT SAVING. The desk's day is Indian; a brief that
// sent at 08:00 in whichever zone the Worker happened to evaluate in would be a different product.
// A fixed +05:30 is therefore exact, and it lets the schedule maths run identically in a browser,
// in Node and on the edge without an Intl timezone database in the loop.
//
// A SEND ON A WEEKEND IS NOT OFFERED. Markets are shut, filings are rare, and Monday's morning brief
// already covers from Friday's close — its window is "since the previous WEEKDAY's evening send",
// so nothing that happened over the weekend falls between two briefs.
//
// NOTHING FALLS BETWEEN TWO BRIEFS, AND THE WINDOW ALONE COULD NOT PROMISE THAT. Every source behind
// the brief is a capture with a lag — BSE's date feed every hour or two on a best-effort scheduler,
// NSE's history hourly, the publishers every thirty minutes — and NSE's live RSS holds the last few
// minutes only. So a filing published at 15:50 and captured at 17:15 was in neither the 16:00 brief
// (not yet captured) nor the next morning's (published before its window opened): it was never
// emailed, and nothing said so. The same hole swallowed a whole window whenever an edition was
// recorded `missed`. So the Worker keeps a ledger of every item a scheduled brief has carried, and
// each brief also reads back over the two windows before its own for anything the ledger does not
// hold — `lateArrivalsFrom()` below — printing those as "not in the previous brief" with their own
// publication time. The ledger is the identity rule from everywhere else here: compare identities,
// never counts or clocks.

import { personName } from './watchlist-shared.js';

export const EDITIONS = Object.freeze({
  morning: Object.freeze({ id: 'morning', label: 'Morning brief', short: 'Morning', defaultTime: '08:00', covers: 'overnight, since the previous evening brief' }),
  evening: Object.freeze({ id: 'evening', label: 'Evening brief', short: 'Evening', defaultTime: '16:00', covers: 'the trading day, since the morning brief' }),
});
export const EDITION_IDS = Object.freeze(['morning', 'evening']);

// A DAY-DATED RECORD IS FILED AT THAT DAY'S CLOSE. Insider, bulk, block and SAST disclosures carry a
// broadcast day and no clock, so the brief has to decide which edition a day belongs to: the evening
// brief of that day, with the label "day only" on the row rather than an invented clock. One captured
// after that brief went out reaches the next as "not in the previous brief" through the ledger.
export const DAY_ONLY_TIME = '15:30';
// Items a scheduled brief carried are remembered this long, which is longer than any lookback below.
export const REPORTED_RETENTION_MS = 10 * 86400000;

export const NEWSLETTER_SUBSCRIBER_LIMIT = 100;
export const NEWSLETTER_INTENT_BATCH = 20;
export const NEWSLETTER_REQUEST_BYTES = 16384;
export const NEWSLETTER_NAME_MAX = 60;
export const NEWSLETTER_EMAIL_MAX = 254;
export const IST_OFFSET_MS = 5.5 * 3600 * 1000;

// ---- addresses ------------------------------------------------------------------------------

// The practical shape of an address rather than the whole of RFC 5322: one local part, one host
// with at least one dot, no whitespace. A stricter grammar refuses real addresses; a looser one
// lets "ravi" through and the upstream refuses it with a 4xx we would then have to explain.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** The address, lower-cased and trimmed, or null. One person is one row whatever case they typed. */
export function normaliseEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return email && email.length <= NEWSLETTER_EMAIL_MAX && EMAIL_RE.test(email) ? email : null;
}

/**
 * SEVERAL ADDRESSES AS A READER PASTES THEM — one per line out of a table, comma- or
 * semicolon-separated out of a mail client, or one typed. Returns `{ emails, invalid }`: the valid
 * addresses, normalised and deduplicated in the order given, and every token that is not one, kept
 * VERBATIM so the caller can name it.
 *
 * NOTHING IS DROPPED SILENTLY. A mistyped address that simply vanished from a paste of six would
 * leave the reader believing five was all they pasted — the same class of error as rendering a
 * missing value as zero. A caller decides what to do with `invalid`; it may not ignore it.
 *
 * A mail client's `Name <a@b.in>` pair is reduced to the address, the display NAME consumed with
 * the brackets rather than left behind as chaff that would then be refused as a bad address. The
 * panel asks for no name, so there is nothing here for one to be kept in.
 */
export function normaliseEmailList(value) {
  const text = String(value ?? '').replace(/[^,;<>\r\n]*<\s*([^<>\s,;]+@[^<>\s,;]+)\s*>/g, ' $1 ');
  const emails = [];
  const invalid = [];
  const seen = new Set();
  for (const token of text.split(/[\s,;]+/)) {
    if (!token) continue;
    const email = normaliseEmail(token);
    if (!email) { if (!invalid.includes(token)) invalid.push(token); continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return { emails, invalid };
}

export const isTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''));
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The subset of editions named, in canonical order, with duplicates dropped. */
export function normaliseEditions(value) {
  const wanted = new Set((Array.isArray(value) ? value : [value]).map((v) => String(v ?? '').trim().toLowerCase()));
  return EDITION_IDS.filter((id) => wanted.has(id));
}

// ---- intents ---------------------------------------------------------------------------------
//
// An edit is sent as WHAT IT WAS, never as the list it produced — the shared-watchlist rule. A
// whole-array PUT from a panel opened an hour ago would silently delete whoever was added since.

export function newsletterIntent(input) {
  const op = String(input?.op ?? '');
  if (!['subscribe', 'unsubscribe', 'editions'].includes(op)) throw new Error('Invalid newsletter intent: unknown op');
  const email = normaliseEmail(input?.email);
  if (!email) throw new Error('Invalid newsletter intent: a valid email address is required');
  const name = personName(input?.name);
  const by = personName(input?.by);
  // Attribution on an addition, exactly as the watchlist enforces it: the desk is owed the answer to
  // "who put this address on the list", and the contract is where that survives a second UI path.
  if (op === 'subscribe' && !by) throw new Error('Invalid newsletter intent: a subscription must name who added it');
  const editions = op === 'unsubscribe' ? null : normaliseEditions(input?.editions ?? EDITION_IDS);
  if (editions && !editions.length) throw new Error('Invalid newsletter intent: choose at least one edition');
  return { op, email, name: name ? name.slice(0, NEWSLETTER_NAME_MAX) : null, by: by ? by.slice(0, NEWSLETTER_NAME_MAX) : null, editions };
}

export function newsletterIntents(input) {
  if (!Array.isArray(input) || !input.length || input.length > NEWSLETTER_INTENT_BATCH) throw new Error('Invalid newsletter intents: expected 1 to 20 edits');
  const seen = new Set();
  return input.map((entry) => {
    const intent = newsletterIntent(entry);
    if (seen.has(intent.email)) throw new Error('Duplicate address in one batch');
    seen.add(intent.email);
    return intent;
  });
}

/** One subscriber row as every surface reads it; unknown fields are dropped, never invented. */
export function subscriberEntry(row) {
  const email = normaliseEmail(row?.email);
  if (!email) return null;
  return {
    email,
    name: personName(row?.name),
    editions: normaliseEditions(row?.editions ?? EDITION_IDS),
    addedAt: typeof row?.addedAt === 'string' ? row.addedAt : null,
    addedBy: personName(row?.addedBy),
  };
}

// ---- settings --------------------------------------------------------------------------------

export const DEFAULT_SETTINGS = Object.freeze({
  morning: Object.freeze({ enabled: true, time: EDITIONS.morning.defaultTime }),
  evening: Object.freeze({ enabled: true, time: EDITIONS.evening.defaultTime }),
});

/** The desk-wide schedule, validated. Missing fields keep their defaults; a bad time is refused. */
export function newsletterSettings(input) {
  const out = {};
  for (const id of EDITION_IDS) {
    const src = input?.[id] && typeof input[id] === 'object' ? input[id] : {};
    const enabled = src.enabled === undefined ? DEFAULT_SETTINGS[id].enabled : src.enabled === true;
    const time = src.time === undefined ? DEFAULT_SETTINGS[id].time : String(src.time);
    if (!isTime(time)) throw new Error(`Invalid newsletter schedule: ${id} time must be HH:MM`);
    out[id] = { enabled, time };
  }
  // The evening window is "since the morning send", so the two must keep their order.
  if (minutesOf(out.morning.time) >= minutesOf(out.evening.time)) throw new Error('Invalid newsletter schedule: the morning brief must send before the evening brief');
  return out;
}

// ---- the Indian clock ------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** Calendar parts of an instant, in IST. `weekday` is 0 (Sunday) to 6. */
export function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), weekday: d.getUTCDay(),
    day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
  };
}

export const istDay = (ms) => istParts(ms).day;

/** The instant of an IST calendar day + HH:MM, as epoch milliseconds. */
export function istInstant(day, time = '00:00') {
  const [y, m, d] = String(day).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS;
}

export const addDays = (day, n) => istDay(istInstant(day) + n * 86400000);
export const isWeekday = (day) => { const w = istParts(istInstant(day)).weekday; return w >= 1 && w <= 5; };

export function previousWeekday(day) {
  let d = addDays(day, -1);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

// ---- editions on the calendar ----------------------------------------------------------------

export const editionKey = (edition, day) => `${day}:${edition}`;
export const editionInstant = (edition, day, settings) => istInstant(day, settings[edition].time);

/**
 * The window one brief covers. The morning brief reaches back to the previous WEEKDAY's evening
 * time — so Monday's covers from Friday's close — and the evening brief back to that morning's
 * send. `to` may be overridden for a brief built on demand, which then covers "up to now" and
 * says so on its face.
 */
export function editionWindow(edition, day, settings, { to = null } = {}) {
  const at = editionInstant(edition, day, settings);
  const from = edition === 'morning'
    ? editionInstant('evening', previousWeekday(day), settings)
    : editionInstant('morning', day, settings);
  return { from, to: to ?? at, at };
}

/** The instant a day-dated record is filed at: the close of its own day. */
export const dayOnlyInstant = (day) => istInstant(day, DAY_ONLY_TIME);

/** The edition sent before this one on the calendar, weekends stepped over. */
export function previousEdition(edition, day) {
  return edition === 'morning' ? { edition: 'evening', day: previousWeekday(day) } : { edition: 'morning', day };
}

/**
 * The earliest publication instant a LATE ARRIVAL may carry: the start of the window two sends
 * back, so a brief reads over the two windows before its own. Monday morning's reaches back to
 * Thursday 16:00, Tuesday evening's to Monday 08:00. Two, not one, because a capture stalled for
 * most of a day — GitHub's scheduler measurably does that — would otherwise still lose a filing.
 * The ledger, not this instant, decides what is actually shown: an item the desk was already sent
 * is never sent again.
 */
export function lateArrivalsFrom(edition, day, settings) {
  const previous = previousEdition(edition, day);
  const before = previousEdition(previous.edition, previous.day);
  return editionWindow(before.edition, before.day, settings).from;
}

/** Every enabled weekday send whose instant lies in (after, until], earliest first. */
export function scheduledEditions(settings, after, until) {
  const out = [];
  const lastDay = istDay(until);
  let day = istDay(after);
  for (let i = 0; i < 60 && day <= lastDay; i++) {
    if (isWeekday(day)) {
      for (const id of EDITION_IDS) {
        if (!settings[id].enabled) continue;
        const at = editionInstant(id, day, settings);
        if (at > after && at <= until) out.push({ edition: id, day, at, key: editionKey(id, day) });
      }
    }
    day = addDays(day, 1);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The next send after `now`, or null when both editions are switched off. */
export function nextScheduled(settings, now) {
  return scheduledEditions(settings, now, now + 14 * 86400000)[0] || null;
}

// ---- labels ----------------------------------------------------------------------------------

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const istTime = (ms) => { const p = istParts(ms); return `${pad(p.hh)}:${pad(p.mm)}`; };

/** "Thu 17 Sep, 08:00 IST" — the form every dated figure in the brief carries. */
export function istLabel(ms, { time = true, year = false } = {}) {
  const p = istParts(ms);
  const date = `${DAYS[p.weekday].slice(0, 3)} ${p.d} ${MONTHS[p.m - 1].slice(0, 3)}${year ? ` ${p.y}` : ''}`;
  return time ? `${date}, ${pad(p.hh)}:${pad(p.mm)} IST` : date;
}

/** "Thursday 17 September 2026" */
export function istDateLong(ms) {
  const p = istParts(ms);
  return `${DAYS[p.weekday]} ${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}
