// Read the latest successful Screener Insights artifact from one fixed Actions workflow. The
// GitHub token is sent only to api.github.com; its signed artifact URL receives no credentials.
import {
  SCREENER_INSIGHTS_ARTIFACT,
  SCREENER_INSIGHTS_COMPRESSED_LIMIT,
  SCREENER_INSIGHTS_LIMIT,
  SCREENER_INSIGHTS_REPO,
  SCREENER_INSIGHTS_WORKFLOW,
  validateScreenerInsightsCapture,
} from '../public/js/data/screener-insights-shared.js';
import { boundedCollectorBytes } from './screener-concalls-collector.mjs';

const API = `https://api.github.com/repos/${SCREENER_INSIGHTS_REPO}`;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

async function boundedText(response, signal, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty Screener Insights response');
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('Screener Insights response exceeds size limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readScreenerInsightsCollector({
  token,
  ref = 'main',
  allowMissing = false,
  fetcher = fetch,
  now = Date.now,
  signal = AbortSignal.timeout(15_000),
} = {}) {
  if (!token) throw Error('Screener Insights collector requires the existing Worker GitHub Actions credential');
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'sattva-screener-insights-reader',
    'x-github-api-version': '2022-11-28',
  };
  const get = (path) => fetcher(`${API}${path}`, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal });
  const json = async (path) => {
    const response = await get(path);
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Screener Insights GitHub read failed (HTTP ${response.status})`);
    }
    return JSON.parse(await boundedText(response, signal, 512 * 1024));
  };
  const runPath = `/actions/workflows/${SCREENER_INSIGHTS_WORKFLOW}/runs?branch=${encodeURIComponent(ref)}`;
  const trusted = (run) => positiveId(run.id) && run.head_branch === ref &&
    run.head_repository?.full_name === SCREENER_INSIGHTS_REPO &&
    (['schedule', 'push', 'workflow_dispatch'].includes(run.event) || (ref !== 'main' && run.event === 'pull_request'));
  const recent = await json(`${runPath}&per_page=10`);
  const runs = (recent.workflow_runs || []).filter(trusted);
  const successful = await json(`${runPath}&status=success&per_page=10`);
  const run = (successful.workflow_runs || []).find((item) => trusted(item) && item.status === 'completed' && item.conclusion === 'success');
  if (!run) {
    if (allowMissing && successful.total_count === 0 && !runs.some((item) => item.conclusion === 'success')) return null;
    throw Error('No successful Screener Insights capture is available');
  }
  const artifactList = await json(`/actions/runs/${run.id}/artifacts?per_page=10`);
  const artifact = (artifactList.artifacts || []).find((item) => item.name === SCREENER_INSIGHTS_ARTIFACT &&
    !item.expired && item.workflow_run?.id === run.id && positiveId(item.id));
  if (!artifact || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') ||
      !(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= SCREENER_INSIGHTS_COMPRESSED_LIMIT)) {
    throw Error('Screener Insights artifact missing or invalid');
  }
  const redirect = await get(`/actions/artifacts/${artifact.id}/zip`);
  const location = redirect.headers.get('location');
  await redirect.body?.cancel();
  if (redirect.status !== 302 || !location) throw Error('Screener Insights artifact download unavailable');
  const target = new URL(location);
  if (target.protocol !== 'https:' || target.username || target.password || target.port ||
      !(/^[-a-z0-9]+\.blob\.core\.windows\.net$/.test(target.hostname) || /^[-a-z0-9]+\.actions\.githubusercontent\.com$/.test(target.hostname))) {
    throw Error('Screener Insights artifact redirect rejected');
  }
  const response = await fetcher(target.href, { method: 'GET', redirect: 'manual', cache: 'no-store', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`Screener Insights artifact unavailable (HTTP ${response.status})`);
  }
  const bytes = await boundedCollectorBytes(response, signal, SCREENER_INSIGHTS_COMPRESSED_LIMIT);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (`sha256:${digest}` !== artifact.digest || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw Error('Screener Insights artifact integrity check failed');
  const decompressed = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  const capture = validateScreenerInsightsCapture(JSON.parse(await boundedText(new Response(decompressed), signal, SCREENER_INSIGHTS_LIMIT)), now());
  const latest = runs.find((item) => item.status === 'completed');
  return {
    capture,
    source: {
      id: 'screener-insights',
      status: 'ok',
      checkedAt: capture.checkedAt,
      targets: capture.targetCount,
      companies: capture.companies.length,
      metrics: capture.companies.reduce((sum, company) => sum + company.rows.length, 0),
      fullCoverage: capture.fullCoverage,
      collectorRunId: run.id,
      collectorRunUrl: `https://github.com/${SCREENER_INSIGHTS_REPO}/actions/runs/${run.id}`,
      collectorLatestFailed: latest ? latest.conclusion !== 'success' : false,
      collectorLatestConclusion: latest?.conclusion || null,
    },
  };
}
