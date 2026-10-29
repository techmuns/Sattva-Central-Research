// Broker reports for AI Alerts and All Alerts — read from data/broker-reports.json, which the runner
// builds out of the retained Telegram research channel (scripts/build-broker-reports.mjs). The page
// never reads the 10 MB Telegram archive for this; the derived file is small and conditional.
import { revalidatedJson } from '../core/store.js';
import { record, istDay } from './alert-records.js';
import { AI_ALERT_WINDOW_DAYS } from '../core/alert-window.js';
import { BROKER_FEED, brokerImportance, brokerHeadline, brokerCall, brokerDirection } from './broker-reports-shared.js';

const PATH = 'data/broker-reports.json';
let file = null;
let error = null;
const subscribers = new Set();
export const onChange = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
const emit = () => subscribers.forEach((fn) => { try { fn(); } catch (err) { console.error('[broker-reports] subscriber failed', err); } });

function valid(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.reports)) throw new Error('Broker reports file could not be read');
  return value;
}

/** Load, or revalidate, the derived file. A failed read keeps the copy already held. */
export async function load() {
  try {
    const next = valid(await revalidatedJson(PATH));
    // A revalidation parses a fresh object even when nothing moved; only a new build is a change,
    // or every collection that loads this file would announce one and collect again.
    const changed = next.generatedAt !== file?.generatedAt;
    file = next; error = null;
    if (changed) emit();
  } catch (err) {
    error = err?.message || 'Broker reports unavailable';
    if (!file) throw err;
  }
  return file;
}

export const isLoaded = () => !!file;
export const reports = () => file?.reports || [];
export const meta = () => (file
  ? { generatedAt: file.generatedAt, captureCheckedAt: file.captureCheckedAt, windowDays: file.windowDays, counts: file.counts, error }
  : { error });

const shiftDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// One event per report, kept on the report object so a re-read hands every cache beneath it the
// same event. The day decides which brokers count as "in the window", so it is part of the key.
const events = new WeakMap();
export function brokerRecord(r, brokersInWindow = 1) {
  const held = events.get(r);
  if (held?.brokersInWindow === brokersInWindow) return held.event;
  const importance = brokerImportance(r, brokersInWindow);
  const call = brokerCall(r);
  const event = record({
    id: `broker:${r.id}`, row: r, at: r.publishedAt, ticker: r.ticker || null, company: r.company || r.named,
    headline: brokerHeadline(r),
    detail: `${r.points || r.reportTitle || 'No report title printed.'} · Broker report as posted on the Telegram research channel; the report itself is not read.`,
    url: r.url, kind: 'broker-report',
    direction: brokerDirection(r), importance: importance.high ? 'high' : 'low',
    // A resolved company, a date and the post's own link: the same bar the filings meet.
    aiEligible: !!r.ticker && !!istDay(r.publishedAt) && !!r.url,
    signalReason: call ? `The broker's own call: ${call}.` : 'The post prints no rating, target or upside; no direction is inferred.',
    importanceReason: importance.reason,
    brokerReport: r,
  });
  events.set(r, { brokersInWindow, event });
  return event;
}

/** The feed as the alert collector reads it. */
export function readFeed({ day } = {}) {
  if (!file) return { events: [], status: 'failed', asOf: null, reachesToday: false,
    note: error ? `Broker reports could not be read: ${error}` : 'Broker reports have not been read yet.' };
  const today = day || istDay(new Date().toISOString());
  const first = shiftDay(today, -(AI_ALERT_WINDOW_DAYS - 1));
  // Distinct brokers per company inside the alert window — two or more makes each report material.
  const brokers = new Map();
  for (const r of file.reports) {
    const d = istDay(r.publishedAt);
    if (!r.ticker || !d || d < first || d > today) continue;
    if (!brokers.has(r.ticker)) brokers.set(r.ticker, new Set());
    brokers.get(r.ticker).add(r.broker.toLowerCase());
  }
  const checked = file.captureCheckedAt || file.generatedAt;
  // A failed or partial Telegram collection is this feed's failure too, whatever this file's read.
  const upstream = file.captureHealth || {};
  const degraded = !!error || upstream.failed === true || upstream.partial === true;
  return {
    events: file.reports.map((r) => brokerRecord(r, brokers.get(r.ticker)?.size || 1)),
    status: degraded ? 'failed' : 'ok', asOf: checked, reachesToday: !degraded && !!istDay(checked) && istDay(checked) >= today,
    note: `Broker report titles from the Telegram research channel over the last ${file.windowDays} days: ${file.counts.reports} reports, ${file.counts.unresolved} not matched to an NSE symbol and left unassigned. Ratings and targets appear only where a post printed them; report PDFs are not read.${error ? ' The latest check failed; the last file read is shown.' : ''}${!error && (upstream.failed || upstream.partial) ? ` The latest Telegram collection ${upstream.failed ? 'failed' : 'was partial'}${upstream.lastRunAt ? ` (${upstream.lastRunAt})` : ''}; the reports shown are the last good read.` : ''}`,
    revision: file.generatedAt,
  };
}

export { BROKER_FEED };
