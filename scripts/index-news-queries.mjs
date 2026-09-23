#!/usr/bin/env node
// Add optional query accelerators locally. Index-only mode keeps existing source part bytes;
// --repartition can regroup their transport. Both preserve source values, timestamps and order.
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { shardSpec, shardPath, parseShard } from '../public/js/core/json-shards.js';
import { newsQueryIndexRow, NEWS_QUERY_INDEX_VERSION } from '../public/js/data/news-query-index.js';
import { readNewsJson, writeNewsJson } from './lib/news-json-storage.mjs';
const digest = body => createHash('sha256').update(body).digest('hex');
const files = ['public/data/news.json', ...['company-news', 'tradingview-news'].flatMap(family =>
  readdirSync(`public/data/${family}`).filter(name => /^(\d{4}-\d{2}|undated|latest)\.json$/.test(name)).map(name => `public/data/${family}/${name}`))];
if (process.argv.includes('--repartition')) {
  if (!process.argv.includes('--write')) throw Error('Repartitioning requires --write');
  for (const path of files) {
    const value = readNewsJson(path);
    if (value) writeNewsJson(path, value);
  }
  console.log(`Verified date-grouped reconstruction for ${files.length} captures.`);
  process.exit(0);
}
const plan = [];
for (const path of files) {
  const value = JSON.parse(readFileSync(path)), spec = shardSpec(value);
  if (!spec) continue;
  const bucketRows = spec.field === 'byTicker' ? Object.fromEntries(Object.keys(value.byTicker).map(key => [key, 0])) : null;
  const indexes = [], previous = spec.parts.flatMap(part => part.queryIndex ? [shardPath(path, part.queryIndex.file)] : []);
  for (const part of spec.parts) {
    const original = readFileSync(shardPath(path, part.file));
    if (original.byteLength !== part.bytes || digest(original) !== part.sha256) throw Error(`Unverified source part: ${path}`);
    const rows = parseShard(original.toString(), part);
    if (bucketRows) for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || !Object.hasOwn(bucketRows, row[0])) throw Error('Unknown news bucket');
      bucketRows[row[0]]++;
    }
    const body = `${JSON.stringify({ items: rows.map(row => newsQueryIndexRow(spec.field === 'byTicker' ? row[1] : row)) })}\n`;
    const sha256 = digest(body), file = `${dirname(part.file)}/${sha256}.json`;
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) continue;
    part.queryIndex = { version: NEWS_QUERY_INDEX_VERSION, sourceSha256: part.sha256,
      file, sha256, bytes: Buffer.byteLength(body), rows: rows.length };
    indexes.push({ path: shardPath(path, file), body });
  }
  if (bucketRows) spec.bucketRows = bucketRows;
  shardSpec(value);
  plan.push({ path, value, indexes, previous });
}
if (process.argv.includes('--write')) for (const { path, value, indexes, previous } of plan) {
  for (const index of indexes) writeFileSync(index.path, index.body);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  const keep = new Set(indexes.map(index => index.path));
  for (const old of previous) if (!keep.has(old)) { try { unlinkSync(old); } catch(error) { if(error.code !== 'ENOENT') throw error; } }
}
console.log(JSON.stringify({ written: process.argv.includes('--write'), captures: plan.length,
  indexes: plan.reduce((sum,p) => sum+p.indexes.length,0), bytes: plan.reduce((sum,p)=>sum+p.indexes.reduce((n,i)=>n+Buffer.byteLength(i.body),0),0) }));
