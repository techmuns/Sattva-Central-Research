#!/usr/bin/env node
import fs from 'node:fs';
import { collect, collectionDue } from './collect-private-market-news.mjs';
import { privateMarketRelease } from './lib/private-market-release.mjs';
import { validateCapture } from './lib/private-market-news.mjs';
const transport = privateMarketRelease();
const latest = await transport.latest();
const state = latest ? await transport.download(latest) : validateCapture(JSON.parse(fs.readFileSync('public/data/private-market-news.json')));
const before = JSON.stringify(state);
if (collectionDue(state)) {
  // Reserve the entire walk before any source request. A timeout/upload failure
  // still spends this window, so hourly triggers cannot multiply source traffic.
  const reservation = new Date().toISOString();
  state.attemptedAt = reservation; state.generatedAt = reservation; state.error = 'Collection started; completion not yet confirmed';
  await transport.publish(state);
  await collect(state, { reservation });
}
if (JSON.stringify(state) !== before) await transport.publish(state);
const report = { sourceCheckedAt:state.sourceCheckedAt, attemptedAt:state.attemptedAt, cooldownUntil:state.cooldownUntil, error:state.error,
  retainedDeals:state.deals.length, roundups:state.articles.length, pending:state.articles.filter(a => a.status === 'pending').length,
  unavailable:state.articles.filter(a => ['unavailable','failed'].includes(a.status)).length, archive:state.archive, lastRun:state.lastRun };
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Private market funding capture\n\n\`\`\`json\n${JSON.stringify(report,null,2)}\n\`\`\`\n`);
if (state.error) process.exitCode = 1;
