#!/usr/bin/env node
// Local representation migration only. No collection, timestamp updates or article filtering.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readNewsJson, writeNewsJson } from './lib/news-json-storage.mjs';
import { JSON_SHARD_BYTES, JSON_ASSET_LIMIT } from '../public/js/core/json-shards.js';

export function partitionNewsData(dataDir, { write = false } = {}) {
  const paths = ['news.json', 'tradingview-news/latest.json', 'market-news.json'];
  for (const family of ['company-news', 'tradingview-news', 'market-news']) {
    try { for (const name of readdirSync(join(dataDir, family))) {
      if (/^(\d{4}-\d{2}|undated)\.json$/.test(name)) paths.push(`${family}/${name}`);
    } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const reports = [];
  for (const relative of paths) {
    const path = join(dataDir, relative);
    let bytes;
    try { bytes = statSync(path).size; } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (bytes <= JSON_SHARD_BYTES) continue;
    const before = readNewsJson(path);
    if (write) {
      writeNewsJson(path, before);
      if (!isDeepStrictEqual(readNewsJson(path), before)) throw Error(`Record preservation failed: ${relative}`);
    }
    reports.push({ file: relative, bytesBefore: bytes, bytesAfter: statSync(path).size,
      rows: Object.values(before.byTicker || {}).reduce((n, rows) => n + rows.length, 0) || before.articles?.length || 0,
      verified: write });
  }
  return reports;
}

export function verifyAssetSizes(publicDir) {
  let files = 0;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        files++;
        if (statSync(path).size > JSON_ASSET_LIMIT) throw Error(`Static asset exceeds 25 MiB: ${path}`);
        if (entry.name.endsWith('.json') && !dir.endsWith('.parts')) {
          const raw = JSON.parse(readFileSync(path, 'utf8'));
          if (raw?._jsonShards) readNewsJson(path); // missing/corrupt parts fail the build too
        }
      }
    }
  }
  walk(publicDir);
  if (files > 20000) throw Error('Static assets exceed the configured free-plan file budget');
  return { files, ok: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  console.log(JSON.stringify(partitionNewsData(join(publicDir, 'data'), { write: process.argv.includes('--write') })));
  console.log(JSON.stringify(verifyAssetSizes(publicDir)));
}
