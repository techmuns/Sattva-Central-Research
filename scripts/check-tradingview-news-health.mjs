#!/usr/bin/env node
// Read only: verifies deployed publication, independently of whether collection finishes.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { assessTradingViewCoverage } from '../public/js/data/tradingview-news-health.js';

let capture = null;
try {
  if (process.env.FILINGS_HEALTH_BASE) {
    const url = new URL('data/tradingview-news/latest.json', `${process.env.FILINGS_HEALTH_BASE.replace(/\/+$/, '')}/`);
    const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Published TradingView capture unavailable');
    capture = await response.json();
  } else capture = JSON.parse(readFileSync(new URL('../public/data/tradingview-news/latest.json', import.meta.url), 'utf8'));
} catch { /* Missing publication is a health failure, never a successful empty feed. */ }
const report = { checkedAt: new Date().toISOString(), ...assessTradingViewCoverage(capture?.tradingViewCoverage) };
const lines = [`## TradingView portfolio-news health`, '', `Status: ${report.status}`, '',
  '15-minute scheduled capture target; 45-minute stale threshold. Public windows are not exhaustive.', ''];
for (const [severity, findings] of [['error', report.critical], ['warning', report.warnings]]) for (const finding of findings) {
  const line = `${finding.code} (${finding.count})`;
  console.log(`${severity.toUpperCase()}: ${line}`);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${severity}::TradingView: ${line}`);
  lines.push(`- ${severity}: ${line}`);
}
if (process.env.TRADINGVIEW_HEALTH_REPORT) writeFileSync(process.env.TRADINGVIEW_HEALTH_REPORT, `${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
console.log(`TradingView health: ${report.status}`);
process.exitCode = report.ok ? 0 : 1;
