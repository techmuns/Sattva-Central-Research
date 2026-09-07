#!/usr/bin/env node
// Read-only capacity audit; no billing changes, archive deletion or production requests.
import { appendFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compactNewsData } from './compact-news-data.mjs';
import { verifyAssetSizes } from './partition-news-data.mjs';
import { readNewsJson } from './lib/news-json-storage.mjs';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const assets = verifyAssetSizes(publicDir);
const news = compactNewsData(`${publicDir}/data`);
const warnings = [...assets.warnings];
let logicalNewsBytes = news.reduce((sum, row) => sum + row.bytesAfter, 0);
for (const family of ['market-news', 'tradingview-news']) {
  const paths = [family === 'market-news' ? 'market-news.json' : 'tradingview-news/latest.json'];
  const directory = `${publicDir}/data/${family}`;
  if (existsSync(directory)) for (const file of readdirSync(directory)) {
    if (/^(\d{4}-\d{2}|undated)\.json$/.test(file)) paths.push(`${family}/${file}`);
  }
  for (const path of paths) if (existsSync(`${publicDir}/data/${path}`))
    logicalNewsBytes += Buffer.byteLength(JSON.stringify(readNewsJson(`${publicDir}/data/${path}`)));
}
if (logicalNewsBytes > 50 * 1024 * 1024) warnings.push('Combined company, publisher and TradingView heads/history exceed the 50 MiB client-load planning budget. Move to selective company/time loading before expanding history; a larger Cloudflare file allowance alone does not solve browser memory.');
for (const row of news) {
  if (row.before > 1000 && row.duplicates / row.before > 0.2) warnings.push(`${row.file}: repeated identical observations exceed 20%; compact during the next normal capture.`);
  if (row.bytesAfter > 50 * 1024 * 1024) warnings.push(`${row.file}: distinct content exceeds the 50 MiB client-load planning budget; partition by company/time before expanding the all-history reader.`);
}
console.log(JSON.stringify({ assets, news, logicalNewsBytes, warnings }));
for (const message of warnings) if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning::${message}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `\n## Storage headroom\n\n${assets.files} / ${assets.fileBudget} static files (${assets.usedPercent}%). ${assets.remainingFiles} file slots remain under the conservative budget. Largest file: ${(assets.largestBytes / 1048576).toFixed(2)} MiB; provider limit: 25 MiB per file. Combined logical news heads/history after identical-observation compaction: ${(logicalNewsBytes / 1048576).toFixed(2)} MiB (includes overlapping head/archive records).\n\n${warnings.map(w => `- ${w}`).join('\n') || 'No capacity warning thresholds reached.'}\n\nFile count and client-load budgets are independent. History is never automatically deleted.\n`);
