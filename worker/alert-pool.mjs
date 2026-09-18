// THE PRECOMPUTED ALERT POOL, SERVED FROM THE ACTIONS ARTIFACT THAT CARRIES IT.
//
// `alert-pool-refresh.yml` builds the pool after every capture and uploads its members as ONE
// artifact per build — index.json beside thirty-one day shards and seven month shards, forty
// megabytes of gzip in all. Nothing here is committed to the repository: the repository already
// takes two hundred capture commits a day and the pool's newest shard changes with every one of
// them, so it lives in artifact storage (short retention, immutable per build) exactly as the
// bulk/block deals and the Screener collectors do.
//
// A MEMBER IS READ WITH RANGE REQUESTS, NEVER BY DOWNLOADING THE ARCHIVE. The artifact download
// redirects to signed blob storage, which answers byte ranges; the ZIP's central directory sits at
// its end and names every member's offset and size, so serving one three-megabyte shard costs the
// directory (cached per artifact) and one ranged read of the member — not forty megabytes into a
// Worker with a 128MB heap. Members are stored uncompressed inside the ZIP (`compression-level: 0`)
// and are themselves gzip files, so the bytes go to the browser unchanged with `content-encoding:
// gzip`, the same delivery the exchange route uses. A storage that answered a range with the whole
// archive is refused rather than read into memory.
//
// The index is short-lived at the edge (a build lands every few minutes) and every member is
// addressed by its artifact id, so a member URL is immutable and cached for days — by the edge and
// by the browser, which therefore re-downloads exactly the shards a new build changed.
import { readLimited } from './exchange-artifact.mjs';
import { ALERT_POOL_ARTIFACT, ALERT_POOL_WORKFLOW, ALERT_POOL_INDEX_MEMBER, ALERT_POOL_CONTRACT, isPoolMember } from '../public/js/data/alert-pool-shared.js';
import { CORS, contentTag, revalidate } from './http.mjs';

export const INDEX_TTL_S = 60;
export const MEMBER_TTL_S = 7 * 24 * 3600;
export const DIRECTORY_TTL_S = 3 * 24 * 3600;
export const MAX_MEMBER_BYTES = 24 * 1024 * 1024;
export const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 1024 * 1024;
const TAIL_BYTES = 65_557 + 256 * 1024;

const cacheKey = (path) => new Request(`https://cache.invalid/alert-pool/${path}`, { method: 'GET' });

function github({ repo, token }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('Alert pool delivery is not configured');
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'Sattva-alert-pool', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { base: `https://api.github.com/repos/${repo}`, headers };
}

/** The newest completed main-branch build's artifact, or null when no build has published one. */
export async function latestPoolArtifact({ repo, token, fetchImpl = fetch, signal = AbortSignal.timeout(20000) }) {
  const { base, headers } = github({ repo, token });
  const get = async (path) => JSON.parse(new TextDecoder().decode(await readLimited(await fetchImpl(base + path, { headers, signal, redirect: 'manual' }), 1024 * 1024)));
  const runs = await get(`/actions/workflows/${ALERT_POOL_WORKFLOW}/runs?branch=main&status=success&per_page=5`);
  if (!Array.isArray(runs.workflow_runs)) throw new Error('Unreadable alert pool run list');
  for (const run of runs.workflow_runs) {
    if (run.head_branch !== 'main' || run.head_repository?.full_name?.toLowerCase() !== repo.toLowerCase() ||
        !['schedule', 'workflow_dispatch', 'workflow_run', 'push'].includes(run.event)) continue;
    const { artifacts } = await get(`/actions/runs/${run.id}/artifacts?per_page=20`);
    const artifact = artifacts?.find((a) => a.name === ALERT_POOL_ARTIFACT && !a.expired);
    if (!artifact) continue;
    if (!Number.isSafeInteger(artifact.id)) throw new Error('Invalid alert pool artifact');
    return { id: artifact.id, size: artifact.size_in_bytes, createdAt: artifact.created_at || null };
  }
  return null;
}

/** The signed storage URL of an artifact's ZIP. The credential goes to GitHub and never to storage. */
async function archiveLocation(artifactId, { repo, token, fetchImpl = fetch, signal }) {
  const { base, headers } = github({ repo, token });
  const redirect = await fetchImpl(`${base}/actions/artifacts/${artifactId}/zip`, { headers, redirect: 'manual', signal });
  const location = redirect.headers.get('location');
  await redirect.body?.cancel();
  if (redirect.status === 404 || redirect.status === 410) throw Object.assign(new Error('Alert pool artifact is gone'), { gone: true });
  if (redirect.status !== 302 || !location || new URL(location).protocol !== 'https:') throw new Error('Alert pool archive download unavailable');
  return location;
}

/** `bytes=start-end` of the archive, refusing a storage that answers with the whole file. */
async function readRange(location, start, end, { fetchImpl = fetch, signal, limit = MAX_MEMBER_BYTES } = {}) {
  const wanted = end - start + 1;
  if (wanted > limit) throw new Error('Alert pool member exceeds size limit');
  const response = await fetchImpl(location, { headers: { range: `bytes=${start}-${end}` }, redirect: 'manual', signal });
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`Alert pool storage did not answer the byte range (HTTP ${response.status})`);
  }
  const bytes = await readLimited(response, wanted);
  if (bytes.length !== wanted) throw new Error('Alert pool storage returned a short range');
  return bytes;
}
/** `bytes=-n`: the last n bytes, and the archive's total size from Content-Range. */
async function readTail(location, n, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(location, { headers: { range: `bytes=-${n}` }, redirect: 'manual', signal });
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`Alert pool storage did not answer the byte range (HTTP ${response.status})`);
  }
  const total = Number((response.headers.get('content-range') || '').split('/')[1]);
  const bytes = await readLimited(response, n);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Alert pool storage did not state the archive size');
  return { bytes, total };
}

/** Every member's name, offset of its local header, stored size and method, from the central directory. */
export function parseDirectory(tail, total) {
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = tail.length - 22;
  for (; end >= 0; end--) if (v.getUint32(end, true) === 0x06054b50) break;
  if (end < 0) throw new Error('Alert pool archive has no end-of-directory record');
  const entries = v.getUint16(end + 10, true);
  const size = v.getUint32(end + 12, true);
  const offset = v.getUint32(end + 16, true);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('ZIP64 alert pool archives are not supported');
  if (size > MAX_DIRECTORY_BYTES) throw new Error('Alert pool directory exceeds size limit');
  const tailStart = total - tail.length;
  if (offset < tailStart) return { needs: { start: offset, end: offset + size - 1 }, entries, size, offset };
  return { members: readEntries(tail.subarray(offset - tailStart, offset - tailStart + size), entries) };
}
export function readEntries(directory, entries) {
  const v = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const members = {};
  let at = 0;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > directory.length || v.getUint32(at, true) !== 0x02014b50) throw new Error('Invalid alert pool directory');
    const method = v.getUint16(at + 10, true), size = v.getUint32(at + 20, true), expanded = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true), extraLength = v.getUint16(at + 30, true), commentLength = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(directory.subarray(at + 46, at + 46 + nameLength));
    if (size === 0xffffffff || local === 0xffffffff) throw new Error('ZIP64 alert pool archives are not supported');
    members[name] = { method, size, expanded, local };
    at += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

/** The archive's member table, read once per artifact and kept at the edge for its lifetime. */
async function directoryFor(artifactId, cfg, cache, ctx) {
  const key = cacheKey(`directory/${artifactId}`);
  const held = await cache.match(key);
  if (held) return held.json();
  const location = await archiveLocation(artifactId, cfg);
  const { bytes, total } = await readTail(location, TAIL_BYTES, cfg);
  let parsed = parseDirectory(bytes, total);
  if (parsed.needs) parsed = { members: readEntries(await readRange(location, parsed.needs.start, parsed.needs.end, { ...cfg, limit: MAX_DIRECTORY_BYTES }), parsed.entries) };
  const directory = { artifactId, total, members: parsed.members, location };
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify({ artifactId, total, members: parsed.members }),
    { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${DIRECTORY_TTL_S}` } })));
  return directory;
}

/** One stored member's bytes. Deflated members are refused: the builder stores gzip files as-is. */
async function memberBytes(artifactId, name, cfg, cache, ctx, { limit = MAX_MEMBER_BYTES } = {}) {
  const directory = await directoryFor(artifactId, cfg, cache, ctx);
  const entry = directory.members[name];
  if (!entry) throw Object.assign(new Error(`Alert pool has no member ${name}`), { missing: true });
  if (entry.method !== 0) throw new Error('Alert pool member is not stored uncompressed');
  if (entry.size > limit || entry.expanded !== entry.size) throw new Error('Alert pool member exceeds size limit');
  const location = directory.location || await archiveLocation(artifactId, cfg);
  const header = await readRange(location, entry.local, entry.local + 29, cfg);
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (hv.getUint32(0, true) !== 0x04034b50) throw new Error('Invalid alert pool member header');
  const start = entry.local + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  if (start + entry.size > directory.total) throw new Error('Truncated alert pool archive');
  return entry.size ? readRange(location, start, start + entry.size - 1, { ...cfg, limit }) : new Uint8Array(0);
}

const gunzipText = async (bytes) => new TextDecoder().decode(await readLimited(new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))), MAX_INDEX_BYTES));

export async function handleAlertPool(request, env, ctx, { fetchImpl = fetch, cache = caches.default } = {}) {
  if (request.method !== 'GET') return Response.json({ ok: false, reason: 'method' }, { status: 405, headers: { ...CORS, allow: 'GET' } });
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/alert-pool\/?/, '');
  const cfg = { repo: env.GH_REPO, token: env.GH_DISPATCH_TOKEN, fetchImpl, signal: AbortSignal.any([request.signal, AbortSignal.timeout(25000)]) };
  try {
    if (path === 'index') return await handleIndex(request, cfg, cache, ctx);
    const match = /^(\d{1,15})\/(.+)$/.exec(path);
    if (match && isPoolMember(match[2])) return await handleMember(request, Number(match[1]), match[2], cfg, cache, ctx);
    return Response.json({ ok: false, reason: 'not-found' }, { status: 404, headers: CORS });
  } catch (error) {
    if (error?.gone || error?.missing) return Response.json({ ok: false, reason: error.gone ? 'gone' : 'missing', message: error.message }, { status: 404, headers: CORS });
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return Response.json({ ok: false, reason: 'timeout', message: 'The alert pool could not be read in time.' }, { status: 504, headers: CORS });
    console.log(`[alert-pool] ${error?.message || error}`);
    return Response.json({ ok: false, reason: 'unavailable', message: String(error?.message || error) }, { status: 503, headers: CORS });
  }
}

async function handleIndex(request, cfg, cache, ctx) {
  const key = cacheKey('index');
  const held = await cache.match(key);
  if (held) return revalidate(request, held, 'hit');
  const artifact = await latestPoolArtifact(cfg);
  if (!artifact) return Response.json({ ok: false, reason: 'no-pool', message: 'No alert pool has been published yet.' }, { status: 404, headers: CORS });
  const index = JSON.parse(await gunzipText(await memberBytes(artifact.id, ALERT_POOL_INDEX_MEMBER, cfg, cache, ctx, { limit: MAX_INDEX_BYTES })
    .then((bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b ? bytes : gzipRaw(bytes))));
  if (index?.contract !== ALERT_POOL_CONTRACT || index.version !== 1) throw new Error('The published alert pool has an unfamiliar contract');
  // The artifact id is the one fact the builder cannot know: it is assigned on upload.
  const body = JSON.stringify({ ...index, artifact: artifact.id, artifactCreatedAt: artifact.createdAt });
  const response = new Response(body, { headers: { ...CORS, 'content-type': 'application/json; charset=utf-8',
    etag: `"alert-pool-${artifact.id}-${contentTag(body)}"`, 'cache-control': `public, max-age=${INDEX_TTL_S}` } });
  ctx.waitUntil(cache.put(key, response.clone()));
  return revalidate(request, response, 'miss');
}
// The index is written uncompressed by the builder; wrap it so both paths decode alike.
async function gzipRaw(bytes) {
  return readLimited(new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))), MAX_INDEX_BYTES);
}

async function handleMember(request, artifactId, member, cfg, cache, ctx) {
  const key = cacheKey(`member/${artifactId}/${member}`);
  const held = await cache.match(key);
  if (held) return answer(request, held, 'hit');
  const bytes = await memberBytes(artifactId, member, cfg, cache, ctx);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Alert pool member is not a gzip file');
  const response = new Response(bytes, { encodeBody: 'manual', headers: { ...CORS, 'content-type': 'application/json; charset=utf-8',
    'content-encoding': 'gzip', etag: `"alert-pool-${artifactId}-${member.replace(/[^A-Za-z0-9-]/g, '_')}"`,
    'cache-control': `public, max-age=${MEMBER_TTL_S}, immutable` } });
  const saved = response.clone();
  ctx.waitUntil(cache.put(key, new Response(saved.body, { headers: saved.headers, encodeBody: 'manual' })));
  return answer(request, response, 'miss');
}

function answer(request, response, state) {
  const out = revalidate(request, response, state);
  // Cache API responses lose the constructor's encodeBody setting. Reapply it after cloning.
  return out.status !== 304 && out.headers.get('content-encoding') === 'gzip'
    ? new Response(out.body, { status: out.status, headers: out.headers, encodeBody: 'manual' }) : out;
}
