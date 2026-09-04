#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assessFilingsHealth, FILINGS_HEALTH_FILES } from '../public/js/data/filings-health-shared.js';

const sources = process.argv.slice(2);
const selected = sources.length ? sources : Object.keys(FILINGS_HEALTH_FILES);
if (selected.some((source) => !Object.hasOwn(FILINGS_HEALTH_FILES, source))) throw new Error('Use company, announcements and/or insider.');
const captures = {};
await Promise.all(selected.map(async (source) => {
  const file = FILINGS_HEALTH_FILES[source];
  try {
    if (process.env.FILINGS_HEALTH_BASE) {
      // Read only the deployed static captures. Never dispatch a capture or contact the upstream.
      const url = new URL(`data/${file}`, `${process.env.FILINGS_HEALTH_BASE.replace(/\/+$/, '')}/`);
      const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Capture unavailable');
      captures[source] = await response.json();
    } else {
      captures[source] = JSON.parse(readFileSync(fileURLToPath(new URL(`../public/data/${file}`, import.meta.url)), 'utf8'));
    }
  } catch { captures[source] = null; }
}));
const report = assessFilingsHealth(captures, { sources: selected });
const plainText = (value) => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
const annotationText = (text) => String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const lines = ['## Filings operational health', '', `Status: **${report.status}** · ${report.critical} critical findings · ${report.warnings} warnings`, '',
  'Captured records are retained. This check does not establish exhaustive provider coverage.', ''];
for (const finding of report.findings) {
  const message = `${finding.source}: ${finding.code} (${finding.count})${finding.affected.length ? ` — ${finding.affected.map(plainText).join(', ')}` : ''}`;
  console.log(`${finding.severity.toUpperCase()}: ${message}`);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${finding.severity === 'critical' ? 'error' : 'warning'}::${annotationText(message)}`);
  lines.push(`- ${finding.severity.toUpperCase()}: ${message.replace(/[`*_{}\[\]<>#@]/g, '')}`);
}
console.log(`Filings health: ${report.status}`);
if (process.env.FILINGS_HEALTH_REPORT) writeFileSync(process.env.FILINGS_HEALTH_REPORT, `${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
process.exitCode = report.ok ? 0 : 1;
