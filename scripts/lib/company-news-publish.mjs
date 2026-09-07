// Semantic reconciliation of captured data only. No Git/network calls; the source directory is
// immutable. Used by the normal publisher's disposable worktree and reviewed local PR recovery.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compactObservations } from '../compact-news-data.mjs';
import { readNewsJson, writeNewsJson } from './news-json-storage.mjs';

const instant = value => Number.isFinite(Date.parse(value || '')) ? Date.parse(value) : -Infinity;
const latest = (...values) => values.filter(value => Number.isFinite(instant(value))).sort((a, b) => instant(b) - instant(a))[0] || null;
const earliest = (...values) => values.filter(value => Number.isFinite(instant(value))).sort((a, b) => instant(a) - instant(b))[0] || null;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ordered = (a, b, field) => instant(a?.[field]) > instant(b?.[field]) ? [b, a] : [a, b];

function reconcileIdentity(current, captured, baseline) {
  if (!current || !captured || !baseline) return current || captured;
  // Reviewed main changes win field-by-field. If main left a field untouched, the live-book
  // capture may legitimately supply a newly listed ticker/name or expanded query identity.
  const fields = [...new Set([...Object.keys(current), ...Object.keys(captured), ...Object.keys(baseline)])];
  return Object.fromEntries(fields.flatMap(field => {
    const mainChanged = Object.hasOwn(current, field) !== Object.hasOwn(baseline, field) || !isDeepStrictEqual(current[field], baseline[field]);
    const owner = mainChanged ? current : captured;
    return Object.hasOwn(owner, field) ? [[field, owner[field]]] : [];
  }));
}

export function mergeQueryCheckpoint(a = {}, b = {}, baseline = {}) {
  const [older, newer] = ordered(a, b, 'lastAttemptAt');
  const result = { ...older, ...newer };
  for (const field of ['lastSuccessAt', 'lastReconciledAt']) {
    const value = latest(a[field], b[field]);
    if (value) result[field] = value;
  }
  // The newest attempt owns its failure, range and result; an old success cannot clear it.
  // Only baseline-known pending work can be cleared by a verified later partition result.
  // A broad range envelope does not prove a branch-divergent pending interval was searched.
  if (Array.isArray(a.pending) || Array.isArray(b.pending)) {
    const range = newer.range || {};
    const baselinePending = new Set((baseline.pending || []).map(part => JSON.stringify(part)));
    const verifiedResult = instant(newer.lastAttemptAt) > instant(baseline.lastAttemptAt) &&
      Array.isArray(newer.pending) && ((!newer.error && instant(newer.lastSuccessAt) >= instant(newer.lastAttemptAt)) ||
        newer.error === 'incomplete-discovery');
    const stillPending = (older.pending || []).filter(part => !(verifiedResult &&
      baselinePending.has(JSON.stringify(part)) && range.from <= part.from && range.to >= part.to));
    result.pending = [...new Map([...(newer.pending || []), ...stillPending].map(part => [JSON.stringify(part), part])).values()];
    if (result.pending.length && !result.error) result.error = 'incomplete-discovery';
  }
  // coveredThrough belongs to a successful interval, not simply to the latest attempted range.
  const [, successful] = ordered(a, b, 'lastSuccessAt');
  if (successful.coveredThrough) result.coveredThrough = successful.coveredThrough;
  return result;
}

function mergeCheckMap(a = {}, b = {}, baseline = {}) {
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map(key =>
    [key, mergeQueryCheckpoint(a[key], b[key], baseline[key])]));
}

function loadCapture(dir) {
  const head = readNewsJson(join(dir, 'news.json'));
  if (!object(head?.byTicker) || !Number.isFinite(instant(head?.capturedAt))) throw Error('Company-news head is missing or invalid');
  for (const rows of Object.values(head.byTicker)) if (!Array.isArray(rows)) throw Error('Company-news bucket is invalid');
  const index = readNewsJson(join(dir, 'company-news/index.json'));
  if (!Array.isArray(index?.archive) || !Array.isArray(index.entities) || !object(index.queries)) throw Error('Company-news index is missing or invalid');
  const months = new Map();
  for (const descriptor of index.archive) {
    if (!/^company-news\/(?:\d{4}-\d{2}|undated)\.json$/.test(descriptor.file || '')) throw Error('Invalid company-news archive path');
    const body = readNewsJson(join(dir, descriptor.file));
    if (!Array.isArray(body?.articles) || body.articles.length !== descriptor.count) throw Error('Company-news archive is incomplete');
    months.set(descriptor.file, body);
  }
  const discoveryPath = join(dir, 'company-news/discovery.json');
  const discovery = existsSync(discoveryPath) ? readNewsJson(discoveryPath) : null;
  if (discovery && (!object(discovery.queries) || !object(discovery.pages) || !object(discovery.documents))) throw Error('Invalid discovery checkpoints');
  return { head, index, months, discovery };
}

/** Keep every distinct content record, including later corrections at the same publisher URL. */
export function mergeCaptureData(sourceDir, targetDir, { baselineIndex = null, baselineDiscovery = null } = {}) {
  if (realpathSync(sourceDir) === realpathSync(targetDir)) throw Error('Capture source must be separate from the publication target');
  // Read and verify every source/target part before writing any output. Neither a truncated
  // artifact nor a missing main-branch shard may be silently treated as an empty archive.
  const source = loadCapture(sourceDir), target = loadCapture(targetDir);
  const [olderHead, newerHead] = ordered(target.head, source.head, 'capturedAt');
  const bucket = (head, key) => Object.hasOwn(head.byTicker, key) ? head.byTicker[key] : [];
  const combinedHead = Object.fromEntries([...new Set([...Object.keys(target.head.byTicker), ...Object.keys(source.head.byTicker)])].sort().map(key =>
    [key, compactObservations([...bucket(newerHead, key), ...bucket(olderHead, key)])]));
  // The capture can read a genuinely newer live book, while main can independently add or
  // remove a holding. Resolve membership against the immutable capture-start registry; exits
  // on either branch win over an unchanged old membership, and new memberships survive.
  // Recovery without that baseline must not invent authority: target's active book wins.
  const reviewed = new Map(target.index.entities.map(entity => [entity.entityId, entity]));
  const captured = new Map(source.index.entities.map(entity => [entity.entityId, entity]));
  const baselineEntities = new Map((baselineIndex?.entities || []).map(entity => [entity.entityId, entity]));
  const baselineIds = new Set((baselineIndex?.entities || []).map(entity => entity.entityId));
  const active = baselineIndex ? new Set([...new Set([...reviewed.keys(), ...captured.keys()])].filter(id =>
    !baselineIds.has(id) || reviewed.has(id) && captured.has(id))) : new Set(reviewed.keys());
  const entities = [...active].map(id => reconcileIdentity(reviewed.get(id), captured.get(id), baselineEntities.get(id)))
    .sort((a, b) => String(a.entityId).localeCompare(String(b.entityId)));
  const historical = new Map([...(source.index.historicalEntities || []), ...(target.index.historicalEntities || []),
    ...source.index.entities, ...target.index.entities].map(entity => [entity.entityId, entity]));
  const identitiesByKey = new Map([...historical.values()].flatMap(entity => [entity.key, entity.ticker].filter(Boolean).map(key => [key, entity])));
  const queries = Object.fromEntries([...new Set([...Object.keys(target.index.queries), ...Object.keys(source.index.queries)])].sort()
    .map(key => [key, mergeCheckMap(target.index.queries[key], source.index.queries[key], baselineIndex?.queries?.[key])]));
  const outputs = [], headArchive = new Map();
  // Preserve every head observation in permanent history before deriving the rolling first
  // paint. This includes captured universe companies that have not been portfolio holdings.
  for (const [key, records] of Object.entries(combinedHead)) for (const row of records) {
    const known = identitiesByKey.get(key);
    const retained = { ...row, entityId: row.entityId || known?.entityId || `ticker:${key}`,
      ticker: Object.hasOwn(row, 'ticker') ? row.ticker : known ? known.ticker : /^ISIN:/i.test(key) ? null : key };
    const month = /^(\d{4}-\d{2})/.exec(row.publishedAt || row.date || '')?.[1] || 'undated';
    const file = `company-news/${month}.json`;
    if (!headArchive.has(file)) headArchive.set(file, []);
    headArchive.get(file).push(retained);
  }
  const from = /^\d{4}-\d{2}-\d{2}$/.test(newerHead.from || '') ? newerHead.from
    : new Date(instant(newerHead.capturedAt) - 30 * 86400000).toISOString().slice(0, 10);
  const byTicker = Object.fromEntries(Object.entries(combinedHead).map(([key, rows]) =>
    [key, rows.filter(row => !(row.date || row.publishedAt) || String(row.date || row.publishedAt).slice(0, 10) >= from)]));
  const archive = [...new Set([...target.months.keys(), ...source.months.keys(), ...headArchive.keys()])].sort().reverse().map(file => {
    const a = target.months.get(file), b = source.months.get(file);
    const articles = compactObservations([...(a?.articles || []), ...(b?.articles || []), ...(headArchive.get(file) || [])]);
    const dates = articles.map(row => row.publishedAt || row.date || row.firstSeenAt).filter(Boolean).sort();
    const body = { ...(a || b), month: file.split('/').at(-1).replace('.json', ''),
      articles, articleCount: articles.length, from: dates[0] || null, to: dates.at(-1) || null };
    for (const field of ['capturedAt', 'updatedAt']) {
      const headClock = headArchive.has(file) ? latest(target.head.capturedAt, source.head.capturedAt,
        ...(field === 'updatedAt' ? [target.head.newsUpdatedAt, source.head.newsUpdatedAt] : [])) : null;
      if (a?.[field] || b?.[field] || headClock) body[field] = latest(a?.[field], b?.[field], headClock);
    }
    outputs.push([file, body]);
    return { month: file.split('/').at(-1).replace('.json', ''), file, count: articles.length, from: body.from, to: body.to };
  });
  const articleCount = archive.reduce((count, part) => count + part.count, 0);
  const updatedAt = latest(target.index.updatedAt, source.index.updatedAt);
  const index = { ...target.index, createdAt: earliest(target.index.createdAt, source.index.createdAt), updatedAt,
    entities, historicalEntities: [...historical.values()].filter(entity => !active.has(entity.entityId)), queries, archive, articleCount };
  let discovery = target.discovery || source.discovery;
  if (target.discovery && source.discovery) {
    const [older, newer] = ordered(target.discovery.coverage, source.discovery.coverage, 'capturedAt');
    discovery = { ...target.discovery, ...source.discovery,
      queries: mergeCheckMap(target.discovery.queries, source.discovery.queries, baselineDiscovery?.queries),
      pages: mergeCheckMap(target.discovery.pages, source.discovery.pages, baselineDiscovery?.pages),
      documents: mergeCheckMap(target.discovery.documents, source.discovery.documents, baselineDiscovery?.documents),
      coverage: { ...older, ...newer } };
  }
  if (discovery) {
    const at = discovery.coverage?.capturedAt;
    const activeKeys = entities.flatMap(entity => (entity.queries || []).map(query => `${entity.entityId}|ALL|${query}`));
    const stale = activeKeys.filter(key => {
      const checkpoint = discovery.queries[key];
      return !checkpoint?.lastSuccessAt || checkpoint.error || checkpoint.pending?.length ||
        instant(checkpoint.lastAttemptAt) > instant(checkpoint.lastSuccessAt) || instant(at) - instant(checkpoint.lastSuccessAt) > 86400000;
    }).length;
    const pageKeys = entities.flatMap(entity => (entity.officialPages || []).map(page => `${entity.entityId}|${page}`));
    const pagesFailed = pageKeys.filter(key => !discovery.pages[key]?.lastSuccessAt || discovery.pages[key]?.error ||
      instant(discovery.pages[key]?.lastAttemptAt) > instant(discovery.pages[key]?.lastSuccessAt)).length;
    const documents = new Map(outputs.flatMap(([, body]) => body.articles || []).filter(row => row.discoverySource === 'official-ir')
      .map(row => [row.url, row]));
    const readDocuments = new Set(outputs.flatMap(([, body]) => body.articles || []).filter(row => row.articleBody).map(row => row.url));
    const documentsPending = [...documents.keys()].filter(url => !readDocuments.has(url)).length;
    discovery = { ...discovery, coverage: { ...discovery.coverage, plannedQueries: activeKeys.length,
      staleOrIncompleteQueries: stale, pagesFailed, documentsPending } };
    outputs.push(['company-news/discovery.json', discovery]);
  }
  const rowCount = Object.values(byTicker).reduce((count, rows) => count + rows.length, 0);
  const empty = [...new Set([...(newerHead.empty || []), ...(olderHead.empty || [])])].filter(key => !byTicker[key]?.length).sort();
  const capturedPlan = new Set((newerHead.entities || []).flatMap(entity => (entity.queries || []).map(query => `${entity.entityId}|${query}`)));
  for (const key of newerHead.queryCoverage?.publicationUnverifiedQueryKeys || []) capturedPlan.delete(key);
  const unverifiedActiveQueryKeys = entities.flatMap(entity => (entity.queries || []).map(query => ({ entity, query })))
    .filter(({ entity, query }) => {
      // Failures in the capture's original plan are already counted. Only reconciliation-only
      // additions extend that plan; do not count the same failed provider query twice.
      if (capturedPlan.has(`${entity.entityId}|${query}`)) return false;
      const checkpoint = queries[entity.entityId]?.[query];
      return !checkpoint?.lastSuccessAt || checkpoint.error || checkpoint.pending?.length ||
        instant(checkpoint.lastAttemptAt) > instant(checkpoint.lastSuccessAt);
    }).map(({ entity, query }) => `${entity.entityId}|${query}`);
  const unverifiedActiveQueries = unverifiedActiveQueryKeys.length;
  const queryCoverage = { ...newerHead.queryCoverage };
  // A reconciled active book may contain new aliases never included in the capture's counts.
  // Preserve source clocks/counts, but never certify those unverified additions as complete.
  const priorPublicationUnverified = Number(queryCoverage.publicationUnverifiedQueries || 0);
  if (unverifiedActiveQueries || priorPublicationUnverified) {
    queryCoverage.planned = Number(queryCoverage.planned || 0) - priorPublicationUnverified + unverifiedActiveQueries;
    queryCoverage.failed = Number(queryCoverage.failed || 0) - priorPublicationUnverified + unverifiedActiveQueries;
    queryCoverage.publicationUnverifiedQueries = unverifiedActiveQueries;
    queryCoverage.publicationUnverifiedQueryKeys = unverifiedActiveQueryKeys;
  }
  const head = { ...olderHead, ...newerHead, byTicker, entities, empty, emptyCount: empty.length, queryCoverage,
    from, rowCount, withRows: Object.values(byTicker).filter(rows => rows.length).length,
    covered: Object.values(byTicker).filter(rows => rows.length).length + empty.length,
    portfolioEntities: entities.length, tickerlessPortfolioEntities: entities.filter(entity => !entity.ticker).length,
    archive: { ...newerHead.archive, index: 'company-news/index.json', articleCount, months: archive.length },
    newsUpdatedAt: latest(target.head.newsUpdatedAt, source.head.newsUpdatedAt, updatedAt, target.head.capturedAt, source.head.capturedAt),
    ...(discovery?.coverage ? { enrichmentCoverage: discovery.coverage } : {}) };
  outputs.push(['company-news/index.json', index], ['news.json', head]);
  for (const [file, body] of outputs) writeNewsJson(join(targetDir, file), body);
  return { capturedAt: head.capturedAt, newsUpdatedAt: head.newsUpdatedAt, headRows: rowCount, archiveRows: articleCount,
    months: archive.length, entities: entities.length, queryEntities: Object.keys(queries).length };
}
