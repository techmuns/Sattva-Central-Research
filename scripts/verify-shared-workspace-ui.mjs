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
  await page.evaluate(async () => { window.query = (await import('/js/tabs/corp-announcements.js')).announcementQuery; window.workspace = await import('/js/core/workspace.js'); });
  await page.waitForFunction(() => window.query.meta().state === 'ready' && !window.query.meta().refreshing);
};
try {
  const one = await context(), two = await context('dark');
  await one.context.addInitScript(() => { if (!localStorage.getItem('dashboard:tab-order:v1:research')) localStorage.setItem('dashboard:tab-order:v1:research', JSON.stringify(['news-section', 'earnings', 'alerts', 'announcements', 'breakouts', 'mutual-funds', 'super-investors'])); });
  await one.page.goto(`${server.url}#/research/corp-announcements?scope=universe`); await ready(one.page);
  assert.deepEqual(await one.page.locator('#tabbar-mount [data-tab-id]').evaluateAll(tabs => tabs.slice(0, 3).map(tab => tab.dataset.tabId)), ['news-section', 'earnings', 'alerts'], 'an uninitialized shared workspace retains the existing browser layout');
  await one.page.route('**/api/workspace', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
  await one.page.locator('#tabbar-mount [data-tab-id="alerts"]').focus(); await one.page.keyboard.press('Alt+ArrowRight');
  await one.page.waitForFunction(() => window.workspace.status().pending === 1 && !!window.workspace.status().error);
  await one.page.reload(); await ready(one.page);
  assert.deepEqual(await one.page.locator('#tabbar-mount [data-tab-id]').evaluateAll(tabs => tabs.slice(0, 3).map(tab => tab.dataset.tabId)), ['news-section', 'earnings', 'announcements'], 'the first migrated move survives an offline reload');
  await one.page.unroute('**/api/workspace'); await one.page.evaluate(() => window.workspace.sync());
  await one.page.waitForFunction(() => window.workspace.status().confirmed && !window.workspace.status().pending && window.workspace.snapshot().revision > 0);
  assert.deepEqual(store.snapshot().order.slice(0, 3), ['news-section', 'earnings', 'announcements'], 'the first shared drag carries forward the existing layout');
  await one.page.locator('[data-ca-open="categories"]').click();
  await one.page.locator('input[value="capital-raise"]').check();
  await one.page.locator('[data-ca-apply]').click();
  await one.page.waitForFunction(() => window.query.query().categories.includes('capital-raise') && window.query.meta().state === 'ready');
  await one.page.getByRole('combobox', { name: 'Announcement period (IST)' }).selectOption('7'); await ready(one.page);
  await one.page.getByRole('button', { name: '+ Add tab', exact: true }).click();
  await one.page.getByRole('button', { name: 'Use current view', exact: true }).click();
  await one.page.getByRole('button', { name: 'Current view selected', exact: true }).waitFor();
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
  const headers = page => page.locator('table[data-shared-column-layout="corp-announcements"] thead th').evaluateAll(cells => cells.map(cell => cell.textContent.replace(/[▴▾▲▼↕]/g, '').trim()));
  const column = (page, label) => page.locator('table[data-shared-column-layout="corp-announcements"] thead th').filter({ hasText: new RegExp(`^\\s*${label}\\s*[▴▾▲▼↕]?\\s*$`) });
  assert.equal((await headers(one.page))[0], 'Company', 'Company starts first on a fresh Announcements table');
  assert.equal((await headers(two.page))[0], 'Company');
  assert(!store.snapshot().columnLayouts, 'opening a table never publishes browser preferences');
  const beforeRows = await one.page.evaluate(() => window.query.rows().map(row => row.id));
  await column(one.page, 'Company').focus(); await one.page.keyboard.press('Alt+ArrowRight');
  await one.page.waitForFunction(() => !window.workspace.status().pending && window.workspace.status().confirmed);
  await one.page.locator('.column-layout-status').filter({ hasText: 'shared with everyone' }).waitFor();
  await two.page.evaluate(() => window.workspace.sync());
  assert.deepEqual((await headers(two.page)).slice(0, 2), ['Subject', 'Company'], 'separate device applies an explicit shared move');
  assert.deepEqual(await two.page.evaluate(() => window.query.rows().map(row => row.id)), beforeRows, 'column updates preserve source rows');
  await two.page.reload(); await ready(two.page);
  assert.deepEqual((await headers(two.page)).slice(0, 2), ['Subject', 'Company'], 'shared order survives reload and saved copies');
  const companyBox = await column(one.page, 'Company').boundingBox();
  await one.page.mouse.move(companyBox.x + companyBox.width / 2, companyBox.y + companyBox.height / 2);
  await one.page.mouse.down(); await one.page.mouse.move(companyBox.x + companyBox.width / 2 + 20, companyBox.y + companyBox.height / 2);
  await one.page.locator('[data-column-dragging]').waitFor();
  store.apply({ id: 'fixture-columns-during-drag', op: 'columns-reset', table: 'corp-announcements' });
  await one.page.evaluate(() => window.workspace.sync());
  assert.deepEqual((await headers(one.page)).slice(0, 2), ['Subject', 'Company'], 'remote updates defer while a column is held');
  await one.page.keyboard.press('Escape'); await one.page.mouse.up();
  await one.page.waitForFunction(() => document.querySelector('table[data-shared-column-layout="corp-announcements"] th')?.textContent.trim() === 'Company');
  await column(one.page, 'Company').focus(); await one.page.keyboard.press('Alt+ArrowRight');
  await one.page.waitForFunction(() => !window.workspace.status().pending && window.workspace.status().confirmed);
  await two.page.evaluate(() => window.workspace.sync());
  await two.page.goto(`${server.url}#/research/corp-announcements?scope=portfolio`); await ready(two.page);
  assert.deepEqual((await headers(two.page)).slice(0, 2), ['Subject', 'Company'], 'the base reader and another scope use the shared table order');
  await two.page.goto(`${server.url}#/research/${view.id}?scope=universe`); await ready(two.page);
  await one.page.route('**/api/workspace', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
  await column(one.page, 'Company').focus(); await one.page.keyboard.press('Alt+ArrowRight');
  await one.page.waitForFunction(() => window.workspace.status().pending === 1 && !!window.workspace.status().error);
  await one.page.locator('.column-layout-status[data-unavailable]').waitFor();
  await one.page.reload(); await ready(one.page);
  assert.equal((await headers(one.page))[2], 'Company', 'queued column moves survive an offline reload');
  await one.page.unroute('**/api/workspace'); await one.page.evaluate(() => window.workspace.sync());
  await two.page.evaluate(() => window.workspace.sync());
  assert.equal((await headers(two.page))[2], 'Company', 'reconnection publishes the durable queued move');
  await column(two.page, 'Company').focus(); await two.page.keyboard.press('Alt+Home');
  await two.page.waitForFunction(() => !window.workspace.status().pending && window.workspace.status().confirmed);
  await one.page.evaluate(() => window.workspace.sync());
  assert.equal((await headers(one.page))[0], 'Company', 'shared reset overrides old browser orders');
  await one.page.reload(); await ready(one.page);
  assert.equal((await headers(one.page))[0], 'Company', 'reset remains authoritative after reload');
  await one.page.route('**/api/workspace', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
  await column(one.page, 'Company').focus(); await one.page.keyboard.press('Alt+ArrowRight');
  await one.page.locator('.column-layout-status[data-unavailable]').waitFor();
  await one.page.unroute('**/api/workspace'); await one.page.evaluate(() => window.workspace.sync());
  assert.equal(await one.page.locator('.column-layout-status[data-unavailable]').count(), 0, 'recovery clears the visible failed-sharing notice without a reload');
  await column(one.page, 'Company').focus(); await one.page.keyboard.press('Alt+Home');
  await one.page.waitForFunction(() => !window.workspace.status().pending && window.workspace.status().confirmed);
  await two.page.evaluate(() => window.workspace.sync());
  if (process.env.WORKSPACE_SCREENSHOT) {
    await one.page.screenshot({ path: `${process.env.WORKSPACE_SCREENSHOT}-light.png` });
    await two.page.screenshot({ path: `${process.env.WORKSPACE_SCREENSHOT}-dark.png` });
  }
  const tab = one.page.locator(`#tabbar-mount [data-tab-id="${view.id}"]`);
  await tab.focus(); await one.page.keyboard.press('Alt+ArrowLeft');
  await one.page.waitForFunction(() => !window.workspace.status().pending && window.workspace.status().confirmed && document.querySelector('#tabbar-mount [data-tab-list]').lastElementChild?.dataset.tabId === 'super-investors');
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
  await one.page.waitForFunction(() => !window.workspace.status().pending && window.workspace.snapshot().tabs[0]?.reading.extras.period === '3');
  await two.page.evaluate(async () => (await import('/js/core/workspace.js')).sync());
  await two.page.waitForFunction(() => window.query.query().period === '3' && window.query.meta().state === 'ready').catch(async error => {
    console.error('Shared filter propagation', await two.page.evaluate(async () => ({ query: window.query.query(), meta: window.query.meta(), workspace: (await import('/js/core/workspace.js')).snapshot(), status: (await import('/js/core/workspace.js')).status(), period: document.querySelector('[aria-label="Announcement period (IST)"]')?.value })), errors);
    throw error;
  });
  await one.page.getByRole('button', { name: 'Edit tab', exact: true }).click();
  await one.page.locator('[data-saved-title]').fill('Fundraising'); await one.page.locator('[data-saved-submit]').click();
  await one.page.getByRole('heading', { name: 'Fundraising', exact: true }).waitFor();
  await two.page.evaluate(async () => (await import('/js/core/workspace.js')).sync());
  await two.page.getByRole('heading', { name: 'Fundraising', exact: true }).waitFor();
  // A rejected request cannot borrow another queued edit's optimistic success.
  for (const action of ['edit', 'remove']) {
    await one.page.getByRole('button', { name: action === 'edit' ? 'Edit tab' : 'Remove tab', exact: true }).click();
    const latest = store.snapshot().tabs[0];
    store.apply({ id: `fixture-concurrent-${action}`, op: 'put', tab: latest, expected: latest.revision });
    if (action === 'edit') await one.page.locator('[data-saved-title]').fill('Rejected editor draft');
    let injected = false;
    await one.page.route('**/api/workspace', async route => {
      if (route.request().method() === 'POST' && !injected) {
        injected = true;
        await one.page.evaluate(async () => { void (await import('/js/core/workspace.js')).edit({ op: 'move', tabId: 'alerts', targetId: 'announcements', after: true }); });
      }
      await route.continue();
    });
    await one.page.locator(action === 'edit' ? '[data-saved-submit]' : '[data-remove-confirm]').click();
    await one.page.locator(action === 'edit' ? '[data-saved-error]' : '[data-remove-error]').filter({ hasText: 'changed elsewhere' }).waitFor();
    assert.equal(await one.page.evaluate(async () => (await import('/js/core/workspace.js')).status().pending), 1, 'the unrelated move stays queued');
    assert(one.page.url().includes(view.id), 'rejection keeps the original reader route');
    await one.page.locator(action === 'edit' ? '[data-saved-cancel]' : '[data-remove-cancel]').click();
    await one.page.unroute('**/api/workspace');
    await one.page.evaluate(async () => { const workspace = await import('/js/core/workspace.js'); await workspace.sync(); workspace.status().rejected.forEach(row => workspace.dismissRejected(row.intent.id)); });
  }
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
  // Hierarchy selection opens the actual source renderer before publishing anything.
  await one.page.getByRole('button', { name: '+ Add tab', exact: true }).click();
  await one.page.locator('[data-saved-title]').fill('Built Capital Raises');
  assert.equal(await one.page.locator('[data-saved-scope]').count(), 0, 'scope has one authoritative header control');
  const expectedChoices = await one.page.evaluate(async () => {
    const { viewChoices } = await import('/js/ui/saved-tabs.js');
    return viewChoices();
  });
  for (const group of [...new Set(expectedChoices.map(choice => choice.group))]) {
    await one.page.locator('[data-saved-group]').selectOption(group);
    assert.equal(await one.page.locator('[data-saved-source]').isVisible(), expectedChoices.filter(choice => choice.group === group).length > 1);
    assert.deepEqual(await one.page.locator('[data-saved-source] option').evaluateAll(options => options.map(option => option.value)), expectedChoices.filter(choice => choice.group === group).map(choice => choice.id));
    for (const choice of expectedChoices.filter(choice => choice.group === group)) {
      if (expectedChoices.filter(choice => choice.group === group).length > 1) await one.page.locator('[data-saved-source]').selectOption(choice.id);
      assert.equal(await one.page.locator('[data-saved-subview]').isVisible(), choice.views.length > 0, 'views without subtabs hide the redundant default selector');
      assert.deepEqual(await one.page.locator('[data-saved-subview] option').evaluateAll(options => options.map(option => option.value)), choice.views.length ? choice.views.map(view => view.id) : ['']);
    }
  }
  await one.page.locator('[data-saved-group]').selectOption('announcements');
  assert.deepEqual(await one.page.locator('[data-saved-source] option').allTextContents(), ['Corporate Announcements', 'Corporate Actions', 'IPOs', 'Bulk/Block Deal']);
  await one.page.locator('[data-saved-source]').selectOption('corp-announcements');
  await one.page.locator('[data-saved-submit]').click();
  await one.page.locator('[data-view-builder]').waitFor().catch(async error => {
    console.error('Builder opening', one.page.url(), await one.page.locator('body').innerText(), errors, store.snapshot().tabs.map(tab => ({ title: tab.title, source: tab.source }))); throw error;
  }); await ready(one.page);
  assert.equal(store.snapshot().tabs.length, 1, 'choosing filters never publishes an unfinished tab');
  await one.page.locator('[data-ca-open="categories"]').click();
  await one.page.locator('input[value="capital-raise"]').check(); await one.page.locator('[data-ca-apply]').click();
  await one.page.getByRole('combobox', { name: 'Announcement period (IST)' }).selectOption('7'); await ready(one.page);
  const builtIds = await one.page.evaluate(() => window.query.rows().map(row => row.id));
  await one.page.locator('#scope-toggle-mount [data-value="watchlist"]').click();
  await one.page.waitForFunction(() => document.querySelector('#scope-toggle-mount [data-value="watchlist"]')?.getAttribute('aria-pressed') === 'true');
  if (!await one.page.locator('[data-watchlist-add]').count()) await ready(one.page);
  await one.page.locator('[data-builder-save]').click();
  await one.page.waitForFunction(() => !window.workspace.status().pending && window.workspace.snapshot().tabs.some(tab => tab.title === 'Built Capital Raises'));
  await one.page.locator('[data-save-reading]').waitFor();
  const built = store.snapshot().tabs.find(tab => tab.title === 'Built Capital Raises');
  assert.deepEqual(built.reading.extras.categories, ['capital-raise']);
  assert.equal(built.scope, 'watchlist', 'even an empty selected scope can publish a screen without discarding its filters');
  await one.page.locator('#scope-toggle-mount [data-value="universe"]').click(); await ready(one.page);
  assert.deepEqual(await one.page.evaluate(() => window.query.rows().map(row => row.id)), builtIds, 'publishing preserves the complete eligible source reading');
  await one.page.locator('#scope-toggle-mount [data-value="portfolio"]').click(); await ready(one.page);
  await one.page.waitForFunction(() => window.query.query().scope === 'portfolio' && window.query.meta().state === 'ready');
  await one.page.locator('#tabbar-mount [data-tab-id="announcements"]').click(); await ready(one.page);
  await one.page.locator(`#tabbar-mount [data-tab-id="${built.id}"]`).click(); await ready(one.page);
  assert.equal(await one.page.locator('#scope-toggle-mount [data-value="portfolio"]').getAttribute('aria-pressed'), 'true', 'opening a saved Watchlist definition retains the currently selected Portfolio scope');
  assert.equal(await one.page.evaluate(() => window.query.query().scope), 'portfolio');
  assert.deepEqual(await one.page.evaluate(() => window.query.query().categories), ['capital-raise']);
  await one.page.locator('#scope-toggle-mount [data-value="universe"]').click(); await ready(one.page);
  await one.page.reload(); await ready(one.page);
  assert.deepEqual(await one.page.evaluate(() => window.query.rows().map(row => row.id)), builtIds);
  await one.page.getByRole('button', { name: 'Remove tab', exact: true }).click(); await one.page.locator('[data-remove-confirm]').click();
  await one.page.waitForFunction(() => !window.workspace.status().pending && window.workspace.snapshot().tabs.length === 1);
  await one.page.goto(`${server.url}#/research/${view.id}?scope=universe`); await ready(one.page);
  console.log('PASS builder: navigation-derived tab/subtab/view mapping, all four Announcements readers, native category selection, complete row parity, unpublished preview, reload and header scope inheritance');
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
  await one.page.locator('[data-saved-group]').selectOption('announcements');
  await one.page.locator('[data-saved-source]').selectOption('corp-announcements'); await one.page.locator('[data-saved-submit]').click();
  await one.page.locator('[data-view-builder]').waitFor();
  await one.page.waitForFunction(() => window.query.query().categories.length === 0 && window.query.meta().state === 'ready');
  await ready(one.page);
  assert.deepEqual(await one.page.evaluate(() => window.query.query().categories), [], 'another saved screen does not inherit Capital Raises filters');
  await one.page.locator('[data-builder-save]').click();
  await one.page.locator('[data-remove-saved]').waitFor();
  await one.page.getByRole('button', { name: 'Remove tab', exact: true }).click();
  await one.page.locator('[data-remove-confirm]').click();
  await one.page.locator('#tabbar-mount [data-tab-id="alerts"][aria-selected="true"]').waitFor();
  await one.page.waitForFunction(() => !window.workspace.status().pending);
  assert(!store.snapshot().tabs.some(tab => tab.title === 'My Research'));
  assert.equal(store.snapshot().tabs.length, 1, 'removing one screen preserves every other saved screen');
  const multiTable = await one.page.evaluate(async () => {
    const { scoreTable } = await import('/js/ui/screener.js');
    const readings = await import('/js/core/view-reading.js'), prior = readings.activeView();
    const root = document.createElement('section'); document.body.append(root);
    const disposers = [], definitions = ['activity', 'holdings'].map((key, index) => ({
      rows: [{ id: 'synthetic-first', name: 'First' }, { id: 'synthetic-second', name: 'Second' }], key: row => row.id, name: row => row.name,
      exportName: `synthetic-${key}`, initialView: { q: index ? 'Second' : 'First', filters: [index ? 'second' : 'first'] },
      filters: [{ label: 'Fixture choice', options: [{ value: 'all', label: 'All' }, { value: 'first', label: 'First' }, { value: 'second', label: 'Second' }], match: (row, value) => row.id === `synthetic-${value}` }],
    }));
    const mount = seeded => {
      disposers.splice(0).forEach(dispose => dispose?.()); root.replaceChildren();
      readings.enterView({ root, key: seeded ? 'multi-table-saved' : null, preset: seeded ? { reading: seeded } : null });
      for (const definition of definitions) {
        const host = document.createElement('div'); root.append(host);
        const table = scoreTable({ ...definition, initialView: seeded ? null : definition.initialView });
        host.innerHTML = table.html; disposers.push(table.wire(host));
      }
    };
    mount(null); const original = readings.captureTableReading(root);
    mount(original); const restored = readings.captureTableReading(root);
    disposers.forEach(dispose => dispose?.()); root.remove(); readings.enterView(prior);
    return { original, restored };
  });
  assert.equal(multiTable.original.tables.length, 2);
  assert.deepEqual(multiTable.restored.tables, multiTable.original.tables, 'each mounted table independently restores its own search and filters');
  assert(!JSON.stringify(multiTable.original).includes('synthetic-first'), 'saved multi-table readings contain no source rows');
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
  await returning.locator(`#tabbar-mount [data-tab-id="${view.id}"]`).waitFor().catch(async error => {
    console.error('Warm workspace upgrade', await returning.evaluate(async () => ({
      controller: navigator.serviceWorker.controller?.scriptURL,
      registrations: (await navigator.serviceWorker.getRegistrations()).map(reg => ({ active: reg.active?.state, installing: reg.installing?.state, waiting: reg.waiting?.state })),
      caches: await caches.keys(), tabs: [...document.querySelectorAll('#tabbar-mount [data-tab-id]')].map(tab => tab.dataset.tabId),
      status: (await import('/js/core/workspace.js')).status(),
    })), errors);
    throw error;
  });
  await returning.locator(`#tabbar-mount [data-tab-id="${view.id}"]`).click();
  await returning.getByRole('heading', { name: 'Fundraising', exact: true }).waitFor(); await ready(returning);
  assert.equal((await returning.locator('table[data-shared-column-layout="corp-announcements"] thead th').first().textContent()).trim(), 'Company', 'warm cache upgrade receives Company-first shared columns');
  assert.deepEqual(await returning.evaluate(() => window.query.query().categories), ['capital-raise']);
  assert(!(await returning.evaluate(() => caches.keys())).some(key => key.includes('previous-shared-workspace')));
  assert.deepEqual(errors, []); await warm.close();
  console.log('PASS returning controlled dashboard upgrades its immutable modules and restores shared tabs with their live filters');
} finally { await browser.close(); await server.close(); rmSync(folder, { recursive: true, force: true }); }
