#!/usr/bin/env node
// Actual provider through the local production Worker handler; no fetch mocks.
// Credentials stay in env. Outputs are private review artifacts, never CI logs.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { handleResearch, researchConfigured } from '../worker/research.mjs';
import { modelScenarios, scenarioBody, checkModelAnswer } from './lib/research-model-scenarios.mjs';
const directory = resolve(process.env.RESEARCH_EVAL_DIR || '.research-evaluation');
const endpoint = process.env.RESEARCH_STAGING_URL;
if (endpoint) {
  const url = new URL(endpoint);
  if (['sattva-central-research.tech-441.workers.dev', 'chat.muns.io', 'sattva-family.pages.dev'].includes(url.hostname) ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Use an explicit staging endpoint or loopback preview, never production.');
}
const selectedIds = process.env.RESEARCH_EVAL_IDS?.split(',');
const snapshot = process.env.RESEARCH_EVAL_INPUT ? JSON.parse(readFileSync(process.env.RESEARCH_EVAL_INPUT, 'utf8')) : null;
if (snapshot && (snapshot.kind !== 'public-snapshot-fixture' || !Array.isArray(snapshot.tests) || snapshot.tests.some(t => t.body?.evidence?.portfolio?.mode !== 'public-snapshot-fixture'))) throw new Error('Only explicit public snapshot fixtures are accepted here, never expired private-book packets.');
const scenarios = (snapshot?.tests || modelScenarios()).filter(test => !selectedIds || selectedIds.includes(test.id));
if (!scenarios.length) throw new Error('No evaluation scenarios selected.');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const report = { generatedAt: new Date().toISOString(), mode: 'real-provider-local-worker-synthetic-facts', customerReady: false,
  limitations: ['Controlled fixtures do not prove live company-news completeness or actual customer allocations.', 'Automated text checks are tripwires, not a substitute for factual and relevance review.', 'Real Family-to-browser latency and current-source review remain separate required gates.'], results: [] };
if (snapshot) report.mode = 'real-provider-saved-dashboard-synthetic-ownership';
const save = () => writeFileSync(resolve(directory, 'model-results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
if (!endpoint && !researchConfigured(process.env)) {
  report.status = 'blocked'; report.blockers = ['No local Muns provider credential. No model calls made.']; save();
  console.log('BLOCKED: real-model evaluation needs a local Muns credential. No readiness pass was recorded.'); process.exitCode = 2;
} else {
  for (const test of scenarios) {
    const body = test.body ? structuredClone(test.body) : scenarioBody(test);
    if (snapshot) {
      // Renew only this explicitly synthetic transport clock. Actual holdings,
      // publication dates and source check dates are left untouched.
      body.evidence.portfolio.checkedAt = new Date().toISOString();
      body.evidence.portfolioPositions.sizes.checkedAt = body.evidence.portfolio.checkedAt;
    }
    const started = performance.now();
    let firstTextMs = null, answer = '', terminal = null, buffer = '';
    const errors = [];
    try {
      const request = new Request(endpoint || 'http://localhost/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(50_000) });
      const response = endpoint ? await fetch(request) : await handleResearch(request, process.env);
      if (!response.ok) throw new Error(`research_http_${response.status}`);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          const lines = buffer.split('\n'); buffer = lines.pop(); if (done && buffer.trim()) lines.push(buffer);
          for (const line of lines.filter(Boolean)) {
            const event = JSON.parse(line);
            if (event.type === 'text') { firstTextMs ??= performance.now() - started; answer += event.text; }
            if (event.type === 'done' || event.type === 'error') terminal = event.type;
            if (event.type === 'error') errors.push(event.reason || 'provider_error');
          }
          if (done) break;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { errors.push('request_failed'); }
    if (terminal !== 'done') errors.push('incomplete_answer');
    errors.push(...checkModelAnswer(test, answer));
    const answerHash = createHash('sha256').update(answer).digest('hex');
    report.results.push({ id: test.id, question: test.question, body, answer, answerHash, review: test.review || 'Review every claim against the exact supplied packet.', firstTextMs, totalMs: performance.now() - started, errors, manualReview: 'pending' });
    save();
    console.log(`${report.results.length}/${scenarios.length} ${test.id}: ${errors.length ? 'NEEDS REVIEW' : 'tripwires passed; factual review pending'}`);
  }
  const percentile = (field, p) => { const values = report.results.map(r => r[field]).filter(Number.isFinite).sort((a, b) => a - b); return values.length ? values[Math.ceil(values.length * p) - 1] : null; };
  report.metrics = { completed: report.results.length, tripwireFailures: report.results.filter(r => r.errors.length).length, firstTextP50Ms: percentile('firstTextMs', .5), firstTextP95Ms: percentile('firstTextMs', .95), completionP95Ms: percentile('totalMs', .95) };
  report.status = 'manual-review-required'; save();
  console.log(JSON.stringify(report.metrics));
  if (report.metrics.tripwireFailures) process.exitCode = 1;
}
