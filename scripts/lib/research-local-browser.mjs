// Isolated, read-only dashboard source harness. All API and external requests
// fail locally; no production queries, scrapes, Family reads or inference.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function researchLocalBrowser({ intercept = null } = {}) {
  const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
  const root = fileURLToPath(new URL('../../public', import.meta.url));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/evaluation') {
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Local portfolio evaluation</title>'); return;
    }
    const file = resolve(root, `.${url.pathname}`);
    if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
    try {
      res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json' }[extname(file)] || 'text/plain');
      res.end(readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (intercept && await intercept(route, url)) return;
      if (url.origin !== origin || url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"Isolated evaluation: API unavailable"}' });
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/evaluation`);
    await page.evaluate(async () => {
      const book = await (await fetch('/data/portfolio-companies.json')).json();
      const universe = await (await fetch('/data/universe.json')).json();
      const coverage = await import('/js/data/coverage.js');
      coverage.prime(book);
      (await import('/js/core/state.js')).setData({ universe });
      window.research = await import('/js/research/estate.js');
      window.prepared = await research.prepareResearchSources();
    });
    return { page, close: async () => { await browser.close(); await new Promise(done => server.close(done)); } };
  } catch (error) {
    await browser?.close(); await new Promise(done => server.close(done)); throw error;
  }
}
