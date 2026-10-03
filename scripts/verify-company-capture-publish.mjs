#!/usr/bin/env node
// Execute the real workflow publisher against shallow local clones and a local bare remote.
// No GitHub calls, production operations or writes outside the temporary fixture directory.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workflow = readFileSync(new URL('../.github/workflows/insider-trades-refresh.yml', import.meta.url), 'utf8');
const step = workflow.split('      - name: Commit filing and trade captures to main\n')[1];
assert(step, 'the actual capture publication step exists');
const lines = step.split('        run: |\n')[1].split('\n');
const commands = [];
for (const line of lines) {
  if (line && !line.startsWith('          ')) break;
  commands.push(line.slice(10));
}
const script = commands.join('\n');
assert(script.includes('git push'), 'test executes the workflow publisher, not a separate implementation');
const scratch = mkdtempSync(join(tmpdir(), 'sattva-company-capture-publish-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'gc.auto=0', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const write = (root, path, body) => {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
};
const configure = root => {
  git(root, 'config', 'user.name', 'Local fixture');
  git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'gc.auto', '0');
};
const commit = (root, message) => { git(root, 'add', '.'); git(root, 'commit', '-m', message); };
const captured = '{"records":["retained","newly-captured"]}\n';
const captureFile = 'public/data/filing-capture/index.json';

function setup(name, { competingCapture = null } = {}) {
  const root = join(scratch, name), seed = join(root, 'seed'), remote = join(root, 'origin.git');
  mkdirSync(seed, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(seed, 'init', '-b', 'codex/fixture-seed'); configure(seed);
  write(seed, captureFile, '{"records":["retained"]}\n');
  write(seed, 'public/data/insider-trades.json', '{"trades":["retained"]}\n');
  write(seed, 'public/data/insider-archive/retained.json', '{"history":true}\n');
  for (let i = 0; i < 24; i++) {
    write(seed, 'unrelated-history.txt', `historical version ${i}\n`);
    commit(seed, `Historical data ${i}`);
  }
  git(seed, 'branch', 'codex/fixture-feature');
  write(seed, 'unrelated-history.txt', 'latest unrelated data\n'); commit(seed, 'Recent data');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'HEAD:refs/heads/main');

  const checkout = join(root, 'capture');
  git(root, 'clone', '--quiet', '--depth=1', pathToFileURL(remote).href, checkout);
  configure(checkout); git(checkout, 'switch', '-c', 'codex/fixture-capture');
  assert.equal(git(checkout, 'rev-list', '--all', '--count'), '1', 'fixture starts like actions/checkout');
  write(checkout, captureFile, captured);

  // A concurrent PR forks before the shallow checkout's boundary. An unbounded fetch
  // follows its second-parent ancestry into historical data that publication never needs.
  git(seed, 'switch', 'codex/fixture-feature');
  write(seed, 'latest-code.txt', 'concurrent code change\n'); commit(seed, 'Concurrent feature');
  git(seed, 'switch', 'codex/fixture-seed');
  git(seed, 'merge', '--no-ff', 'codex/fixture-feature', '-m', 'Merge concurrent PR');
  if (competingCapture) { write(seed, captureFile, competingCapture); commit(seed, 'Concurrent capture'); }
  git(seed, 'push', 'origin', 'HEAD:refs/heads/main');
  return { root, seed, checkout, remote, upstream: git(remote, 'rev-parse', 'refs/heads/main') };
}
const publish = fixture => spawnSync('bash', ['-e', '-c', script], {
  cwd: fixture.checkout, encoding: 'utf8', timeout: 30_000,
});
const remoteFile = (fixture, path) => git(fixture.remote, 'show', `refs/heads/main:${path}`) + '\n';

try {
  const race = setup('merged-pr');
  const result = publish(race);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(remoteFile(race, captureFile), captured, 'captured and retained records survive the retry');
  assert.equal(remoteFile(race, 'latest-code.txt'), 'concurrent code change\n', 'latest code survives');
  assert.equal(remoteFile(race, 'unrelated-history.txt'), 'latest unrelated data\n', 'unrelated data survives');
  assert.equal(remoteFile(race, 'public/data/insider-archive/retained.json'), '{"history":true}\n');
  assert.equal(git(race.remote, 'rev-parse', 'refs/heads/main^'), race.upstream, 'ordinary fast-forward on the latest main');
  assert(Number(git(race.checkout, 'rev-list', '--all', '--count')) <= 3, 'publication must not fetch the old data history');
  assert.equal(git(race.checkout, 'status', '--porcelain'), '', 'successful capture checkout is clean');

  const secondRace = setup('main-advances-again');
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
  const hook = join(secondRace.checkout, '.git/hooks/pre-push');
  const pushCount = join(secondRace.root, 'push-count');
  // Advance the local fixture remote after the first rebase, during the second push.
  // This checks that a later retry reapplies the current capture commit's parent range.
  writeFileSync(hook, `#!/bin/sh
set -e
capture_push_count=0
if [ -f ${quote(pushCount)} ]; then capture_push_count=$(cat ${quote(pushCount)}); fi
capture_push_count=$((capture_push_count + 1))
printf '%s' "$capture_push_count" > ${quote(pushCount)}
if [ "$capture_push_count" = 2 ]; then
  printf 'newer concurrent data\\n' > ${quote(join(secondRace.seed, 'second-source.txt'))}
  git -C ${quote(secondRace.seed)} add second-source.txt
  git -C ${quote(secondRace.seed)} commit -m 'Second concurrent update'
  git -C ${quote(secondRace.seed)} push origin HEAD:refs/heads/main
fi
`);
  chmodSync(hook, 0o755);
  const secondResult = publish(secondRace);
  assert.equal(secondResult.status, 0, secondResult.stderr || secondResult.error?.message);
  assert.equal(readFileSync(pushCount, 'utf8'), '3', 'two rejected pushes are followed by a normal successful push');
  assert.equal(remoteFile(secondRace, captureFile), captured);
  assert.equal(remoteFile(secondRace, 'latest-code.txt'), 'concurrent code change\n');
  assert.equal(remoteFile(secondRace, 'second-source.txt'), 'newer concurrent data\n');
  assert.equal(git(secondRace.remote, 'rev-parse', 'refs/heads/main^'), git(secondRace.seed, 'rev-parse', 'HEAD'));
  assert(Number(git(secondRace.checkout, 'rev-list', '--all', '--count')) <= 3, 'later retries stay shallow');

  const duplicate = setup('already-published', { competingCapture: captured });
  const duplicateResult = publish(duplicate);
  assert.equal(duplicateResult.status, 0, duplicateResult.stderr || duplicateResult.error?.message);
  assert.equal(git(duplicate.remote, 'rev-parse', 'refs/heads/main'), duplicate.upstream, 'identical publication adds no extra commit');
  assert.equal(remoteFile(duplicate, captureFile), captured);

  const conflict = setup('conflicting-capture', { competingCapture: '{"records":["retained","other-writer"]}\n' });
  const conflictResult = publish(conflict);
  assert.notEqual(conflictResult.status, 0, 'a conflicting capture must stop for recovery');
  assert.equal(git(conflict.remote, 'rev-parse', 'refs/heads/main'), conflict.upstream, 'conflicts never overwrite main');
  assert.equal(readFileSync(join(conflict.checkout, captureFile), 'utf8'), captured, 'failed publication retains the captured checkpoint');
  assert.equal(git(conflict.checkout, 'status', '--porcelain'), '', 'the failed rebase is aborted cleanly');
  console.log('PASS shallow company-capture publication: bounded history, repeated races, concurrent code/data preservation, identical publication and conflict retention.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
