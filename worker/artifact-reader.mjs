// READ ONE MEMBER OF AN ACTIONS ARTIFACT BY BYTE RANGE — the alert pool's reader (worker/alert-pool.mjs),
// generalised over the workflow and artifact names, for the announcement index. The alert pool keeps
// its own proven copy and its own error wording; a later change can move it onto this module once
// its runtime test is updated alongside.
//
// The artifact download redirects to signed blob storage, which answers byte ranges; the ZIP's central
// directory sits at its end and names every member's offset and size, so serving one member costs the
// directory and one ranged read — never the whole archive into a Worker with a 128MB heap. Members are
// stored uncompressed (`compression-level: 0`) because they are gzip files already; a storage that
// answered a range with the whole archive is refused rather than read into memory. The GitHub
// credential goes to api.github.com and never to storage.
import { readLimited } from './exchange-artifact.mjs';

export const MAX_MEMBER_BYTES = 24 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 1024 * 1024;
const TAIL_BYTES = 65_557 + 256 * 1024;

export function github({ repo, token, agent = 'Sattva-artifact-reader' }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('Artifact delivery is not configured');
  const headers = { accept: 'application/vnd.github+json', 'user-agent': agent, 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { base: `https://api.github.com/repos/${repo}`, headers };
}

/** The newest completed main-branch build's artifact of this name, or null when none is published. */
export async function latestArtifact({ repo, token, workflow, artifact, fetchImpl = fetch, signal = AbortSignal.timeout(20000), label = 'artifact' }) {
  const { base, headers } = github({ repo, token });
  const get = async (path) => JSON.parse(new TextDecoder().decode(await readLimited(await fetchImpl(base + path, { headers, signal, redirect: 'manual' }), 1024 * 1024)));
  const runs = await get(`/actions/workflows/${workflow}/runs?branch=main&status=success&per_page=5`);
  if (!Array.isArray(runs.workflow_runs)) throw new Error(`Unreadable ${label} run list`);
  for (const run of runs.workflow_runs) {
    if (run.head_branch !== 'main' || run.head_repository?.full_name?.toLowerCase() !== repo.toLowerCase() ||
        !['schedule', 'workflow_dispatch', 'workflow_run', 'push'].includes(run.event)) continue;
    const { artifacts } = await get(`/actions/runs/${run.id}/artifacts?per_page=20`);
    const found = artifacts?.find((a) => a.name === artifact && !a.expired);
    if (!found) continue;
    if (!Number.isSafeInteger(found.id)) throw new Error(`Invalid ${label} artifact`);
    return { id: found.id, size: found.size_in_bytes, createdAt: found.created_at || null };
  }
  return null;
}

/** The signed storage URL of an artifact's ZIP. */
export async function archiveLocation(artifactId, { repo, token, fetchImpl = fetch, signal, label = 'artifact' }) {
  const { base, headers } = github({ repo, token });
  const redirect = await fetchImpl(`${base}/actions/artifacts/${artifactId}/zip`, { headers, redirect: 'manual', signal });
  const location = redirect.headers.get('location');
  await redirect.body?.cancel();
  if (redirect.status === 404 || redirect.status === 410) throw Object.assign(new Error(`The ${label} is gone`), { gone: true });
  if (redirect.status !== 302 || !location || new URL(location).protocol !== 'https:') throw new Error(`The ${label} archive download is unavailable`);
  return location;
}

/** `bytes=start-end` of the archive, refusing a storage that answers with the whole file. */
export async function readRange(location, start, end, { fetchImpl = fetch, signal, limit = MAX_MEMBER_BYTES, label = 'artifact' } = {}) {
  const wanted = end - start + 1;
  if (wanted > limit) throw new Error(`The ${label} member exceeds the size limit`);
  const response = await fetchImpl(location, { headers: { range: `bytes=${start}-${end}` }, redirect: 'manual', signal });
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`The ${label} storage did not answer the byte range (HTTP ${response.status})`);
  }
  const bytes = await readLimited(response, wanted);
  if (bytes.length !== wanted) throw new Error(`The ${label} storage returned a short range`);
  return bytes;
}

/** `bytes=-n`: the last n bytes, and the archive's total size from Content-Range. */
export async function readTail(location, n, { fetchImpl = fetch, signal, label = 'artifact' } = {}) {
  const response = await fetchImpl(location, { headers: { range: `bytes=-${n}` }, redirect: 'manual', signal });
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`The ${label} storage did not answer the byte range (HTTP ${response.status})`);
  }
  const total = Number((response.headers.get('content-range') || '').split('/')[1]);
  const bytes = await readLimited(response, n);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error(`The ${label} storage did not state the archive size`);
  return { bytes, total };
}

/** Every member's name, offset of its local header, stored size and method, from the central directory. */
export function parseDirectory(tail, total, label = 'artifact') {
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = tail.length - 22;
  for (; end >= 0; end--) if (v.getUint32(end, true) === 0x06054b50) break;
  if (end < 0) throw new Error(`The ${label} archive has no end-of-directory record`);
  const entries = v.getUint16(end + 10, true);
  const size = v.getUint32(end + 12, true);
  const offset = v.getUint32(end + 16, true);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error(`ZIP64 ${label} archives are not supported`);
  if (size > MAX_DIRECTORY_BYTES) throw new Error(`The ${label} directory exceeds the size limit`);
  const tailStart = total - tail.length;
  if (offset < tailStart) return { needs: { start: offset, end: offset + size - 1 }, entries, size, offset };
  return { members: readEntries(tail.subarray(offset - tailStart, offset - tailStart + size), entries, label) };
}

export function readEntries(directory, entries, label = 'artifact') {
  const v = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const members = {};
  let at = 0;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > directory.length || v.getUint32(at, true) !== 0x02014b50) throw new Error(`Invalid ${label} directory`);
    const method = v.getUint16(at + 10, true), size = v.getUint32(at + 20, true), expanded = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true), extraLength = v.getUint16(at + 30, true), commentLength = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(directory.subarray(at + 46, at + 46 + nameLength));
    if (size === 0xffffffff || local === 0xffffffff) throw new Error(`ZIP64 ${label} archives are not supported`);
    members[name] = { method, size, expanded, local };
    at += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

/** The archive's member table and its storage location. */
export async function readDirectory(artifactId, cfg) {
  const location = await archiveLocation(artifactId, cfg);
  const { bytes, total } = await readTail(location, TAIL_BYTES, cfg);
  let parsed = parseDirectory(bytes, total, cfg.label);
  if (parsed.needs) parsed = { members: readEntries(await readRange(location, parsed.needs.start, parsed.needs.end, { ...cfg, limit: MAX_DIRECTORY_BYTES }), parsed.entries, cfg.label) };
  return { artifactId, total, members: parsed.members, location };
}

/** Where a stored member's data starts in the archive (after its local header). */
export async function memberStart(directory, name, cfg) {
  const entry = directory.members[name];
  if (!entry) throw Object.assign(new Error(`The ${cfg.label || 'artifact'} has no member ${name}`), { missing: true });
  if (entry.method !== 0) throw new Error(`The ${cfg.label || 'artifact'} member is not stored uncompressed`);
  if (entry.expanded !== entry.size) throw new Error(`The ${cfg.label || 'artifact'} member size is inconsistent`);
  const header = await readRange(directory.location, entry.local, entry.local + 29, cfg);
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (hv.getUint32(0, true) !== 0x04034b50) throw new Error(`Invalid ${cfg.label || 'artifact'} member header`);
  const start = entry.local + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  if (start + entry.size > directory.total) throw new Error(`Truncated ${cfg.label || 'artifact'} archive`);
  return { start, size: entry.size };
}

/** One stored member's bytes, or a slice of it (`offset`, `length` inside the member). */
export async function memberBytes(directory, name, cfg, { offset = 0, length = null, limit = MAX_MEMBER_BYTES } = {}) {
  const { start, size } = await memberStart(directory, name, cfg);
  const wanted = length ?? size - offset;
  if (offset < 0 || wanted < 0 || offset + wanted > size) throw new Error(`The requested range lies outside ${name}`);
  if (wanted > limit) throw new Error(`The ${cfg.label || 'artifact'} member exceeds the size limit`);
  return wanted ? readRange(directory.location, start + offset, start + offset + wanted - 1, { ...cfg, limit }) : new Uint8Array(0);
}

/** gunzip in the runtime's own DecompressionStream, bounded. */
export async function gunzip(bytes, limit = 64 * 1024 * 1024) {
  return readLimited(new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))), limit);
}
