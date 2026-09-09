#!/usr/bin/env node
// Read-only local production-data retrieval. No API or actual model calls.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { researchLocalBrowser } from './lib/research-local-browser.mjs';
const book = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url)));
const h = await researchLocalBrowser();
try {
  const report = await h.page.evaluate(async () => {
    const { researchEvidenceChars } = await import('/js/research/evidence-shared.js');
    const { researchPreview } = await import('/js/research/preview.js');
    const questions = [
      'If crude oil prices fall, which portfolio companies could benefit or be hurt?',
      'If interest rates fall, which of my portfolio companies have upside and what could offset it?',
      'Which portfolio companies are exposed to a weaker rupee, positively or negatively?',
      'Which portfolio companies have businesses similar to Supreme Industries?',
      'Which portfolio companies depend on the same customer demand and could disappoint together?',
      'Which portfolio companies have improving earnings but conflicting risks in public chatter?',
    ];
    const cases = [];
    for (const question of questions) {
      const start = performance.now();
      const evidence = await research.buildResearchEvidence({ question, prepared, scope: 'portfolio' });
      cases.push({ question, ms: Math.round(performance.now() - start), chars: researchEvidenceChars(evidence),
        companies: evidence.selection.companies, context: evidence.businessContext,
        evidence, sources: evidence.sources.map(s => ({ id: s.id, status: s.status, count: s.rows.length })), preview: researchPreview(evidence) });
    }
    return cases;
  });
  for (const r of report) {
    assert.equal(r.context.kind, 'portfolio-reasoning', r.question);
    assert.equal(r.context.businessProfiles.total, book.holdings.length);
    assert.equal(r.context.businessProfiles.omitted, 0);
    assert.equal(r.context.businessProfiles.rows.length, book.holdings.length);
    assert.deepEqual(new Set(r.context.businessProfiles.rows.map(p => p[0])), new Set(book.holdings.map(h => h.ticker || h.isin)));
    assert(r.context.businessProfiles.analyses.rows.length > 0, 'business map must carry source-backed analysis, not only sector labels');
    assert(r.context.candidates.every(c => c.weightPct === null));
    assert.match(r.context.holdingsBasis, /ownership and weights not established/);
    assert.equal(r.sources.length, 20);
    assert(r.sources.some(s => s.count));
    assert(r.chars <= 30000);
    assert(r.preview.items.every(p => p.kind === 'excerpt' || p.kind === 'headline'));
    assert(r.context.candidates.every(c => c.evidence.every(e => e.tab && e.text && e.sourceStatus)));
  }
  assert.deepEqual(report[0].companies, [], 'crude oil must not resolve to Oil India');
  assert(report[0].context.candidates.some(c => c.ticker === 'MRPL'), 'actual crude sourcing evidence must survive');
  assert(!report[0].context.candidates.some(c => c.ticker === 'HDFCBANK'), 'a market-wrap co-mention is not oil exposure');
  assert(report[1].context.businessProfiles.analyses.rows.some(p => p[0] === 'SAMMAANCAP' && p[2]), 'the model must see funding analysis beyond lexical leaders');
  assert(report[3].context.references.some(r => r.ticker === 'SUPREMEIND' && r.evidence.some(e => /piping|plastic|Industrial Products/i.test(e.text))), 'arbitrary peer anchor needs business evidence instead of broker boilerplate');
  if (process.env.RESEARCH_EVAL_EXPORT) {
    const checkedAt = new Date().toISOString();
    const tests = report.map((r, i) => {
      const evidence = r.evidence;
      evidence.portfolio = { status: 'limited', mode: 'public-snapshot-fixture', checkedAt, archiveVersion: 1, bookAsOf: book.asOf,
        answer: 'Saved public identity snapshot for evaluation. Current ownership, actual weights and quotes are unavailable.' };
      evidence.portfolioPositions = { sizes: { basis: 'listed-market-value', complete: false, checkedAt, archiveVersion: 1, bookAsOf: book.asOf,
        quotes: { asOf: null, status: 'unavailable', priced: 0, notLive: book.holdings.length } }, holdings: book.holdings.map(h => ({ isin: h.isin, ticker: h.ticker, name: h.name, sector: h.sector, weightPct: null })) };
      return { id: ['oil', 'rates', 'currency', 'peers', 'demand', 'conflicts'][i], question: r.question,
        must: [], forbidden: ['public-snapshot-fixture', 'industrySourceIndex'],
        body: { question: r.question, requirePortfolio: true, scope: 'portfolio', history: [], evidence },
        review: 'Check relevance, dates, exact source citations, opposing mechanisms, conditional vs realised benefits, missing inputs, legal-entity attribution, and unknown actual ownership. Keyword checks are not a quality pass.' };
    });
    writeFileSync(process.env.RESEARCH_EVAL_EXPORT, JSON.stringify({ kind: 'public-snapshot-fixture', tests }, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify({ pass: true, cases: report.map(r => ({ question: r.question, retrievalMs: r.ms, chars: r.chars, holdings: r.context.businessProfiles.rows.length, candidates: r.context.candidates.map(c => c.ticker) })) }, null, 2));
} finally { await h.close(); }
