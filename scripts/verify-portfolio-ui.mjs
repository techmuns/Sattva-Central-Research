// Start Research on localhost:8080 and the companion Family Vite app on
// localhost:5173. All external APIs and both model endpoints are intercepted:
// this test cannot send portfolio data to production or start a production run.
import assert from 'node:assert/strict';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const errors = [];
let outage = false;
let pauseResearch = false, releaseResearch, reportStarted;
const questions = [];
let page;
const standaloneHistory = JSON.stringify([{ id: 'saved-standalone', title: 'Saved standalone conversation', messages: [], draft: '' }]);
await context.addInitScript(value => {
  if (location.origin === 'http://localhost:8080' && !localStorage.getItem('sattva:ask-research:v1')) localStorage.setItem('sattva:ask-research:v1', value);
}, standaloneHistory);
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
await context.route('**/*', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.fulfill({ status: 503, body: 'External network disabled in this test' });
  if (url.pathname === '/api/workbooks') return json(route, outage ? { error: 'offline' } : { ok: true, storage: 'unconfigured', books: [] }, outage ? 503 : 200);
  if (url.port === '8080' && url.pathname === '/api/research') {
    if (req.method() === 'GET') return json(route, { configured: true });
    const body = req.postDataJSON();
    questions.push(body);
    if (pauseResearch) { reportStarted?.(); await new Promise(resolve => { releaseResearch = resolve; }); }
    return route.fulfill({ contentType: 'application/x-ndjson', body: [
      { type: 'text', text: 'Portfolio source was read. [Dashboard: Ask Sattva]' }, { type: 'done' },
    ].map(x => JSON.stringify(x)).join('\n') + '\n' }).catch(error => { if (!pauseResearch) throw error; });
  }
  if (url.pathname.startsWith('/api/')) return json(route, { ok: false, error: 'Test API unavailable' }, 503);
  return route.continue();
});
try {
  page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:5173/research', { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const research = page.frameLocator('iframe[title="Portfolio-connected Sattva Research"]');
  await research.getByText('Full portfolio via Ask Sattva', { exact: false }).waitFor({ timeout: 90_000 });
  const input = research.getByRole('textbox', { name: 'Ask about the dashboard' });
  await input.fill('Do I have Sterlite in my portfolio?');
  await research.getByRole('button', { name: 'Send question' }).click();
  await research.getByText('Portfolio source was read.', { exact: false }).waitFor({ timeout: 125_000 });
  assert.equal(questions.length, 1);
  assert.ok(['ready', 'limited'].includes(questions[0].evidence.portfolio.status));
  assert.match(questions[0].evidence.portfolio.answer, /Sterlite/i);
  assert.equal(questions[0].evidence.portfolio.bookAsOf, '2026-06-30');
  await research.getByText('Portfolio book: 2026-06-30.', { exact: false }).waitFor();
  const child = page.frames().find(f => f.url().startsWith('http://localhost:8080'));
  assert.ok(child);
  assert.equal(await child.evaluate(() => localStorage.getItem('sattva:ask-research:v1')), standaloneHistory, 'private conversations neither load nor overwrite standalone history');
  assert.equal(await research.getByText('Saved standalone conversation', { exact: true }).count(), 0);
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });

  await child.evaluate(() => { location.hash = '#/research/ai-alerts?scope=portfolio'; });
  await research.locator('[data-ai-size-note]').filter({ hasText: 'Largest holdings first' }).waitFor({ timeout: 60_000 });
  await child.waitForFunction(() => document.querySelector('[data-ai-feed-status]')?.dataset.state === 'complete', null, { timeout: 60_000 });
  const weights = await research.locator('[data-ai-holding-size]').allTextContents();
  assert(weights.length > 0, 'actual Family book sizes reach surfaced AI cards');
  const percentages = weights.map(w => parseFloat(w));
  assert(percentages.every(Number.isFinite));
  assert(percentages.every((w, i) => i === 0 || w <= percentages[i - 1]), 'largest holdings appear first');
  assert.equal(questions.length, 1, 'holding size requests do not invoke a model');
  assert.match(await research.locator('[data-ai-size-note]').innerText(), /Book 30 Jun 2026/);
  assert(await child.evaluate(() => !JSON.stringify(localStorage).includes('weightPct')), 'private sizes are never persisted');
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '-sizes.png'), fullPage: true });
  outage = true;
  await child.evaluate(async () => (await import('/js/core/refresh.js')).refreshAll());
  await research.locator('[data-ai-error]').filter({ hasText: 'could not be checked' }).waitFor();
  assert.equal(await research.locator('[data-ai-holding-size]').count(), 0, 'failed revalidation removes old private sizes');
  outage = false;
  await child.evaluate(async () => (await import('/js/core/refresh.js')).refreshAll());
  await research.locator('[data-ai-size-note]').filter({ hasText: 'Largest holdings first' }).waitFor();
  await page.evaluate(async () => { await (await import('/src/lib/auditStore.ts')).refreshAskArchive(); });
  await research.locator('[data-ai-size-note]').filter({ hasText: 'Largest holdings first' }).waitFor({ timeout: 60_000 });
  await child.evaluate(() => { location.hash = '#/research/ask-research?scope=portfolio'; });
  await input.waitFor();

  outage = true;
  await input.fill('Do I have Sterlite in my portfolio?');
  await research.getByRole('button', { name: 'Send question' }).click();
  await research.getByText('The shared workbook store could not be checked.', { exact: false }).waitFor({ timeout: 45_000 });
  assert.equal(questions.length, 1, 'an outage must not send old private facts to Research');

  outage = false; pauseResearch = true;
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The fresh portfolio reading never reached Research.')), 125_000);
    reportStarted = () => { clearTimeout(timer); resolve(); };
  });
  await input.fill('Do I have Sterlite in my portfolio?');
  await research.getByRole('button', { name: 'Send question' }).click();
  await started;
  await page.evaluate(async () => { await (await import('/src/lib/auditStore.ts')).refreshAskArchive(); });
  await research.getByText('The Family workbook changed while this answer was being written.', { exact: false }).waitFor();
  assert.equal(await input.inputValue(), 'Do I have Sterlite in my portfolio?');
  assert.equal(await research.locator('.research-assistant-answer').count(), 1, 'the invalidated answer cannot be added to the conversation');
  releaseResearch();

  const standalone = await context.newPage();
  standalone.on('pageerror', e => errors.push(e.message));
  await standalone.goto('http://localhost:8080');
  await standalone.getByRole('link', { name: 'Open with portfolio' }).waitFor();
  await standalone.getByRole('textbox', { name: 'Ask about the dashboard' }).fill('Do I have Sterlite in my portfolio?');
  await standalone.getByRole('button', { name: 'Send question' }).click();
  await standalone.getByText('This question needs your full portfolio.', { exact: false }).waitFor();
  assert.equal(questions.length, 2, 'standalone portfolio questions never reach a model');
  assert.deepEqual(errors, []);
  console.log('Portfolio UI: real Family readers → Research evidence and holding sizes, descending position order, dates, memory-only state, outage refusal, invalidation and standalone refusal passed. No production API calls.');
} catch (error) {
  console.error('Browser errors:', errors);
  for (const frame of page?.frames() || []) console.error('Frame:', frame.url(), (await frame.locator('body').innerText().catch(() => '')).slice(-6000));
  if (process.env.SCREENSHOT_PATH && page) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { releaseResearch?.(); await context.close(); await browser.close(); }
