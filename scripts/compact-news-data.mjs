#!/usr/bin/env node
// Offline representation maintenance only: no source requests, timestamps or retention changes.
import { existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { anonymousArticleContentKey } from '../public/js/data/filings-shared.js';
import { readNewsJson, writeNewsJson } from './lib/news-json-storage.mjs';

function writeVerified(path, value) {
  writeNewsJson(path, value);
  if (!isDeepStrictEqual(readNewsJson(path), value)) throw Error('News compaction changed retained records');
}

/** Only identical source content collapses. Different titles, bodies, dates or links survive. */
export function compactObservations(rows) {
  if (!Array.isArray(rows)) throw Error('News observations must be an array');
  const found = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('News observation must be an object');
    for (const field of ['firstSeenAt', 'lastSeenAt']) if (row[field] != null && row[field] !== '' &&
      (typeof row[field] !== 'string' || !Number.isFinite(Date.parse(row[field])))) throw Error(`Invalid observation ${field}`);
    if (row.query != null && typeof row.query !== 'string') throw Error('Invalid observation query');
    if (row.matchedQueries != null && (!Array.isArray(row.matchedQueries) || row.matchedQueries.some(value => typeof value !== 'string')))
      throw Error('Invalid observation matchedQueries');
    const key = anonymousArticleContentKey(row);
    const held = found.get(key);
    if (!held) { found.set(key, { ...row }); continue; }
    for (const field of ['firstSeenAt', 'lastSeenAt']) {
      const values = [held[field], row[field]].filter(value => typeof value === 'string' && value);
      // Preserve the original timestamp strings, but compare instants rather than lexicographic
      // spellings: +05:30 and Z observations must not invert the first/last range.
      if (values.length) held[field] = values.sort((a, b) => Date.parse(a) - Date.parse(b))[field === 'firstSeenAt' ? 0 : values.length - 1];
    }
    const queries = [...new Set([...(held.matchedQueries || []), held.query,
      ...(row.matchedQueries || []), row.query].filter(value => typeof value === 'string' && value))];
    if (queries.length) held.matchedQueries = queries;
    if (!held.query && row.query) held.query = row.query;
  }
  return [...found.values()];
}

export function compactNewsData(dataDir, { write = false } = {}) {
  const reports = [], planned = [];
  const indexPath = join(dataDir, 'company-news/index.json');
  const index = existsSync(indexPath) ? readNewsJson(indexPath) : null;
  const paths = ['news.json', ...(index?.archive || []).map(shard => shard.file)];
  for (const relative of paths) {
    if (relative !== 'news.json' && !/^company-news\/(?:\d{4}-\d{2}|undated)\.json$/.test(relative)) throw Error('Invalid company-news archive path');
    const path = join(dataDir, relative);
    if (!existsSync(path)) { if (relative !== 'news.json') throw Error('Company-news archive missing'); else continue; }
    const before = readNewsJson(path);
    let after, oldCount, newCount;
    if (!before || typeof before !== 'object' || Array.isArray(before)) throw Error('Invalid news payload');
    if (relative === 'news.json') {
      if (!before.byTicker || typeof before.byTicker !== 'object' || Array.isArray(before.byTicker)) throw Error('News head has no company buckets');
      const byTicker = Object.fromEntries(Object.entries(before.byTicker).map(([key, rows]) => [key, compactObservations(rows)]));
      oldCount = Object.values(before.byTicker).reduce((n, rows) => n + rows.length, 0);
      newCount = Object.values(byTicker).reduce((n, rows) => n + rows.length, 0);
      after = { ...before, byTicker, ...(Object.hasOwn(before, 'rowCount') ? { rowCount: newCount } : {}) };
    } else {
      if (!Array.isArray(before.articles)) throw Error('Company-news archive has no articles');
      const articles = compactObservations(before.articles);
      oldCount = before.articles.length; newCount = articles.length;
      after = { ...before, articles, ...(Object.hasOwn(before, 'articleCount') ? { articleCount: newCount } : {}) };
    }
    const record = { file: relative, before: oldCount, after: newCount, duplicates: oldCount - newCount,
      bytesBefore: Buffer.byteLength(JSON.stringify(before)), bytesAfter: Buffer.byteLength(JSON.stringify(after)) };
    reports.push(record);
    if (write && record.duplicates) planned.push({ path, after });
  }
  // Validate every referenced head/month before writing any of them. A malformed later archive
  // cannot leave earlier files compacted with an unchanged index count.
  if (write) for (const { path, after } of planned) writeVerified(path, after);
  if (write && index) {
    const archive = index.archive.map(shard => ({ ...shard, count: reports.find(row => row.file === shard.file)?.after ?? shard.count }));
    const articleCount = archive.reduce((n, shard) => n + shard.count, 0);
    if (articleCount !== index.articleCount || archive.some((s, i) => s.count !== index.archive[i].count)) {
      writeVerified(indexPath, { ...index, archive, articleCount });
      const headPath = join(dataDir, 'news.json');
      const head = existsSync(headPath) ? readNewsJson(headPath) : null;
      if (head?.archive?.index === 'company-news/index.json') writeVerified(headPath, { ...head, archive: { ...head.archive, articleCount } });
    }
  }
  return reports;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const report = compactNewsData(fileURLToPath(new URL('../public/data/', import.meta.url)), { write });
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n## News storage efficiency — ${write ? 'maintenance' : 'read-only audit'}\n\n${report.map(r => `- ${r.file}: ${r.before} observations → ${r.after} distinct content records; ${r.duplicates} identical duplicates ${write ? 'compacted' : 'eligible for compaction'}.`).join('\n')}\n\n${write ? 'No distinct source content or observation range was removed. Source check times are unchanged.' : 'No files were changed. These counts describe possible savings, not completed maintenance.'}\n`);
}
