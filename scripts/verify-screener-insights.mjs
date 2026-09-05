#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseScreenerInsightsPage } from './lib/screener-insights.mjs';
import { buildInsightInventory } from './lib/screener-insights-inventory.mjs';
import {
  mergeScreenerInsightsCapture,
  SCREENER_INSIGHTS_ARTIFACT,
  screenerInsightKey,
  screenerInsightIdentity,
  screenerInsightHealth,
  validateScreenerInsightsCapture,
} from '../public/js/data/screener-insights-shared.js';
import { enrichCardFromAllAlerts, insightEvents } from '../public/js/data/intelligence-graph.js';
import { readScreenerInsightsCollector } from '../worker/screener-insights-collector.mjs';

const cell = ({ value, title = 'Presentation - 24 Apr 2026', quote = 'Mine production 200 100', page = '35' }) => `<td>
  <span class="inline-flex flex-align-center"><span>${value}</span><span class="tooltip">
    <span class="font-weight-500">${title}</span><span class="ink-700">“${quote}”</span>
    Page ${page} · <a href="https://www.bseindia.com/source.pdf#page=${page}">Source</a>
  </span></span></td>`;
const table = (periodicity, rows) => `<div id="${periodicity}-insights"><div><table><thead><tr><th></th>
  <th data-date-key="2026-03-31">Mar 2026</th><th data-date-key="2026-06-30">Jun 2026</th>
  </tr></thead><tbody>${rows}</tbody></table></div></div>`;
const html = `<main><section id="insights"><h2>Insights</h2>
  <button data-url="/insights/company/1596/quarter/" data-tab-id="quarterly-insights"></button>
  ${table('yearly', `<tr><td>Pellet Plant Production<br><span class="sub">MT</span></td>${cell({ value: '1,100' })}${cell({ value: '1,250' })}</tr>`)}
  ${table('quarterly', `<tr><td>Chhotedongar Iron Ore Mine Production<br><span class="sub">MT</span></td>${cell({ value: '100' })}${cell({ value: '200' })}</tr>
    <tr><td>Blank metric<br><span class="sub">MT</span></td><td>—</td><td>-</td></tr>`)}
  </section></main>`;

const parsed = parseScreenerInsightsPage(html);
assert.equal(parsed.available, true);
assert.equal(parsed.companyId, '1596');
assert.equal(parsed.rows.length, 2);
assert.deepEqual(parsed.rows.map((row) => [row.periodicity, row.metric, row.unit]), [
  ['yearly', 'Pellet Plant Production', 'MT'],
  ['quarterly', 'Chhotedongar Iron Ore Mine Production', 'MT'],
]);
assert.equal(parsed.rows[1].values[1].numeric, 200);
assert.equal(parsed.rows[1].values[1].source.page, '35');
assert.equal(parsed.rows[1].values[1].source.url, 'https://www.bseindia.com/source.pdf#page=35');
assert.deepEqual(parseScreenerInsightsPage('<main>No insights</main>'), { available: false, companyId: null, rows: [] });

const checkedAt = '2026-09-05T01:00:00.000Z';
const company = {
  companyKey: 'JAYNECOIND', ticker: 'JAYNECOIND', name: 'Jayaswal Neco',
  companyUrl: 'https://www.screener.in/company/JAYNECOIND/', inPortfolio: true, inUniverse: true,
  checkedAt,
  rows: parsed.rows.map((row) => ({ ...row, id: screenerInsightKey({ companyKey: 'JAYNECOIND', ...row }) })),
};
const capture = validateScreenerInsightsCapture({
  version: 1, sourceId: 'screener-insights', checkedAt, targetCount: 1, checkedCount: 1,
  failedCount: 0, fullCoverage: true, targetKeys: ['JAYNECOIND'], companies: [company],
}, Date.parse('2026-09-05T02:00:00.000Z'));
assert.equal(capture.companies[0].rows.length, 2);
assert.throws(() => validateScreenerInsightsCapture({ ...capture, targetKeys: ['OTHER'] }));
assert.throws(() => validateScreenerInsightsCapture({ ...capture, companies: [{ ...company, companyUrl: 'https://evil.example/company/JAYNECOIND/' }] }));

const partial = {
  ...capture,
  checkedAt: '2026-09-06T01:00:00.000Z',
  checkedCount: 1,
  failedCount: 1,
  fullCoverage: false,
  companies: [],
};
const restored = mergeScreenerInsightsCapture(partial, capture, Date.parse('2026-09-06T02:00:00.000Z'));
assert.equal(restored.companies.length, 1, 'a failed incremental read retains the last valid company series');
assert.equal(restored.fullCoverage, false, 'the latest failure remains explicit');

const seriesEvents = insightEvents([company], '2026-09-05');
const mine = seriesEvents.find((event) => event.metric.startsWith('Chhotedongar'));
assert.equal(mine.day, '2026-06-30');
assert.equal(mine.changePct, 100);
assert.equal(mine.aiEligible, false);
const percentSeries = { ...company, rows: [{ ...company.rows[0], unit: '%', values: company.rows[0].values.map((point, i) => ({ ...point, numeric: i ? 40 : 20, value: i ? '40' : '20' })) }] };
const percentEvent = insightEvents([percentSeries], '2026-09-05')[0];
assert.equal(percentEvent.changePct, null);
assert.equal(percentEvent.changePoints, 20);
assert.match(percentEvent.detail, /20\.0 percentage points/);
const negativeBase = { ...company, rows: [{ ...company.rows[0], values: company.rows[0].values.map((point, i) => ({ ...point, numeric: i ? 100 : -50 })) }] };
assert.equal(insightEvents([negativeBase], '2026-09-05')[0].changePct, null);

const trigger = {
  id: 'news-1', ticker: 'JAYNECOIND', company: 'Jayaswal Neco', feed: 'news', feedLabel: 'Company news',
  day: '2026-09-05', headline: 'Jayaswal Neco mine production controversy', detail: '',
  keywordIds: ['investigation'], keywords: ['Investigation'], direction: 'neutral', importance: 'high',
};
const rawFiling = {
  id: 'nse-1', ticker: 'JAYNECOIND', company: 'Jayaswal Neco', feed: 'nse-filings', feedLabel: 'NSE filings',
  day: '2026-09-05', headline: 'Mine production clarification filed', detail: '', kind: 'filing', aiEligible: false,
  direction: 'neutral', importance: 'low',
};
const scheduled = {
  id: 'agm-1', ticker: 'JAYNECOIND', company: 'Jayaswal Neco', feed: 'screener-portfolio-upcoming', feedLabel: 'Portfolio calendar',
  day: '2026-09-12', headline: 'AGM scheduled', detail: '', kind: 'scheduled', aiEligible: false,
  direction: 'neutral', importance: 'low',
};
const report = {
  day: '2026-09-05', events: [trigger, rawFiling, scheduled],
  feeds: ['news', 'nse-filings', 'screener-portfolio-upcoming'].map((id) => ({ id, status: 'ok', reachesToday: true })),
};
const card = { ticker: 'JAYNECOIND', events: [trigger] };
const enriched = enrichCardFromAllAlerts(card, report, { insightCompanies: [company] });
assert.equal(enriched.contextEvents[0].id, 'nse-1', 'same-day source document leads slower business context');
assert(enriched.contextEvents.some((event) => event.feed === 'screener-insights'), 'topic-matched operating series enriches the alert');
assert.equal(enriched.upcomingEvents[0].id, 'agm-1');
assert.match(enriched.contextSummary, /Related context/);
assert.equal(card.contextEvents, undefined, 'the pure enrichment does not mutate its input');

const unrelated = enrichCardFromAllAlerts({ ...card, events: [{ ...trigger, headline: 'Defence procurement arbitration', keywords: ['Arbitration'] }] }, {
  ...report,
  events: [{ ...trigger, headline: 'Defence procurement arbitration', keywords: ['Arbitration'] }],
}, { insightCompanies: [company] });
assert.equal(unrelated.contextEvents.length, 0, 'a large but unrelated operating metric does not clutter a news alert');

const many = Array.from({ length: 10 }, (_, i) => ({ ...rawFiling, id: `filing-${i}`, headline: `Mine production clarification document ${i}`, feed: `filing-${i % 3}` }));
const dense = enrichCardFromAllAlerts(card, { ...report, events: many, feeds: [0, 1, 2].map((i) => ({ id: `filing-${i}`, status: 'ok' })) });
assert.equal(dense.contextEvents.length, 3, 'three distinct feeds must not overflow the second selection pass');
assert.equal(new Set(dense.contextEvents.map((event) => event.feed)).size, 3);
const duplicateDocs = enrichCardFromAllAlerts(card, { ...report, events: [
  { ...rawFiling, url: 'https://exchange.test/doc.pdf?utm_source=feed#page=2' },
  { ...rawFiling, id: 'copy-2', feed: 'news', headline: 'Another mine production clarification', url: 'https://exchange.test/doc.pdf' },
] });
assert.equal(duplicateDocs.contextEvents.length, 1, 'one underlying document cannot consume several context slots');
const candidateNews = { ...rawFiling, feed: 'news', headline: 'Mine production clarification from company', kind: 'news' };
assert.equal(enrichCardFromAllAlerts(card, { ...report, events: [candidateNews] }).contextEvents.length, 0, 'old cached news without confirmed attribution cannot provide context');
assert.equal(enrichCardFromAllAlerts(card, { ...report, events: [{ ...candidateNews, attribution: { version: 1, status: 'confirmed' } }] }).contextEvents.length, 1);
assert.equal(enrichCardFromAllAlerts(card, { ...report, events: [{ ...candidateNews, attribution: { version: 1, status: 'uncertain' } }] }).contextEvents.length, 0);
const singleFeed = enrichCardFromAllAlerts(card, { ...report, events: many.map((event) => ({ ...event, feed: 'nse-filings' })) });
assert.equal(singleFeed.contextEvents.length, 3, 'one feed still fills the bounded context budget');
const falseMatch = enrichCardFromAllAlerts(card, { ...report, events: [{ ...rawFiling, headline: 'Jayaswal Neco board appoints a director' }] });
assert.equal(falseMatch.contextEvents.length, 0, 'same company and same date alone do not establish event relevance');
assert.equal(enrichCardFromAllAlerts({ ticker: null, events: [trigger] }, { ...report, events: [{ ...rawFiling, ticker: null }] }).contextEvents.length, 0, 'unresolved entities must not correlate through a blank ticker');
assert.equal(enrichCardFromAllAlerts({ ticker: 'JAYNECOIND', events: [] }, report).contextEvents.length, 0);
const calendar = enrichCardFromAllAlerts(card, { ...report, events: [20, 3, 10].map((days) => ({ ...scheduled, id: `calendar-${days}`, headline: `Milestone ${days}`, day: `2026-09-${String(days + 5).padStart(2, '0')}` })) });
assert.deepEqual(calendar.upcomingEvents.map((event) => event.day), ['2026-09-08', '2026-09-15'], 'nearest milestones come first independently of context rank');

assert.deepEqual(screenerInsightIdentity('https://www.screener.in/company/id/1286088/consolidated/'), { companyKey: 'ID:1286088', ticker: null, companyUrl: 'https://www.screener.in/company/id/1286088/' });
assert.equal(screenerInsightIdentity('/company/543619/').ticker, null);
for (const url of ['/company/id/ABC/', '/company/%ZZ/', '/company/A/?secret=1', 'https://evil.test/company/A/']) assert.equal(screenerInsightIdentity(url), null);
const internalCompany = { ...company, ...screenerInsightIdentity('/company/id/1286088/'), name: 'Internal ID company' };
assert.doesNotThrow(() => validateScreenerInsightsCapture({ ...capture, companies: [internalCompany], targetKeys: [internalCompany.companyKey] }, Date.parse(checkedAt)));
const inventory = buildInsightInventory([
  { Company: 'Internal universe company', 'Screener URL': '/company/id/1286088/consolidated/' },
  { Company: 'Jayaswal Neco', 'Screener URL': '/company/JAYNECOIND/' },
], [{ isin: 'INE000000001', name: 'Name without exchange codes', nseCode: '', bseCode: '' }], [{ href: '/company/id/1274211/', name: 'Retained company' }]);
assert.equal(inventory.size, 3, 'a codeless watchlist company and internal universe ID both survive inventory');
assert.equal(inventory.get('ID:1274211').inPortfolio, true);
assert.throws(() => buildInsightInventory([{ Company: 'Bad', 'Screener URL': '/login/' }], [{}], [{ href: '/company/A/', name: 'A' }]), /inventory-identity/);
assert.throws(() => buildInsightInventory([{ Company: 'A', 'Screener URL': '/company/A/' }], [{}, {}], [{ href: '/company/B/', name: 'B' }]), /inventory-count/);
const actualUniverse = JSON.parse(readFileSync(new URL('../public/data/universe.json', import.meta.url), 'utf8'));
const spanRecords = [
  { isin: 'INE000000001', name: 'Jayaswal Neco Industries', nseCode: 'JAYNECOIND', bseCode: '522285' },
  { isin: 'INE000000002', name: 'BSE Only', nseCode: '', bseCode: '543619' },
  { isin: 'INE000000003', name: 'Delisted', nseCode: '', bseCode: '' },
];
const spanRows = [
  { companyId: '1596', href: '', name: 'Jayaswal Neco Industries Ltd' },
  { companyId: '90001', href: '', name: 'BSE Only Limited' },
  { companyId: '90002', href: '', name: 'Delisted Ltd' },
];
const spanInventory = buildInsightInventory(actualUniverse, spanRecords, spanRows);
assert.equal(spanInventory.get('JAYNECOIND').ticker, 'JAYNECOIND', 'span-only row uses the exact exported NSE identity');
assert.equal(spanInventory.get('543619').ticker, null, 'exported BSE code is not an NSE ticker');
assert.equal(spanInventory.get('ID:90002').isin, 'INE000000003', 'codeless company keeps its exact exported ISIN and namespaced ID');
assert.equal(spanInventory.get('JAYNECOIND').inPortfolio, true);
assert.equal([...spanInventory.values()].filter(row => row.inUniverse).length, new Set(actualUniverse.map(row => screenerInsightIdentity(row['Screener URL']).companyKey)).size, 'the checked-in universe also survives real-shape inventory construction');
assert.throws(() => buildInsightInventory(actualUniverse, spanRecords, spanRows.map((row, i) => i === 1 ? { ...row, companyId: '1596' } : row)), /inventory-company-id/);
assert.throws(() => buildInsightInventory(actualUniverse, spanRecords, spanRows.map((row, i) => i === 0 ? { ...row, companyId: '' } : row)), /inventory-company-id/);
assert.throws(() => buildInsightInventory(actualUniverse, spanRecords, spanRows.map((row, i) => i === 0 ? { ...row, name: 'Unknown company' } : row)), /inventory-export-match/);
assert.throws(() => buildInsightInventory(actualUniverse, spanRecords.map((row, i) => i === 1 ? { ...row, name: spanRecords[0].name } : row), spanRows), /inventory-export-match/);
assert.throws(() => buildInsightInventory(actualUniverse, spanRecords, spanRows.map((row, i) => i === 1 ? { ...row, name: spanRows[0].name } : row)), /inventory-export-match/);
assert.throws(() => buildInsightInventory(actualUniverse, spanRecords, spanRows.map((row, i) => i === 0 ? { ...row, href: 'https://evil.test/company/JAYNECOIND/' } : row)), /inventory-identity/);

assert.equal(screenerInsightHealth(company, Date.parse('2026-09-07')), 'stale');
assert.equal(insightEvents([{ ...company, checkedAt: '2026-09-05T17:30:00Z' }], '2026-09-05')[0].sourceStatus, 'ok', 'late Indian-day captures are not future-dated relative to an arbitrary noon clock');
assert.equal(screenerInsightHealth({ ...company, inPortfolio: false }, Date.parse('2026-09-07')), 'ok');
const failedRead = mergeScreenerInsightsCapture({ ...partial, checkedCount: 1, failedKeys: ['JAYNECOIND'] }, capture, Date.parse('2026-09-06T02:00:00Z'));
assert.equal(failedRead.companies[0].readStatus, 'failed');
assert.equal(insightEvents(failedRead.companies, '2026-09-06')[0].sourceStatus, 'failed');
assert.equal(enrichCardFromAllAlerts(card, { ...report, events: [trigger] }, { insightCompanies: failedRead.companies }).contextEvents.length, 0);
assert.throws(() => validateScreenerInsightsCapture({ ...capture, failedKeys: ['UNKNOWN'] }, Date.parse(checkedAt)));
assert.throws(() => parseScreenerInsightsPage('<section id="insights"><div id="yearly-insights"></div></section>'), /table unavailable/);
assert.throws(() => parseScreenerInsightsPage(html.replace('data-date-key="2026-06-30"', 'data-removed="2026-06-30"')), /column mismatch/);

function artifactFetch({ digest = null, host = 'https://example.blob.core.windows.net/capture', event = 'schedule' } = {}) {
  const bytes = gzipSync(JSON.stringify(capture));
  const goodDigest = createHash('sha256').update(bytes).digest('hex');
  const run = { id: 10, head_branch: 'main', head_repository: { full_name: 'techmuns/Sattva-Central-Research' }, event, status: 'completed', conclusion: 'success' };
  return async (url, init = {}) => {
    if (!url.startsWith('https://api.github.com/')) {
      assert.equal(init.headers, undefined, 'the GitHub credential is never forwarded to the signed artifact host');
      return new Response(bytes);
    }
    if (url.includes('/runs?')) return Response.json({ total_count: 1, workflow_runs: [run] });
    if (url.includes('/runs/10/artifacts')) return Response.json({ artifacts: [{ id: 20, name: SCREENER_INSIGHTS_ARTIFACT, expired: false, workflow_run: { id: 10 }, size_in_bytes: bytes.length, digest: `sha256:${digest || goodDigest}` }] });
    if (url.endsWith('/artifacts/20/zip')) return new Response(null, { status: 302, headers: { location: host } });
    throw Error(`Unexpected test URL ${url}`);
  };
}

const artifact = await readScreenerInsightsCollector({ token: 'test-token', now: () => Date.parse(checkedAt), fetcher: artifactFetch() });
assert.equal(artifact.capture.companies.length, 1);
for (const options of [{ digest: '0'.repeat(64) }, { host: 'https://evil.test/capture' }, { event: 'pull_request' }]) {
  await assert.rejects(readScreenerInsightsCollector({ token: 'test-token', now: () => Date.parse(checkedAt), fetcher: artifactFetch(options) }));
}

const workflow = readFileSync(new URL('../.github/workflows/screener-insights-refresh.yml', import.meta.url), 'utf8');
const collector = readFileSync(new URL('./collect-screener-insights.mjs', import.meta.url), 'utf8');
assert.match(workflow, /SCREENER_USERNAME: \$\{\{ secrets\.SCREENER_USERNAME \}\}/);
assert.match(workflow, /actions\/upload-artifact@v7/);
assert.match(workflow, /archive:\s*false/);
assert.doesNotMatch(workflow, /git push|contents:\s*write/);
assert.match(collector, /delete process\.env\.SCREENER_PASSWORD/);
assert.match(collector, /inPortfolio \|\| hashBucket/);
assert.match(collector, /parseWatchlistExport/, 'portfolio coverage comes from Screener\'s complete watchlist export');
assert.doesNotMatch(collector, /locator\('a\[href\^="\/company\/"\]'\)\.evaluateAll/, 'the collector must not infer full portfolio coverage from rendered page links');
assert.doesNotMatch(collector, /console\.(?:log|error)\([^\n]*(?:item\.|companyUrl|company\.name)/);

console.log('PASS: source-backed Screener series parsing, validation, incremental retention, context-only correlation and collector privacy.');
