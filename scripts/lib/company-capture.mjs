import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { announcementSourceUrls, announcementSources, mergeAnnouncements } from '../../public/js/data/announcements-shared.js';
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

function resetSourceCoverage(entry) {
  Object.assign(entry, { ranges: [], lastAttemptAt: null, lastSuccessAt: null,
    lastResponseAt: null, recentCheckedAt: null, recheckBefore: null, nextRetryAt: null,
    failureCount: 0, error: null, skipped: 0, unavailableLinks: 0,
    declared: null, collected: null, pages: null, requests: null });
}

function purgeProviderEvidence(dir, ticker, provider, keepSource) {
  const path = join(dir, companyPath('announcements', ticker));
  const saved = readJson(path, null);
  if (!Array.isArray(saved?.rows)) return { changed: false, removed: 0 };
  let changed = false, removed = 0;
  const rows = [];
  for (const row of saved.rows) {
    if (!(row.providers || []).includes(provider)) { rows.push(row); continue; }
    changed = true;
    const providers = (row.providers || []).filter(value => value !== provider);
    if (!providers.length) { removed++; continue; }
    const allSources = announcementSources(row);
    let sources = allSources.filter(keepSource);
    let sourceUrls = announcementSourceUrls(row).filter(item => keepSource(item.source));
    // Another independent provider still proves this record. If its exchange cannot be inferred
    // from the merged fields, retain that provider's source rather than deleting its evidence.
    const fellBackToOtherProvider = !sources.length;
    if (fellBackToOtherProvider) sources = allSources;
    if (!sourceUrls.length && sources.some(source => allSources.includes(source))) {
      sourceUrls = announcementSourceUrls(row).filter(item => sources.includes(item.source));
    }
    const next = { ...row, providers, sources, source: sources.join(' / '), sourceUrls,
      url: sourceUrls[0]?.url || (fellBackToOtherProvider ? row.url : null) };
    delete next.crossExchangeDocumentId;
    // A paired row can retain its original per-exchange observations for later ambiguity checks.
    // Once one provider's identity is corrected, those observations are stale evidence and must
    // not be allowed to restore the provider half that was just removed.
    delete next.crossExchangeObservations;
    if (!sources.includes('BSE')) {
      for (const field of ['scripCode', 'newsId', 'headline', 'category', 'subCategory', 'critical']) delete next[field];
    }
    rows.push(next);
  }
  if (changed) writeJson(path, { ...saved, rows });
  return { changed, removed };
}

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
      announcementTicker: identity ? filingTicker(identity.ticker || identity.bseSymbol) : filingTicker(c.ticker),
      ...(identity?.bseCode ? { bseCode: String(identity.bseCode) } : {}), priority: true };
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
    const bseCode = String(identity?.bseCode || c.bseCode || '');
    const key = announcements ? identityIndex.key({ ...c, ticker }) || filingTicker(ticker) : ticker;
    if (!seen.has(key)) seen.set(key, { ticker, name: c.name || c.Company || ticker,
      ...(sourceTicker ? { announcementTicker: sourceTicker } : {}),
      ...(identity ? { isin: identity.isin } : {}),
      ...(/^\d{6}$/.test(bseCode) ? { bseCode } : {}), priority: !!c.priority });
  }
  return { companies: [...seen.values()], unresolved: [...new Set(unresolved)] };
}

/** Bounded, restartable capture. Dependencies are injectable for offline failure/recovery tests. */
export async function captureCompanySources({ dir, companies, unresolved = [], portfolio = null, registration = null, identitySources = null, request, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), budgetMs = 20 * 60000,
  spacingMs = 2500, concurrency = 3, backfillDays = 365, maxRequests = Infinity,
  prepareAnnouncements = null, expandAnnouncements = null, onProgress = () => {} }) {
  if (prepareAnnouncements && (typeof prepareAnnouncements !== 'function' || typeof expandAnnouncements !== 'function')) {
    throw new TypeError('Announcement preparation requires its source-observation expander.');
  }
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
    for (const { ticker, priority, announcementTicker, bseCode } of companies) {
      if (!entries[ticker]) entries[ticker] = { rowCount: 0, ranges: [], registeredAt: new Date(start).toISOString() };
      else entries[ticker].registeredAt ||= index.createdAt;
      entries[ticker].priority = !!priority;
      const queryTicker = kind === 'announcements' ? announcementTicker || ticker : ticker;
      if (entries[ticker].queryTicker && entries[ticker].queryTicker !== queryTicker) {
        // Coverage belongs to the exact upstream identity. Retain the evidence already captured,
        // but remove that provider's attribution and make the corrected symbol prove every
        // historical window again. Independently captured direct-BSE evidence survives.
        const purged = purgeProviderEvidence(dir, ticker, 'Muns corporate announcements', source => source === 'BSE');
        if (purged.changed) {
          const saved = readJson(join(dir, companyPath('announcements', ticker)), { rows: [] });
          entries[ticker].rowCount = saved.rows.length;
          entries[ticker].fileRevision = (Number(entries[ticker].fileRevision) || 0) + 1;
        }
        resetSourceCoverage(entries[ticker]);
      }
      entries[ticker].queryTicker = queryTicker;
      if (kind === 'announcements') {
        const bse = entries[ticker].bse ||= { rowCount: 0, ranges: [], registeredAt: new Date(start).toISOString() };
        bse.registeredAt ||= entries[ticker].registeredAt || index.createdAt;
        const suppliedCode = /^\d{6}$/.test(String(bseCode || '')) ? String(bseCode) : null;
        const retainedCode = /^\d{6}$/.test(String(bse.bseCode || '')) ? String(bse.bseCode) : null;
        const code = suppliedCode || retainedCode;
        if (suppliedCode && retainedCode && retainedCode !== suppliedCode) {
          // A changed issuer code invalidates both its watermark and every record attributed only
          // to that direct collector. Removing those rows is safer than displaying another
          // issuer's filing; reset Muns coverage too so any merged NSE evidence is recovered.
          const purged = purgeProviderEvidence(dir, ticker, 'BSE company index', source => source !== 'BSE');
          resetSourceCoverage(bse);
          bse.rowCount = 0;
          if (purged.changed) {
            const saved = readJson(join(dir, companyPath('announcements', ticker)), { rows: [] });
            entries[ticker].rowCount = saved.rows.length;
            entries[ticker].fileRevision = (Number(entries[ticker].fileRevision) || 0) + 1;
            resetSourceCoverage(entries[ticker]);
          }
        }
        bse.bseCode = code;
      }
    }
  }
  const retryDue = (entry) => !entry?.nextRetryAt || Date.parse(entry.nextRetryAt) <= now() || !Number.isFinite(Date.parse(entry.nextRetryAt));
  const hasBseSource = (entry) => /^\d{6}$/.test(String(entry?.bse?.bseCode || ''));
  const independentBseAvailable = Object.entries(index.sources.announcements)
    .some(([ticker, entry]) => wanted.has(ticker) && hasBseSource(entry) && retryDue(entry.bse));
  // Fair across restarts. A failure is attempted again, but does not starve companies that have
  // never been reached. Nothing is sliced out of the declared universe to meet a run's budget.
  const queue = Object.entries(index.sources).flatMap(([kind, entries]) =>
    Object.entries(entries).filter(([ticker]) => wanted.has(ticker)).map(([ticker, entry]) => ({ kind, ticker, entry,
      company: companyByTicker.get(ticker) })))
    .filter(({ kind, entry }) => kind !== 'domestic' || !entry.lastSuccessAt || entry.error || now() - Date.parse(entry.lastSuccessAt) >= 86400000)
    .filter(({ kind, entry }) => kind === 'announcements'
      ? retryDue(entry) || hasBseSource(entry) && retryDue(entry.bse)
      : retryDue(entry))
    .sort((a, b) => {
      const pendingStates = (job) => job.kind === 'announcements'
        ? [retryDue(job.entry) ? job.entry : null, hasBseSource(job.entry) && retryDue(job.entry.bse) ? job.entry.bse : null].filter(Boolean)
        : [job.entry];
      const rank = job => pendingStates(job).some(entry => !entry.lastAttemptAt) ? 0 : pendingStates(job).some(entry => entry.error) ? 1 :
        job.kind === 'announcements' && job.entry.priority ? 2 : job.kind === 'announcements' ? 3 : 4;
      const priority = job => job.kind === 'announcements' && job.entry.priority ? 0 : 1;
      const oldest = job => pendingStates(job).map(entry => entry.lastAttemptAt || '').sort()[0] || '';
      return rank(a) - rank(b) || priority(a) - priority(b) || oldest(a).localeCompare(oldest(b));
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
  let count = 0, stop = false, authFailedThisRun = false, legacySucceededThisRun = false;
  let gate = Promise.resolve(), nextStart = start;
  const checkpoint = () => { index.updatedAt = new Date(now()).toISOString(); writeJson(indexPath, index); };
  const sourceError = (value, fallback = 'Unrecognized source response') => {
    if (value instanceof Error) return value;
    return Object.assign(new Error(value?.message || fallback), {
      reason: value?.reason || 'shape', retryAfterMs: value?.retryAfterMs,
    });
  };
  const failSource = (entry, error, attemptedAt) => {
    // Never persist request headers or raw errors which could contain credentials.
    entry.error = { reason: error.reason || 'upstream', message: error.message || 'Source could not be read', at: attemptedAt };
    entry.failureCount = Math.min(10, (Number(entry.failureCount) || 0) + 1);
    const delay = Math.min(24 * 3600000, Math.max(2 * 3600000 * 2 ** (entry.failureCount - 1), Number(error.retryAfterMs) || 0));
    entry.nextRetryAt = new Date(now() + delay).toISOString();
  };
  const completeSource = (entry, result, range, attemptedAt) => {
    entry.skipped = result.skipped || 0;
    entry.unavailableLinks = result.unavailableLinks || 0;
    entry.lastResponseAt = result.fetchedAt || attemptedAt;
    for (const field of ['declared', 'collected', 'pages', 'requests']) {
      if (Number.isFinite(result[field]) && result[field] >= 0) entry[field] = result[field];
    }
    if (entry.skipped) {
      failSource(entry, new Error(`${entry.skipped} source entries could not be parsed; captured rows retained, window remains incomplete.`), attemptedAt);
      return false;
    }
    entry.lastSuccessAt = attemptedAt;
    entry.error = null;
    entry.failureCount = 0;
    entry.nextRetryAt = null;
    if (range) {
      entry.ranges = mergeRanges(entry.ranges || [], { from: range.from, to: range.to });
      if (range.recent) entry.recentCheckedAt = attemptedAt;
      if (range.recheck) entry.recheckBefore = shift(range.from, -1);
    }
    return true;
  };
  const hashStats = (result, attemptedAt, status = 'ok') => {
    const stats = { at: attemptedAt, status };
    for (const field of ['eligible', 'candidatePairs', 'ambiguous', 'fetched', 'downloaded', 'failed',
      'deferredPairs', 'deferredDownloads', 'nextPairOffset', 'failedPairs', 'hashed', 'reused', 'compared', 'matched', 'different']) {
      if (Number.isSafeInteger(result?.[field]) && result[field] >= 0) stats[field] = result[field];
    }
    return stats;
  };
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
      const range = kind === 'announcements' && retryDue(entry) ? nextRange(entry, from, to, now()) : null;
      const bseRange = kind === 'announcements' && hasBseSource(entry) && retryDue(entry.bse)
        ? nextRange(entry.bse, from, to, now()) : null;
      const attemptedAt = new Date(now()).toISOString();
      if (kind === 'domestic' || range) entry.lastAttemptAt = attemptedAt;
      if (bseRange) entry.bse.lastAttemptAt = attemptedAt;
      try {
        const result = await request(kind, ticker, range, company, {
          bseRange, bseCode: bseRange ? entry.bse.bseCode : null,
        });
        if (kind === 'announcements') {
          const sources = [
            ...(range ? [{ state: entry, range, result }] : []),
            ...(bseRange ? [{ state: entry.bse, range: bseRange, result: result?.bse, bse: true }] : []),
          ];
          const incoming = [], readable = [];
          let responseAt = null, legacyAuth = false;
          for (const source of sources) {
            const sourceRows = source.result?.announcements;
            if (source.result?.ok !== true || !Array.isArray(sourceRows)) {
              const error = sourceError(source.result);
              failSource(source.state, error, attemptedAt);
              if (!source.bse && ['no-token', 'unauthorised'].includes(error.reason)) {
                legacyAuth = true;
                authFailedThisRun = true;
              }
              continue;
            }
            if (source.bse) {
              const validCount = value => Number.isSafeInteger(value) && value >= 0;
              const result = source.result;
              const validPagination = validCount(result.declared) && validCount(result.collected)
                && result.declared === result.collected && result.collected === sourceRows.length
                && Number.isSafeInteger(result.pages) && result.pages > 0
                && Number.isSafeInteger(result.requests) && result.requests >= result.pages;
              if (!validPagination) {
                failSource(source.state, Object.assign(new Error('Official BSE pagination metadata is incomplete.'), { reason: 'shape' }), attemptedAt);
                incoming.push(...sourceRows);
                readable.push({ ...source, incomplete: true });
                responseAt = [responseAt, source.result.fetchedAt].filter(Boolean).sort().at(-1) || attemptedAt;
                continue;
              }
            }
            if (!source.bse) legacySucceededThisRun = true;
            incoming.push(...sourceRows);
            readable.push(source);
            responseAt = [responseAt, source.result.fetchedAt].filter(Boolean).sort().at(-1) || attemptedAt;
          }
          if (readable.length) {
            const path = join(dir, companyPath(kind, ticker));
            const previous = readJson(path, { rows: [] });
            const clean = incoming.map(({ raw, ...row }) => ({ ...row, ticker }));
            // Re-expand a stored pair before merging fresh rows so repeat observations update the
            // correct exchange constituent. Otherwise top-level merged metadata would replace the
            // source observations used for re-clustering and silently disappear after enrichment.
            const retained = prepareAnnouncements ? expandAnnouncements(previous.rows) : previous.rows;
            let rows = mergeAnnouncements(retained, clean);
            // Save the source records and their independent completion states before optional PDF
            // comparison. A slow or interrupted enrichment can never lose an exchange response or
            // make the next run repeat an already completed source window.
            writeJson(path, { ticker, kind, rows, fetchedAt: responseAt || attemptedAt });
            entry.rowCount = rows.length;
            entry.fileRevision = (Number(entry.fileRevision) || 0) + 1;
            entry.bse.rowCount = rows.filter(row => (row.providers || []).includes('BSE company index')).length;
            for (const source of readable) if (!source.incomplete) completeSource(source.state, source.result, source.range, attemptedAt);
            checkpoint();
            let preparation = null;
            if (prepareAnnouncements) {
              try {
                const result = await prepareAnnouncements(rows, { ticker,
                  pairOffset: Number.isSafeInteger(entry.documentHashes?.nextPairOffset) ? entry.documentHashes.nextPairOffset : 0 });
                const priorLinks = new Set(rows.flatMap(row => announcementSourceUrls(row)
                  .map(item => `${item.source}|${item.url}`)));
                const preparedLinks = new Set((result?.rows || []).flatMap(row => announcementSourceUrls(row)
                  .map(item => `${item.source}|${item.url}`)));
                // Reconsidering a stored BSE/NSE pair can safely expand one displayed row back to
                // its two source observations. Reject shrinkage, malformed rows and any result
                // that loses an exchange link from the durable pre-enrichment checkpoint.
                const validRows = Array.isArray(result?.rows) && result.rows.length >= rows.length
                  && result.rows.every(row => row && typeof row === 'object' && row.ticker === ticker)
                  && [...priorLinks].every(link => preparedLinks.has(link));
                if (!validRows) throw new Error('Invalid prepared announcement rows');
                rows = mergeAnnouncements(result.rows);
                preparation = hashStats(result, attemptedAt);
              } catch {
                // Document comparison is enrichment. A blocked or malformed PDF leaves exchange
                // records separate and cannot turn a successful source read into a failed window.
                preparation = hashStats(null, attemptedAt, 'unavailable');
              }
            }
            // A successful enrichment replaces the raw copy atomically; otherwise this rewrites
            // the same already-durable rows while retaining the source response.
            writeJson(path, { ticker, kind, rows, fetchedAt: responseAt || attemptedAt });
            entry.rowCount = rows.length;
            entry.fileRevision = (Number(entry.fileRevision) || 0) + 1;
            entry.bse.rowCount = rows.filter(row => (row.providers || []).includes('BSE company index')).length;
            if (preparation) entry.documentHashes = preparation;
          }
          // An expiring authenticated source must not discard a successful official BSE read made
          // by the same company job. Stop only after its rows and coverage checkpoint are durable.
          if (legacyAuth && !independentBseAvailable) stop = true;
        } else {
          const incoming = result.documents;
          if (result.ok !== true || !Array.isArray(incoming)) throw sourceError(result);
          const path = join(dir, companyPath(kind, ticker));
          const previous = readJson(path, { rows: [] });
          const clean = incoming.map(({ raw, ...row }) => ({ ...row, ticker }));
          const rows = mergeDocuments(previous.rows, clean);
          // Write the rows before their checkpoint: a crash can cause a harmless re-read, never a
          // watermark pointing past documents that were not saved.
          writeJson(path, { ticker, kind, rows, fetchedAt: result.fetchedAt || attemptedAt });
          entry.rowCount = rows.length;
          completeSource(entry, result, null, attemptedAt);
        }
      } catch (error) {
        if (kind === 'domestic' || range) failSource(entry, error, attemptedAt);
        if (bseRange) failSource(entry.bse, error, attemptedAt);
        if (['no-token', 'unauthorised'].includes(error.reason)) {
          if (kind === 'announcements') authFailedThisRun = true;
          if (!independentBseAvailable) stop = true;
        }
      }
      checkpoint();
      onProgress({ kind, ticker, count, error: entry.error, bseAttempted: !!bseRange, bseError: entry.bse?.error || null });
    }
  }));
  index.lastRunFinishedAt = new Date(now()).toISOString();
  index.requests = count;
  index.stoppedForAuth = authFailedThisRun;
  index.sourceOutages ||= {};
  if (authFailedThisRun) index.sourceOutages.authenticatedAnnouncements = {
    reason: 'unauthorised', at: index.lastRunFinishedAt,
  };
  else if (legacySucceededThisRun) delete index.sourceOutages.authenticatedAnnouncements;
  if (!Object.keys(index.sourceOutages).length) delete index.sourceOutages;
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
