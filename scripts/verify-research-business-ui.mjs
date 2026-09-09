#!/usr/bin/env node
// Whole saved dashboard regression for the customer's Sterlite peer questions.
// API and external requests are blocked; this never queries the live portfolio or model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { researchLocalBrowser } from './lib/research-local-browser.mjs';
const book = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url)));
const harness = await researchLocalBrowser();
try {
  const report = await harness.page.evaluate(async () => {
    const { providerEvidence, researchEvidenceChars } = await import('/js/research/evidence-shared.js');
    const { researchPreview } = await import('/js/research/preview.js');
    const questions = [
      'Which are my ai related stocks and how are they performing after sterlite news?',
      'the benefit that sterlite comparable business which other stocks in my portfolio have got benefit',
      'Which other portfolio stocks could benefit?',
      'Latest news on Sterlite?',
    ];
    const results = [];
    for (const question of questions) {
      const started = performance.now();
      const packet = await research.buildResearchEvidence({ question, prepared, scope: 'portfolio',
        history: [{ role: 'user', text: 'Latest Sterlite news?' }] });
      results.push({ question, ms: Math.round(performance.now() - started), chars: researchEvidenceChars(packet),
        context: providerEvidence(packet).businessContext, companies: packet.selection.companies,
        sources: packet.sources.map(s => ({ id: s.id, status: s.status, rows: s.rows.length })), preview: researchPreview(packet) });
    }
    return results;
  });
  for (const row of report.slice(0, 3)) {
    assert(row.chars <= 18000);
    assert.deepEqual(row.companies.map(c => c.ticker), ['STLTECH']);
    assert(row.context.candidates.some(c => c.ticker === 'HFCL'), `${row.question}: HFCL evidence missing`);
    assert(row.context.candidates.some(c => c.ticker === 'TEJASNET'), `${row.question}: Tejas evidence missing`);
    assert(!row.context.candidates.some(c => c.ticker === 'HDFCBANK'), 'emoji round-up must not invent a bank telecom business');
    assert(row.context.candidates.every(c => c.ticker !== 'STLTECH'));
    assert.equal(row.context.candidates[0].ticker, 'HFCL', 'fibre product overlap should lead broad AI activity');
    assert.equal(row.context.holdingsExamined, book.holdings.length);
    assert.match(row.context.holdingsBasis, /ownership and weights not established/);
    assert(row.context.candidates.every(c => c.weightPct === null));
    assert.equal(row.sources.length, 20);
    assert(row.sources.reduce((n, s) => n + s.rows, 0) >= 3, 'comparison cannot crowd out all original feed rows');
    assert(row.preview.items.some(p => p.ticker === 'HFCL'));
    assert(row.preview.items.some(p => p.ticker === 'TEJASNET'));
    assert(row.context.candidates.every(c => c.evidence.length && c.evidence.every(e => e.tab && e.text && e.sourceStatus)));
  }
  assert(!report[3].context, 'ordinary single-company research is unchanged');
  console.log(JSON.stringify({ pass: true, cases: report.map(r => ({ question: r.question, retrievalMs: r.ms,
    evidenceChars: r.chars, candidates: r.context?.candidates.map(c => c.ticker), preview: r.preview.items.map(p => p.ticker) })) }, null, 2));
} finally { await harness.close(); }
