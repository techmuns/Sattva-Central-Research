import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeAnnouncements } from '../../public/js/data/announcements-shared.js';
import { documentUrl } from '../../public/js/data/domestic-filings-shared.js';

export const day = (time) => new Date(time).toISOString().slice(0, 10);
const shift = (date, days) => day(Date.parse(date) + days * 86400000);
export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`);
  renameSync(`${path}.tmp`, path);
}
export const companyPath = (kind, ticker) => `${kind}/${ticker}.json`;

// A source failure never closes a gap. Successful, fully parsed windows alone join this union.
export function mergeRanges(ranges, incoming) {
  const out = [];
  for (const range of [...ranges, ...(incoming ? [incoming] : [])].sort((a, b) => a.from.localeCompare(b.from))) {
    const last = out.at(-1);
    if (last && range.from <= shift(last.to, 1)) last.to = last.to > range.to ? last.to : range.to;
    else out.push({ ...range });
  }
  return out;
}
export function missingRanges(ranges, from, to) {
  const gaps = [];
  let cursor = from;
  for (const r of mergeRanges(ranges)) {
    if (r.to < cursor || r.from > to) continue;
    if (r.from > cursor) gaps.push({ from: cursor, to: shift(r.from, -1) });
    cursor = shift(r.to, 1);
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return gaps;
}
export function nextRange(entry, from, to, now) {
  // Re-read a week for late filings at least daily; otherwise work backwards through uncovered
  // history, 31 days per request. Never move a cursor just because the job ran.
  if (!entry.recentCheckedAt || now - Date.parse(entry.recentCheckedAt) >= 86400000) {
    return { from: shift(to, -6) < from ? from : shift(to, -6), to, recent: true };
  }
  const gap = missingRanges(entry.ranges || [], from, to).at(-1);
  if (gap) return { from: shift(gap.to, -30) > gap.from ? shift(gap.to, -30) : gap.from, to: gap.to };
  // Revisit historical windows as well: a filing may arrive with an older event date.
  const end = entry.recheckBefore && entry.recheckBefore >= from ? entry.recheckBefore : to;
  return { from: shift(end, -30) > from ? shift(end, -30) : from, to: end, recheck: true };
}
export function mergeDocuments(previous, incoming) {
  const rows = new Map();
  for (const row of [...previous, ...incoming]) {
    const url = documentUrl(row.url);
    if (!url) throw new Error('A document has no safe source URL.');
    rows.set(`${row.ticker}|${row.form}|${url}`, { ...row, url });
  }
  return [...rows.values()];
}

export function captureCompanies(dataDir) {
  const book = readJson(join(dataDir, 'portfolio-companies.json'), {}).holdings || [];
  const universe = readJson(join(dataDir, 'universe.json'), []);
  const technicals = readJson(join(dataDir, 'technicals.json'), {}).companies || [];
  const known = [...book, ...(Array.isArray(universe) ? universe : universe.companies || []), ...technicals];
  const seen = new Map();
  const unresolved = [];
  for (const c of known) {
    const ticker = String(c.ticker || /\/company\/([^/]+)/.exec(c['Screener URL'] || '')?.[1] || '').trim().toUpperCase();
    if (!/^[A-Z0-9&._-]{1,80}$/.test(ticker)) { unresolved.push(c.name || c.Company || ticker || 'Unnamed company'); continue; }
    if (!seen.has(ticker)) seen.set(ticker, { ticker, name: c.name || c.Company || ticker });
  }
  return { companies: [...seen.values()], unresolved: [...new Set(unresolved)] };
}

/** Bounded, restartable capture. Dependencies are injectable for offline failure/recovery tests. */
export async function captureCompanySources({ dir, companies, unresolved = [], request, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), budgetMs = 20 * 60000,
  spacingMs = 2500, concurrency = 3, backfillDays = 365, maxRequests = Infinity, onProgress = () => {} }) {
  const start = now(), to = day(start);
  const indexPath = join(dir, 'index.json');
  const index = readJson(indexPath, { version: 1, sources: {} });
  index.createdAt ||= index.lastRunAt || new Date(start).toISOString();
  const from = index.requestedFrom || shift(to, -(backfillDays - 1));
  const wanted = new Set(companies.map((c) => c.ticker));
  index.companies = companies;
  index.unresolved = unresolved;
  index.requestedFrom = from;
  index.requestedTo = to;
  index.lastRunAt = new Date(start).toISOString();
  index.scope = 'Committed portfolio, universe and technicals; device-only additions are not registered for background capture.';
  for (const kind of ['announcements', 'domestic']) {
    const entries = index.sources[kind] ||= {};
    for (const { ticker } of companies) {
      if (!entries[ticker]) entries[ticker] = { rowCount: 0, ranges: [], registeredAt: new Date(start).toISOString() };
      else entries[ticker].registeredAt ||= index.createdAt;
    }
  }
  // Fair across restarts. A failure is attempted again, but does not starve companies that have
  // never been reached. Nothing is sliced out of the declared universe to meet a run's budget.
  const queue = Object.entries(index.sources).flatMap(([kind, entries]) =>
    Object.entries(entries).filter(([ticker]) => wanted.has(ticker)).map(([ticker, entry]) => ({ kind, ticker, entry })))
    .filter(({ kind, entry }) => kind !== 'domestic' || !entry.lastSuccessAt || entry.error || now() - Date.parse(entry.lastSuccessAt) >= 86400000)
    .sort((a, b) => (a.entry.lastAttemptAt || '').localeCompare(b.entry.lastAttemptAt || ''));
  let count = 0, stop = false, gate = Promise.resolve(), nextStart = start;
  const checkpoint = () => { index.updatedAt = new Date(now()).toISOString(); writeJson(indexPath, index); };
  const reserve = () => {
    const turn = gate.then(async () => {
      if (stop || count >= maxRequests || now() >= start + budgetMs) return false;
      const wait = Math.max(0, nextStart - now());
      if (now() + wait >= start + budgetMs) return false;
      if (wait) await sleep(wait);
      nextStart = now() + spacingMs;
      count++;
      return true;
    });
    gate = turn.then(() => {});
    return turn;
  };
  checkpoint();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length && await reserve()) {
      if (stop) return;
      const job = queue.shift();
      if (!job) return;
      const { kind, ticker, entry } = job;
      const range = kind === 'announcements' ? nextRange(entry, from, to, now()) : null;
      entry.lastAttemptAt = new Date(now()).toISOString();
      try {
        const result = await request(kind, ticker, range);
        const incoming = result[kind === 'domestic' ? 'documents' : 'announcements'];
        if (result.ok !== true || !Array.isArray(incoming)) throw Object.assign(new Error(result.message || 'Unrecognized source response'), { reason: result.reason || 'shape' });
        const path = join(dir, companyPath(kind, ticker));
        const previous = readJson(path, { rows: [] });
        const clean = incoming.map(({ raw, ...row }) => ({ ...row, ticker }));
        const rows = kind === 'domestic' ? mergeDocuments(previous.rows, clean) : mergeAnnouncements(previous.rows, clean);
        // Write the rows before their checkpoint: a crash can cause a harmless re-read, never a
        // watermark pointing past documents that were not saved.
        writeJson(path, { ticker, kind, rows, fetchedAt: result.fetchedAt || entry.lastAttemptAt });
        entry.rowCount = rows.length;
        entry.skipped = result.skipped || 0;
        entry.unavailableLinks = result.unavailableLinks || 0;
        entry.lastResponseAt = result.fetchedAt || entry.lastAttemptAt;
        if (entry.skipped) throw new Error(`${entry.skipped} source entries could not be parsed; captured rows retained, window remains incomplete.`);
        entry.lastSuccessAt = entry.lastAttemptAt;
        entry.error = null;
        if (range) {
          entry.ranges = mergeRanges(entry.ranges || [], { from: range.from, to: range.to });
          if (range.recent) entry.recentCheckedAt = entry.lastAttemptAt;
          if (range.recheck) entry.recheckBefore = shift(range.from, -1);
        }
      } catch (error) {
        // Never persist request headers or raw errors which could contain credentials.
        entry.error = { reason: error.reason || 'upstream', message: error.message || 'Source could not be read', at: entry.lastAttemptAt };
        if (['no-token', 'unauthorised'].includes(error.reason)) stop = true;
      }
      checkpoint();
      onProgress({ kind, ticker, count, error: entry.error });
    }
  }));
  index.lastRunFinishedAt = new Date(now()).toISOString();
  index.requests = count;
  index.stoppedForAuth = stop;
  checkpoint();
  // Small initial table. Full histories remain in per-company files and are accessible in the UI.
  const recent = [];
  for (const ticker of Object.keys(index.sources.announcements)) {
    const saved = readJson(join(dir, companyPath('announcements', ticker)), { rows: [] });
    recent.push(...saved.rows.filter((r) => !r.date || r.date >= shift(to, -29)));
  }
  writeJson(join(dir, 'announcements-recent.json'), { updatedAt: index.updatedAt, from: shift(to, -29), rows: mergeAnnouncements(recent) });
  return index;
}
