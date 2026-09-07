// Read validated Telegram checkpoints from one fixed Actions workflow. The
// GitHub token is sent only to api.github.com; its signed artifact URL receives no credentials.
import {
  TELEGRAM_ARTIFACT,
  TELEGRAM_HEAD_ARTIFACT,
  TELEGRAM_COMPRESSED_LIMIT,
  TELEGRAM_LIMIT,
  TELEGRAM_REPO,
  TELEGRAM_WORKFLOW,
  validateTelegramCapture,
} from '../public/js/data/telegram-shared.js';
import { boundedCollectorBytes } from './screener-concalls-collector.mjs';

const API = `https://api.github.com/repos/${TELEGRAM_REPO}`;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

async function boundedText(response, signal, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty Telegram response');
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('Telegram response exceeds size limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readTelegramCollector({
  token,
  ref = 'main',
  allowMissing = false,
  purpose = 'delivery',
  excludeRunId = 0,
  runAttempt = 1,
  fetcher = fetch,
  now = Date.now,
  signal = AbortSignal.timeout(15_000),
} = {}) {
  if (!token) throw Error('Telegram collector requires the existing Worker GitHub Actions credential');
  if (!['delivery', 'restore'].includes(purpose)) throw Error('Invalid Telegram artifact read purpose');
  if (!positiveId(runAttempt)) throw Error('Invalid Telegram workflow attempt');
  if (purpose === 'restore' && runAttempt > 1) throw Error('Telegram restore cannot confirm safety for a rerun; use a new workflow run');
  signal.throwIfAborted();
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'sattva-telegram-reader',
    'x-github-api-version': '2022-11-28',
  };
  const get = (path) => fetcher(`${API}${path}`, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal });
  const json = async (path) => {
    const response = await get(path);
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Telegram GitHub read failed (HTTP ${response.status})`);
    }
    return JSON.parse(await boundedText(response, signal, 512 * 1024));
  };
  const runPath = `/actions/workflows/${TELEGRAM_WORKFLOW}/runs?branch=${encodeURIComponent(ref)}`;
  // GitHub's REST `name` contains run-name when configured. The collection prefix marks
  // artifact-producing runs; legacy "Telegram refresh (...)" runs have no such artifact.
  const trusted = (run) => positiveId(run.id) && (run.name === 'Telegram collection' ||
    (typeof run.name === 'string' && run.name.startsWith('Telegram collection (') && run.name.endsWith(')'))) && run.head_branch === ref &&
    run.head_repository?.full_name === TELEGRAM_REPO &&
    (['schedule', 'push', 'workflow_dispatch'].includes(run.event) || (ref !== 'main' && run.event === 'pull_request'));
  const recent = await json(`${runPath}&per_page=10`);
  const successful = await json(`${runPath}&status=success&per_page=10`);
  const allRuns = [...new Map([...(successful.workflow_runs || []), ...(recent.workflow_runs || [])]
    // A rerun shares its ID with the previous attempt, which may have recorded a safety
    // pause. Only a new run can exclude its own empty first-attempt restore step.
    .filter(trusted).filter(run => run.id !== Number(excludeRunId) || runAttempt > 1).map(run => [run.id, run])).values()]
    .sort((a, b) => b.id - a.id);
  const latest = allRuns[0];
  const latestCompleted = allRuns.find(run => run.status === 'completed');
  const active = allRuns.find(run => run.status === 'in_progress');
  // Queued runs have not read Telegram. In-progress checkpoints are useful for display, but
  // cannot establish the final safety state needed to authorize the next collection.
  const eligible = allRuns.filter(run => purpose === 'restore' ? run.status !== 'queued' : ['in_progress', 'completed'].includes(run.status));
  const baseline = eligible.find(run => run.status === 'completed' && run.conclusion === 'success');
  const recentIds = new Set((recent.workflow_runs || []).filter(trusted).map(run => run.id));
  const candidates = purpose === 'restore' ? eligible.filter(run => recentIds.has(run.id)).slice(0, 10) : eligible.slice(0, 3);
  // Repeated failures before publication must not crowd the successful baseline out of the
  // fixed recovery budget. Still inspect the two newest runs for current failure checkpoints.
  if (purpose === 'delivery' && baseline && !candidates.some(run => run.id === baseline.id)) candidates[2] = baseline;
  if (!candidates.length) {
    if (allowMissing && !eligible.length) return null;
    throw Error('No Telegram capture is available');
  }
  const skipped = [];
  const beforeSourceSteps = new Set(['Set up job', 'Run actions/checkout@v5', 'Run actions/setup-node@v5',
    'Restore retained collection independently of archive PRs', 'Post Run actions/setup-node@v5',
    'Post Run actions/checkout@v5', 'Complete job']);
  async function failedBeforeSource(run) {
    if (run.status !== 'completed' || run.conclusion !== 'failure' || run.run_attempt !== 1) return false;
    // Only authenticated, complete attempt1 job evidence can establish that a failed restore
    // never contacted Telegram. Missing steps, reruns, cancellation and unknown work fail shut.
    const inventory = await json(`/actions/runs/${run.id}/attempts/1/jobs?per_page=10`);
    if (inventory.total_count !== 1 || !Array.isArray(inventory.jobs) || inventory.jobs.length !== 1) return false;
    const job = inventory.jobs[0];
    if (job.name !== 'collect' || job.run_id !== run.id || (job.run_attempt != null && job.run_attempt !== 1) ||
        job.status !== 'completed' || job.conclusion !== 'failure' || !Array.isArray(job.steps) || !job.steps.length) return false;
    if (job.steps.some(step => !positiveId(step.number)) || new Set(job.steps.map(step => step.number)).size !== job.steps.length) return false;
    const source = job.steps.find(step => step.name === 'Collect channel through official API or public fallback');
    if (!source || source.status !== 'completed' || source.conclusion !== 'skipped') return false;
    return job.steps.every(step => step.status === 'completed' && (step.conclusion === 'skipped' ||
      beforeSourceSteps.has(step.name) && ['success', 'failure'].includes(step.conclusion)));
  }
  async function readArtifact(artifact, run) {
    if (!artifact || artifact.expired || artifact.workflow_run?.id !== run.id || !positiveId(artifact.id) ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') ||
        !(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= TELEGRAM_COMPRESSED_LIMIT)) {
      throw Error('Telegram artifact missing or invalid');
    }
    const redirect = await get(`/actions/artifacts/${artifact.id}/zip`);
    const location = redirect.headers.get('location');
    await redirect.body?.cancel();
    if (redirect.status !== 302 || !location) throw Error('Telegram artifact download unavailable');
    const target = new URL(location);
    if (target.protocol !== 'https:' || target.username || target.password || target.port ||
        !(/^[-a-z0-9]+\.blob\.core\.windows\.net$/.test(target.hostname) || /^[-a-z0-9]+\.actions\.githubusercontent\.com$/.test(target.hostname))) {
      throw Error('Telegram artifact redirect rejected');
    }
    const response = await fetcher(target.href, { method: 'GET', redirect: 'manual', cache: 'no-store', signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Telegram artifact unavailable (HTTP ${response.status})`);
    }
    const bytes = await boundedCollectorBytes(response, signal, TELEGRAM_COMPRESSED_LIMIT);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (`sha256:${digest}` !== artifact.digest || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw Error('Telegram artifact integrity check failed');
    const decompressed = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    return validateTelegramCapture(JSON.parse(await boundedText(new Response(decompressed), signal, TELEGRAM_LIMIT)), now());
  }
  for (const run of candidates) {
    signal.throwIfAborted();
    if (purpose === 'restore' && run.status !== 'completed') throw Error('Telegram restore cannot confirm safety while a previous collection is running');
    try {
      const list = await json(`/actions/runs/${run.id}/artifacts?per_page=10`);
      if (!Array.isArray(list.artifacts)) throw Error('Telegram artifact inventory is invalid');
      const artifacts = list.artifacts;
      if (purpose === 'restore' && !artifacts.length && await failedBeforeSource(run)) continue;
      // Normal collection has a short interval before its first upload. Keep displaying the
      // last verified final during that interval; absence alone is not a failed publication.
      if (purpose === 'delivery' && run.status === 'in_progress' &&
          !artifacts.some(item => [TELEGRAM_ARTIFACT, TELEGRAM_HEAD_ARTIFACT].includes(item.name))) continue;
      let capture, phase, finalError;
      for (const [name, label] of [[TELEGRAM_ARTIFACT, 'final'], [TELEGRAM_HEAD_ARTIFACT, 'head']]) {
        const artifact = artifacts.find(item => item.name === name);
        if (!artifact) continue;
        try { capture = await readArtifact(artifact, run); phase = label; break; }
        catch (error) { signal.throwIfAborted(); finalError = error; }
      }
      if (!capture) throw finalError || Error('Telegram artifact missing or invalid');
      if (purpose === 'restore' && phase !== 'final') throw Error('Telegram restore requires a final checkpoint; later source safety is unknown');
      const latestFailed = !!latestCompleted && latestCompleted.id >= run.id && latestCompleted.conclusion !== 'success';
      // A head checkpoint is deliberately published while history is still collecting.
      // Its phase exposes that normal progress; degradation means missing/failed delivery.
      const degraded = skipped.length > 0 || !!finalError || latestFailed ||
        (run.status === 'completed' && (phase !== 'final' || run.conclusion !== 'success'));
      return { capture, source: {
        id: 'telegram', status: degraded ? 'partial' : 'ok', degraded, checkedAt: capture.lastCheckedAt,
        count: capture.posts.length, collectorRunId: run.id,
        collectorRunUrl: `https://github.com/${TELEGRAM_REPO}/actions/runs/${run.id}`,
        collectorArtifactPhase: phase,
        collectorFallback: skipped.length > 0,
        collectorSkippedRuns: skipped,
        collectorLatestRunId: latest?.id || null,
        collectorActiveRunId: active?.id || null,
        collectorLatestCompletedRunId: latestCompleted?.id || null,
        collectorInProgress: !!active,
        collectorLatestFailed: latestFailed,
        collectorLatestConclusion: latestCompleted?.conclusion || null,
      } };
    } catch (error) {
      signal.throwIfAborted();
      // Display can retain an older verified archive. Collection must not silently discard a
      // pause recorded in an unreadable newer checkpoint, even when its rows remain usable.
      if (purpose === 'restore') throw Error(`Telegram restore stopped: ${error.message}; newer source safety could not be confirmed`);
      skipped.push({ id: run.id, reason: String(error.message || 'Capture unavailable').slice(0, 160) });
    }
  }
  if (purpose === 'restore') throw Error('Telegram restore stopped: no final safety checkpoint within the contiguous recent-run recovery window');
  throw Error('No validated Telegram capture is available within the recent recovery window');
}
