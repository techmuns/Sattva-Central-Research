// Sattva-owned read-only delivery of scheduled captures. Uses the existing Actions-read secret.
export const EXCHANGE_WORKFLOW = 'bulk-block-refresh.yml';
export const ARTIFACT_NAME = 'exchange-deals';
export const ARTIFACT_FILE = 'exchange-deals.json.gz';
export const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
export async function readLimited(response, limit = MAX_CAPTURE_BYTES) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Source returned HTTP ${response.status}`); }
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Capture exceeds size limit'); }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > limit) throw new Error('Capture exceeds size limit'); chunks.push(value);
    }
  } catch (err) { await reader.cancel(); throw err; } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
/** Only one known gzip member is accepted. Central directory sizes support streaming ZIP
 * descriptors; no paths are extracted, and both compressed and expanded bytes are bounded.
 */
export async function unzipMember(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (v.getUint32(end, true) === 0x06054b50) break;
  if (end < 0 || v.getUint16(end + 10, true) !== 1) throw new Error('Expected a single-file capture archive');
  const c = v.getUint32(end + 16, true);
  if (c + 46 > bytes.length || v.getUint32(c, true) !== 0x02014b50) throw new Error('Invalid capture archive');
  const method = v.getUint16(c + 10, true), size = v.getUint32(c + 20, true), expanded = v.getUint32(c + 24, true);
  const name = new TextDecoder().decode(bytes.subarray(c + 46, c + 46 + v.getUint16(c + 28, true)));
  const local = v.getUint32(c + 42, true);
  if (name !== ARTIFACT_FILE || ![0, 8].includes(method) || expanded > MAX_CAPTURE_BYTES || local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw new Error('Invalid capture member');
  const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
  if (start + size > c) throw new Error('Truncated capture archive');
  let file = bytes.slice(start, start + size);
  if (method === 8) file = await readLimited(new Response(new Blob([file]).stream().pipeThrough(new DecompressionStream('deflate-raw'))));
  if (file.length !== expanded) throw new Error('Truncated capture member');
  if (file[0] !== 0x1f || file[1] !== 0x8b) throw new Error('Expected a gzip capture');
  return file;
}
export async function unzipCapture(bytes) {
  const file = await unzipMember(bytes);
  return new TextDecoder().decode(await readLimited(new Response(new Blob([file]).stream().pipeThrough(new DecompressionStream('gzip')))));
}
export async function latestExchangeArtifact({ repo, token, fetchImpl = fetch, compressed = false }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !token) throw new Error('Exchange archive delivery is not configured');
  const base = `https://api.github.com/repos/${repo}`;
  const signal = AbortSignal.timeout(25000);
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'Sattva-exchange-capture', 'x-github-api-version': '2022-11-28' };
  // Workers supports manual/follow only. readLimited rejects unexpected redirect responses.
  const get = async (path) => JSON.parse(new TextDecoder().decode(await readLimited(await fetchImpl(base + path, { headers, signal, redirect: 'manual' }), 1024 * 1024)));
  const runs = await get(`/actions/workflows/${EXCHANGE_WORKFLOW}/runs?branch=main&status=completed&per_page=5`);
  if (!Array.isArray(runs.workflow_runs)) throw new Error('Unreadable capture run list');
  for (const run of runs.workflow_runs) {
    if (run.head_branch !== 'main' || run.head_repository?.full_name?.toLowerCase() !== repo.toLowerCase() || !['schedule', 'workflow_dispatch', 'push'].includes(run.event)) continue;
    const { artifacts } = await get(`/actions/runs/${run.id}/artifacts?per_page=20`);
    const artifact = artifacts?.find((a) => a.name === ARTIFACT_NAME && !a.expired);
    if (!artifact) continue;
    if (!Number.isSafeInteger(artifact.id) || artifact.size_in_bytes > MAX_CAPTURE_BYTES) throw new Error('Invalid capture artifact');
    const redirect = await fetchImpl(`${base}/actions/artifacts/${artifact.id}/zip`, { headers, redirect: 'manual', signal });
    const location = redirect.headers.get('location');
    await redirect.body?.cancel();
    if (redirect.status !== 302 || !location || new URL(location).protocol !== 'https:') throw new Error('Capture archive download unavailable');
    // Signed storage URL: NEVER send the GitHub credential to the redirect destination.
    const download = await fetchImpl(location, { signal, redirect: 'manual' });
    const bytes = await readLimited(download);
    if (artifact.digest?.startsWith('sha256:')) {
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((v) => v.toString(16).padStart(2, '0')).join('');
      if (`sha256:${hash}` !== artifact.digest) throw new Error('Capture archive checksum mismatch');
    }
    return compressed ? { gzip: await unzipMember(bytes), id: artifact.id } : { text: await unzipCapture(bytes), id: artifact.id };
  }
  return null;
}
