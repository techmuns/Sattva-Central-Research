// Fixed-repository, digest-checked artifacts. No credential follows a signed download redirect.
import { SCREENER_INSIGHTS_REPO, SCREENER_INSIGHTS_WORKFLOW } from '../public/js/data/screener-insights-shared.js';
import { boundedCollectorBytes } from './screener-concalls-collector.mjs';

async function boundedJson(response, signal, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty Insights artifact body');
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('Insights artifact body exceeds limit');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function insightArtifactReader({ token, ref = 'main', fetcher = fetch, signal = AbortSignal.timeout(20_000) }) {
  if (!token) throw Error('Insights artifact credential unavailable');
  const api = `https://api.github.com/repos/${SCREENER_INSIGHTS_REPO}`;
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
    'user-agent': 'sattva-screener-insights-reader', 'x-github-api-version': '2022-11-28' };
  const get = path => fetcher(`${api}${path}`, { headers, redirect: 'manual', cache: 'no-store', signal });
  const json = async path => {
    const response = await get(path);
    if (!response.ok) { await response.body?.cancel(); throw Error('Insights artifact metadata unavailable'); }
    return boundedJson(response, signal, 512 * 1024);
  };
  const positiveId = value => Number.isSafeInteger(value) && value > 0;
  const trusted = run => positiveId(run?.id) && run.head_branch === ref &&
    run.head_repository?.full_name === SCREENER_INSIGHTS_REPO &&
    run.path === `.github/workflows/${SCREENER_INSIGHTS_WORKFLOW}` &&
    ['schedule', 'push', 'workflow_dispatch'].includes(run.event);
  const read = async ({ name, compressedLimit, rawLimit, validate }) => {
    // Interrupted runs can have valid checkpoints; cooldown-only runs need no new data capture.
    for (let page = 1; page <= 5; page++) {
      const list = await json(`/actions/artifacts?name=${encodeURIComponent(name)}&per_page=20&page=${page}`);
      for (const artifact of list.artifacts || []) {
        if (artifact.name !== name || artifact.workflow_run?.head_branch !== ref) continue;
        if (!positiveId(artifact.workflow_run?.id) || !positiveId(artifact.id)) throw Error('Invalid Insights artifact identity');
        const run = await json(`/actions/runs/${artifact.workflow_run.id}`);
        if (!trusted(run) || run.id !== artifact.workflow_run.id) throw Error('Untrusted Insights artifact run');
        if (run.status !== 'completed') continue;
        if (artifact.expired || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') ||
            !(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= compressedLimit)) throw Error('Insights artifact missing or invalid');
        const redirect = await get(`/actions/artifacts/${artifact.id}/zip`);
        const location = redirect.headers.get('location');
        await redirect.body?.cancel();
        if (redirect.status !== 302 || !location) throw Error('Insights artifact download unavailable');
        const target = new URL(location);
        if (target.protocol !== 'https:' || target.username || target.password || target.port ||
            !(/^[-a-z0-9]+\.blob\.core\.windows\.net$/.test(target.hostname) || /^[-a-z0-9]+\.actions\.githubusercontent\.com$/.test(target.hostname))) throw Error('Insights artifact redirect rejected');
        const response = await fetcher(target.href, { redirect: 'manual', cache: 'no-store', signal });
        if (!response.ok) { await response.body?.cancel(); throw Error('Insights artifact unavailable'); }
        const bytes = await boundedCollectorBytes(response, signal, compressedLimit);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        if (`sha256:${digest}` !== artifact.digest || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw Error('Insights artifact integrity check failed');
        const decompressed = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
        const value = validate(await boundedJson(new Response(decompressed), signal, rawLimit));
        return { value, run };
      }
      if ((list.artifacts || []).length < 20) return null;
    }
    throw Error('Insights artifact history exceeds bounded search');
  };
  read.latestRun = async () => {
    const recent = await json(`/actions/workflows/${SCREENER_INSIGHTS_WORKFLOW}/runs?branch=${encodeURIComponent(ref)}&per_page=5`);
    return (recent.workflow_runs || []).find(run => trusted(run) && run.status === 'completed') || null;
  };
  return read;
}
