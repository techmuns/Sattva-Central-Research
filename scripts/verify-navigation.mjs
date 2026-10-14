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
// Keep the shortened parent strip overflowing so native scrolling remains exercised.
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 768, height: 800 } });
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
  assert.equal(await page.locator(active).getAttribute('data-tab-id'), 'news-section', 'Arrows must not load a new page');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.includes('/super-investors'));
  await page.locator(`${strip} [data-tab-id="super-investors"][aria-selected="true"]`).waitFor();
  await visibleInStrip(active);
  assert(await page.evaluate((selector) => window.navigationList === document.querySelector(selector), strip));
  assert(await page.locator(active).evaluate((button) => document.activeElement === button));
  assert((await page.locator(strip).evaluate((list) => list.scrollLeft)) > 0);
  assert.equal(await page.locator(`${strip} [tabindex="0"]`).count(), 1);
  pass('Keyboard activation preserves the mounted strip, focus, and horizontal position');

  await page.keyboard.press('End');
  await visibleInStrip(`${strip} [data-tab-id="super-investors"]`);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tabId), 'super-investors');
  await page.keyboard.press('ArrowRight');
  await visibleInStrip(`${strip} [data-tab-id="alerts"]`);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tabId), 'alerts');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.tabId), 'super-investors');
  await page.keyboard.press('Home');
  await visibleInStrip(`${strip} [data-tab-id="alerts"]`);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => location.hash.includes('/ai-alerts'));
  await page.locator(`${strip} [data-tab-id="alerts"][aria-selected="true"]`).waitFor();
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
  await page.waitForFunction(() => location.hash.includes('/super-investors'));
  await page.locator(`${strip} [data-tab-id="super-investors"][aria-selected="true"]`).waitFor();

  await page.locator('#tabbar-mount [data-tab-id="news-section"]').click();
  const newsChildren = '#subview-mount [data-tab-list]';
  await page.locator(`${newsChildren} [data-tab-id="news"][aria-selected="true"]`).waitFor();
  assert.deepEqual(await page.locator(`${newsChildren} [data-tab-id]`).evaluateAll(tabs =>
    tabs.map(tab => [tab.dataset.tabId, tab.textContent.trim()])),
    [['news', 'Market News'], ['public-chatter', 'Public Chatter']]);
  assert.equal(await page.locator('#tabbar-mount [data-tab-id="public-chatter"]').count(), 0);
  await page.evaluate(selector => { window.newsList = document.querySelector(selector); }, newsChildren);
  await page.locator(`${newsChildren} [data-tab-id="news"]`).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator(`${newsChildren} [aria-selected="true"]`).getAttribute('data-tab-id'), 'news');
  await page.keyboard.press('Enter');
  await page.locator(`${newsChildren} [data-tab-id="public-chatter"][aria-selected="true"]`).waitFor();
  assert(await page.evaluate(selector => window.newsList === document.querySelector(selector), newsChildren));
  assert(await page.locator(`${newsChildren} [data-tab-id="public-chatter"]`).evaluate(button => document.activeElement === button));
  const chatterUrl = page.url();
  await page.locator('#tabbar-mount [data-tab-id="news-section"]').click();
  assert.equal(page.url(), chatterUrl, 'the active News parent retains Public Chatter');
  await page.locator(`${newsChildren} [data-tab-id="public-chatter"]`).focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await page.locator(`${newsChildren} [data-tab-id="news"][aria-selected="true"]`).waitFor();
  assert.match(page.url(), /news\?scope=watchlist/);
  await page.goBack();
  await page.locator(`${newsChildren} [data-tab-id="public-chatter"][aria-selected="true"]`).waitFor();
  pass('News defaults to Market News; keyboard subtabs, empty Watchlist and saved Chatter history retain focus and scope');

  await page.evaluate(() => { location.hash = '#/research/corporate-actions?scope=watchlist'; });
  await page.locator(`${strip} [data-tab-id="announcements"][aria-selected="true"]`).waitFor();
  const children = '#subview-mount [data-tab-list]';
  const selectedChild = `${children} [aria-selected="true"]`;
  await page.locator(`${children} [data-tab-id="corporate-actions"][aria-selected="true"]`).waitFor();
  await page.evaluate(selector => { window.announcementList = document.querySelector(selector); }, children);
  await page.locator(selectedChild).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator(selectedChild).getAttribute('data-tab-id'), 'corporate-actions', 'subtab arrows must only move focus');
  await page.keyboard.press('Enter');
  await page.locator(`${children} [data-tab-id="ipos"][aria-selected="true"]`).waitFor();
  await page.locator('[data-ipo-filings] [data-score-table]').waitFor();
  assert(await page.evaluate(selector => window.announcementList === document.querySelector(selector), children));
  assert(await page.locator(selectedChild).evaluate(button => document.activeElement === button));
  assert.equal(await page.locator(`${children} [tabindex="0"]`).count(), 1);
  pass('Saved Announcements routes and keyboard subtabs preserve focus; IPOs loads with an empty watchlist');
  await page.locator(selectedChild).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator(selectedChild).getAttribute('data-tab-id'), 'ipos');
  await page.keyboard.press('Enter');
  await page.locator(`${children} [data-tab-id="insider-trades"][aria-selected="true"]`).waitFor();
  assert(await page.evaluate(selector => window.announcementList === document.querySelector(selector), children));
  assert(await page.locator(selectedChild).evaluate(button => document.activeElement === button));
  assert.equal(await page.locator(`${strip} [data-tab-id="insider-trades"]`).count(), 0);
  await page.evaluate(() => { location.hash = '#/research/insider-trades?scope=universe&range=all'; });
  await page.locator('[data-active-tab="insider-trades"]').waitFor();
  await page.waitForFunction(() => document.querySelector('#scope-toggle-mount [aria-pressed="true"]')?.textContent.trim() === 'Universe');
  const dealUrl = page.url();
  await page.locator(`${strip} [data-tab-id="announcements"]`).click();
  assert.equal(page.url(), dealUrl, 'active Announcements retains the saved deals route and period');
  await page.goBack();
  await page.waitForFunction(() => location.hash.includes('insider-trades?scope=watchlist'));
  await page.locator(`${children} [data-tab-id="insider-trades"][aria-selected="true"]`).waitFor();
  pass('Bulk/Block Deal is an Announcements subtab; keyboard activation and saved links retain scope, period and history');
  for (const width of [1440, 1100, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await visibleInStrip(active);
    await page.waitForFunction(selector => {
      const button = document.querySelector(selector).getBoundingClientRect();
      const list = document.querySelector('#subview-mount [data-tab-list]').getBoundingClientRect();
      return button.left >= list.left - 1 && button.right <= list.right + 1;
    }, selectedChild);
    await noOverflow();
    const childMetrics = await page.locator(children).evaluate(list => ({ height: list.clientHeight, scrollHeight: list.scrollHeight }));
    assert.equal(childMetrics.height, childMetrics.scrollHeight, 'subtabs must not overflow vertically');
    pass(`Active parent, subtab and page layout remain usable at ${width}px`);
  }

  await page.locator('#tabbar-mount [data-tab-id="earnings"]').click();
  await page.locator(`${children} [data-tab-id="earnings-hub"][aria-selected="true"]`).waitFor();
  await page.locator(selectedChild).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator(selectedChild).getAttribute('data-tab-id'), 'earnings-hub', 'Results stays selected until keyboard activation');
  await page.keyboard.press('Enter');
  await page.locator(`${children} [data-tab-id="concall"][aria-selected="true"]`).waitFor();
  assert(await page.locator(selectedChild).evaluate(button => document.activeElement === button));
  for (const width of [1440, 1100, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await visibleInStrip(active);
    await noOverflow();
    assert(await page.locator('#subview-mount [data-tab-scroll-controls]').isHidden(), 'Results and Concall fit without overflow controls');
    assert(await page.locator(`${children} [data-tab-id="earnings-hub"]`).isVisible());
    assert(await page.locator(selectedChild).isVisible());
  }
  pass('Earnings defaults to Results; Concall keyboard activation and both subtabs fit at 320–1440px');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator(active).focus();
  await page.keyboard.press('End');
  await visibleInStrip(`${strip} [data-tab-id="super-investors"]`);
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
  // This detached fixture tests listener disposal, not hit-testing against the floating Sources beacon.
  await page.locator('#navigation-fixture [data-tab-id="two"]').dispatchEvent('click');
  assert.deepEqual(await page.evaluate(() => window.fixtureSelections), []);
  await page.locator('#navigation-fixture').evaluate((root) => root.remove());
  pass('Shared section tabs release control space when they fit and remove listeners on disposal');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  pass('No uncaught browser errors');
} finally {
  await browser.close();
}
