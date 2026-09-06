#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { modelScenarios, scenarioBody, checkModelAnswer } from './lib/research-model-scenarios.mjs';
import { validateResearchBody, buildMunsRequest, handleResearch } from '../worker/research.mjs';
import { finalAnswerFilter } from '../worker/research-answer.mjs';
const cases = modelScenarios();
assert.equal(cases.length, 50);
assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
for (const test of cases) {
  const input = validateResearchBody(scenarioBody(test));
  assert(input.ok, `${test.id}: ${input.error}`);
  assert(buildMunsRequest(input).query.includes('SYNTHETIC'));
  assert(checkModelAnswer(test, '').length, 'empty answers must never pass');
  assert(checkModelAnswer(test, 'A generic answer about another company.').length);
}
const latest = cases[0];
const framed = 'Provider draft that must never be shown.<research-answer>\nJayaswal Neco: ₹73 crore. [Dashboard: News]\n</research-answer>\nExtra discarded draft';
for (let split = 1; split < framed.length; split++) {
  let answer = '';
  const filter = finalAnswerFilter(text => { answer += text; });
  filter.push(framed.slice(0, split)); filter.push(framed.slice(split));
  assert.equal(filter.finish().complete, true);
  assert.equal(answer, 'Jayaswal Neco: ₹73 crore. [Dashboard: News]\n');
}
for (const text of ['Provider draft only.', '<research-answer>\n', '<research-answer>\nPartial answer']) {
  const filter = finalAnswerFilter(() => {}); filter.push(text);
  assert.equal(filter.finish().complete, false, 'missing final answer or terminator cannot be labelled complete');
}
assert.deepEqual(checkModelAnswer(latest, 'Jayaswal Neco: on 5 September 2026, a ₹73 crore order was reported. [Dashboard: News]'), []);
assert(checkModelAnswer(latest, 'A guaranteed ₹73 crore order on 5 September 2026. [Dashboard: News]').some(x => x.startsWith('forbidden:')));
const directory = mkdtempSync(join(tmpdir(), 'research-eval-'));
try {
  // Clean environment deliberately prevents a configured developer workstation
  // from spending provider calls during CI/contract verification.
  const run = spawnSync(process.execPath, ['scripts/evaluate-research-model.mjs'], { encoding: 'utf8', env: { PATH: process.env.PATH, RESEARCH_EVAL_DIR: directory } });
  assert.equal(run.status, 2, run.stderr);
  const report = JSON.parse(readFileSync(join(directory, 'model-results.json')));
  assert.equal(report.status, 'blocked');
  assert.equal(report.customerReady, false);
  assert.deepEqual(report.results, []);
} finally { rmSync(directory, { recursive: true, force: true }); }

// Three independent portfolio requests must never exchange model prompts or
// output. This is a transport fixture, explicitly not a model-quality score.
const realFetch = globalThis.fetch;
const encoder = new TextEncoder();
const prompts = [];
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  const marker = /QUESTION:\n([^\n]+)/.exec(request.query)[1];
  prompts.push(request.query);
  return new Response(new ReadableStream({ start(controller) {
    setTimeout(() => { controller.enqueue(encoder.encode(JSON.stringify({ text: `<research-answer>\n${marker}</research-answer>` }) + '\n')); controller.close(); }, marker.includes('IIFL') ? 5 : 20);
  } }));
};
try {
  const selected = [cases[0], cases[14], cases[28]];
  const output = await Promise.all(selected.map(async test => {
    const response = await handleResearch(new Request('http://localhost/api/research', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(scenarioBody(test)) }), { MUNS_LLM_TOKEN: 'synthetic-transport-credential' });
    return (await response.text()).trim().split('\n').map(JSON.parse);
  }));
  for (let i = 0; i < selected.length; i++) {
    assert.equal(output[i].filter(e => e.type === 'text').map(e => e.text).join(''), selected[i].question);
    assert.equal(output[i].at(-1).type, 'done');
  }
  assert.equal(prompts.length, 3);
} finally { globalThis.fetch = realFetch; }
console.log('PASS: 50 model scenarios validate; bad answers trip checks; missing credentials block readiness; concurrent portfolio streams remain isolated. No real-model evaluation was performed by this contract test.');
