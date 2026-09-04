// Read-only bridge to one repository/workflow's immutable public-data artifacts.
// Production accepts main captures only. `ref` is dependency injection for staging tests,
// never taken from a request. No workflow dispatches and no arbitrary upstream URL input.
import { boundedIpoText, IPO_SOURCES } from './ipo-sources.mjs';
import { BSE_ARTIFACT_NAME, BSE_COLLECTOR_WORKFLOW, BSE_COLLECTOR_REPO, BSE_CAPTURE_LIMIT, BSE_COMPRESSED_LIMIT, validateBseCapture } from '../public/js/data/bse-ipo-shared.js';

const API = `https://api.github.com/repos/${BSE_COLLECTOR_REPO}`;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
export async function boundedArtifactBytes(response, signal, limit = BSE_COMPRESSED_LIMIT) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error('BSE artifact exceeds size limit'); }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty BSE artifact');
  const chunks = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('BSE artifact exceeds size limit');
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function readBseCollector({ token, ref = 'main', allowMissing = false, fetcher = fetch, now = Date.now, signal = AbortSignal.timeout(12000) } = {}) {
  if (!token) throw Error('BSE collector requires the existing Worker GitHub Actions credential');
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'sattva-bse-ipo-reader', 'x-github-api-version': '2026-03-10' };
  const get = (path) => fetcher(`${API}${path}`, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal });
  const json = async (path) => {
    const r = await get(path);
    if (!r.ok) { await r.body?.cancel(); throw Error(`BSE collector GitHub read failed (HTTP ${r.status})`); }
    return JSON.parse(await boundedIpoText(r, signal, 512 * 1024));
  };
  const runPath = `/actions/workflows/${BSE_COLLECTOR_WORKFLOW}/runs?branch=${encodeURIComponent(ref)}`;
  const trusted = (r) => positiveId(r.id) && r.head_branch === ref && r.head_repository?.full_name === BSE_COLLECTOR_REPO
    && (['schedule', 'push', 'workflow_dispatch'].includes(r.event) || (ref !== 'main' && r.event === 'pull_request'));
  const listing = await json(`${runPath}&per_page=10`);
  const runs = (listing.workflow_runs || []).filter(trusted);
  // Failure streaks must not hide the previous good capture beyond a ten-run window.
  const successful = await json(`${runPath}&status=success&per_page=10`);
  const run = (successful.workflow_runs || []).find((r) => trusted(r) && r.status === 'completed' && r.conclusion === 'success');
  if (!run) {
    if (allowMissing && successful.total_count === 0 && !runs.some((r) => r.conclusion === 'success')) return null; // first-ever capture only, never an API error
    throw Error('No successful BSE collector capture is available');
  }
  const artifacts = await json(`/actions/runs/${run.id}/artifacts?per_page=10`);
  const artifact = (artifacts.artifacts || []).find((a) => a.name === BSE_ARTIFACT_NAME && !a.expired && a.workflow_run?.id === run.id && positiveId(a.id));
  if (!artifact || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') || !(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= BSE_COMPRESSED_LIMIT)) throw Error('BSE collector artifact missing or invalid');
  // GitHub's download API retains the /zip path even for v7 archive:false single files.
  const redirect = await get(`/actions/artifacts/${artifact.id}/zip`);
  const location = redirect.headers.get('location'); await redirect.body?.cancel();
  if (redirect.status !== 302 || !location) throw Error('BSE artifact download unavailable');
  const target = new URL(location);
  if (target.protocol !== 'https:' || target.username || target.password || target.port
    || !(/^[-a-z0-9]+\.blob\.core\.windows\.net$/.test(target.hostname) || /^[-a-z0-9]+\.actions\.githubusercontent\.com$/.test(target.hostname))) throw Error('BSE artifact redirect rejected');
  // Never send the GitHub token, caller headers or cookies to the signed blob URL.
  const response = await fetcher(target.href, { method: 'GET', redirect: 'manual', cache: 'no-store', signal });
  if (!response.ok) { await response.body?.cancel(); throw Error(`BSE artifact unavailable (HTTP ${response.status})`); }
  const bytes = await boundedArtifactBytes(response, signal);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  if (`sha256:${digest}` !== artifact.digest || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw Error('BSE artifact integrity check failed');
  const decompressed = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  const capture = validateBseCapture(JSON.parse(await boundedIpoText(new Response(decompressed), signal, BSE_CAPTURE_LIMIT)), now());
  const latest = runs.find((r) => r.status === 'completed');
  const latestFailed = latest?.conclusion !== 'success';
  const source = IPO_SOURCES.find((s) => s.id === 'bse-sme');
  return { capture, rows: capture.rows, source: {
    id: source.id, label: source.label, url: source.url, status: 'ok', checkedAt: capture.checkedAt,
    count: capture.currentCount, retainedCount: capture.retainedCount, records: capture.records, unmapped: capture.unmapped,
    delivery: 'scheduled', collectorRunId: run.id, collectorRunUrl: `https://github.com/${BSE_COLLECTOR_REPO}/actions/runs/${run.id}`,
    collectorLatestFailed: latestFailed, collectorLatestConclusion: latest?.conclusion || null,
    note: `${capture.note} ${capture.retainedCount} additional documents retained from earlier captures, not re-confirmed by this read. Collected separately by GitHub Actions; the source check time is the collection time, not this page load. Requested every 15 minutes; scheduling can lag.${latestFailed ? ' The latest completed collection failed; this is the previous successful capture.' : ''}`,
  } };
}
