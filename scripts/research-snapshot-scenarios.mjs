#!/usr/bin/env node
// Export current dashboard packets for real inference, using public portfolio
// names and UNKNOWN weights. Never claim an authenticated customer-book test.
import { readFileSync, writeFileSync } from 'node:fs';
import { researchLocalBrowser } from './lib/research-local-browser.mjs';
const output = process.env.RESEARCH_EVAL_INPUT;
if (!output) throw new Error('Set RESEARCH_EVAL_INPUT to a local review artifact path.');
const book = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url)));
const questions = [
  ['jayaswal-latest', 'any new updates on jayaswal neco?', 'Jayaswal|Neco'],
  ['iifl-latest', 'What is the latest news on IIFL Finance?', 'IIFL'],
  ['alankit-latest', 'What should I know about Alankit?', 'Alankit'],
  ['ashika-latest', 'What changed at Ashika Credit Capital?', 'Ashika'],
  ['vedanta-demerger', 'Latest updates on Vedanta Iron and Steel?', 'Vedanta'],
  ['pnb-earnings', 'What do PNB Housing Finance earnings show?', 'PNB'],
  ['jayaswal-conflicts', 'Where do the sources disagree about Jayaswal Neco?', 'Jayaswal|Neco'],
];
const { page, close } = await researchLocalBrowser();
const tests = [];
try {
  for (const [id, question, issuer] of questions) {
    const evidence = await page.evaluate(async question => research.buildResearchEvidence({ question, prepared, scope: 'portfolio' }), question);
    const checkedAt = new Date().toISOString();
    evidence.portfolio = { status: 'limited', mode: 'public-snapshot-fixture', checkedAt, archiveVersion: 1, bookAsOf: book.asOf,
      answer: 'Evaluation fixture using saved public portfolio identities, not an authenticated customer book. Actual weights, quotes and private financial details are unavailable.' };
    evidence.portfolioPositions = { sizes: { basis: 'listed-market-value', complete: false, checkedAt, archiveVersion: 1, bookAsOf: book.asOf,
      quotes: { asOf: null, status: 'unavailable', priced: 0, notLive: book.holdings.length } },
    holdings: book.holdings.map(h => ({ isin: h.isin, ticker: h.ticker, name: h.name, sector: h.sector, weightPct: null })) };
    tests.push({ id, question, must: [issuer], forbidden: [], body: { question, requirePortfolio: true, scope: 'portfolio', evidence },
      review: 'Actual saved dashboard facts; synthetic ownership context with unknown weights. Verify each claim against this exact packet, especially dates, issuer attribution, conflicting periods, units, incomplete feeds and source gaps.' });
  }
  writeFileSync(output, JSON.stringify({ kind: 'public-snapshot-fixture', tests }, null, 2), { mode: 0o600 });
  console.log(`Exported ${tests.length} real dashboard scenarios. No model calls or customer allocations.`);
} finally { await close(); }
