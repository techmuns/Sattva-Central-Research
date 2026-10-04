#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCompanies, captureCompanySources } from './lib/company-capture.mjs';
import { loadCapturePortfolio } from './lib/capture-portfolio.mjs';
import { refreshNseIdentities } from './lib/nse-identities.mjs';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { loadCaptureRegistrations } from './lib/capture-registrations.mjs';
import { collectBseCompanyAnnouncements } from './lib/bse-collection.mjs';
import { enrichCrossExchangeDocumentHashes, expandCrossExchangeObservations } from './lib/announcement-document-hashes.mjs';
import { createScreenerCompanyFallback, companySourceTicker, screenerCompanyResponse } from './lib/screener-company-filings.mjs';

const dataDir = fileURLToPath(new URL('../public/data/', import.meta.url));
const base = (process.env.FILINGS_BASE || 'https://sattva-central-research.tech-441.workers.dev').replace(/\/+$/, '');
const [active, nseIdentities, registered] = await Promise.all([loadCapturePortfolio(dataDir), refreshNseIdentities(dataDir), loadCaptureRegistrations(dataDir)]);
const scope = captureCompanies(dataDir, { announcements: true, holdings: active.holdings, registrations: registered.companies });
if (active.portfolio.error) console.warn(active.portfolio.error);
if (registered.registration.error) console.warn(registered.registration.error);

const retryAfter = (response) => {
  const value = response.headers.get('retry-after');
  return /^\d+$/.test(value || '') ? Number(value) * 1000 : Math.max(0, Date.parse(value || '') - Date.now());
};
const failed = (error) => ({
  ok: false,
  reason: error?.reason || 'upstream',
  message: String(error?.message || 'Source could not be read').slice(0, 300),
  ...(Number.isFinite(Number(error?.retryAfterMs)) ? { retryAfterMs: Number(error.retryAfterMs) } : {}),
});
let proxyAuthFailure = null;
const announcementHashCache = new Map();
const screenerCompany = createScreenerCompanyFallback();
async function proxyRequest(kind, ticker, range, company) {
  if (proxyAuthFailure) throw Object.assign(new Error(proxyAuthFailure.message), proxyAuthFailure);
  const query = kind === 'domestic' ? 'form=all' : `fromDate=${range.from.replaceAll('-', '')}&toDate=${range.to.replaceAll('-', '')}`;
  const path = kind === 'domestic' ? 'domestic-filings' : 'announcements';
  const sourceTicker = companySourceTicker(company || { ticker });
  const response = await fetch(`${base}/api/${path}/${encodeURIComponent(sourceTicker)}?${query}`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    const retryAfterMs = retryAfter(response);
    await response.body?.cancel();
    const error = Object.assign(new Error(`Source proxy returned HTTP ${response.status}`), {
      reason: [401, 403].includes(response.status) ? 'unauthorised' : 'upstream', retryAfterMs,
    });
    if (error.reason === 'unauthorised') proxyAuthFailure = failed(error);
    throw error;
  }
  const result = await boundedJson(response, 8 * 1024 * 1024);
  if (result?.ok === false && ['no-token', 'unauthorised'].includes(result.reason)) proxyAuthFailure = failed(result);
  return result;
}
async function companyRequest(kind, ticker, range, company) {
  const primary = await proxyRequest(kind, ticker, range, company);
  if (primary?.ok !== false || primary.reason !== 'not-found') return primary;
  try {
    const page = await screenerCompany(company);
    return screenerCompanyResponse(page, kind, primary);
  } catch (error) {
    return { ...primary, reason: 'company-fallback', message: `${primary.message || 'Primary provider has no company feed'}; fallback: ${error.message}`.slice(0, 300) };
  }
}
async function bseRequest(bseCode, range) {
  const result = await collectBseCompanyAnnouncements(
    { scripCode: bseCode, from: range.from, to: range.to },
    { fetchImpl: fetch },
  );
  const announcements = result.rows.map(row => ({ ...row, title: row.headline, source: 'BSE', sources: ['BSE'],
    providers: ['BSE company index'] }));
  return { ok: true, announcements, fetchedAt: new Date().toISOString(), skipped: 0,
    unavailableLinks: announcements.filter(row => !row.url).length,
    declared: result.declared, collected: result.collected, pages: result.pages, requests: result.requests };
}

const result = await captureCompanySources({
  dir: resolve(dataDir, 'filing-capture'), ...scope, portfolio: active.portfolio, registration: registered.registration,
  identitySources: Object.fromEntries(Object.entries(nseIdentities.directories).map(([key, { checkedAt, error }]) => [key, { checkedAt, error }])),
  budgetMs: Number(process.env.COMPANY_CAPTURE_BUDGET_MS || 20 * 60000),
  prepareAnnouncements: (rows, { pairOffset } = {}) => enrichCrossExchangeDocumentHashes(rows, {
    cache: announcementHashCache, pairOffset,
  }),
  expandAnnouncements: expandCrossExchangeObservations,
  request: async (kind, ticker, range, company, { bseRange, bseCode } = {}) => {
    if (kind === 'domestic') return companyRequest(kind, ticker, range, company);
    // Both reads settle before the company checkpoint is handled. A failed authenticated proxy
    // cannot discard a successful official BSE read, and a BSE outage cannot freeze NSE/Muns rows.
    const [legacy, bse] = await Promise.allSettled([
      range ? companyRequest(kind, ticker, range, company) : null,
      bseRange && bseCode ? bseRequest(bseCode, bseRange) : null,
    ]);
    return {
      ...(range ? legacy.status === 'fulfilled' ? legacy.value : failed(legacy.reason) : {}),
      ...(bseRange ? { bse: bse.status === 'fulfilled' ? bse.value : failed(bse.reason) } : {}),
    };
  },
  onProgress: ({ kind, ticker, count, error, bseAttempted, bseError }) => console.log(
    `${count}: ${kind}/${ticker}: ${error ? error.reason : 'saved'}${bseAttempted ? `; BSE ${bseError ? bseError.reason : 'saved'}` : ''}`,
  ),
});
console.log(`Checkpoint saved for ${scope.companies.length} companies; ${result.requests} requests this run.`);
