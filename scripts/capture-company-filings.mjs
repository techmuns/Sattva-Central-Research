#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCompanies, captureCompanySources } from './lib/company-capture.mjs';

const dataDir = fileURLToPath(new URL('../public/data/', import.meta.url));
const base = (process.env.FILINGS_BASE || 'https://sattva-central-research.tech-441.workers.dev').replace(/\/+$/, '');
const scope = captureCompanies(dataDir);
const result = await captureCompanySources({
  dir: resolve(dataDir, 'filing-capture'), ...scope,
  budgetMs: Number(process.env.COMPANY_CAPTURE_BUDGET_MS || 20 * 60000),
  request: async (kind, ticker, range) => {
    const query = kind === 'domestic' ? 'form=all' : `fromDate=${range.from.replaceAll('-', '')}&toDate=${range.to.replaceAll('-', '')}`;
    const path = kind === 'domestic' ? 'domestic-filings' : 'announcements';
    const response = await fetch(`${base}/api/${path}/${encodeURIComponent(ticker)}?${query}`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw Object.assign(new Error(`Source proxy returned HTTP ${response.status}`), { reason: [401, 403].includes(response.status) ? 'unauthorised' : 'upstream' });
    return response.json();
  },
  onProgress: ({ kind, ticker, count, error }) => console.log(`${count}: ${kind}/${ticker}: ${error ? error.reason : 'saved'}`),
});
console.log(`Checkpoint saved for ${scope.companies.length} companies; ${result.requests} requests this run.`);
