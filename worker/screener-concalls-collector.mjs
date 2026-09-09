// Read the latest successful Screener concall capture from one fixed Actions workflow.
// The GitHub token is sent only to api.github.com; the signed artifact URL receives no credentials.
import {
  SCREENER_CONCALL_ARTIFACT,
  SCREENER_CONCALL_COMPRESSED_LIMIT,
  SCREENER_CONCALL_ID,
  SCREENER_CONCALL_LIMIT,
  SCREENER_CONCALL_REPO,
  SCREENER_CONCALL_WORKFLOW,
  validateScreenerConcallCapture,
} from '../public/js/data/screener-concalls-shared.js';

const API = `https://api.github.com/repos/${SCREENER_CONCALL_REPO}`;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
// upload-artifact with archive:false publishes the file's basename and ignores `name`.
export const SCREENER_DOCUMENT_ARTIFACT = 'screener-concalls-v1.json.gz.documents.gz';

// Document publication and calendar publication are independent. Keep the last confirmed
// calendar and its own check time while newer complete documents continue reaching the library.
// No calendar fields may be taken from a document-only checkpoint.
export async function readScreenerConcallCollection(options = {}, read = readScreenerConcallCollector) {
  const [calendar, documents] = await Promise.allSettled([
    read(options), read({ ...options, documentsOnly: true }),
  ]);
  const full = calendar.status === 'fulfilled' ? calendar.value : null;
  const checkpoint = documents.status === 'fulfilled' ? documents.value : null;
  if (!checkpoint?.capture || (full?.capture && Date.parse(full.capture.checkedAt) >= Date.parse(checkpoint.capture.checkedAt))) {
    if (full) return full;
    throw Error('Screener collection unavailable');
  }
  const { documentCheckpoint, portfolioUpcoming, upcoming, upcomingPublishedTotal, upcomingPagesFetched,
    upcomingDuplicatesRemoved, ...history } = checkpoint.capture;
  return {
    capture: { ...full?.capture, ...history,
      ...(full?.capture?.portfolioUpcoming !== undefined ? { portfolioUpcoming: full.capture.portfolioUpcoming } : {}),
    },
    source: {
      ...(full?.source || { id: SCREENER_CONCALL_ID, status: 'failed', checkedAt: null,
        portfolioUpcomingAvailable: false, portfolioUpcomingRecords: 0, upcomingPublishedTotal: null,
        upcomingRecords: 0, upcomingDuplicatesRemoved: 0, upcomingPagesFetched: 0, collectorLatestFailed: true }),
      records: history.rows.length, publishedTotal: history.publishedTotal, fullHistory: history.fullHistory,
      documentCheckedAt: checkpoint.source.checkedAt,
      documentLatestFailed: checkpoint.source.collectorLatestFailed,
      documentCollectorRunId: checkpoint.source.collectorRunId,
    },
  };
}

export async function boundedCollectorBytes(response, signal, limit = SCREENER_CONCALL_COMPRESSED_LIMIT) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw Error('Screener concall artifact exceeds size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty Screener concall artifact');
  const chunks = [];
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
      if (size > limit) throw Error('Screener concall artifact exceeds size limit');
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function boundedCollectorText(response, signal, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty Screener concall capture');
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
      if (size > limit) throw Error('Screener concall capture exceeds size limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readScreenerConcallCollector({
  token,
  ref = 'main',
  allowMissing = false,
  documentsOnly = false,
  fetcher = fetch,
  now = Date.now,
  signal = AbortSignal.timeout(15000),
} = {}) {
  if (!token) throw Error('Screener concall collector requires the existing Worker GitHub Actions credential');
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'sattva-screener-concall-reader',
    'x-github-api-version': '2022-11-28',
  };
  const get = (path) => fetcher(`${API}${path}`, { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal });
  const json = async (path) => {
    const response = await get(path);
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Screener concall GitHub read failed (HTTP ${response.status})`);
    }
    return JSON.parse(await boundedCollectorText(response, signal, 512 * 1024));
  };
  const runPath = `/actions/workflows/${SCREENER_CONCALL_WORKFLOW}/runs?branch=${encodeURIComponent(ref)}`;
  const trusted = (run) =>
    positiveId(run.id) &&
    run.head_branch === ref &&
    run.head_repository?.full_name === SCREENER_CONCALL_REPO &&
    (['schedule', 'push', 'workflow_dispatch'].includes(run.event) || (ref !== 'main' && run.event === 'pull_request'));
  const recent = await json(`${runPath}&per_page=10`);
  const runs = (recent.workflow_runs || []).filter(trusted);
  const latest = runs.find(item => item.status === 'completed');
  let run, artifactList, documentArtifact = false;
  // Completed runs can contain a healthy document checkpoint even when a later calendar failed.
  // Look back only for restoring history. A newer run without a usable checkpoint still marks
  // discovery failed below, so this fallback cannot authorise paid requests from an old success.
  if (documentsOnly) {
    const list = await json(`/actions/artifacts?name=${SCREENER_DOCUMENT_ARTIFACT}&per_page=10`);
    for (const candidate of runs.filter(item => item.status === 'completed')) {
      const owned = (list.artifacts || []).filter(item => item.name === SCREENER_DOCUMENT_ARTIFACT && item.workflow_run?.id === candidate.id);
      if (owned.length) {
        run = candidate; artifactList = { artifacts: owned }; documentArtifact = true; break;
      }
    }
  }
  let successful;
  if (!run) {
    successful = await json(`${runPath}&status=success&per_page=10`);
    run = (successful.workflow_runs || []).find((item) => trusted(item) && item.status === 'completed' && item.conclusion === 'success');
  }
  if (!run) {
    if (allowMissing && successful?.total_count === 0 && !runs.some((item) => item.conclusion === 'success')) return null;
    throw Error('No successful Screener concall capture is available');
  }
  artifactList ||= await json(`/actions/runs/${run.id}/artifacts?per_page=10`);
  const artifact = (artifactList.artifacts || []).find(
    (item) =>
      item.name === (documentArtifact ? SCREENER_DOCUMENT_ARTIFACT : SCREENER_CONCALL_ARTIFACT) &&
      !item.expired &&
      item.workflow_run?.id === run.id &&
      positiveId(item.id),
  );
  if (
    !artifact ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') ||
    !(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= SCREENER_CONCALL_COMPRESSED_LIMIT)
  ) {
    throw Error('Screener concall artifact missing or invalid');
  }

  const redirect = await get(`/actions/artifacts/${artifact.id}/zip`);
  const location = redirect.headers.get('location');
  await redirect.body?.cancel();
  if (redirect.status !== 302 || !location) throw Error('Screener concall artifact download unavailable');
  const target = new URL(location);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.port ||
    !(/^[-a-z0-9]+\.blob\.core\.windows\.net$/.test(target.hostname) || /^[-a-z0-9]+\.actions\.githubusercontent\.com$/.test(target.hostname))
  ) {
    throw Error('Screener concall artifact redirect rejected');
  }
  const response = await fetcher(target.href, { method: 'GET', redirect: 'manual', cache: 'no-store', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`Screener concall artifact unavailable (HTTP ${response.status})`);
  }
  const bytes = await boundedCollectorBytes(response, signal);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (`sha256:${digest}` !== artifact.digest || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw Error('Screener concall artifact integrity check failed');
  const decompressed = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  const capture = validateScreenerConcallCapture(
    JSON.parse(await boundedCollectorText(new Response(decompressed), signal, SCREENER_CONCALL_LIMIT)),
    now(),
  );
  if (documentArtifact && (capture.documentCheckpoint?.version !== 1 || !capture.fullHistory ||
      !['pending', 'complete', 'calendar-shape', 'blocked'].includes(capture.documentCheckpoint.outcome) ||
      ['portfolioUpcoming', 'upcoming', 'upcomingPublishedTotal', 'upcomingPagesFetched', 'upcomingDuplicatesRemoved']
        .some(key => capture[key] !== undefined))) throw Error('Invalid independent document checkpoint');
  const documentFailure = documentArtifact && (latest?.id !== run.id ||
    !['complete', 'calendar-shape'].includes(capture.documentCheckpoint.outcome));
  return {
    capture,
    source: {
      id: SCREENER_CONCALL_ID,
      status: 'ok',
      checkedAt: capture.checkedAt,
      publishedTotal: capture.publishedTotal,
      records: capture.rows.length,
      fullHistory: capture.fullHistory,
      portfolioUpcomingAvailable: Array.isArray(capture.portfolioUpcoming),
      portfolioUpcomingRecords: capture.portfolioUpcoming?.length || 0,
      upcomingPublishedTotal: capture.upcomingPublishedTotal ?? null,
      upcomingRecords: Array.isArray(capture.upcoming) ? capture.upcoming.length : 0,
      upcomingDuplicatesRemoved: capture.upcomingDuplicatesRemoved ?? 0,
      upcomingPagesFetched: capture.upcomingPagesFetched ?? 0,
      collectorRunId: run.id,
      collectorRunUrl: `https://github.com/${SCREENER_CONCALL_REPO}/actions/runs/${run.id}`,
      collectorLatestFailed: documentArtifact ? documentFailure : latest ? latest.conclusion !== 'success' : false,
      collectorLatestConclusion: latest?.conclusion || null,
      ...(documentArtifact ? { documentCheckpoint: true, calendarFailure: capture.documentCheckpoint.outcome === 'calendar-shape' } : {}),
    },
  };
}
