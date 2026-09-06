// Local workerd regression: native Request validates the outbound Claude options.
// Network inference is simulated; no remote bindings or real credentials are loaded.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const scratch = mkdtempSync(join(tmpdir(), 'sattva-claude-runtime-'));
const portFinder = createServer(); await new Promise(done => portFinder.listen(0, '127.0.0.1', done));
const port = portFinder.address().port; await new Promise(done => portFinder.close(done));
const origin = `http://127.0.0.1:${port}`;
writeFileSync(join(scratch, 'worker.mjs'), `
import { handleResearch } from ${JSON.stringify(resolve('worker/research.mjs'))};
globalThis.fetch = async (url, options) => {
  const outbound = new Request(url, options);
  if (outbound.url !== 'https://api.anthropic.com/v1/messages' || outbound.redirect !== 'manual' || outbound.headers.get('x-api-key') !== 'synthetic-claude-runtime-key') throw new Error('Invalid native provider request');
  const input = JSON.parse(await outbound.text());
  const question = JSON.parse(input.messages[0].content).QUESTION;
  if (question === 'Rate limited') return new Response('Synthetic limit', { status: 429 });
  const frame = data => new TextEncoder().encode('data: ' + JSON.stringify(data) + '\\n\\n');
  let timer;
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(frame({type:'message_start',message:{role:'assistant'}}));
    controller.enqueue(frame({type:'content_block_start',index:0,content_block:{type:'text',text:''}}));
    controller.enqueue(frame({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'A cited finding. [Dashboard: Telegram]'}}));
    timer = setTimeout(() => {
      controller.enqueue(frame({type:'content_block_stop',index:0}));
      controller.enqueue(frame({type:'message_delta',delta:{stop_reason:'end_turn'}}));
      controller.enqueue(frame({type:'message_stop'})); controller.close();
    }, 800);
  }, cancel() { clearTimeout(timer); } }), {headers:{'content-type':'text/event-stream'}});
};
export default { fetch(request) { return handleResearch(request, {CLAUDE_API_KEY:'synthetic-claude-runtime-key'}); } };
`);
writeFileSync(join(scratch, 'wrangler.json'), JSON.stringify({ name: 'claude-runtime-local-test', main: 'worker.mjs', compatibility_date: '2026-05-23' }));
let child, logs = '';
try {
  child = spawn('npx', ['--yes', 'wrangler@4', 'dev', '--local', '--config', join(scratch, 'wrangler.json'), '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'],
    { cwd: scratch, detached: true, env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local Worker exited: ${logs}`);
    try { ready = (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; if (ready) break; } catch { /* Local listener is starting. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  assert(ready, `Local Worker did not start: ${logs}`);
  assert.equal((await (await fetch(origin)).json()).provider, 'claude');
  const send = question => fetch(origin, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ question, evidence: { sources: [] }, history: [] }) });
  const result = await send('Complete');
  assert.equal(result.status, 200);
  const reader = result.body.getReader(); let data = '', firstTextAt = null, completeAt = null;
  const started = performance.now();
  while (true) {
    const part = await reader.read(); if (part.done) break;
    data += new TextDecoder().decode(part.value);
    if (data.includes('"type":"text"')) firstTextAt ??= performance.now() - started;
    if (data.includes('"type":"done"')) completeAt ??= performance.now() - started;
  }
  const output = data.trim().split('\n').map(JSON.parse);
  assert.equal(output.at(-1).type, 'done', data);
  assert.equal(output.filter(e => e.type === 'text').map(e => e.text).join(''), 'A cited finding. [Dashboard: Telegram]');
  assert(firstTextAt !== null && completeAt - firstTextAt > 200, 'native Worker must forward text before provider completion');
  const limited = (await (await send('Rate limited')).text()).trim().split('\n').map(JSON.parse);
  assert.equal(limited.at(-1).type, 'error');
  assert.match(limited.at(-1).message, /rate-limited/);
  console.log('PASS local workerd: native Claude Request options, incremental text before completion and safe provider errors');
} finally {
  if (child && child.exitCode === null) {
    const done = once(child, 'exit');
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ } }, 5000);
    try { process.kill(-child.pid, 'SIGTERM'); await done; } finally { clearTimeout(timer); }
  }
  rmSync(scratch, { recursive: true, force: true });
}
