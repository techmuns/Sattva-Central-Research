#!/usr/bin/env node
// Read-only scheduler watchdog. A green collector run is not proof of fresh source coverage;
// filings-health and tradingview-health independently check the published data as well.
import { readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function workflowCatalog(dir = new URL('../.github/workflows/', import.meta.url)) {
  return readdirSync(dir).filter(file => /\.ya?ml$/.test(file)).map(file => {
    const text = readFileSync(new URL(file, dir instanceof URL ? dir : pathToFileURL(`${resolve(dir)}/`)), 'utf8');
    return { file, name: text.match(/^name:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '') || file,
      schedules: [...text.matchAll(/^\s+-\s+cron:\s*["']([^"']+)["']/gm)].map(m => m[1]) };
  }).filter(w => w.file !== 'filings-health.yml' && (w.schedules.length || ['verify.yml', 'deploy.yml'].includes(w.file)));
}

function fieldMatches(field, value, min, max) {
  return field.split(',').some(term => {
    const [range, stepText] = term.split('/'), step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw Error('Invalid cron step');
    const [start, end] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(Number) : [Number(range), Number(range)];
    if (![start, end].every(Number.isInteger) || start < min || end > max || start > end) throw Error('Unsupported cron range');
    return value >= start && value <= end && (value - start) % step === 0;
  });
}

export function cronMatches(cron, time) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw Error('Expected five-field UTC cron');
  const d = new Date(time), [minute, hour, day, month, week] = fields;
  const dom = fieldMatches(day, d.getUTCDate(), 1, 31);
  const dow = fieldMatches(week, d.getUTCDay(), 0, 7) || d.getUTCDay() === 0 && fieldMatches(week, 7, 0, 7);
  return fieldMatches(minute, d.getUTCMinutes(), 0, 59) && fieldMatches(hour, d.getUTCHours(), 0, 23) &&
    fieldMatches(month, d.getUTCMonth() + 1, 1, 12) && (day !== '*' && week !== '*' ? dom || dow : dom && dow);
}

export function assessWorkflow(workflow, metadata, runs, { now = Date.now(), graceMs = 2 * 3600000 } = {}) {
  const issues = [];
  if (metadata.state !== 'active') issues.push('workflow-disabled');
  const ordered = runs.filter(r => r.head_branch === 'main' && ['schedule', 'workflow_dispatch', 'push'].includes(r.event))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latest = ordered[0], completed = ordered.find(r => r.status === 'completed');
  if (!latest) issues.push('no-main-run');
  if (completed && completed.conclusion !== 'success') issues.push(`latest-completed-${completed.conclusion || 'unknown'}`);
  if (latest && latest.status !== 'completed' && now - Date.parse(latest.created_at) > graceMs) issues.push('run-overdue');
  // Look back across weekends. A weekday-only market workflow is not late on Saturday.
  let due = null;
  if (workflow.schedules.length) {
    const cutoff = Math.floor((now - graceMs) / 60000) * 60000;
    for (let time = cutoff; time >= cutoff - 8 * 86400000; time -= 60000) {
      if (workflow.schedules.some(cron => cronMatches(cron, time))) { due = time; break; }
    }
    if (due === null) issues.push('schedule-not-assessed');
    else if (!ordered.some(r => r.conclusion === 'success' && Date.parse(r.created_at) >= due && Date.parse(r.created_at) <= now)) issues.push('successful-run-overdue');
  }
  return { ...workflow, ok: issues.length === 0, issues, state: metadata.state, dueAt: due === null ? null : new Date(due).toISOString(),
    latestRun: latest ? { id: latest.id, status: latest.status, conclusion: latest.conclusion, createdAt: latest.created_at, url: latest.html_url } : null };
}

export async function checkWorkflows({ repository, token, fetcher = fetch, catalog = workflowCatalog(), now = Date.now() }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw Error('GITHUB_REPOSITORY must identify one repository');
  const read = async path => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/actions/workflows/${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw Error(`GitHub read returned HTTP ${response.status}`);
    return response.json();
  };
  const results = [];
  // Four concurrent reads bound both API pressure and watchdog runtime.
  for (let i = 0; i < catalog.length; i += 4) {
    results.push(...await Promise.all(catalog.slice(i, i + 4).map(async workflow => {
      try {
        const name = encodeURIComponent(basename(workflow.file));
        const metadata = await read(name);
        const body = await read(`${name}/runs?branch=main&per_page=100`);
        if (!Array.isArray(body.workflow_runs)) throw Error('GitHub run list missing');
        return assessWorkflow(workflow, metadata, body.workflow_runs, { now });
      } catch (error) { return { ...workflow, ok: false, issues: ['workflow-check-unavailable'], detail: error.message }; }
    })));
  }
  return { checkedAt: new Date(now).toISOString(), ok: results.every(r => r.ok), workflows: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await checkWorkflows({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN });
  const lines = ['## Scheduled pipeline health', '', 'Read-only checks. UTC schedules allow two hours for GitHub queueing and collection; data-health checks have independent freshness thresholds.', ''];
  for (const workflow of report.workflows) {
    const line = `${workflow.name}: ${workflow.ok ? 'passing' : workflow.issues.join(', ')}`;
    console.log(line); lines.push(`- ${line}`);
    if (!workflow.ok && process.env.GITHUB_ACTIONS === 'true') console.log(`::error::${line}`);
  }
  if (process.env.WORKFLOW_HEALTH_REPORT) writeFileSync(process.env.WORKFLOW_HEALTH_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
