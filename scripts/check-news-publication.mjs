#!/usr/bin/env node
// Read-only, end-to-end publication check. Never dispatches, deploys, retries or repairs a job.
import { readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hydrateJsonShards } from '../public/js/core/json-shards.js';

const PATHS = ['news.json', 'tradingview-news/latest.json', 'market-news.json'];
const revision = value => Math.max(...[value?.capturedAt, value?.newsUpdatedAt, value?.enrichmentCoverage?.capturedAt]
  .map(at => Date.parse(at || '') || 0));

export async function checkNewsPublication({ dataDir, base, fetcher = fetch, now = Date.now() }) {
  const findings = [], sources = [];
  for (const path of PATHS) {
    try {
      const expected = JSON.parse(readFileSync(join(dataDir, path), 'utf8'));
      const url = new URL(`data/${path}`, base.endsWith('/') ? base : `${base}/`).href;
      const response = await fetcher(url, { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Error('snapshot-unavailable');
      const raw = await response.json();
      if (!revision(raw) || revision(raw) > now + 600000) throw Error('snapshot-time-invalid');
      if (revision(raw) < revision(expected)) throw Error('capture-not-published');
      // The same decoder used by the dashboard checks every referenced byte and record count.
      const value = await hydrateJsonShards(raw, url, { fetcher });
      const rows = value.byTicker ? Object.values(value.byTicker).reduce((n, list) => n + list.length, 0) : value.articles?.length;
      if (!Number.isSafeInteger(rows)) throw Error('snapshot-shape-invalid');
      sources.push({ path, capturedAt: value.capturedAt, rows, completeTransport: true });
    } catch (error) {
      const code = ['snapshot-unavailable', 'snapshot-time-invalid', 'capture-not-published', 'snapshot-shape-invalid'].includes(error.message)
        ? error.message : 'snapshot-or-part-unreadable';
      findings.push({ path, code });
    }
  }
  return { checkedAt: new Date(now).toISOString(), ok: !findings.length, sources, findings,
    note: 'Publication integrity only. Source completeness and capture cadence have independent health checks.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const waitMs = Math.min(8 * 60000, Math.max(0, Number(process.env.PUBLICATION_WAIT_MS || 0)));
  const until = Date.now() + waitMs;
  let report;
  do {
    report = await checkNewsPublication({ dataDir: fileURLToPath(new URL('../public/data/', import.meta.url)),
      base: process.env.NEWS_PUBLICATION_BASE || 'https://sattva-central-research.tech-441.workers.dev' });
    if (report.ok || Date.now() >= until || report.findings.some(f => f.code !== 'capture-not-published')) break;
    console.log('Awaiting normal Git publication; no production action is requested.');
    await new Promise(resolve => setTimeout(resolve, Math.min(30000, until - Date.now())));
  } while (true);
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## News delivery to customers\n\n${report.ok ? 'Published captures and all referenced parts verified.' : 'Publication incomplete; customer data is not confirmed current.'}\n\n${report.findings.map(f => `- ${f.path}: ${f.code}`).join('\n')}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
