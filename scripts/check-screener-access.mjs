/**
 * One read-only Screener login and sample-company check. Credentials are injected
 * by GitHub Actions; never print errors, HTML, account details, cookies or traces.
 * This does not download exports, save a browser session or write dashboard data.
 */
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const origin = 'https://www.screener.in';
const samplePath = '/company/TCS/consolidated/';
const sections = ['quarters', 'profit-loss', 'balance-sheet', 'cash-flow', 'ratios', 'shareholding'];
let stage = 'credential configuration';
let browser;

async function report(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
  }
}

try {
  const username = process.env.SCREENER_USERNAME;
  const password = process.env.SCREENER_PASSWORD;
  if (!username || !password) throw new Error('Missing configuration');
  // Chromium and its child processes do not need the credential environment.
  delete process.env.SCREENER_USERNAME;
  delete process.env.SCREENER_PASSWORD;
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  await report('PASS: both Screener credential secrets are available to the runner.');

  stage = 'browser startup';
  if (!process.env.PLAYWRIGHT_ROOT) throw new Error('Missing runtime');
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  stage = 'login page access';
  const login = await page.goto(`${origin}/login/?next=${encodeURIComponent(samplePath)}`, {
    waitUntil: 'domcontentloaded',
  });
  if (!login?.ok()) throw new Error('Login page unavailable');
  const form = page.locator('form[action="/login/"]');
  await form.waitFor({ state: 'visible' });
  if (new URL(page.url()).origin !== origin) throw new Error('Unexpected origin');

  stage = 'login submission';
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL(`${origin}${samplePath}`, { waitUntil: 'domcontentloaded' }),
    form.locator('button[type="submit"]').click(),
  ]);

  stage = 'authenticated session verification';
  const hasSession = (await context.cookies(origin)).some(cookie => cookie.name === 'sessionid' && cookie.value);
  const hasLogout = await page.locator('a[href^="/logout/"], form[action^="/logout/"]').count() > 0;
  if (!hasSession || !hasLogout) throw new Error('Authentication not verified');
  await report('PASS: Screener login succeeded and the authenticated session was verified.');

  stage = 'sample company data access';
  const ratios = await page.locator('#top-ratios .number').count();
  if (ratios === 0) throw new Error('Missing top ratios');
  await report(`PASS: TCS consolidated company page exposes ${ratios} top-ratio values.`);
  for (const section of sections) {
    stage = `sample ${section} data access`;
    const numericCells = await page.locator(`#${section} table td:not(:first-child)`).evaluateAll(
      cells => cells.filter(cell => /\d/.test(cell.textContent || '')).length,
    );
    if (numericCells === 0) throw new Error('Missing financial table');
    await report(`PASS: ${section} table is readable (${numericCells} populated numeric cells).`);
  }
  await report(`Access check completed at ${new Date().toISOString()}. No dashboard data or saved session was written.`);
} catch {
  // Playwright exceptions can contain fill values and page content. Only this
  // fixed-stage message is safe for a public repository's Actions log/summary.
  await report(`FAIL: Screener access check stopped during ${stage}. No credentials or page content were logged.`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
