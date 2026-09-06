#!/usr/bin/env node
// Scheduled metadata enrichment; public access only. Every run resolves the active book.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { loadCapturePortfolio } from './lib/capture-portfolio.mjs';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';
import { mergeExchangeIdentities } from '../public/js/data/announcement-identity.js';
import { commitCompanyNewsArchive, readCompanyNewsIndex, observedCompanyArticles,
  recentArchivedCompanyNews, articlesFromNewsSnapshot, companyNewsArchiveRows } from './lib/company-news-archive.mjs';
import { tradingViewTargets, readTradingViewNews, tradingViewPageUrl } from './lib/tradingview-news.mjs';

const DATA = fileURLToPath(new URL('../public/data/', import.meta.url));

export async function enrichTradingViewNews({ dataDir = DATA, portfolio = null, fetcher = fetch,
  isolated = false, now = Date.now(), budgetMs = (isolated ? 8 : 6) * 60000, spacingMs = 1250, maxRequests = Infinity,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now,
  checkpointEvery = 20, onProgress = () => {} } = {}) {
  // The frequent lane owns a separate write set, including its verified portfolio checkpoint.
  // It never waits behind, or overwrites, the much slower company-name/global searches.
  const archivePrefix = isolated ? 'tradingview-news' : 'company-news';
  const dir = join(dataDir, archivePrefix), statePath = join(dir, 'tradingview.json');
  const book = portfolio || await loadCapturePortfolio(dataDir, { fetcher,
    ...(isolated ? { cachePath: join(dir, 'portfolio.json') } : {}) });
  if (!Array.isArray(book.holdings) || !book.holdings.length) throw Error('No verified portfolio; refusing to infer exits from an empty book.');
  const overrides = readJson(fileURLToPath(new URL('./company-news-identity-overrides.json', import.meta.url)), {}).entities || [];
  const entities = portfolioNewsEntities(book.holdings, overrides);
  const nse = readJson(join(dataDir, 'filing-capture/nse-identities.json'), {}).directories || {};
  const directory = mergeExchangeIdentities(readJson(join(dataDir, 'announcement-identities.json'), {}).entries || [],
    nse.sme?.entries || [], nse.equity?.entries || []);
  const headPath = isolated ? join(dir, 'latest.json') : join(dataDir, 'news.json');
  const index = readCompanyNewsIndex(dir), head = readJson(headPath, {});
  const legacy = isolated ? readJson(join(dataDir, 'company-news/tradingview.json'), {}) : {};
  const state = readJson(statePath, { ...legacy, version: 1, entries: legacy.entries || {} });
  const targets = tradingViewTargets(entities, directory, { nseEntries: [...(nse.sme?.entries || []), ...(nse.equity?.entries || [])],
    previousEntries: state.entries });
  const at = new Date(now).toISOString(), started = clock(), deadline = started + budgetMs;
  const captureNow = () => now + clock() - started;
  const active = new Set(entities.map(e => e.entityId));
  for (const entry of Object.values(state.entries)) entry.active = false;
  const jobs = targets.flatMap(({ entity, symbols }) => symbols.map(symbol => {
    const key = `${entity.entityId}|${symbol}`;
    const entry = state.entries[key] ||= { registeredAt: at };
    Object.assign(entry, { active: true, entityId: entity.entityId, company: entity.name, symbol, pageUrl: tradingViewPageUrl(symbol) });
    return { entity, symbol, issuerSymbols: symbols, entry };
  })).sort((a, b) => String(a.entry.lastAttemptAt || '').localeCompare(String(b.entry.lastAttemptAt || '')) || a.symbol.localeCompare(b.symbol));
  // A newly enrolled holding may already have identity-less rows in the legacy universe head.
  // Its exact bucket is an observation too; archive it before rebuilding the recent view.
  const incoming = articlesFromNewsSnapshot(head, entities, head.capturedAt || at);
  if (isolated && !index.createdAt) incoming.push(...companyNewsArchiveRows(join(dataDir, 'company-news')).filter(r => r.tradingViewId));
  let attempted = 0, retainedThisRun = 0;
  const checkpoint = () => {
    // Archive bytes before success watermarks. Atomic JSON writes preserve the last checkpoint
    // on termination; checkpoints never certify the unfinished head as a complete capture.
    commitCompanyNewsArchive({ dir, entities, articles: incoming, archivePrefix,
      capturedAt: isolated ? new Date(captureNow()).toISOString() : index.updatedAt || at });
    incoming.length = 0;
    writeJson(statePath, state);
    onProgress({ attempted, retainedThisRun });
  };
  for (const { entity, symbol, issuerSymbols, entry } of jobs) {
    if (attempted >= maxRequests || clock() > deadline - 17000 || Date.parse(state.blockedUntil || '') > captureNow()) break;
    if (Date.parse(entry.nextRetryAt || '') > captureNow()) continue;
    if (attempted) await sleep(spacingMs);
    if (clock() > deadline - 17000) break;
    attempted++;
    const observedMs = captureNow(), observedAt = new Date(observedMs).toISOString();
    entry.lastAttemptAt = observedAt;
    try {
      const result = await readTradingViewNews(symbol, { fetcher, now: observedMs, issuerSymbols, clock, sleep });
      incoming.push(...observedCompanyArticles(result.articles, entity, symbol, observedAt));
      retainedThisRun += result.articles.length;
      // The public page returns a bounded latest window without a next cursor. Record what it
      // exposed, not a claim that a private/history endpoint has been exhausted. A missed overlap
      // remains a gap even on later successful polls; only explicit recovery can clear it.
      const previous = Date.parse(entry.lastSuccessAt || '');
      const overlapFrom = (Number.isFinite(previous) ? previous : observedMs) - 48 * 3600000;
      const missedOverlap = result.limited && (!result.oldestReturnedAt || Date.parse(result.oldestReturnedAt) > overlapFrom);
      if (missedOverlap) entry.possibleGapSince ||= entry.lastSuccessAt || entry.registeredAt;
      Object.assign(entry, { lastReadAt: observedAt, lastResultCount: result.returned,
        retainedCount: result.articles.length, restrictedCount: result.restricted,
        invalidCount: result.invalid, undatedCount: result.undated, untaggedCount: result.untagged,
        publicWindowLimited: result.limited, oldestReturnedAt: result.oldestReturnedAt,
        error: result.invalid || result.undated || result.untagged ? 'partial-metadata' : null,
        failureCount: 0, nextRetryAt: null });
      if (!entry.error) entry.lastSuccessAt = observedAt;
      state.blockedUntil = null;
    } catch (error) {
      entry.error = Number.isInteger(error.status) ? `http-${error.status}` :
        ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout' : 'source-unavailable';
      entry.failureCount = (entry.failureCount || 0) + 1;
      const delay = error.retryAfterMs || ([404, 422].includes(error.status) ? 86400000 : Math.min(3600000, 300000 * 2 ** Math.min(entry.failureCount - 1, 4)));
      entry.nextRetryAt = new Date(captureNow() + delay).toISOString();
      if ([401, 403, 429].includes(error.status)) {
        // A refusal is not a reason to try another account, region, endpoint or company.
        state.blockedUntil = new Date(captureNow() + (error.retryAfterMs || (error.status === 429 ? 3600000 : 86400000))).toISOString();
        break;
      }
    }
    if (attempted % checkpointEvery === 0) checkpoint();
  }
  const finishedMs = captureNow(), finishedAt = new Date(finishedMs).toISOString();
  const entries = jobs.map(job => job.entry);
  const unresolved = targets.filter(t => !t.symbols.length).map(t => ({ entityId: t.entity.entityId, company: t.entity.name, reason: t.reason }));
  const staleAfterMinutes = isolated ? 45 : 240;
  const stale = entries.filter(e => e.error || !e.lastSuccessAt || finishedMs - Date.parse(e.lastSuccessAt) > staleAfterMinutes * 60000);
  const coverage = { checkedAt: finishedAt, activeCompanies: entities.length, mappedCompanies: targets.length - unresolved.length,
    plannedSymbols: jobs.length, attemptedSymbols: attempted, staleOrFailedSymbols: stale.length,
    unresolvedCompanies: unresolved.length, possibleGapSymbols: entries.filter(e => e.possibleGapSince).length,
    limitedHistorySymbols: entries.filter(e => e.publicWindowLimited).length,
    restrictedHeadlines: entries.reduce((sum, e) => sum + (e.restrictedCount || 0), 0),
    retainedThisRun, blockedUntil: state.blockedUntil || null, staleAfterMinutes,
    oldestSuccessAt: entries.length && entries.every(e => e.lastSuccessAt) ? entries.map(e => e.lastSuccessAt).sort()[0] : null,
    targetIntervalMinutes: isolated ? 15 : 180,
    portfolioStatus: book.portfolio?.status || 'injected', portfolioError: book.portfolio?.error || null,
    note: 'Public headline metadata only. Latest-page coverage is bounded; history, restricted headlines and all-source completeness are not guaranteed.' };
  // Archive before acknowledging source success. A failed/empty response never deletes a row.
  // Keep the core query-health clock separate from this independent source's observations.
  const archive = commitCompanyNewsArchive({ dir, entities, articles: incoming, capturedAt: isolated ? finishedAt : index.updatedAt || at, archivePrefix });
  const byTicker = { ...head.byTicker };
  const entityById = new Map(entities.map(e => [e.entityId, e]));
  const recent = new Map();
  const from = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  for (const row of recentArchivedCompanyNews(dir, from)) {
    const entity = entityById.get(row.entityId);
    if (entity) { if (!recent.has(entity.key)) recent.set(entity.key, []); recent.get(entity.key).push(row); }
  }
  for (const entity of entities) {
    if (recent.has(entity.key)) byTicker[entity.key] = recent.get(entity.key);
    else delete byTicker[entity.key];
  }
  const identities = new Map((head.entities || []).map(e => [e.entityId, { ...e, portfolio: active.has(e.entityId) }]));
  for (const entity of entities) identities.set(entity.entityId, entity);
  writeJson(headPath, { ...head, ...(isolated ? { capturedAt: finishedAt, generator: 'scripts/enrich-tradingview-news.mjs', retention: 'permanent-archive' } : {}),
    byTicker, entities: [...identities.values()],
    newsUpdatedAt: finishedAt, tradingViewCoverage: coverage,
    rowCount: Object.values(byTicker).reduce((n, rows) => n + rows.length, 0),
    empty: (head.empty || []).filter(key => !byTicker[key]?.length),
    archive: { ...head.archive, index: `${archivePrefix}/index.json`, articleCount: archive.articleCount, months: archive.archive.length } });
  writeJson(statePath, { ...state, version: 1, checkedAt: finishedAt, unresolved, coverage });
  return coverage;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await enrichTradingViewNews({ isolated: process.argv.includes('--isolated') });
  console.log(JSON.stringify(result));
  if (result.staleOrFailedSymbols || result.unresolvedCompanies || result.possibleGapSymbols || result.portfolioError)
    console.log('::warning::TradingView enrichment has coverage limits; retained news is preserved. See its tradingview.json checkpoint.');
}
