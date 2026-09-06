#!/usr/bin/env node
// Actual browser adapters + saved public portfolio. This verifies retrieval,
// never model prose, authenticated customer allocations or live-source coverage.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { researchQuestionBank } from './lib/research-questions.mjs';
import { researchLocalBrowser } from './lib/research-local-browser.mjs';
import { validateResearchBody } from '../worker/research.mjs';
const book = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url)));
const cases = researchQuestionBank(book.holdings).filter(c => ['latest', 'earnings', 'filings'].includes(c.category));
const { page, close } = await researchLocalBrowser();
const results = [], errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  for (const test of cases) {
    const started = Date.now();
    const packet = await page.evaluate(async question => research.buildResearchEvidence({ question, scope: 'portfolio', prepared }), test.question);
    const packetMs = Date.now() - started;
    const failures = [];
    const target = book.holdings.find(h => h.isin === test.id.split(':')[0]);
    if (!packet.selection.companies.some(c => target.ticker ? c.ticker === target.ticker : c.isin === target.isin)) failures.push('company_not_resolved');
    if (packet.selection.companies.some(c => target.ticker ? c.ticker !== target.ticker : c.isin !== target.isin)) failures.push('unrequested_company_selected');
    // This suite has no authenticated Family book. Validate the bounded packet
    // with a neutral question, separately from the company-selection assertions.
    const bounds = validateResearchBody({ question: 'Summarise the available company evidence.', evidence: packet });
    if (!bounds.ok) failures.push(`packet_${bounds.error}`);
    const clean = value => String(value || '').toLowerCase().replace(/^the\s+/, '').replace(/\b(limited|ltd)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const sources = packet.sources.map(s => ({ id: s.id, status: s.status, companyRows: s.companyRows || 0, included: s.includedRows,
      companyIncluded: s.rows.filter(r => target.ticker && r.ticker ? r.ticker === target.ticker : r.isin === target.isin || [target.name, target.bookName, target.matchedName, ...packet.selection.companies.map(c => c.name)].filter(Boolean).some(name => clean(r.company) === clean(name))).length }));
    for (const s of sources) if (s.companyRows > 0 && !s.companyIncluded) failures.push(`${s.id}_company_rows_lost`);
    // Independent source-store oracle: a confirmed article must survive when
    // present, even if the adapter accidentally reports companyRows = 0.
    const confirmed = await page.evaluate(async target => {
      const { news } = await import('/js/data/filings.js');
      const { attributionFor } = await import('/js/data/company-news-attribution.js');
      return news.rows().filter(r => { const a = attributionFor(r); return a.status === 'confirmed' && (target.ticker ? a.companyTicker === target.ticker : a.companyName === target.name); }).length;
    }, target);
    if (confirmed && !packet.sources.find(s => s.id === 'company-news').rows.some(r => r.attribution === 'confirmed' && (target.ticker ? r.ticker === target.ticker : r.company === target.name))) failures.push('confirmed_news_not_retrieved');
    results.push({ id: test.id, company: test.company, category: test.category, elapsedMs: packetMs, selected: packet.selection.companies, confirmedNewsAvailable: confirmed, sources, failures });
    if (results.length % 50 === 0) console.log(`Checked ${results.length}/${cases.length} portfolio packets`);
  }
  const failed = results.filter(r => r.failures.length);
  const times = results.map(r => r.elapsedMs).sort((a, b) => a - b);
  const report = { kind: 'local-snapshot-retrieval', generatedAt: new Date().toISOString(), companies: book.holdings.length, scenarios: results.length, packetP95Ms: times[Math.ceil(times.length * .95) - 1],
    passed: failed.length === 0 && !errors.length, failures: failed.length, browserErrors: errors, results };
  if (process.env.RESEARCH_REPORT_PATH) writeFileSync(process.env.RESEARCH_REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, results: failed.slice(0, 30) }, null, 2));
  assert.equal(failed.length, 0, 'every portfolio company retains its identity and available source evidence');
  assert.deepEqual(errors, []);
} finally { await close(); }
