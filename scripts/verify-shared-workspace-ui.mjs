import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../worker/workspace-store.mjs';
import { startAnnouncementServer, sqliteStorage } from './lib/announcement-test-server.mjs';
import { buildFixtureIndex } from './lib/announcement-index-fixture.mjs';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const folder = mkdtempSync(join(tmpdir(), 'saved-views-')), publicDir = resolve('public');
const { index } = buildFixtureIndex(folder, { root: publicDir });
const now = Date.parse(`${index.range.to}T18:00:00+05:30`), store = new WorkspaceStore(sqliteStorage());
let oldModules = false;
const server = await startAnnouncementServer({ indexDir: folder, publicDir, now: () => now, workspaceStore: store, transformAsset(path, bytes) {
  if (path === '/sw.js') {
    let code = bytes.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/assets/brand/favicon.svg', self.location).href;");
    if (oldModules) code = code.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-shared-workspace`;');
    return code;
  }
  if (path === '/js/core/workspace.js' && oldModules) return `export const snapshot=()=>({version:1,revision:0,tabs:[],order:${JSON.stringify(['alerts','announcements','earnings','breakouts','insider-trades','mutual-funds','news-section','super-investors'])}});export const status=()=>({confirmed:false,pending:0,error:null});export const onChange=()=>()=>{};export const start=()=>{};export const sync=async()=>({confirmed:false});export const edit=async()=>({confirmed:false});`;
  return bytes;
} });
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
async function context(colorScheme = 'light', width = 1440) {
  const context = await browser.newContext({ serviceWorkers: 'block', colorScheme, viewport: { width, height: 900 } });
  await context.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: now });
  return { context, page };
}
const ready = async page => {
  await page.evaluate(async () => { window.query = (await import('/js/tabs/corp-announcements.js')).announcementQuery; });
  await page.waitForFunction(() => window.query.meta().state === 'ready' && !window.query.meta().refreshing);
};
try {
  const one = await context(), two = await context('dark');
  await one.page.goto(`${server.url}#/research/corp-announcements?scope=universe`); await ready(one.page);
  await one.page.locator('[data-ca-open="categories"]').click();
  await one.page.locator('input[value="capital-raise"]').check();
  await one.page.locator('[data-ca-apply]').click();
  await one.page.waitForFunction(() => window.query.query().categories.includes('capital-raise') && window.query.meta().state === 'ready');
  await one.page.getByRole('combobox', { name: 'Announcement period (IST)' }).selectOption('7'); await ready(one.page);
  await one.page.getByRole('button', { name: 'Save as tab', exact: true }).click();
  await one.page.locator('[data-saved-title]').fill('Capital Raises');
  await one.page.locator('[data-saved-submit]').click();
  await one.page.getByRole('heading', { name: 'Capital Raises', exact: true }).waitFor(); await ready(one.page);
  const view = store.snapshot().tabs[0];
  assert.equal(view.title, 'Capital Raises'); assert.deepEqual(view.reading.extras.categories, ['capital-raise']);
  assert.equal(view.reading.extras.period, '7'); assert.equal(view.scope, 'universe');
  assert.equal(await one.page.getByRole('combobox', { name: 'Announcement period (IST)' }).inputValue(), '7');
  assert.deepEqual(await one.page.evaluate(() => window.query.query().categories), ['capital-raise']);
  const rowIds = await one.page.evaluate(() => window.query.rows().map(row => row.id));
  assert(rowIds.length > 0, 'the saved view uses real matching captured filings');
  await two.page.goto(`${server.url}#/research/${view.id}?scope=universe`);
  await two.page.getByRole('heading', { name: 'Capital Raises', exact: true }).waitFor(); await ready(two.page);
  assert.deepEqual(await two.page.evaluate(() => window.query.rows().map(row => row.id)), rowIds, 'a second device restores the same filters and eligible records');
  if (process.env.WORKSPACE_SCREENSHOT) {
    await one.page.screenshot({ path: `${process.env.WORKSPACE_SCREENSHOT}-light.png` });
    await two.page.screenshot({ path: `${process.env.WORKSPACE_SCREENSHOT}-dark.png` });
  }
  const tab = one.page.locator(`#tabbar-mount [data-tab-id="${view.id}"]`);
  await tab.focus(); await one.page.keyboard.press('Alt+ArrowLeft');
  await one.page.waitForFunction(async () => { const workspace = await import('/js/core/workspace.js'); return !workspace.status().pending && workspace.status().confirmed && workspace.snapshot().order.at(-1) === 'super-investors'; });
  await two.page.evaluate(async () => (await import('/js/core/workspace.js')).sync());
  await two.page.waitForFunction(() => document.querySelector('#tabbar-mount [data-tab-list]').lastElementChild?.dataset.tabId === 'super-investors');
  const order = page => page.locator('#tabbar-mount [data-tab-id]').evaluateAll(tabs => tabs.map(tab => tab.dataset.tabId));
  assert.deepEqual(await order(two.page), await order(one.page), 'rearrangement is universal across separate browser storage');
  await two.page.reload(); await two.page.getByRole('heading', { name: 'Capital Raises', exact: true }).waitFor(); await ready(two.page);
  assert.deepEqual(await two.page.evaluate(() => window.query.query().categories), ['capital-raise']);
  assert.equal(await two.page.getByRole('combobox', { name: 'Announcement period (IST)' }).inputValue(), '7');
  // Source data continues to arrive behind the saved definition; no rows are stored in the tab.
  const sample = await one.page.evaluate(() => window.query.rows()[0]);
  const originalQuery = server.index.query.bind(server.index);
  const arrival = { ...sample, id: 'fixture-capital-arrival', title: '[Synthetic fixture] New capital raise filing', event: null };
  server.index.query = async input => {
    const result = await originalQuery(input);
    return input.categories?.includes('capital-raise') && !input.q ? { ...result, rows: [arrival, ...result.rows], total: result.total + 1 } : result;
  };
  await one.page.clock.fastForward(91000);
  await one.page.waitForFunction(() => window.query.rows().some(row => row.id === 'fixture-capital-arrival'));
  const afterArrival = await one.page.evaluate(() => window.query.rows().map(row => row.id));
  assert(rowIds.every(id => afterArrival.includes(id)), 'automatic source revalidation retains prior matching evidence');
  assert(!('rows' in store.snapshot().tabs[0].reading), 'the saved definition is not a source snapshot');
  // One-off changes remain local until the user deliberately saves the shared view.
  await one.page.getByRole('combobox', { name: 'Announcement period (IST)' }).selectOption('3'); await ready(one.page);
  assert.equal(store.snapshot().tabs[0].reading.extras.period, '7');
  await one.page.getByRole('button', { name: 'Save filters', exact: true }).click();
  await one.page.waitForFunction(async () => { const workspace = await import('/js/core/workspace.js'); return !workspace.status().pending && workspace.snapshot().tabs[0]?.reading.extras.period === '3'; });
  await two.page.evaluate(async () => (await import('/js/core/workspace.js')).sync());
  await two.page.waitForFunction(() => window.query.query().period === '3' && window.query.meta().state === 'ready');
  await one.page.getByRole('button', { name: 'Edit tab', exact: true }).click();
  await one.page.locator('[data-saved-title]').fill('Fundraising'); await one.page.locator('[data-saved-submit]').click();
  await one.page.getByRole('heading', { name: 'Fundraising', exact: true }).waitFor();
  await two.page.evaluate(async () => (await import('/js/core/workspace.js')).sync());
  await two.page.getByRole('heading', { name: 'Fundraising', exact: true }).waitFor();
  // A conflict retains the unsaved definition on its device and offers an explicit review.
  const stale = { ...store.snapshot().tabs[0], title: 'Review this draft', revision: 1 };
  const rejected = await two.page.evaluate(async tab => (await import('/js/core/workspace.js')).edit({ op: 'put', tab, expected: tab.revision }), stale);
  assert.equal(rejected.confirmed, false);
  await two.page.getByRole('button', { name: 'Review unsaved tab', exact: true }).waitFor();
  assert.equal(store.snapshot().tabs[0].title, 'Fundraising', 'a stale edit cannot overwrite another user');
  await two.page.reload(); await two.page.getByRole('heading', { name: 'Fundraising', exact: true }).waitFor();
  await two.page.getByRole('button', { name: 'Review unsaved tab', exact: true }).waitFor();
  await two.page.getByRole('button', { name: 'Review unsaved tab', exact: true }).click();
  assert.equal(await two.page.locator('[data-saved-title]').inputValue(), 'Review this draft');
  await two.page.locator('[data-saved-cancel]').click();
  await two.page.evaluate(async () => { const workspace = await import('/js/core/workspace.js'); workspace.status().rejected.forEach(row => workspace.dismissRejected(row.intent.id)); });
  await ready(two.page);
  // A failed shared read keeps the last confirmed screen, including captured evidence.
  await two.page.route('**/api/workspace', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
  await two.page.evaluate(async () => (await import('/js/core/workspace.js')).sync());
  assert(await two.page.getByRole('heading', { name: 'Fundraising', exact: true }).isVisible());
  assert.deepEqual(await two.page.evaluate(() => window.query.query().categories), ['capital-raise']);
  await two.page.unroute('**/api/workspace');
  await one.page.getByRole('button', { name: '+ Add tab', exact: true }).click();
  await one.page.locator('[data-saved-title]').fill('My Research'); await one.page.locator('[data-saved-submit]').click();
  await one.page.getByRole('heading', { name: 'My Research', exact: true }).waitFor();
  await one.page.getByRole('button', { name: 'Choose a table', exact: true }).waitFor();
  // Offline edits stay on their device and publish after reconnect, including a create/update chain.
  await one.page.route('**/api/workspace', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
  const offlineId = await one.page.evaluate(async () => {
    const workspace = await import('/js/core/workspace.js'), tab = { id: `view-${crypto.randomUUID()}`, title: 'Queued screen', source: null, scope: 'universe', subview: null, params: {}, reading: {} };
    await workspace.edit({ op: 'put', tab });
    await workspace.edit({ op: 'put', tab: { ...tab, title: 'Queued renamed screen' }, expected: 0 });
    return tab.id;
  });
  assert(!store.snapshot().tabs.some(tab => tab.id === offlineId));
  await one.page.unroute('**/api/workspace');
  await one.page.evaluate(async () => (await import('/js/core/workspace.js')).sync());
  assert.equal(store.snapshot().tabs.find(tab => tab.id === offlineId).title, 'Queued renamed screen');
  await one.page.evaluate(async id => { const workspace = await import('/js/core/workspace.js'), tab = workspace.snapshot().tabs.find(tab => tab.id === id); await workspace.edit({ op: 'remove', tabId: id, expected: tab.revision }); }, offlineId);
  await one.page.setViewportSize({ width: 390, height: 800 });
  assert(await one.page.getByRole('button', { name: '+ Add tab', exact: true }).isVisible());
  await one.page.getByRole('button', { name: 'Choose a table', exact: true }).click();
  await one.page.locator('[data-saved-source]').selectOption('corp-announcements'); await one.page.locator('[data-saved-submit]').click();
  await one.page.waitForFunction(() => window.query.query().categories.length === 0 && window.query.meta().state === 'ready');
  await ready(one.page);
  assert.deepEqual(await one.page.evaluate(() => window.query.query().categories), [], 'another saved screen does not inherit Capital Raises filters');
  await one.page.getByRole('button', { name: 'Remove tab', exact: true }).click();
  await one.page.locator('[data-remove-confirm]').click();
  await one.page.locator('#tabbar-mount [data-tab-id="alerts"][aria-selected="true"]').waitFor();
  assert(!store.snapshot().tabs.some(tab => tab.title === 'My Research'));
  assert.equal(store.snapshot().tabs.length, 1, 'removing one screen preserves every other saved screen');
  assert.deepEqual(errors, []);
  console.log('PASS shared screens: real Capital Raises filters, two devices, universal order, deep links/reload, deliberate shared saves, rename, failed reads, blank page/configuration, responsive controls and removal without source changes');
  await one.context.close(); await two.context.close();
  oldModules = true;
  const warm = await browser.newContext({ viewport: { width: 1440, height: 900 } }), returning = await warm.newPage();
  await warm.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  returning.on('pageerror', error => errors.push(error.message));
  await returning.goto(`${server.url}#/research/ask-research?scope=universe`);
  await returning.waitForFunction(() => navigator.serviceWorker.controller);
  await returning.reload(); await returning.locator('[data-active-tab="ask-research"]').waitFor();
  assert.equal(await returning.locator('#tabbar-mount [data-tab-id^="view-"]').count(), 0, 'warm previous modules do not read shared screens');
  assert((await returning.evaluate(() => caches.keys())).some(key => key.includes('previous-shared-workspace')));
  oldModules = false;
  await returning.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await returning.locator(`#tabbar-mount [data-tab-id="${view.id}"]`).waitFor();
  await returning.locator(`#tabbar-mount [data-tab-id="${view.id}"]`).click();
  await returning.getByRole('heading', { name: 'Fundraising', exact: true }).waitFor(); await ready(returning);
  assert.deepEqual(await returning.evaluate(() => window.query.query().categories), ['capital-raise']);
  assert(!(await returning.evaluate(() => caches.keys())).some(key => key.includes('previous-shared-workspace')));
  assert.deepEqual(errors, []); await warm.close();
  console.log('PASS returning controlled dashboard upgrades its immutable modules and restores shared tabs with their live filters');
} finally { await browser.close(); await server.close(); rmSync(folder, { recursive: true, force: true }); }
