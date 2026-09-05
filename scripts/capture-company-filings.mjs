#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCompanies, captureCompanySources } from './lib/company-capture.mjs';
import { loadCapturePortfolio } from './lib/capture-portfolio.mjs';
import { refreshNseIdentities } from './lib/nse-identities.mjs';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { loadCaptureRegistrations } from './lib/capture-registrations.mjs';

const dataDir = fileURLToPath(new URL('../public/data/', import.meta.url));
const base = (process.env.FILINGS_BASE || 'https://sattva-central-research.tech-441.workers.dev').replace(/\/+$/, '');
const [active, nseIdentities, registered] = await Promise.all([loadCapturePortfolio(dataDir), refreshNseIdentities(dataDir), loadCaptureRegistrations(dataDir)]);
const scope = captureCompanies(dataDir, { announcements: true, holdings: active.holdings, registrations: registered.companies });
if (active.portfolio.error) console.warn(active.portfolio.error);
if (registered.registration.error) console.warn(registered.registration.error);
const result = await captureCompanySources({
  dir: resolve(dataDir, 'filing-capture'), ...scope, portfolio: active.portfolio, registration: registered.registration,
  identitySources: Object.fromEntries(Object.entries(nseIdentities.directories).map(([key, { checkedAt, error }]) => [key, { checkedAt, error }])),
  budgetMs: Number(process.env.COMPANY_CAPTURE_BUDGET_MS || 20 * 60000),
  request: async (kind, ticker, range, company) => {
    const query = kind === 'domestic' ? 'form=all' : `fromDate=${range.from.replaceAll('-', '')}&toDate=${range.to.replaceAll('-', '')}`;
    const path = kind === 'domestic' ? 'domestic-filings' : 'announcements';
    const sourceTicker = kind === 'announcements' ? company?.announcementTicker || ticker : ticker;
    const response = await fetch(`${base}/api/${path}/${encodeURIComponent(sourceTicker)}?${query}`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const retryAfterMs = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Math.max(0, Date.parse(retry || '') - Date.now());
      await response.body?.cancel();
      throw Object.assign(new Error(`Source proxy returned HTTP ${response.status}`), { reason: [401, 403].includes(response.status) ? 'unauthorised' : 'upstream', retryAfterMs });
    }
    return boundedJson(response, 8 * 1024 * 1024);
  },
  onProgress: ({ kind, ticker, count, error }) => console.log(`${count}: ${kind}/${ticker}: ${error ? error.reason : 'saved'}`),
});
console.log(`Checkpoint saved for ${scope.companies.length} companies; ${result.requests} requests this run.`);
