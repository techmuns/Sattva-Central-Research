import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeAnnouncements } from '../../public/js/data/announcements-shared.js';
import { documentUrl } from '../../public/js/data/domestic-filings-shared.js';
import { createAnnouncementIdentity, filingTicker, mergeExchangeIdentities } from '../../public/js/data/announcement-identity.js';

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

export function captureCompanies(dataDir, { announcements = false, holdings = null, registrations = null } = {}) {
  const book = holdings ?? readJson(join(dataDir, 'portfolio-companies.json'), {}).holdings ?? [];
  const identities = announcements ? readJson(join(dataDir, 'announcement-identities.json'), {}).entries || [] : [];
  const nse = announcements ? readJson(join(dataDir, 'filing-capture/nse-identities.json'), {}).directories || {} : {};
  const identityIndex = createAnnouncementIdentity(mergeExchangeIdentities(identities, nse.sme?.entries || [], nse.equity?.entries || []));
  const universe = readJson(join(dataDir, 'universe.json'), []);
  const technicals = readJson(join(dataDir, 'technicals.json'), {}).companies || [];
  const announcementBook = book.map(c => {
    const identity = identityIndex.find(c);
    return { ...c, ticker: c.ticker || identity?.ticker || identity?.bseSymbol || null,
      announcementTicker: identity ? filingTicker(identity.ticker || identity.bseSymbol) : filingTicker(c.ticker), priority: true };
  });
  const enrolled = announcements ? registrations ?? readJson(join(dataDir, 'filing-capture/registrations.json'), {}).companies ?? [] : [];
  const known = [...(announcements ? announcementBook : book), ...enrolled.map(c => ({ ...c, priority: true })), ...(Array.isArray(universe) ? universe : universe.companies || []), ...technicals];
  const seen = new Map();
  const unresolved = [];
  for (const c of known) {
    const ticker = String(c.ticker || /\/company\/([^/]+)/.exec(c['Screener URL'] || '')?.[1] || '').trim().toUpperCase();
    if (!/^[A-Z0-9&._-]{1,80}$/.test(ticker)) { unresolved.push(c.name || c.Company || ticker || 'Unnamed company'); continue; }
    const identity = announcements ? identityIndex.find({ ...c, ticker }) : null;
    const sourceTicker = c.announcementTicker || (identity && filingTicker(identity.ticker || identity.bseSymbol));
    const key = announcements ? identityIndex.key({ ...c, ticker }) || filingTicker(ticker) : ticker;
    if (!seen.has(key)) seen.set(key, { ticker, name: c.name || c.Company || ticker,
      ...(sourceTicker ? { announcementTicker: sourceTicker } : {}),
      ...(identity ? { isin: identity.isin } : {}), priority: !!c.priority });
  }
  return { companies: [...seen.values()], unresolved: [...new Set(unresolved)] };
}

/** Bounded, restartable capture. Dependencies are injectable for offline failure/recovery tests. */
export async function captureCompanySources({ dir, companies, unresolved = [], portfolio = null, registration = null, identitySources = null, request, now = Date.now,
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
  if (portfolio) index.portfolio = portfolio;
  if (registration) index.registration = registration;
  if (identitySources) index.identitySources = identitySources;
  index.requestedFrom = from;
  index.requestedTo = to;
  index.lastRunAt = new Date(start).toISOString();
  index.scope = 'Active shared portfolio, enrolled company identities, universe and technicals. Watchlist membership stays on the reader’s device.';
  const companyByTicker = new Map(companies.map(company => [company.ticker, company]));
  for (const kind of ['announcements', 'domestic']) {
    const entries = index.sources[kind] ||= {};
    for (const entry of Object.values(entries)) entry.priority = false;
    for (const { ticker, priority, announcementTicker } of companies) {
      if (!entries[ticker]) entries[ticker] = { rowCount: 0, ranges: [], registeredAt: new Date(start).toISOString() };
      else entries[ticker].registeredAt ||= index.createdAt;
      entries[ticker].priority = !!priority;
      const queryTicker = kind === 'announcements' ? announcementTicker || ticker : ticker;
      if (entries[ticker].queryTicker && entries[ticker].queryTicker !== queryTicker) {
        entries[ticker].nextRetryAt = null;
        entries[ticker].failureCount = 0;
        entries[ticker].recentCheckedAt = null;
      }
      entries[ticker].queryTicker = queryTicker;
    }
  }
  // Fair across restarts. A failure is attempted again, but does not starve companies that have
  // never been reached. Nothing is sliced out of the declared universe to meet a run's budget.
  const queue = Object.entries(index.sources).flatMap(([kind, entries]) =>
    Object.entries(entries).filter(([ticker]) => wanted.has(ticker)).map(([ticker, entry]) => ({ kind, ticker, entry,
      company: companyByTicker.get(ticker) })))
    .filter(({ kind, entry }) => kind !== 'domestic' || !entry.lastSuccessAt || entry.error || now() - Date.parse(entry.lastSuccessAt) >= 86400000)
    .filter(({ entry }) => !entry.nextRetryAt || Date.parse(entry.nextRetryAt) <= now() || !Number.isFinite(Date.parse(entry.nextRetryAt)))
    .sort((a, b) => {
      const rank = job => !job.entry.lastAttemptAt ? 0 : job.entry.error ? 1 :
        job.kind === 'announcements' && job.entry.priority ? 2 : job.kind === 'announcements' ? 3 : 4;
      return rank(a) - rank(b) || (a.entry.lastAttemptAt || '').localeCompare(b.entry.lastAttemptAt || '');
    });
  // Reserve two of every three starts for announcements, one for domestic reports. A large
  // announcement universe must not starve reports (or let reports consume the backfill budget).
  const announcements = queue.filter(job => job.kind === 'announcements');
  const domestic = queue.filter(job => job.kind === 'domestic');
  let lane = 0;
  const takeJob = () => {
    const prefer = lane++ % 3 === 2 ? domestic : announcements;
    const other = prefer === domestic ? announcements : domestic;
    if (prefer[0]?.entry.lastAttemptAt && other[0] && !other[0].entry.lastAttemptAt) return other.shift();
    return prefer.shift() || other.shift();
  };
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
    while (!stop) {
      const job = takeJob();
      if (!job || !await reserve() || stop) return;
      const { kind, ticker, entry, company } = job;
      const range = kind === 'announcements' ? nextRange(entry, from, to, now()) : null;
      entry.lastAttemptAt = new Date(now()).toISOString();
      try {
        const result = await request(kind, ticker, range, company);
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
        entry.failureCount = 0;
        entry.nextRetryAt = null;
        if (range) {
          entry.ranges = mergeRanges(entry.ranges || [], { from: range.from, to: range.to });
          if (range.recent) entry.recentCheckedAt = entry.lastAttemptAt;
          if (range.recheck) entry.recheckBefore = shift(range.from, -1);
        }
      } catch (error) {
        // Never persist request headers or raw errors which could contain credentials.
        entry.error = { reason: error.reason || 'upstream', message: error.message || 'Source could not be read', at: entry.lastAttemptAt };
        entry.failureCount = Math.min(10, (Number(entry.failureCount) || 0) + 1);
        const delay = Math.min(24 * 3600000, Math.max(2 * 3600000 * 2 ** (entry.failureCount - 1), Number(error.retryAfterMs) || 0));
        entry.nextRetryAt = new Date(now() + delay).toISOString();
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
