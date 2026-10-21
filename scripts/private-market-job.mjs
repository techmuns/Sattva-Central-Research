#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collect, collectionDue } from './collect-private-market-news.mjs';
import { privateMarketRelease } from './lib/private-market-release.mjs';
import { validateCapture } from './lib/private-market-news.mjs';
export async function runPrivateMarketJob({ transport = privateMarketRelease(), bootstrap = () => JSON.parse(fs.readFileSync('public/data/private-market-news.json')), now = () => new Date().toISOString(), collector = collect } = {}) {
  const latest = await transport.latest();
  const state = latest ? await transport.download(latest) : validateCapture(bootstrap());
  const before = JSON.stringify(state), attempted = collectionDue(state, Date.parse(now()));
  // Promote a recently verified bootstrap without spending another source walk.
  if (!latest && !attempted) await transport.publish(state);
  if (attempted) {
  // Reserve the entire walk before any source request. A timeout/upload failure
  // still spends this window, so hourly triggers cannot multiply source traffic.
    const reservation = now();
    state.attemptedAt = reservation; state.generatedAt = reservation; state.error = 'Collection started; completion not yet confirmed';
    await transport.publish(state);
    await collector(state, { reservation, now });
  }
  if (JSON.stringify(state) !== before) await transport.publish(state);
  return { attempted, sourceCheckedAt:state.sourceCheckedAt, attemptedAt:state.attemptedAt, cooldownUntil:state.cooldownUntil, error:state.error,
  retainedDeals:state.deals.length, roundups:state.articles.length, pending:state.articles.filter(a => a.status === 'pending').length,
    unavailable:state.articles.filter(a => ['unavailable','failed'].includes(a.status)).length, archive:state.archive, lastRun:state.lastRun };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runPrivateMarketJob();
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Private market funding capture\n\n\`\`\`json\n${JSON.stringify(report,null,2)}\n\`\`\`\n`);
  if (report.attempted && report.error) process.exitCode = 1;
}
