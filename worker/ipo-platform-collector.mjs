// Read-only bridge to one repository/workflow's immutable public-data artifacts.
// Production accepts main captures only. `ref` is dependency injection for staging tests,
// never taken from a request. No workflow dispatches and no arbitrary upstream URL input.
import { boundedIpoText } from './ipo-sources.mjs';
import { PLATFORM_ARTIFACT, PLATFORM_WORKFLOW, PLATFORM_REPO, PLATFORM_LIMIT, PLATFORM_COMPRESSED_LIMIT, validatePlatformCapture } from '../public/js/data/ipo-platform-shared.js';

const API = `https://api.github.com/repos/${PLATFORM_REPO}`;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
export async function boundedArtifactBytes(response, signal, limit = PLATFORM_COMPRESSED_LIMIT) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error('IPOPlatform artifact exceeds size limit'); }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty IPOPlatform artifact');
  const chunks = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('IPOPlatform artifact exceeds size limit');
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function readPlatformCollector({ token, ref = 'main', allowMissing = false, fetcher = fetch, now = Date.now, signal = AbortSignal.timeout(12000) } = {}) {
  if (!token) throw Error('IPOPlatform collector requires the existing Worker GitHub Actions credential');
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'sattva-ipo-platform-reader', 'x-github-api-version': '2026-03-10' };
  const get = (path) => fetcher(`${API}${path}`, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal });
  const json = async (path) => {
    const r = await get(path);
    if (!r.ok) { await r.body?.cancel(); throw Error(`IPOPlatform collector GitHub read failed (HTTP ${r.status})`); }
    return JSON.parse(await boundedIpoText(r, signal, 512 * 1024));
  };
  const runPath = `/actions/workflows/${PLATFORM_WORKFLOW}/runs?branch=${encodeURIComponent(ref)}`;
  const trusted = (r) => positiveId(r.id) && r.head_branch === ref && r.head_repository?.full_name === PLATFORM_REPO
    && (['schedule', 'push', 'workflow_dispatch'].includes(r.event) || (ref !== 'main' && r.event === 'pull_request'));
  const listing = await json(`${runPath}&per_page=10`);
  const runs = (listing.workflow_runs || []).filter(trusted);
  // Failure streaks must not hide the previous good capture beyond a ten-run window.
  const successful = await json(`${runPath}&status=success&per_page=10`);
  const run = (successful.workflow_runs || []).find((r) => trusted(r) && r.status === 'completed' && r.conclusion === 'success');
  if (!run) {
    if (allowMissing && successful.total_count === 0 && !runs.some((r) => r.conclusion === 'success')) return null; // first-ever capture only, never an API error
    throw Error('No successful IPOPlatform collector capture is available');
  }
  const artifacts = await json(`/actions/runs/${run.id}/artifacts?per_page=10`);
  const artifact = (artifacts.artifacts || []).find((a) => a.name === PLATFORM_ARTIFACT && !a.expired && a.workflow_run?.id === run.id && positiveId(a.id));
  if (!artifact || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') || !(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= PLATFORM_COMPRESSED_LIMIT)) throw Error('IPOPlatform collector artifact missing or invalid');
  // GitHub's download API retains the /zip path even for v7 archive:false single files.
  const redirect = await get(`/actions/artifacts/${artifact.id}/zip`);
  const location = redirect.headers.get('location'); await redirect.body?.cancel();
  if (redirect.status !== 302 || !location) throw Error('IPOPlatform artifact download unavailable');
  const target = new URL(location);
  if (target.protocol !== 'https:' || target.username || target.password || target.port
    || !(/^[-a-z0-9]+\.blob\.core\.windows\.net$/.test(target.hostname) || /^[-a-z0-9]+\.actions\.githubusercontent\.com$/.test(target.hostname))) throw Error('IPOPlatform artifact redirect rejected');
  // Never send the GitHub token, caller headers or cookies to the signed blob URL.
  const response = await fetcher(target.href, { method: 'GET', redirect: 'manual', cache: 'no-store', signal });
  if (!response.ok) { await response.body?.cancel(); throw Error(`IPOPlatform artifact unavailable (HTTP ${response.status})`); }
  const bytes = await boundedArtifactBytes(response, signal);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  if (`sha256:${digest}` !== artifact.digest || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw Error('IPOPlatform artifact integrity check failed');
  const decompressed = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  const capture = validatePlatformCapture(JSON.parse(await boundedIpoText(new Response(decompressed), signal, PLATFORM_LIMIT)), now());
  const latest = runs.find((r) => r.status === 'completed');
  const latestFailed = latest ? latest.conclusion !== 'success' : false;

  return { capture, rows: capture.rows, companies: capture.companies, source: {
    id: 'ipo-platform', label: 'IPOPlatform catalogue & DRHPs', url: 'https://www.ipoplatform.com/ipo', status: 'ok', checkedAt: capture.checkedAt,
    count: capture.rows.length, records: capture.companies.length, unmapped: 0,
    delivery: 'scheduled', collectorRunId: run.id, collectorRunUrl: `https://github.com/${PLATFORM_REPO}/actions/runs/${run.id}`,
    collectorLatestFailed: latestFailed, collectorLatestConclusion: latest?.conclusion || null,
    note: `${capture.companies.length} issuers retained across paginated SME/mainboard, upcoming/open/closed/listed and both DRHP lists. Secondary publisher metadata, not a complete exchange archive. Document dates are not exchange filing dates. ${capture.rows.filter((r) => !r.url).length} document records have no usable public link; other links may still depend on BSE/NSE. Collected hourly by GitHub Actions; scheduling and publisher updates can lag.${latestFailed ? ' The latest completed collection failed; showing the previous successful capture.' : ''}`,
  } };
}
