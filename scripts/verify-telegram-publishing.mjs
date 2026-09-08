#!/usr/bin/env node
// Exercise the auto-publisher with a fake gh executable; no GitHub calls or repository writes.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareTelegramArchive } from './prepare-telegram-archive.mjs';
import { mergeTelegramRestore } from './telegram-artifact.mjs';
import { TELEGRAM_LIMIT, TELEGRAM_REPO } from '../public/js/data/telegram-shared.js';
const root = await mkdtemp(join(tmpdir(), 'telegram-publish-test-'));
const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), scenario = process.env.TEST_CASE;
const out = (value) => process.stdout.write(JSON.stringify(value));
const statePath = process.env.TEST_DIR + '/calls';
fs.appendFileSync(statePath, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'view') out({headRefOid:'abc123', headRefName:'codex/telegram-capture', baseRefName:'main', files:[{path:scenario === 'wrong-file' ? 'worker/index.js' : 'public/data/telegram-posts.json'}]});
else if (args[0] === 'run') {
  const calls = fs.readFileSync(statePath, 'utf8').split('\\n').filter(Boolean).map(JSON.parse).filter(a=>a[0]==='run').length;
  out(calls === 1 ? [] : [{databaseId:7,headSha:'abc123',status:'completed',conclusion:scenario === 'failed-ci' ? 'failure' : 'success'}]);
} else if (args[0] === 'api') {
  if (args[1].endsWith('/check-runs')) out([{check_runs:[{status:scenario === 'pending-check' ? 'in_progress' : 'completed',conclusion:'success'}]}]);
  else if (args[1].endsWith('/reviews')) out([scenario === 'review' ? [{state:'CHANGES_REQUESTED'}] : []]);
  else if (args[1].includes('/pulls/')) out([scenario === 'inline' ? [{body:'Please fix'}] : []]);
  else out([scenario === 'comment' ? [{user:{login:'human'},body:'Please check this'}] : [
    {user:{login:'cloudflare-workers-and-pages[bot]'},body:'## Deploying with Cloudflare'},
    {user:{login:'chatgpt-codex-connector[bot]'},body:'You have reached your Codex usage limits for code reviews.'}
  ]]);
} else if (args[0] === 'pr' && args[1] === 'merge') fs.writeFileSync(process.env.TEST_DIR + '/merged', JSON.stringify(args));
`;
try {
  await writeFile(join(root, 'gh'), fake, { mode: 0o755 });
  for (const scenario of ['ok', 'wrong-file', 'failed-ci', 'pending-check', 'review', 'inline', 'comment']) {
    const dir = await mkdtemp(join(root, 'case-'));
    const result = spawnSync(process.execPath, [resolve('scripts/merge-telegram-capture.mjs')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_REPOSITORY: 'test/repository', TELEGRAM_PR_NUMBER: '1', TELEGRAM_VERIFY_TIMEOUT_MS: '1000', TEST_CASE: scenario, TEST_DIR: dir },
    });
    let merged = null;
    try { merged = JSON.parse(await readFile(join(dir, 'merged'), 'utf8')); } catch {}
    assert.equal(Boolean(merged), scenario === 'ok', scenario);
    if (merged) assert.deepEqual(merged.slice(-2), ['--match-head-commit', 'abc123']);
    if (['wrong-file', 'failed-ci', 'pending-check'].includes(scenario)) assert.notEqual(result.status, 0, scenario);
    else assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
  }
  const now = Date.parse('2026-09-07T14:00:00Z'), sha = 'a'.repeat(40);
  const capture = (at, posts, extra = {}) => ({ schemaVersion: 2, channel: 'researchreportss',
    route: 'embed+permalink', lastRun: { at, status: 'ok' }, lastCheckedAt: at,
    posts: posts.map(([id, text]) => ({ id, text, publishedAt: at })), ...extra });
  const main = capture('2026-09-07T13:00:00Z', [[1, 'Main-only record'], [3, 'Old shared text']]);
  const pending = capture('2026-09-07T13:30:00Z', [[2, 'Unmerged PR-only record'], [3, 'Corrected shared text']], {
    publicSafety: { reason: 'rate-limit', nextAttemptAt: '2026-09-07T16:00:00Z' },
    apiSafety: { paused: true, reason: 'account-attention' },
  });
  const file = join(root, 'capture.json');
  const exact = { state: 'OPEN', headRefOid: sha, headRefName: 'codex/telegram-capture', baseRefName: 'main',
    isCrossRepository: false, headRepository: { nameWithOwner: TELEGRAM_REPO }, files: [{ path: 'public/data/telegram-posts.json' }] };
  let mode = 'ok', requests = [];
  const run = (args, maximum) => {
    requests.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(mode === 'none' ? [] : [{ number: 133 }]);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ ...exact,
      ...(mode === 'wrong-file' ? { files: [{ path: 'worker/index.js' }] } : {}),
      ...(mode === 'cross-repo' ? { isCrossRepository: true } : {}),
      ...(mode === 'wrong-repo' ? { headRepository: { nameWithOwner: 'other/repository' } } : {}),
      ...(mode === 'bad-sha' ? { headRefOid: 'main' } : {}) });
    assert.equal(args[0], 'api'); assert.deepEqual(args.slice(1, 3), ['--method', 'GET']);
    assert.equal(args[3], `repos/${TELEGRAM_REPO}/contents/public/data/telegram-posts.json?ref=${sha}`);
    assert.equal(maximum, TELEGRAM_LIMIT, 'the exact-head JSON download is bounded');
    if (mode === 'oversized') return ' '.repeat(TELEGRAM_LIMIT + 1);
    if (mode === 'malformed') return '{bad json';
    if (mode === 'wrong-channel') return JSON.stringify({ ...pending, channel: 'untrusted' });
    return JSON.stringify(pending);
  };
  await writeFile(file, JSON.stringify(main));
  const result = prepareTelegramArchive({ repository: TELEGRAM_REPO, file, run, now });
  assert.equal(result.number, 133); assert.equal(result.head, sha);
  const retained = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(retained.posts.map(p => p.id), [3, 2, 1], 'open-PR-only and current-main records survive branch refresh');
  assert.equal(retained.posts[0].text, 'Corrected shared text');
  const fallback = mergeTelegramRestore(retained, capture('2026-09-07T13:15:00Z', [[4, 'Older fallback-only record'], [3, 'Stale correction']]), now);
  assert.deepEqual(fallback.posts.map(p => p.id), [4, 3, 2, 1], 'older artifact fallback cannot discard unmerged PR records');
  assert.equal(fallback.posts.find(p => p.id === 3).text, 'Corrected shared text');
  assert.equal(fallback.lastCheckedAt, pending.lastCheckedAt);
  assert.equal(fallback.publicSafety.nextAttemptAt, pending.publicSafety.nextAttemptAt);
  assert.equal(fallback.apiSafety.paused, true, 'branch refresh does not clear a retained account-review pause');
  for (mode of ['none', 'wrong-file', 'cross-repo', 'wrong-repo', 'bad-sha', 'oversized', 'malformed', 'wrong-channel']) {
    await writeFile(file, JSON.stringify(main)); requests = [];
    if (mode === 'none') assert.equal(prepareTelegramArchive({ repository: TELEGRAM_REPO, file, run, now }).existing, false);
    else assert.throws(() => prepareTelegramArchive({ repository: TELEGRAM_REPO, file, run, now }));
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(main), `${mode}: rejected captures never overwrite current main data`);
    if (['none', 'wrong-file', 'cross-repo', 'wrong-repo', 'bad-sha'].includes(mode)) assert(!requests.some(args => args[0] === 'api'));
  }
  assert.throws(() => prepareTelegramArchive({ repository: 'other/repository', file, run, now }), /Unexpected archive repository/);
  const local = spawnSync(process.execPath, [resolve('scripts/prepare-telegram-archive.mjs')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' },
  });
  assert.notEqual(local.status, 0, 'normal local execution cannot prepare a production archive');
  const workflow = await readFile(new URL('../.github/workflows/telegram-archive.yml', import.meta.url), 'utf8');
  assert.match(workflow, /collect:\n\s+if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /actions\/checkout@v5\n\s+with:\n\s+#.*\n\s+ref: main/);
  assert(!workflow.includes('steps.existing.outputs.skip'), 'an existing stale PR must be refreshed, not skipped forever');
  assert(workflow.indexOf('prepare-telegram-archive.mjs') < workflow.indexOf('telegram-artifact.mjs backup'));
  assert(workflow.indexOf('telegram-artifact.mjs backup') < workflow.indexOf('peter-evans/create-pull-request'));
  assert.match(workflow, /add-paths: public\/data\/telegram-posts.json/);
  console.log('PASS Telegram publishing: exact commit, archive-only scope, CI/review gates, current-main recovery, unmerged history/corrections/pauses and bounded validation');
} finally { await rm(root, { recursive: true, force: true }); }
