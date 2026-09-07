#!/usr/bin/env node
// Normal Actions data publication only. Never rebase generated files, force-push, reset main,
// or overwrite the capture checkout. Each attempt starts in a fresh disposable latest-main
// worktree and semantically reconciles the immutable captured records into it.
import { appendFileSync, cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mergeCaptureData } from './lib/company-news-publish.mjs';
import { assessFilingsHealth } from '../public/js/data/filings-health-shared.js';

const git = (cwd, args, { mayFail = false } = {}) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 && !mayFail) throw Error(`company-news-git-${args[0]}-failed`);
  return { ok: result.status === 0, output: result.stdout?.trim() || '' };
};
const inside = (path, root) => realpathSync(path).startsWith(realpathSync(root) + sep);

export async function publishCompanyNews({ repoDir = process.cwd(), captureDataDir = join(repoDir, 'public/data'),
  attempts = 4, fixtureRoot = null, beforePush = async () => {}, verify = async () => {}, healthNow = null } = {}) {
  repoDir = realpathSync(repoDir);
  // The callable fixture seam cannot target a hosted remote. All non-Actions tests must keep
  // both checkout and local bare origin inside their own explicitly supplied temporary root.
  if (fixtureRoot) {
    const remote = git(repoDir, ['remote', 'get-url', 'origin']).output;
    if (!inside(repoDir, fixtureRoot) || !existsSync(remote) || !inside(remote, fixtureRoot)) throw Error('company-news-fixture-scope-invalid');
  } else if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' ||
      !process.env.GITHUB_WORKSPACE || realpathSync(process.env.GITHUB_WORKSPACE) !== repoDir) {
    throw Error('company-news-publication-requires-main-actions-workspace');
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) throw Error('company-news-retry-budget-invalid');
  // HEAD is the immutable capture-start commit, not the dirty captured files. Comparing both
  // branches to this registry preserves live-book updates without reviving main-branch exits.
  const baselineJson = path => {
    const read = git(repoDir, ['show', `HEAD:${path}`], { mayFail: true });
    return read.ok ? JSON.parse(read.output) : null;
  };
  const baselineIndex = baselineJson('public/data/company-news/index.json');
  const baselineDiscovery = baselineJson('public/data/company-news/discovery.json');
  const scratch = mkdtempSync(join(fixtureRoot || process.env.RUNNER_TEMP || tmpdir(), 'company-news-publish-'));
  const capture = join(scratch, 'capture'), worktrees = [];
  try {
    // Copy only this collector's allow-listed data, never scripts, workflow files or credentials.
    for (const path of ['news.json', 'news.parts', 'company-news']) if (existsSync(join(captureDataDir, path)))
      cpSync(join(captureDataDir, path), join(capture, path), { recursive: true });
    for (let attempt = 1; attempt <= attempts; attempt++) {
      git(repoDir, ['fetch', '--no-tags', 'origin', 'main']);
      const latest = git(repoDir, ['rev-parse', 'FETCH_HEAD']).output;
      const worktree = join(scratch, `attempt-${attempt}`);
      git(repoDir, ['worktree', 'add', '--detach', worktree, latest]);
      worktrees.push(worktree);
      const merged = mergeCaptureData(capture, join(worktree, 'public/data'), { baselineIndex, baselineDiscovery });
      await verify(worktree, merged);
      const paths = ['public/data/news.json', 'public/data/company-news'];
      if (existsSync(join(worktree, 'public/data/news.parts')) || git(worktree, ['ls-files', 'public/data/news.parts']).output) paths.push('public/data/news.parts');
      git(worktree, ['add', '-A', '--', ...paths]);
      const changed = git(worktree, ['diff', '--cached', '--name-only']).output.split('\n').filter(Boolean);
      if (changed.some(path => path !== 'public/data/news.json' && !path.startsWith('public/data/news.parts/') && !path.startsWith('public/data/company-news/')))
        throw Error('company-news-publication-path-outside-scope');
      const finish = (outcome, commit) => {
        // Assess the exact committed index, never the original capture checkout or mutable
        // remote main. This stays tied to the published version even if main advances again.
        // Incomplete coverage fails the job only AFTER useful partial data is preserved.
        let index = null;
        try { index = JSON.parse(git(worktree, ['show', `${commit}:public/data/company-news/index.json`]).output); } catch {}
        const health = { ...assessFilingsHealth({ news: index }, { sources: ['news'], now: healthNow ?? Date.now() }),
          publicationCommit: commit, publicationOutcome: outcome };
        return { ok: health.ok, published: true, outcome, attempts: attempt, commit, ...merged, health };
      };
      if (!changed.length) return finish('already-retained', latest);
      git(worktree, ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', `Company news refresh (${merged.capturedAt})`]);
      const commit = git(worktree, ['rev-parse', 'HEAD']).output;
      await beforePush({ attempt, worktree, commit, base: latest });
      if (git(worktree, ['push', 'origin', 'HEAD:refs/heads/main'], { mayFail: true }).ok)
        return finish('published', commit);
      // Distinguish a real main-branch race from authentication/protection/network refusal.
      // An ambiguous response that actually published this commit is success, not a second push.
      git(repoDir, ['fetch', '--no-tags', 'origin', 'main']);
      const after = git(repoDir, ['rev-parse', 'FETCH_HEAD']).output;
      if (after === commit) return finish('published', commit);
      if (after === latest) throw Error('company-news-push-refused-without-main-change');
    }
    throw Error('company-news-publication-retry-budget-exhausted');
  } finally {
    // These are only the worktrees created above, below this invocation's mkdtemp directory.
    // Their source capture remains in the original checkout and the uploaded workflow artifact.
    for (const path of worktrees) git(repoDir, ['worktree', 'remove', '--force', path], { mayFail: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await publishCompanyNews({ verify: async worktree => {
      const checked = spawnSync(process.execPath, ['scripts/check-news-capacity.mjs'], { cwd: worktree, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (checked.status !== 0) throw Error('company-news-reconciled-capacity-check-failed');
    } });
    if (process.env.FILINGS_HEALTH_REPORT) writeFileSync(process.env.FILINGS_HEALTH_REPORT, `${JSON.stringify(report.health, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n## Published company-news health\n\nCommit: \`${report.commit}\` · Status: **${report.health.status}** · ${report.health.critical} critical findings\n\n` +
      report.health.findings.map(finding => `- ${finding.severity}: ${finding.code} (${finding.count})`).join('\n') +
      '\n\nThe exact committed index was checked after publication. Retained records were published even when coverage remained incomplete; this does not certify exhaustive provider coverage.\n');
    console.log(JSON.stringify(report));
    if (!report.ok) {
      if (process.env.GITHUB_ACTIONS === 'true') console.error('::error::Published company-news coverage is incomplete. See the commit-bound health report; captured records were retained.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: /^company-news-[a-z-]+$/.test(error.message) ? error.message : 'company-news-reconciliation-failed',
      note: 'Captured data is retained in the workflow artifact. No force push or capture-job replay was performed.' }));
    process.exitCode = 1;
  }
}
