#!/usr/bin/env node
// Provider transport fixtures only. No real credentials, paid calls or accuracy claims.
import assert from 'node:assert/strict';
import { buildClaudeRequest, CLAUDE_MODEL, consumeClaudeStream } from '../worker/research-claude.mjs';
import { handleResearch, researchConfigured, providerEvidence } from '../worker/research.mjs';
import { modelScenarios, scenarioBody } from './lib/research-model-scenarios.mjs';

const encoder = new TextEncoder();
const env = { CLAUDE_API_KEY: 'synthetic-claude-credential', MUNS_TOKEN: 'must-not-be-used', ANTHROPIC_API_KEY: 'legacy-muns-token', MUNS_LLM_LEGACY_ANTHROPIC_BINDING: 'confirmed-muns-token' };
const body = { question: 'Any upside in Indraprastha Gas?', scope: 'portfolio', history: [], evidence: { sources: [] } };
const request = (value = body, signal) => new Request('https://dashboard.example/api/research', { method: 'POST', headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' }, body: JSON.stringify(value), signal });
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const start = frame({ type: 'message_start', message: { role: 'assistant' } });
const open = frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const token = text => frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const close = frame({ type: 'content_block_stop', index: 0 });
const ending = (reason = 'end_turn') => frame({ type: 'message_delta', delta: { stop_reason: reason } }) + frame({ type: 'message_stop' });
const answer = 'Geojit reportedly sees 14% upside — a broker view, not a promised return. [Dashboard: Telegram]';
const full = start + open + token(answer) + close + ending();
const response = text => new Response(text, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
const events = async value => (await value.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
const parts = chunks => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
let checks = 0;
const pass = label => { checks++; console.log(`PASS ${label}`); };

assert.equal(researchConfigured({ CLAUDE_API_KEY: env.CLAUDE_API_KEY }), true);
assert.equal(researchConfigured({ ...env, CLAUDE_API_KEY: 'short' }), false, 'a malformed dedicated key cannot silently choose Muns');
assert.equal(researchConfigured({ ANTHROPIC_API_KEY: 'sk-ant-real-key-must-not-go-to-muns', MUNS_LLM_LEGACY_ANTHROPIC_BINDING: 'confirmed-muns-token' }), false);
assert.equal(researchConfigured({ MUNS_TOKEN: 'sk-ant-real-key-must-not-go-to-muns' }), false);
const configured = await (await handleResearch(new Request('https://dashboard.example/api/research'), env)).json();
assert.equal(configured.provider, 'claude');
assert(!JSON.stringify(configured).includes(env.CLAUDE_API_KEY));
pass('dedicated Claude key wins; malformed and misplaced keys fail closed; config exposes no secrets');

for (const test of modelScenarios()) {
  const value = scenarioBody(test);
  const built = buildClaudeRequest(value, 'Evidence-only instructions');
  assert.equal(built.model, CLAUDE_MODEL);
  assert.equal(built.stream, true);
  assert.equal(built.thinking.type, 'disabled');
  assert(!('temperature' in built), 'Sonnet 5 rejects custom sampling');
  assert.equal(built.system[0].cache_control.type, 'ephemeral');
  assert(!JSON.stringify(built.system).includes('DASHBOARD_EVIDENCE'), 'private evidence is not placed in the cached instruction prefix');
  assert.deepEqual(JSON.parse(built.messages[0].content).DASHBOARD_EVIDENCE, JSON.parse(JSON.stringify(providerEvidence(value.evidence))));
  assert.deepEqual(JSON.parse(built.messages[0].content).CONVERSATION_HISTORY, value.history);
  assert(!built.messages.some(message => message.cache_control));
}
pass('all 50 portfolio scenarios retain their complete provider evidence and history on the Claude path');

for (const delimiter of ['\n', '\r\n', '\r']) {
  const bytes = encoder.encode(full.replaceAll('\n', delimiter));
  for (let split = 1; split < bytes.length; split++) {
    let output = '';
    const result = await consumeClaudeStream(parts([bytes.slice(0, split), bytes.slice(split)]), text => { output += text; });
    assert.equal(result.providerStreamFailure, null, `${delimiter}: split ${split}`);
    assert.equal(output, answer);
  }
}
pass('every byte split preserves UTF-8 text, citations and SSE delimiters (LF, CRLF, CR)');

const thinking = frame({ type: 'content_block_start', index: 7, content_block: { type: 'thinking', thinking: 'hidden draft' } })
  + frame({ type: 'content_block_delta', index: 7, delta: { type: 'thinking_delta', thinking: 'must never enter the answer' } })
  + frame({ type: 'content_block_stop', index: 7 });
let clean = '';
const filtered = await consumeClaudeStream(response(start + thinking + frame({ type: 'ping' }) + frame({ type: 'future_metadata' }) + open + token(answer) + close + ending()).body, text => { clean += text; });
assert.equal(clean, answer);
assert.equal(filtered.providerStreamFailure, null);
pass('thinking and future metadata never become customer answer text');

for (const [name, stream] of [
  ['missing terminal event', start + open + token(answer) + close],
  ['missing stop reason', start + open + token(answer) + close + frame({ type: 'message_stop' })],
  ['token limit', start + open + token(answer) + close + ending('max_tokens')],
  ['context limit', start + open + token(answer) + close + ending('model_context_window_exceeded')],
  ['refusal', start + open + token(answer) + close + ending('refusal')],
  ['tool handoff', start + open + token(answer) + close + ending('tool_use')],
  ['empty answer', start + open + token('  ') + close + ending()],
  ['unclosed block', start + open + token(answer) + ending()],
  ['orphan text', start + token(answer) + ending()],
  ['malformed JSON', start + 'data: {bad}\n\n'],
  ['unterminated final frame', full.slice(0, -2)],
  ['oversized line', 'data: ' + 'x'.repeat(64_001) + '\n\n'],
  ['oversized multiline event', ('data: ' + 'x'.repeat(32_001) + '\n').repeat(2) + '\n'],
  ['excess answer', start + open + token('x'.repeat(8001)) + close + ending()],
]) {
  const result = await consumeClaudeStream(response(stream).body, () => {});
  assert(result.providerStreamFailure, name);
}
pass('truncation, refusal, malformed/oversized streams and EOF cannot masquerade as completed answers');

const originalFetch = globalThis.fetch;
try {
  let providerController;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], env.CLAUDE_API_KEY);
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, undefined);
    assert(!options.body.includes('must-not-be-used'));
    return response(new ReadableStream({ start(controller) { providerController = controller; controller.enqueue(encoder.encode(start + open + token('Geojit reportedly sees '))); } }));
  };
  const output = await handleResearch(request(), env);
  const reader = output.body.getReader();
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'start');
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'phase');
  let timer;
  const first = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('First text buffered until completion')), 500); })]).finally(() => clearTimeout(timer));
  assert.equal(JSON.parse(new TextDecoder().decode(first.value)).text, 'Geojit reportedly sees ');
  providerController.enqueue(encoder.encode(token('14% upside. [Dashboard: Telegram]') + close + ending()));
  providerController.close();
  let rest = ''; while (true) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
  assert.match(rest, /"type":"done"/);
  pass('actual Worker forwards first answer delta before completion, without framing or credential forwarding');

  for (const status of [400, 401, 403, 404, 429, 500, 529]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('private provider detail ' + env.CLAUDE_API_KEY, { status }); };
    const out = await events(await handleResearch(request(), env));
    assert.equal(out.at(-1).type, 'error');
    assert(!JSON.stringify(out).includes(env.CLAUDE_API_KEY));
    assert.equal(calls, 1, 'no hidden fallback to another provider');
  }
  for (const errorType of ['overloaded_error', 'rate_limit_error', 'authentication_error']) {
    globalThis.fetch = async () => response(start + open + token('Partial finding') + frame({ type: 'error', error: { type: errorType, message: env.CLAUDE_API_KEY } }));
    const out = await events(await handleResearch(request(), env));
    assert.equal(out.filter(e => e.type === 'text').map(e => e.text).join(''), 'Partial finding');
    assert.equal(out.at(-1).type, 'error');
    assert(!JSON.stringify(out).includes(env.CLAUDE_API_KEY));
  }
  globalThis.fetch = async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
  assert.equal((await events(await handleResearch(request(), env))).at(-1).type, 'error');
  pass('HTTP and in-stream failures retain partial text, redact provider details and never silently switch providers');

  let upstreamSignal;
  globalThis.fetch = async (_url, options) => {
    upstreamSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const cancelling = await handleResearch(request(), env);
  await cancelling.body.cancel();
  assert.equal(upstreamSignal.aborted, true);
  pass('browser cancellation aborts the provider while awaiting headers');

  // Exercise the real first-text timer path without a 20-second test sleep.
  const realTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (callback, ms, ...args) => realTimeout(callback, ms === 20_000 ? 5 : ms, ...args);
    const out = await events(await handleResearch(request(), env));
    assert.equal(out.at(-1).reason, 'timeout');
    assert.match(out.at(-1).message, /source readings are saved/);
    assert(!/narrower/.test(out.at(-1).message));
  } finally { globalThis.setTimeout = realTimeout; }
  pass('a stalled first answer times out with retained findings and no misleading request to narrow the question');

  globalThis.fetch = async (_url, options) => {
    const question = JSON.parse(JSON.parse(options.body).messages[0].content).QUESTION;
    return response(start + open + token(question) + close + ending());
  };
  const questions = ['Jayaswal Neco update?', 'IIFL risks?', 'Indraprastha Gas broker view?'];
  const outputs = await Promise.all(questions.map(question => handleResearch(request({ ...body, question }), env).then(events)));
  for (let i = 0; i < questions.length; i++) assert.equal(outputs[i].filter(e => e.type === 'text').map(e => e.text).join(''), questions[i]);
  pass('concurrent company requests keep prompts and answers isolated');
} finally { globalThis.fetch = originalFetch; }

console.log(`\n${checks} Claude transport groups passed. Simulated provider only; no live quality or latency claim.`);
