import { join } from 'node:path';
import { readJson, writeJson } from './company-capture.mjs';
import { mergeAnnouncements } from '../../public/js/data/announcements-shared.js';
import { mergeInsiderTrades } from '../../public/js/data/insider-history.js';

/** Preserve events before a recent snapshot applies its size/date window. No archive expiry. */
export function archiveFilings(dir, kind, rows) {
  const indexPath = join(dir, 'index.json');
  const index = readJson(indexPath, { version: 1, months: {} });
  const buckets = new Map();
  for (const { raw, ...row } of rows) {
    const month = /^\d{4}-(0[1-9]|1[0-2])-/.test(row.date || '') ? row.date.slice(0, 7) : 'undated';
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month).push(row);
  }
  for (const [month, incoming] of buckets) {
    const path = join(dir, `${month}.json`);
    const previous = readJson(path, { rows: [] });
    const merged = kind === 'insider' ? mergeInsiderTrades(previous.rows, incoming) : mergeAnnouncements(previous.rows, incoming);
    writeJson(path, { kind, rows: merged });
    index.months[month] = merged.length;
  }
  index.rowCount = Object.values(index.months).reduce((a, b) => a + b, 0);
  index.updatedAt = new Date().toISOString();
  writeJson(indexPath, index);
  return index;
}
