#!/usr/bin/env node
/**
 * Mirror the current listed portfolio into the existing S Screen watchlist.
 * The watchlist identity is fixed and verified before mutation. This script has
 * no path that creates or renames a watchlist, and it never logs holdings.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  additionsCsv,
  matchRemovalButtons,
  portfolioWatchlistTargets,
  reconcileWatchlist,
} from './lib/screener-watchlist.mjs';

import { readWatchlistInventory, watchlistFailureReason } from './lib/screener-watchlist-browser.mjs';

const ORIGIN = 'https://www.screener.in';
const WATCHLIST_ID = '10850427';
const WATCHLIST_NAME = 'S Screen';
const WATCHLIST_PATH = `/watchlist/${WATCHLIST_ID}/`;
const MANAGE_PATH = `/user/stocks/${WATCHLIST_ID}/`;
const IMPORT_PATH = `/watchlist/import/${WATCHLIST_ID}/`;
const PORTFOLIO = new URL('../public/data/portfolio-companies.json', import.meta.url);

let browser;
let stage = 'configuration';

async function report(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}

async function go(page, path) {
  const response = await page.goto(`${ORIGIN}${path}`, { waitUntil: 'domcontentloaded' });
  if (!response?.ok() || new URL(page.url()).origin !== ORIGIN) throw new Error('Screener page unavailable');
}

const inventory = page => readWatchlistInventory(page, { origin: ORIGIN, watchlistId: WATCHLIST_ID, watchlistName: WATCHLIST_NAME });

async function importAdditions(page, additions) {
  if (!additions.length) return;
  await go(page, IMPORT_PATH);
  const title = (await page.locator('h1').first().textContent())?.trim();
  if (title !== `Import companies to ${WATCHLIST_NAME}`) throw new Error('Unexpected import target');
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({
    name: 'portfolio-additions.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(additionsCsv(additions)),
  });
  const form = input.locator('xpath=ancestor::form[1]');
  const [response] = await Promise.all([
    page.waitForResponse(candidate => candidate.request().method() === 'POST' && new URL(candidate.url()).pathname === IMPORT_PATH),
    form.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);
  if (response.status() < 200 || response.status() >= 400) throw new Error('Screener rejected the import request');
  await page.waitForLoadState('domcontentloaded');
  if (new URL(page.url()).origin !== ORIGIN) throw new Error('Unexpected import result');
  if (await page.locator('.errorlist li, .alert-danger, .messages .error').count()) throw new Error('Screener reported an import error');
}

async function removeCompanies(page, matches) {
  if (!matches.length) return;
  await go(page, MANAGE_PATH);
  page.on('dialog', dialog => dialog.accept());
  for (const match of matches) {
    const removed = await page.evaluate(companyId => {
      const button = [...document.querySelectorAll('button[onclick*="Watchlist.removeCompany"]')].find(candidate => {
        const onclick = candidate.getAttribute('onclick') || '';
        return new RegExp(`removeCompany\\(['\"]${companyId}['\"]\\)`).test(onclick);
      });
      if (!button) return false;
      button.click();
      return true;
    }, match.companyId);
    if (!removed) throw new Error('Planned removal control disappeared');
    await page.waitForFunction(companyId => ![...document.querySelectorAll('button[onclick*="Watchlist.removeCompany"]')].some(candidate => {
      const onclick = candidate.getAttribute('onclick') || '';
      return new RegExp(`removeCompany\\(['\"]${companyId}['\"]\\)`).test(onclick);
    }), match.companyId);
  }
}

try {
  const username = process.env.SCREENER_USERNAME;
  const password = process.env.SCREENER_PASSWORD;
  const dryRun = process.env.SCREENER_SYNC_DRY_RUN === 'true';
  if (!username || !password || !process.env.PLAYWRIGHT_ROOT) throw new Error('Missing configuration');
  const portfolio = JSON.parse(await readFile(PORTFOLIO, 'utf8'));
  const targets = portfolioWatchlistTargets(portfolio);

  // Chromium and child processes do not need credentials or verbose debug flags.
  delete process.env.SCREENER_USERNAME;
  delete process.env.SCREENER_PASSWORD;
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;

  stage = 'browser startup';
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  stage = 'Screener login';
  await go(page, `/login/?next=${encodeURIComponent(WATCHLIST_PATH)}`);
  const form = page.locator('form[action="/login/"]');
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL(`${ORIGIN}${WATCHLIST_PATH}`, { waitUntil: 'domcontentloaded' }),
    form.locator('button[type="submit"]').click(),
  ]);
  const hasSession = (await context.cookies(ORIGIN)).some(cookie => cookie.name === 'sessionid' && cookie.value);
  if (!hasSession) throw new Error('Authenticated session unavailable');

  stage = 'watchlist inventory';
  const { current, manageRows } = await inventory(page);
  const plan = reconcileWatchlist(current, targets);
  const removalMatches = matchRemovalButtons(plan.removals, manageRows);
  await report(`S Screen plan: ${current.length} current, ${targets.length} listed portfolio companies, ${plan.additions.length} additions, ${plan.removals.length} removals.`);

  if (dryRun) {
    await report('Dry run completed. The existing S Screen watchlist was not changed.');
  } else {
    stage = 'watchlist additions';
    await importAdditions(page, plan.additions);
    stage = 'watchlist removals';
    await removeCompanies(page, removalMatches);
    stage = 'final watchlist verification';
    const { current: final } = await inventory(page);
    const result = reconcileWatchlist(final, targets);
    if (result.removals.length) throw new Error('Non-portfolio companies remain after sync');
    await report(`S Screen ${result.additions.length ? 'partially synced' : 'synced'}: ${final.length} portfolio companies present; ${result.additions.length} listed holdings are unavailable on Screener.`);
    if (result.additions.length) console.log(`::warning::Screener could not add ${result.additions.length} listed portfolio holdings; they will be retried on the next sync.`);
  }
} catch (error) {
  // Browser exceptions can include account, holding, or form data. Keep public
  // logs limited to a fixed stage name and never print the caught exception.
  await report(`FAIL: S Screen sync stopped during ${stage} (${watchlistFailureReason(error)}). No credentials or portfolio identifiers were logged.`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
