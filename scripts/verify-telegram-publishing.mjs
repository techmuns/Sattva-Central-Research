#!/usr/bin/env node
// Exercise the auto-publisher with a fake gh executable; no GitHub calls or repository writes.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  console.log('PASS Telegram publishing: exact commit, archive-only scope, CI gates, review feedback, and informational bot notices');
} finally { await rm(root, { recursive: true, force: true }); }
