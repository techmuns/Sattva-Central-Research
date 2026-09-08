#!/usr/bin/env node
// Account-limited, durable private collection. Never writes paid content to Git or Actions artifacts.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildSummaryInventory } from './lib/concall-summary-inventory.mjs';
import { readScreenerSummary, summaryResponseError, summaryNavigationGate } from './lib/read-screener-summary.mjs';
import { loadActivePortfolio } from './lib/active-portfolio.mjs';
import { readScreenerConcallCollector } from '../worker/screener-concalls-collector.mjs';
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { SUMMARY_ORIGIN, SUMMARY_FAILURES, SUMMARY_INVENTORY_BATCH, SUMMARY_TRANSPORT_LIMIT } from '../public/js/data/concall-summaries-shared.js';

const ENDPOINT = `${SUMMARY_ORIGIN}/api/concall-summaries/collector`;
const MAX_BATCH = 10;

export function summaryCollectorClient({ fetcher = fetch, env = process.env } = {}) {
  // GitHub's request credential stays on its documented Actions hostname. The short-lived OIDC
  // token goes only to this dashboard's fixed collector audience; redirects are never followed.
  const send = async input => {
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL || '');
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com') || url.username || url.password || url.port)
      throw Error('OIDC endpoint unavailable');
    url.searchParams.set('audience', ENDPOINT);
    const identity = await boundedJson(await fetcher(url.href, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      redirect: 'manual', signal: AbortSignal.timeout(15000) }), 64000);
    if (typeof identity.value !== 'string' || identity.value.length > 16000) throw Error('OIDC identity unavailable');
    // Retrying the same complete payload is idempotent. Reserve is never repeated automatically:
    // a response lost after claiming a slot is an accounted interrupted attempt.
    const attempts = ['complete', 'sync-begin', 'sync-batch', 'sync-finish'].includes(input.action) ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetcher(ENDPOINT, { method: 'POST', headers: { authorization: `Bearer ${identity.value}`,
          'content-type': 'application/json' }, body: JSON.stringify(input), redirect: 'manual', signal: AbortSignal.timeout(45000) });
        const result = await boundedJson(response, SUMMARY_TRANSPORT_LIMIT);
        if (result.ok !== true) throw Error('Private summary checkpoint unavailable');
        return result;
      } catch { if (attempt + 1 === attempts) throw Error('Private summary checkpoint unavailable'); }
    }
  };
  return async input => {
    if (input.action !== 'sync') return send(input);
    const { targets, ...manifest } = input.inventory, syncId = randomUUID();
    await send({ action: 'sync-begin', syncId, manifest: { ...manifest, targetCount: targets.length } });
    for (let offset = 0; offset < targets.length; offset += SUMMARY_INVENTORY_BATCH)
      await send({ action: 'sync-batch', syncId, offset, targets: targets.slice(offset, offset + SUMMARY_INVENTORY_BATCH) });
    return send({ action: 'sync-finish', syncId });
  };
}

export async function runSummaryCollection({ client, inventory, openSession, read = readScreenerSummary,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, uuid = randomUUID }) {
  let session, saved = 0, attempted = 0;
  try {
    let plan;
    try { plan = await inventory(); }
    catch { await client({ action: 'discovery-failed' }); throw Error('Current portfolio or source catalogue unavailable'); }
    let synced;
    try { synced = await client({ action: 'sync', inventory: plan }); }
    catch {
      // A rejected reconciliation or an oversized inventory must invalidate the previous
      // coverage claim immediately, even though the retained records remain untouched.
      try { await client({ action: 'discovery-failed' }); } catch { /* Checkpoint outage: age stays visible. */ }
      throw Error('Private summary inventory could not be reconciled');
    }
    if (Date.parse(synced.state?.cooldownUntil) > now()) return { saved, attempted, reason: 'source-cooldown' };
    // Do not even sign in if the rolling daily allowance has already been consumed.
    if (synced.state?.automatedRequestsLast24h >= synced.state?.requestBudget) return { saved, attempted, reason: 'daily-budget' };
    for (let index = 0; index < MAX_BATCH; index++) {
      let claim = await client({ action: 'reserve', requestId: uuid() });
      if (!claim.reserved && claim.reason === 'spacing') {
        const wait = Date.parse(claim.retryAt) - now();
        if (wait > 0 && wait <= 20000) {
          await sleep(wait);
          claim = await client({ action: 'reserve', requestId: uuid() });
        }
      }
      if (!claim.reserved) return { saved, attempted, reason: claim.reason };
      attempted++;
      let body;
      try {
        session ||= await openSession();
        session.prepare?.(claim.target);
        body = await read(session.page, claim.target);
      } catch (error) {
        const outcome = SUMMARY_FAILURES.has(error?.summaryCode) ? error.summaryCode : 'source-unavailable';
        await client({ action: 'complete', requestId: claim.requestId, token: claim.token, outcome, retryAt: error?.retryAt || null });
        if (outcome !== 'not-published') return { saved, attempted, reason: outcome };
        continue;
      }
      await client({ action: 'complete', requestId: claim.requestId, token: claim.token, outcome: 'ready', body });
      saved++;
    }
    return { saved, attempted, reason: 'batch-complete' };
  } finally { await session?.close(); }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'techmuns/Sattva-Central-Research' ||
      process.env.GITHUB_REF !== 'refs/heads/main') throw Error('Collector requires its fixed main-branch workflow');
  const username = process.env.SCREENER_USERNAME, password = process.env.SCREENER_PASSWORD, github = process.env.GH_TOKEN;
  delete process.env.SCREENER_USERNAME; delete process.env.SCREENER_PASSWORD; delete process.env.GH_TOKEN;
  delete process.env.DEBUG; delete process.env.PWDEBUG;
  const client = summaryCollectorClient();
  const result = await runSummaryCollection({ client,
    inventory: async () => {
      const [portfolio, result] = await Promise.all([
        loadActivePortfolio(new URL('../public/data/portfolio-companies.json', import.meta.url), { live: true }),
        readScreenerConcallCollector({ token: github, signal: AbortSignal.timeout(45000) }),
      ]);
      if (result.source.collectorLatestFailed) throw Error('Source catalogue has a newer failed check');
      const identities = JSON.parse(readFileSync(new URL('../public/data/announcement-identities.json', import.meta.url), 'utf8')).entries || [];
      return buildSummaryInventory(portfolio, result.capture, { identities });
    },
    openSession: async () => {
      if (!username || !password || !process.env.PLAYWRIGHT_ROOT) throw Error('Summary source account unavailable');
      const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
      // Do not pass GitHub OIDC credentials to the browser subprocess.
      const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|ACTIONS_ID_TOKEN/.test(key)));
      const browser = await chromium.launch({ headless: true, env: browserEnv });
      try {
        const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
        const page = await context.newPage(), navigation = summaryNavigationGate();
        // A summary navigation is the only metered source request. Disable prefetch/XHR/scripts
        // and third-party resources instead of letting the page make unaccounted summary reads.
        await context.route('**/*', route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== 'https://www.screener.in' || !['document', 'stylesheet'].includes(request.resourceType())) return route.abort();
          if (!navigation.accept(url.href, request.resourceType(), request.frame() === page.mainFrame())) return route.abort();
          return route.continue();
        });
        page.setDefaultTimeout(15000);
        const response = await page.goto('https://www.screener.in/login/?next=%2Fconcalls%2F', { waitUntil: 'domcontentloaded' });
        const refused = summaryResponseError(response?.status() || 0, await page.locator('body').innerText(), response?.headers()['retry-after']);
        if (refused) throw refused;
        const form = page.locator('form[action="/login/"]');
        await form.locator('input[name="username"]').fill(username);
        await form.locator('input[name="password"]').fill(password);
        await Promise.all([page.waitForURL('https://www.screener.in/concalls/', { waitUntil: 'domcontentloaded' }), form.locator('button[type="submit"]').click()]);
        if (!(await context.cookies('https://www.screener.in')).some(cookie => cookie.name === 'sessionid' && cookie.value)) throw Error('Source sign-in failed');
        return { page, prepare: target => navigation.arm(target), close: () => browser.close() };
      } catch (error) { await browser.close(); throw error; }
    },
  });
  // Aggregate counters and controlled reasons only; never paid text, account identity or tokens.
  console.log(JSON.stringify(result));
  if (!['source-cooldown', 'daily-budget', 'spacing', 'busy', 'no-due-summaries', 'batch-complete'].includes(result.reason)) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => { console.error('Private summary collection could not finish; durable checkpoints and budget remain retained.'); process.exitCode = 1; });
}
