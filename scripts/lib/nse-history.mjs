// Daily static assets retain every captured filing without growing one unbounded JSON download.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { capturedRows, filingDay, mergeFilings } from '../../public/js/data/nse-history-shared.js';

const read = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;

export function archiveNseFilings(dataDir, captures) {
  const dir = join(dataDir, 'nse-filings');
  const indexPath = join(dir, 'index.json');
  const previous = read(indexPath, { days: [] });
  const index = new Map(previous.days.map((entry) => [entry.day, entry]));
  const grouped = new Map();
  for (const row of mergeFilings(...captures.map(capturedRows))) {
    const day = filingDay(row.publishedAt) || 'undated';
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push(row);
  }
  mkdirSync(dir, { recursive: true });
  for (const [day, fresh] of grouped) {
    const path = join(dir, `${day}.json`);
    const old = read(path, { rows: [] });
    const rows = mergeFilings(old.rows, fresh);
    const content = JSON.stringify({ day, rows }) + '\n';
    const revision = createHash('sha256').update(content).digest('hex').slice(0, 16);
    if (index.get(day)?.revision !== revision) writeFileSync(path, content);
    index.set(day, { day, count: rows.length, revision });
  }
  const times = [previous.capturedAt, ...captures.map((capture) => capture?.capturedAt)]
    .filter((time) => Number.isFinite(Date.parse(time || ''))).sort();
  const days = [...index.values()].sort((a, b) => b.day.localeCompare(a.day));
  const payload = {
    version: 1,
    note: 'Filings retained from successful NSE captures, not a complete exchange history. Dates are IST. Undated notices are kept separately.',
    capturedAt: times.at(-1) || null,
    count: days.reduce((sum, entry) => sum + entry.count, 0),
    days,
  };
  // Write the index last so it never advertises a shard that has not been written.
  writeFileSync(indexPath, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}
