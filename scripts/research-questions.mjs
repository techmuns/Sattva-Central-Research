#!/usr/bin/env node
// Print questions only; this command never runs a model or contacts a service.
// Default: public names-only list. --positions /private/path.json: a current
// authenticated {sizes,holdings} reply, validated and ordered largest first.
import { readFileSync } from 'node:fs';
import { PORTFOLIO_QUESTIONS, researchQuestionBank } from './lib/research-questions.mjs';
const args = process.argv.slice(2);
const positionsIndex = args.indexOf('--positions');
const source = JSON.parse(readFileSync(positionsIndex >= 0 ? args[positionsIndex + 1] : new URL('../public/data/portfolio-companies.json', import.meta.url), 'utf8'));
if (positionsIndex >= 0) {
  const info = console.info;
  console.info = (...items) => console.error(...items);
  const { validPositionSizes } = await import('../public/js/research/portfolio-bridge.js');
  console.info = info;
  if (!validPositionSizes(source, Date.now() - 120_000)) throw new Error('Supply a fresh validated positions reply. Do not infer ranking from the public names-only snapshot.');
}
const cases = researchQuestionBank(source.holdings, { complete: positionsIndex >= 0 && source.sizes.complete });
if (args.includes('--json')) {
  console.log(JSON.stringify({ portfolio: PORTFOLIO_QUESTIONS, companies: cases }, null, 2));
} else {
  console.log('# Ask Research question bank\n');
  console.log(`${PORTFOLIO_QUESTIONS.length + cases.length} questions: ${PORTFOLIO_QUESTIONS.length} portfolio-wide cases and ${cases.length} company cases across ${source.holdings.length} holdings.\n`);
  console.log(positionsIndex >= 0 && source.sizes.complete ? 'Companies are ordered by verified listed-market-value weight, largest first.\n' : 'Companies are alphabetical from the saved names-only coverage list. This list contains no holding sizes and cannot establish current ownership. Use `node scripts/research-questions.mjs --positions /private/path.json` with a fresh authenticated reply to order every holding from largest to smallest. Do not commit private outputs.\n');
  console.log('## Portfolio-wide questions\n');
  for (const question of PORTFOLIO_QUESTIONS) console.log(`- ${question}`);
  let company = null;
  for (const item of cases) {
    if (item.company !== company) { company = item.company; console.log(`\n## ${item.rank ? `${item.rank}. ` : ''}${company} (${item.ticker || 'unresolved ticker'})\n`); }
    console.log(`- ${item.question}`);
  }
}
