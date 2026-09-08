#!/usr/bin/env node
// Actual local bare-Git publication races. All checkouts/remotes/artifacts stay in mkdtemp;
// no GitHub commands, hosted remotes, main-workspace writes or production operations.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { publishCompanyNews } from './publish-company-news.mjs';
import { readNewsJson, writeNewsJson } from './lib/news-json-storage.mjs';
import { assessFilingsHealth } from '../public/js/data/filings-health-shared.js';

// process.cwd() resolves macOS /var aliases; canonicalize before constructing any fixture paths.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sattva-company-news-git-')));
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const initialPath = process.env.PATH;
const healthNow = Date.parse('2026-09-07T07:30:00Z');
const identity = { entityId: 'isin:INE12F801023', key: 'KISSHT', ticker: 'KISSHT',
  name: 'OnEMI Technology Solutions', legalName: 'OnEMI Technology Solutions Limited', queries: ['OnEMI Technology Solutions'] };
const article = id => ({ entityId: identity.entityId, ticker: identity.ticker, company: identity.name,
  title: `OnEMI Technology fixture ${id}`, source: 'Local fixture publisher', url: `https://example.test/${id}`,
  date: '2026-09-07', publishedAt: '2026-09-07T06:00:00Z', firstSeenAt: '2026-09-07T06:00:00Z' });
const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (path, content) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); };
const json = (path, value) => write(path, JSON.stringify(value) + '\n');
function saveCapture(checkout, rows, at) {
  const data = join(checkout, 'public/data');
  writeNewsJson(join(data, 'news.json'), { capturedAt: at, entities: [identity], byTicker: { KISSHT: rows },
    from: '2026-08-08', empty: [], failed: {}, queryCoverage: { planned: 1, succeeded: 1, failed: 0 },
    archive: { index: 'company-news/index.json' } });
  writeNewsJson(join(data, 'company-news/2026-09.json'), { month: '2026-09', articles: rows });
  writeNewsJson(join(data, 'company-news/index.json'), { version: 1, createdAt: '2026-09-07T06:00:00Z', updatedAt: at,
    entities: [identity], queries: { [identity.entityId]: { [identity.name]: { lastAttemptAt: at, lastSuccessAt: at, coveredThrough: '2026-09-07' } } },
    archive: [{ file: 'company-news/2026-09.json', month: '2026-09', count: rows.length }], articleCount: rows.length });
}
function fingerprint(directory) {
  const entries = [];
  const walk = (path, prefix = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) walk(join(path, entry.name), `${key}/`);
      else entries.push([key, createHash('sha256').update(readFileSync(join(path, entry.name))).digest('hex')]);
    }
  };
  walk(directory); return entries;
}
function setup(name) {
  const root = join(scratch, name), remote = join(root, 'origin.git'), seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(seed, 'init', '-b', 'codex/fixture-seed');
  git(seed, 'config', 'user.name', 'Local fixture'); git(seed, 'config', 'user.email', 'fixture@example.test');
  git(seed, 'config', 'commit.gpgsign', 'false');
  saveCapture(seed, [article('base')], '2026-09-07T06:00:00Z');
  write(join(seed, 'worker/index.js'), 'export const build = "baseline";\n');
  json(join(seed, 'public/data/other-source.json'), { version: 'baseline' });
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Local fixture baseline');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'HEAD:refs/heads/main');
  const checkout = join(root, 'capture'), competing = join(root, 'competing');
  for (const [path, branch] of [[checkout, 'codex/fixture-capture'], [competing, 'codex/fixture-competing']]) {
    git(root, 'clone', '--quiet', remote, path); git(path, 'switch', '-c', branch);
    git(path, 'config', 'user.name', 'Local fixture'); git(path, 'config', 'user.email', 'fixture@example.test');
    git(path, 'config', 'commit.gpgsign', 'false');
  }
  saveCapture(checkout, [article('base'), article('captured')], '2026-09-07T07:00:00Z');
  // Unrelated dirty code/data in a capture workspace must never enter this data-only publisher.
  write(join(checkout, 'worker/index.js'), 'export const build = "unrelated-capture-edit";\n');
  json(join(checkout, 'public/data/other-source.json'), { version: 'unrelated-capture-edit' });
  write(join(checkout, 'capture-notes.txt'), 'untracked fixture observation\n');
  const artifact = join(root, 'captured-artifact');
  cpSync(join(checkout, 'public/data'), artifact, { recursive: true });
  return { root, remote, checkout, competing, artifact };
}
function preservation(fixture) {
  return { head: git(fixture.checkout, 'rev-parse', 'HEAD'), branch: git(fixture.checkout, 'branch', '--show-current'),
    status: git(fixture.checkout, 'status', '--porcelain'), data: fingerprint(join(fixture.checkout, 'public/data')),
    code: readFileSync(join(fixture.checkout, 'worker/index.js'), 'utf8'), artifact: fingerprint(fixture.artifact) };
}
function advanceMain(fixture, sequence) {
  const rows = [article('base'), ...Array.from({ length: sequence }, (_, i) => article(`competing-${i + 1}`))];
  saveCapture(fixture.competing, rows, `2026-09-07T06:${String(sequence).padStart(2, '0')}:00Z`);
  write(join(fixture.competing, 'worker/index.js'), `export const build = "latest-main-${sequence}";\n`);
  json(join(fixture.competing, 'public/data/other-source.json'), { version: `latest-main-${sequence}` });
  git(fixture.competing, 'add', '.'); git(fixture.competing, 'commit', '-m', `Competing fixture update ${sequence}`);
  git(fixture.competing, 'push', 'origin', 'HEAD:refs/heads/main');
  return git(fixture.competing, 'rev-parse', 'HEAD');
}
const remoteText = (fixture, path) => git(fixture.remote, 'show', `refs/heads/main:${path}`);
const remoteHead = fixture => JSON.parse(remoteText(fixture, 'public/data/news.json'));
const urls = rows => rows.map(row => row.url).sort();

try {
  // Record the publisher's real Git commands without replacing Git behavior. Fixture setup and
  // competing writer use the resolved binary directly; the wrapper sees publication only.
  const bin = join(scratch, 'bin'), log = join(scratch, 'git-calls.jsonl');
  mkdirSync(bin);
  write(join(bin, 'git'), `#!/usr/bin/env node\nconst fs=require('node:fs');const cp=require('node:child_process');\nconst args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({cwd:process.cwd(),args})+'\\n');\nconst r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status===null?1:r.status);\n`);
  execFileSync('chmod', ['+x', join(bin, 'git')]);
  process.env.PATH = `${bin}:${initialPath}`;
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

  const race = setup('race-recovered'), beforeRace = preservation(race), checks = [], attempts = [];
  let competingCommit;
  const published = await publishCompanyNews({ repoDir: race.checkout, fixtureRoot: race.root, healthNow,
    verify: async (worktree, result) => {
      assert(readNewsJson(join(worktree, 'public/data/news.json')).byTicker.KISSHT.some(row => row.url === article('captured').url));
      checks.push(result.archiveRows);
    },
    beforePush: async ({ attempt, worktree, base }) => {
      attempts.push(attempt);
      if (attempt === 1) competingCommit = advanceMain(race, 1);
      else {
        assert.equal(base, competingCommit, 'retry starts from the competing main commit, not stale code');
        assert.match(readFileSync(join(worktree, 'worker/index.js'), 'utf8'), /latest-main-1/);
      }
    } });
  assert.equal(published.outcome, 'published'); assert.equal(published.attempts, 2);
  assert.equal(published.ok, true); assert.equal(published.health.ok, true);
  assert.equal(published.health.publicationCommit, published.commit, 'health is bound to the actual successfully published commit');
  assert.deepEqual(attempts, [1, 2]); assert.equal(checks.length, 2, 'each semantic merge is verified before its push');
  assert.equal(git(race.remote, 'rev-parse', 'refs/heads/main^'), competingCommit, 'published data is a descendant of current main');
  assert.deepEqual(urls(remoteHead(race).byTicker.KISSHT), urls([article('base'), article('captured'), article('competing-1')]));
  assert.deepEqual(urls(JSON.parse(remoteText(race, 'public/data/company-news/2026-09.json')).articles), urls([article('base'), article('captured'), article('competing-1')]));
  assert.match(remoteText(race, 'worker/index.js'), /latest-main-1/, 'latest application code is preserved');
  assert.equal(JSON.parse(remoteText(race, 'public/data/other-source.json')).version, 'latest-main-1', 'other writers retain their data');
  assert.deepEqual(preservation(race), beforeRace, 'publication never rewrites the original capture workspace or uploaded artifact');
  const mergedCommit = git(race.remote, 'rev-parse', 'refs/heads/main');
  const unchanged = await publishCompanyNews({ repoDir: race.checkout, fixtureRoot: race.root, healthNow });
  assert.equal(unchanged.outcome, 'already-retained', 'retrying the same retained capture is idempotent');
  assert.equal(unchanged.ok, true); assert.equal(unchanged.health.publicationCommit, mergedCommit);
  assert.equal(git(race.remote, 'rev-parse', 'refs/heads/main'), mergedCommit);

  const exhausted = setup('race-exhausted'), beforeExhaustion = preservation(exhausted), exhaustedAttempts = [];
  await assert.rejects(publishCompanyNews({ repoDir: exhausted.checkout, fixtureRoot: exhausted.root, attempts: 4,
    beforePush: async ({ attempt }) => { exhaustedAttempts.push(attempt); advanceMain(exhausted, attempt); },
  }), /company-news-publication-retry-budget-exhausted/);
  assert.deepEqual(exhaustedAttempts, [1, 2, 3, 4], 'publication stops at its finite race budget');
  assert.deepEqual(preservation(exhausted), beforeExhaustion, 'exhaustion preserves every captured source byte and the recovery artifact');
  assert.deepEqual(urls(remoteHead(exhausted).byTicker.KISSHT), urls([article('base'), ...Array.from({ length: 4 }, (_, i) => article(`competing-${i + 1}`))]));
  assert.match(remoteText(exhausted, 'worker/index.js'), /latest-main-4/);
  assert(!git(exhausted.remote, 'log', 'refs/heads/main', '--format=%s').includes('Company news refresh'), 'failed attempts do not rewrite main history');
  assert.equal(git(exhausted.checkout, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1, 'disposable publication worktrees are cleaned');
  assert(!readdirSync(exhausted.root).some(name => name.startsWith('company-news-publish-')), 'only disposable attempt copies are removed');

  const refused = setup('push-refused'), beforeRefusal = preservation(refused);
  write(join(refused.remote, 'hooks/update'), '#!/bin/sh\nexit 1\n');
  execFileSync('chmod', ['+x', join(refused.remote, 'hooks/update')]);
  const refusalCalls = calls().length;
  await assert.rejects(publishCompanyNews({ repoDir: refused.checkout, fixtureRoot: refused.root }), /company-news-push-refused-without-main-change/);
  assert.equal(calls().slice(refusalCalls).filter(call => call.args[0] === 'push').length, 1, 'unchanged-main refusal is not treated as a retryable race');
  assert.deepEqual(preservation(refused), beforeRefusal);
  assert.deepEqual(urls(remoteHead(refused).byTicker.KISSHT), [article('base').url]);

  // A concurrent main update introduces an unvisited alias. The original capture remains
  // healthy, but the actual reconciled published index must fail health without losing data.
  const partial = setup('published-partial'), beforePartial = preservation(partial);
  const originalIndex = readNewsJson(join(partial.checkout, 'public/data/company-news/index.json'));
  assert.equal(assessFilingsHealth({ news: originalIndex }, { sources: ['news'], now: healthNow }).ok, true);
  const partialResult = await publishCompanyNews({ repoDir: partial.checkout, fixtureRoot: partial.root, healthNow,
    beforePush: async ({ attempt, worktree }) => {
      if (attempt !== 1) {
        // Simulate mutable worktree state diverging after the commit. It is not pushed and
        // cannot replace the exact committed snapshot as the health audit's evidence.
        const path = join(worktree, 'public/data/company-news/index.json');
        const transient = readNewsJson(path);
        transient.entities[0].queries = [identity.name];
        writeNewsJson(path, transient);
        assert.equal(assessFilingsHealth({ news: transient }, { sources: ['news'], now: healthNow }).ok, true);
        return;
      }
      advanceMain(partial, 1);
      const path = join(partial.competing, 'public/data/company-news/index.json');
      const current = readNewsJson(path);
      current.entities[0].queries.push('New reviewed alias not searched yet');
      writeNewsJson(path, current);
      git(partial.competing, 'add', 'public/data/company-news/index.json');
      git(partial.competing, 'commit', '-m', 'Concurrent reviewed alias awaiting capture');
      git(partial.competing, 'push', 'origin', 'HEAD:refs/heads/main');
    } });
  assert.equal(partialResult.published, true); assert.equal(partialResult.outcome, 'published');
  assert.equal(partialResult.ok, false, 'publication success is not a healthy coverage result');
  assert.equal(partialResult.health.ok, false);
  assert.equal(partialResult.attempts, 2, 'a healthy stale checkout cannot determine the retried publication health');
  assert(partialResult.health.findings.some(f => f.code === 'company-never-checked'));
  assert.equal(partialResult.health.publicationCommit, git(partial.remote, 'rev-parse', 'refs/heads/main'));
  assert.deepEqual(urls(remoteHead(partial).byTicker.KISSHT), urls([article('base'), article('captured'), article('competing-1')]),
    'partial merged coverage is published, not discarded when the health result fails');
  assert.deepEqual(preservation(partial), beforePartial, 'partial health preserves the original healthy checkout and artifact');
  const partialRetained = await publishCompanyNews({ repoDir: partial.checkout, fixtureRoot: partial.root, healthNow });
  assert.equal(partialRetained.outcome, 'already-retained'); assert.equal(partialRetained.ok, false,
    'an idempotent already-retained publication still checks its reconciled incomplete index');

  const commands = calls();
  assert(commands.every(call => !['reset', 'rebase', 'checkout'].includes(call.args[0])), 'no reset, rebase or checkout can discard the capture');
  const pushes = commands.filter(call => call.args[0] === 'push');
  assert(pushes.length >= 7);
  assert(pushes.every(call => JSON.stringify(call.args) === JSON.stringify(['push', 'origin', 'HEAD:refs/heads/main'])), 'only ordinary fast-forward pushes; no --force, +refspec or branch overwrite');
  assert(commands.every(call => call.cwd.startsWith(scratch + '/')), 'every Git operation stayed in the isolated local fixture');
  console.log('PASS local bare Git: competing-main retry preserves latest code and both news captures; idempotent publication; four-race exhaustion and unchanged-main refusal retain capture checkout/artifact; scoped normal pushes and worktree cleanup.');
} finally {
  process.env.PATH = initialPath;
  rmSync(scratch, { recursive: true, force: true });
}
