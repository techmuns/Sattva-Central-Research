#!/usr/bin/env node
// Run against a local static server, using the same external Playwright install as verify-ui.mjs.
// No production requests: remote services and local Worker APIs are stubbed for this UI check.
import assert from 'node:assert/strict';

const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(BASE).hostname), 'Use a local test server');
const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = await import(`${PW_ROOT}/index.mjs`);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.origin === new URL(BASE).origin && !url.pathname.startsWith('/api/')) return route.continue();
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const strip = '#tabbar-mount [data-tab-list]';
const active = `${strip} [aria-selected="true"]`;
const previous = page.locator('#tabbar-mount [data-tab-scroll="-1"]');
const next = page.locator('#tabbar-mount [data-tab-scroll="1"]');
const pass = (label) => console.log(`PASS  ${label}`);
const visibleInStrip = async (selector) => {
  await page.waitForFunction(({ strip, selector }) => {
    const list = document.querySelector(strip).getBoundingClientRect();
    const button = document.querySelector(selector)?.getBoundingClientRect();
    return button && button.left >= list.left - 1 && button.right <= list.right + 1;
  }, { strip, selector });
};
const noOverflow = async () => {
  const metrics = await page.locator(strip).evaluate((list) => ({
    height: list.clientHeight, scrollHeight: list.scrollHeight,
    overflowY: getComputedStyle(list).overflowY,
    scrollbar: getComputedStyle(list).scrollbarWidth,
    webkitScrollbar: getComputedStyle(list, '::-webkit-scrollbar').display,
    pageWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(metrics.height, metrics.scrollHeight, 'The tab strip must not overflow vertically');
  assert.equal(metrics.overflowY, 'hidden');
  assert.equal(metrics.scrollbar, 'none');
  assert.equal(metrics.webkitScrollbar, 'none');
  assert(metrics.scrollWidth <= metrics.pageWidth, 'The page must not overflow horizontally');
};

try {
  await page.goto(`${BASE}/#/research/news?scope=watchlist`);
  await page.locator(active).waitFor();
  await visibleInStrip(active);
  await noOverflow();
  pass('News deep link reveals the active tab without either scrollbar');

  // The actual shell must preserve the element, its scroll position, and focus across routes.
  await page.evaluate((selector) => { window.navigationList = document.querySelector(selector); }, strip);
  await page.locator(active).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator(active).getAttribute('data-tab-id'), 'news', 'Arrows must not load a new page');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.includes('/corp-announcements'));
  await page.locator(`${strip} [data-tab-id="corp-announcements"][aria-selected="true"]`).waitFor();
  await visibleInStrip(active);
  assert(await page.evaluate((selector) => window.navigationList === document.querySelector(selector), strip));
  assert(await page.locator(active).evaluate((button) => document.activeElement === button));
  assert((await page.locator(strip).evaluate((list) => list.scrollLeft)) > 0);
  assert.equal(await page.locator(`${strip} [tabindex="0"]`).count(), 1);
  pass('Keyboard activation preserves the mounted strip, focus, and horizontal position');

  await page.keyboard.press('End');
  await visibleInStrip(`${strip} [data-tab-id="insider-trades"]`);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tabId), 'insider-trades');
  await page.keyboard.press('ArrowRight');
  await visibleInStrip(`${strip} [data-tab-id="ask-research"]`);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tabId), 'ask-research');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tabId), 'insider-trades');
  await page.keyboard.press('Home');
  await visibleInStrip(`${strip} [data-tab-id="ask-research"]`);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => location.hash.includes('/ask-research'));
  await page.locator(`${strip} [data-tab-id="ask-research"][aria-selected="true"]`).waitFor();
  pass('Home, End, wrapping arrow keys, Enter and Space work with manual activation');

  await page.waitForFunction(() => document.querySelector('#tabbar-mount [data-tab-scroll="-1"]').disabled);
  await next.click();
  await page.waitForFunction((selector) => document.querySelector(selector).scrollLeft > 30, strip);
  await page.waitForFunction(() => !document.querySelector('#tabbar-mount [data-tab-scroll="-1"]').disabled);
  assert(await page.locator('#tabbar-mount [data-tab-scroll-controls]').isVisible());
  await page.locator(strip).evaluate((list) => list.scrollTo({ left: list.scrollWidth, behavior: 'instant' }));
  await page.waitForFunction(() => document.querySelector('#tabbar-mount [data-tab-scroll="1"]').disabled);
  await previous.click();
  await page.waitForFunction((selector) => {
    const list = document.querySelector(selector);
    return list.scrollLeft < list.scrollWidth - list.clientWidth - 30;
  }, strip);
  pass('Overflow buttons scroll in both directions and disable at the ends');

  // Keep the off-screen active tab in view after browser history and viewport changes.
  await page.goBack();
  await page.waitForFunction(() => location.hash.includes('/corp-announcements'));
  await page.locator(`${strip} [data-tab-id="corp-announcements"][aria-selected="true"]`).waitFor();
  for (const width of [1440, 1100, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await visibleInStrip(active);
    await noOverflow();
    pass(`Active tab and page layout remain usable at ${width}px`);
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator(active).focus();
  await page.keyboard.press('End');
  await visibleInStrip(`${strip} [data-tab-id="insider-trades"]`);
  assert((await page.locator(active).evaluate((button) => parseFloat(getComputedStyle(button).transitionDuration))) <= 0.00001);
  pass('Reduced motion removes the animation while keeping navigation functional');

  // An independent short strip exercises the shared primitive's fit threshold and cleanup.
  await page.evaluate(async () => {
    const { tabBar } = await import('/js/ui/components.js');
    const root = document.createElement('div');
    root.id = 'navigation-fixture';
    root.style.width = '170px';
    document.body.append(root);
    window.fixtureSelections = [];
    const bar = tabBar({
      tabs: [{ id: 'one', label: 'Overview' }, { id: 'two', label: 'All positions' }],
      activeId: 'one', onSelect: (id) => window.fixtureSelections.push(id),
    });
    root.innerHTML = bar.html;
    window.disposeFixture = bar.wire(root);
  });
  const fixtureControls = page.locator('#navigation-fixture [data-tab-scroll-controls]');
  assert(await fixtureControls.isVisible());
  await page.locator('#navigation-fixture').evaluate((root) => { root.style.width = '260px'; });
  await page.waitForFunction(() => document.querySelector('#navigation-fixture [data-tab-scroll-controls]').hidden);
  assert(!(await fixtureControls.isVisible()));
  await page.evaluate(() => window.disposeFixture());
  await page.locator('#navigation-fixture [data-tab-id="two"]').click();
  assert.deepEqual(await page.evaluate(() => window.fixtureSelections), []);
  await page.locator('#navigation-fixture').evaluate((root) => root.remove());
  pass('Shared section tabs release control space when they fit and remove listeners on disposal');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  pass('No uncaught browser errors');
} finally {
  await browser.close();
}
