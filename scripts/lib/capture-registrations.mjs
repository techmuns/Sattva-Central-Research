import { join } from 'node:path';
import { boundedJson } from '../../public/js/data/family-book-contract.js';
import { registeredCompany, CAPTURE_REGISTRY_SHARDS, CAPTURE_REGISTRY_LIMIT } from '../../public/js/data/capture-registration-shared.js';
import { readJson, writeJson } from './company-capture.mjs';

export async function loadCaptureRegistrations(dataDir, { live = process.env.FAMILY_HOLDINGS_LIVE === 'true', fetcher = fetch,
  base = process.env.FILINGS_BASE || 'https://sattva-central-research.tech-441.workers.dev', now = Date.now } = {}) {
  const path = join(dataDir, 'filing-capture/registrations.json');
  const previous = readJson(path, { companies: [], checkedAt: null });
  let companies = [], checkedAt = null, error = null;
  try { companies = previous.companies.map(registeredCompany); checkedAt = previous.checkedAt; }
  catch { error = 'The saved company registration catalog is invalid; awaiting a fresh registry read.'; }
  if (live) {
    try {
      const response = await fetcher(`${base.replace(/\/+$/, '')}/api/capture-registration`, { signal: AbortSignal.timeout(20000), cache: 'no-store', redirect: 'error' });
      const body = await boundedJson(response, 1024 * 1024);
      if (body?.ok !== true || body.version !== 1 || !Array.isArray(body.companies) || body.count !== body.companies.length ||
          body.count > CAPTURE_REGISTRY_SHARDS * CAPTURE_REGISTRY_LIMIT || !Number.isFinite(Date.parse(body.checkedAt)) ||
          now() - Date.parse(body.checkedAt) > 600000 || Date.parse(body.checkedAt) > now() + 5000) throw new Error('Invalid company registrations');
      const incoming = body.companies.map(registeredCompany), ids = new Set(incoming.map(c => c.isin));
      if (ids.size !== incoming.length || companies.some(c => !ids.has(c.isin))) throw new Error('Company registration history was lost');
      companies = incoming; checkedAt = body.checkedAt; error = null;
      writeJson(path, { version: 1, checkedAt, companies });
    } catch { error = 'Company registrations could not be checked; retaining previously enrolled companies.'; }
  }
  return { companies, registration: { liveRequested: live, checkedAt, error, count: companies.length } };
}
