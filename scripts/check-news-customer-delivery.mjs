#!/usr/bin/env node
// Read-only, real-browser delivery probe. Only same-origin public GET assets may leave the
// browser. No API reads, inference, authentication, capture dispatches or production mutations.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkNewsCustomerDelivery({ base = null, publicDir = fileURLToPath(new URL('../public', import.meta.url)),
  now = Date.now(), timeoutMs = 180000, chromium = null } = {}) {
  let server, browser, deadline;
  const failures = [], blocked = { api: 0, external: 0, writes: 0 };
  try {
    if (!chromium) ({ chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`));
    if (base) {
      const url = new URL(base);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
          !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw Error('invalid-delivery-origin');
      base = url.origin;
    } else {
      const root = resolve(publicDir);
      server = createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        const file = resolve(root, `.${pathname}`);
        if (req.method !== 'GET' || !file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
        try {
          res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[extname(file)] || 'application/octet-stream');
          res.end(readFileSync(file));
        } catch { res.writeHead(404); res.end('{}'); }
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      base = `http://127.0.0.1:${server.address().port}`;
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      let reason = null;
      if (request.method() !== 'GET') reason = 'writes';
      else if (url.origin !== base) reason = 'external';
      else if (url.pathname.startsWith('/api/') || !/^\/(?:js|data|css)\//.test(url.pathname) && url.pathname !== '/__news_delivery_probe__') reason = 'api';
      if (reason) {
        blocked[reason]++;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"reason":"read-only-delivery-probe"}' });
      }
      if (url.pathname === '/__news_delivery_probe__') return route.fulfill({ contentType: 'text/html',
        body: '<!doctype html><title>Read-only news delivery probe</title>' });
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', () => { failures.push({ code: 'browser-runtime-error' }); });
    await page.clock.install({ time: new Date(now) });
    await page.goto(`${base}/__news_delivery_probe__`);
    const result = await Promise.race([page.evaluate(async () => {
      const findings = [];
      const read = async path => { const response = await fetch(path, { cache: 'no-cache' }); if (!response.ok) throw Error('portfolio-capture-unavailable'); return response.json(); };
      const portfolio = await read('/data/portfolio-companies.json');
      if (!Array.isArray(portfolio.holdings)) throw Error('portfolio-capture-invalid');
      const coverage = await import('/js/data/coverage.js');
      coverage.prime(portfolio);
      const { news } = await import('/js/data/filings.js');
      const alerts = await import('/js/data/daily-alerts.js');
      const { filterCompanyNewsByScope } = await import('/js/data/company-news-identity.js');
      const { newsSearchText } = await import('/js/data/company-news-attribution.js');
      const { canonicalArticleUrl, anonymousArticleContentKey } = await import('/js/data/filings-shared.js');
      const { rankReport } = await import('/js/data/ai-alerts.js');
      const loaded = await alerts.prepareSources({ feedIds: ['news', 'market-news'] });
      if (loaded.some(result => result.status === 'rejected')) findings.push({ code: 'news-source-load-failed' });
      const holdings = coverage.holdings(), day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const report = await alerts.collect({ scope: 'portfolio', holdings, day, includeHistory: true, load: false });
      const rows = filterCompanyNewsByScope(news.rows(), 'portfolio', holdings);
      const meta = news.meta();
      const enrichment = meta.enrichmentCoverage;
      const enrichmentComplete = enrichment && Number.isFinite(Date.parse(enrichment.capturedAt)) &&
        Date.parse(enrichment.capturedAt) <= Date.now() + 600000 && Date.now() - Date.parse(enrichment.capturedAt) <= 24 * 3600000 &&
        enrichment.staleOrIncompleteQueries === 0 && enrichment.pagesFailed === 0 &&
        (!Object.hasOwn(enrichment, 'documentsPending') || enrichment.documentsPending === 0);
      if (!enrichmentComplete) findings.push({ code: 'upstream-enrichment-incomplete', source: 'global-and-official-websites' });
      for (const family of ['core', 'publishers', 'tradingView']) {
        const part = meta.newsDelivery?.[family];
        if (!part || part.status !== 'ok' || part.pending || part.historyPending || part.historyError)
          findings.push({ code: !part || part.status === 'pending' || part.pending ? 'source-pending' : 'source-incomplete', source: family });
      }
      if (!meta.newsHistory?.loaded || meta.newsHistory?.pending || meta.newsHistory?.error) findings.push({ code: 'retained-history-incomplete' });
      for (const family of ['news', 'market-news']) if (report.feeds.find(feed => feed.id === family)?.status !== 'ok') findings.push({ code: 'alerts-news-feed-incomplete', source: family });
      const identity = row => String(row.ticker || row.entityId || '').toUpperCase();
      const recordKey = row => `${identity(row)}|${row.url ? canonicalArticleUrl(row.url) : anonymousArticleContentKey(row)}`;
      const newsEvents = report.events.filter(event => event.feed === 'news' || event.feed === 'market-news');
      const delivered = new Set(newsEvents.map(event => recordKey(event.sourceRecord || event)));
      const missing = rows.filter(row => !delivered.has(recordKey(row)));
      if (missing.length) findings.push({ code: 'portfolio-news-not-in-all-alerts', count: missing.length });
      const missingGroups = new Map();
      for (const row of missing) {
        const key = JSON.stringify([row.ticker || null, row.entityId || null]);
        missingGroups.set(key, (missingGroups.get(key) || 0) + 1);
      }
      const exact = 'economictimes.indiatimes.com/markets/stocks/news/jm-financial-initiates-coverage-on-onemi-technology-with-buy-call-sees-28-upside/articleshow/133755070.cms';
      const isStory = row => canonicalArticleUrl(row.url) === exact;
      const isHeld = holdings.some(h => String(h.ticker).toUpperCase() === 'KISSHT' || h.isin === 'INE12F801023');
      let onemi = { held: isHeld, news: null, allAlerts: null, aiEligibleByAge: false, aiCandidate: null };
      if (isHeld) {
        const newsHit = rows.find(isStory), event = newsEvents.find(isStory);
        onemi.news = !!newsHit && ['kissht', 'onemi technology'].every(term => newsSearchText(newsHit).toLowerCase().includes(term));
        onemi.allAlerts = !!event && ['kissht', 'onemi technology'].every(term => alerts.eventSearchText(event).toLowerCase().includes(term));
        if (!onemi.news) findings.push({ code: 'onemi-et-not-searchable-in-news' });
        if (!onemi.allAlerts) findings.push({ code: 'onemi-et-not-searchable-in-all-alerts' });
        const age = Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse('2026-09-04T00:00:00Z')) / 86400000);
        onemi.aiEligibleByAge = age >= 0 && age < 14;
        if (onemi.aiEligibleByAge) {
          const ranked = rankReport(report, { holdings, insightCompanies: [] });
          onemi.aiCandidate = (ranked.allCards || ranked.cards || []).some(card => card.ticker === 'KISSHT' && card.events?.some(isStory));
          if (!onemi.aiCandidate) findings.push({ code: 'onemi-et-missing-from-eligible-ai-evidence' });
        }
      }
      return { ok: !findings.length, checkedAt: new Date().toISOString(), portfolioCompanies: holdings.length,
        retainedPortfolioNews: rows.length, deliveredNewsEvents: newsEvents.length, missingPortfolioNews: missing.length,
        ...(missing.length ? { missingDiagnostics: { withUrl: missing.filter(row => row.url).length,
          groups: [...missingGroups].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, count]) => ({ identity: JSON.parse(key), count })) } } : {}),
        sourceStates: Object.fromEntries(Object.entries(meta.newsDelivery || {}).map(([key, part]) => [key, part.status])),
        captureCoverage: { globalAndOfficialWebsites: { status: enrichmentComplete ? 'ok' : 'partial',
          capturedAt: enrichment?.capturedAt || null, staleOrIncompleteQueries: enrichment?.staleOrIncompleteQueries ?? null,
          pagesFailed: enrichment?.pagesFailed ?? null, documentsPending: enrichment?.documentsPending ?? null } },
        onemi, findings,
        note: 'Published public news delivery and current saved-portfolio scope only. All Alerts retains routine/unverified records; AI is a separate 14-day materiality view. Other source families and upstream exhaustiveness are not certified.' };
    }), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('delivery-probe-timeout')), timeoutMs); })]);
    return { ...result, ok: result.ok && !failures.length, findings: [...result.findings, ...failures], blockedRequests: blocked };
  } catch (error) {
    const known = ['invalid-delivery-origin', 'delivery-probe-timeout'];
    return { ok: false, checkedAt: new Date(now).toISOString(), findings: [{ code: known.includes(error.message) ? error.message : 'customer-delivery-check-failed' }], blockedRequests: blocked };
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    if (server) await new Promise(done => server.close(done));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await checkNewsCustomerDelivery({ base: process.env.NEWS_DELIVERY_BASE || null });
  console.log(JSON.stringify(report));
  if (process.env.NEWS_DELIVERY_REPORT) writeFileSync(process.env.NEWS_DELIVERY_REPORT, JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Customer news delivery\n\n${report.ok ? 'Published news passed the browser adapter and searchability checks.' : 'Customer news delivery or source coverage is not fully verified.'}\n\n` +
    `| Check | Result |\n| --- | --- |\n| Retained portfolio news | ${report.retainedPortfolioNews ?? 'Unavailable'} |\n| News missing from All Alerts | ${report.missingPortfolioNews ?? 'Unchecked'} |\n| OnEMI Economic Times story | ${report.onemi?.held ? `News: ${report.onemi.news}; All Alerts: ${report.onemi.allAlerts}; AI age-eligible: ${report.onemi.aiEligibleByAge}; candidate: ${report.onemi.aiCandidate}` : 'Not in the saved portfolio / unchecked'} |\n\n` +
    `${report.findings.map(f => `- ${f.code}${f.source ? ` (${f.source})` : ''}${f.count != null ? `: ${f.count}` : ''}`).join('\n')}\n\nActual published browser adapters and search text, not rendered table layout. GET-only public assets; APIs and external requests blocked.\n`);
  process.exitCode = report.ok ? 0 : 1;
}
