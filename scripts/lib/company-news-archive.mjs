// Permanent portfolio-company news capture.
//
// `public/data/news.json` remains the bounded, fast first paint. Every portfolio article is filed
// here before it can leave that head:
//
//   public/data/company-news/index.json       identities, query watermarks and shard manifest
//   public/data/company-news/YYYY-MM.json     every discovered article for that month
//   public/data/company-news/undated.json     source rows without a readable publication date
//
// A scheduled response is additive. An empty response says only that this overlapping poll found
// nothing; it never retracts an article captured earlier. Filtering and materiality do not appear
// in this module—the capture retains every usable row returned by every reviewed identity query.

import { join } from 'node:path';
import { canonicalArticleUrl } from '../../public/js/data/filings-shared.js';
import { readJson, writeJson } from './company-capture.mjs';

export const COMPANY_NEWS_ARCHIVE_VERSION = 1;
export const DEFAULT_OVERLAP_HOURS = 48;
export const DEFAULT_BACKFILL_DAYS = 30;

const clean = (value) => String(value || '').trim();
const iso = (value) => new Date(value).toISOString();
const day = (value) => iso(value).slice(0, 10);
const uniq = (values) => [...new Set((values || []).map(clean).filter(Boolean))];

const storyKey = (row) => row?.title && row?.source
  ? `${clean(row.date || row.publishedAt).slice(0, 10)} :: ${clean(row.source).toLowerCase()} :: ${clean(row.title).toLowerCase()}`
  : null;

export function companyArticleKey(row = {}) {
  const entity = clean(row.entityId) || `ticker:${clean(row.ticker).toUpperCase()}`;
  const url = row.url ? canonicalArticleUrl(row.url) : null;
  return `${entity}|${url ? `url:${url}` : `story:${storyKey(row) || JSON.stringify([row.date, row.title, row.source, row.summary])}`}`;
}

/** Merge observations without allowing an empty or smaller search response to retract history. */
export function mergeCompanyNewsArticles(previous = [], incoming = []) {
  const rows = [];
  const byUrl = new Map();
  const byStory = new Map();

  const add = (value) => {
    const row = { ...value };
    const entity = clean(row.entityId) || `ticker:${clean(row.ticker).toUpperCase()}`;
    if (!entity || entity === 'ticker:') throw new Error('A company-news article has no company identity.');
    row.entityId = entity;
    const urlKey = row.url ? `${entity}|${canonicalArticleUrl(row.url)}` : null;
    const headlineKey = storyKey(row) ? `${entity}|${storyKey(row)}` : null;
    const existingIndex = (urlKey && byUrl.get(urlKey)) ?? (headlineKey && byStory.get(headlineKey));
    if (existingIndex != null) {
      const existing = rows[existingIndex];
      const firstSeenAt = [existing.firstSeenAt, row.firstSeenAt].filter(Boolean).sort()[0] || null;
      const lastSeenAt = [existing.lastSeenAt, row.lastSeenAt].filter(Boolean).sort().at(-1) || null;
      const matchedQueries = uniq([
        ...(existing.matchedQueries || []), existing.query,
        ...(row.matchedQueries || []), row.query,
      ]);
      rows[existingIndex] = {
        ...existing,
        ...Object.fromEntries(Object.entries(row).filter(([, field]) => field !== null && field !== undefined && field !== '')),
        firstSeenAt,
        lastSeenAt,
        matchedQueries,
        query: existing.query || row.query || null,
      };
      if (urlKey) byUrl.set(urlKey, existingIndex);
      if (headlineKey) byStory.set(headlineKey, existingIndex);
      return;
    }
    const index = rows.length;
    row.matchedQueries = uniq([...(row.matchedQueries || []), row.query]);
    rows.push(row);
    if (urlKey) byUrl.set(urlKey, index);
    if (headlineKey) byStory.set(headlineKey, index);
  };

  previous.forEach(add);
  incoming.forEach(add);
  return rows.sort((a, b) => String(b.publishedAt || b.date || b.firstSeenAt || '').localeCompare(String(a.publishedAt || a.date || a.firstSeenAt || '')));
}

export function archiveMonth(row) {
  const value = clean(row.publishedAt || row.date || row.firstSeenAt);
  return /^\d{4}-(0[1-9]|1[0-2])/.test(value) ? value.slice(0, 7) : 'undated';
}

const shardPath = (dir, month) => join(dir, `${month}.json`);

export function readCompanyNewsIndex(dir) {
  return readJson(join(dir, 'index.json'), {
    version: COMPANY_NEWS_ARCHIVE_VERSION,
    createdAt: null,
    updatedAt: null,
    overlapHours: DEFAULT_OVERLAP_HOURS,
    entities: [],
    queries: {},
    archive: [],
    articleCount: 0,
  });
}

export function readCompanyNewsShard(dir, month) {
  return readJson(shardPath(dir, month), { month, articles: [] });
}

export function companyNewsArchiveRows(dir) {
  const index = readCompanyNewsIndex(dir);
  return (index.archive || []).flatMap((item) => readCompanyNewsShard(dir, item.month).articles || []);
}

/**
 * File every supplied observation, then rewrite only the shards it touched.
 * Existing shards absent from this run are retained and remain in the manifest.
 */
export function commitCompanyNewsArchive({ dir, articles = [], entities = [], capturedAt = new Date().toISOString(), queries = null, overlapHours = DEFAULT_OVERLAP_HOURS }) {
  const previous = readCompanyNewsIndex(dir);
  const buckets = new Map();
  for (const row of articles) {
    const month = archiveMonth(row);
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month).push(row);
  }

  for (const [month, incoming] of buckets) {
    const saved = readCompanyNewsShard(dir, month);
    const merged = mergeCompanyNewsArticles(saved.articles || [], incoming);
    const dates = merged.map((row) => row.publishedAt || row.date || row.firstSeenAt).filter(Boolean).sort();
    writeJson(shardPath(dir, month), {
      _provenance:
        'Permanent portfolio-company news captured from reviewed company-name and alias searches. Headlines, standfirsts, outlets and dates are the publishers\' own. Rows are retained before topic, materiality or scope filters are applied. The article remains on the publisher site.',
      generator: 'scripts/lib/company-news-archive.mjs',
      month,
      articleCount: merged.length,
      from: dates[0] || null,
      to: dates.at(-1) || null,
      articles: merged,
    });
  }

  const known = new Set([...(previous.archive || []).map((item) => item.month), ...buckets.keys()]);
  const archive = [...known].map((month) => {
    const shard = readCompanyNewsShard(dir, month);
    return {
      month,
      file: `company-news/${month}.json`,
      count: (shard.articles || []).length,
      from: shard.from || null,
      to: shard.to || null,
    };
  }).sort((a, b) => b.month.localeCompare(a.month));

  const index = {
    ...previous,
    version: COMPANY_NEWS_ARCHIVE_VERSION,
    _provenance:
      'Permanent portfolio-company news archive. The entity registry covers every active portfolio company, including companies without an NSE ticker. Query watermarks produce overlapping incremental reads; successful empty reads never delete an earlier article.',
    generator: 'scripts/lib/company-news-archive.mjs',
    createdAt: previous.createdAt || capturedAt,
    updatedAt: capturedAt,
    overlapHours,
    entities,
    queries: queries || previous.queries || {},
    archive,
    articleCount: archive.reduce((sum, item) => sum + item.count, 0),
  };
  writeJson(join(dir, 'index.json'), index);
  return index;
}

/** A 48-hour overlap, expressed as inclusive calendar dates for the upstream contract. */
export function incrementalNewsRange(queryState, now = Date.now(), { overlapHours = DEFAULT_OVERLAP_HOURS, backfillDays = DEFAULT_BACKFILL_DAYS } = {}) {
  const last = Date.parse(queryState?.lastSuccessAt || '');
  const fromMs = Number.isFinite(last)
    ? last - overlapHours * 3600000
    : now - backfillDays * 86400000;
  return { from: day(fromMs), to: day(now), incremental: Number.isFinite(last) };
}

/** Attach the company identity and observation times before an article reaches any view filter. */
export function observedCompanyArticles(rows, entity, query, observedAt) {
  return (rows || [])
    .map(({ raw, ...row }) => ({
      ...row,
      ticker: entity.ticker || null,
      entityId: entity.entityId,
      company: entity.name,
      query: row.query || query,
      matchedQueries: uniq([...(row.matchedQueries || []), query]),
      firstSeenAt: row.firstSeenAt || observedAt,
      lastSeenAt: observedAt,
    }))
    .filter((row) => Object.entries(row).some(([key, value]) => !['query', 'matchedQueries', 'ticker', 'entityId', 'company', 'firstSeenAt', 'lastSeenAt'].includes(key) && value !== null && value !== undefined && value !== ''));
}

/** Seed the permanent store with portfolio rows already present in the legacy 30-day snapshot. */
export function articlesFromNewsSnapshot(snapshot, entities, observedAt = snapshot?.capturedAt || new Date().toISOString()) {
  const rows = [];
  for (const entity of entities) {
    const saved = snapshot?.byTicker?.[entity.key] || snapshot?.byTicker?.[entity.ticker] || [];
    rows.push(...observedCompanyArticles(saved, entity, entity.queries[0] || entity.name, observedAt));
  }
  return rows;
}

/** The bounded first-paint rows are derived from archive history, not used as its authority. */
export function recentArchivedCompanyNews(dir, from) {
  return companyNewsArchiveRows(dir).filter((row) => !row.date || row.date >= from);
}
