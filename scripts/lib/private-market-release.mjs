// Durable public captures on GitHub Releases. Private-source transports are separate.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { validateCapture, RESERVATION_ERROR } from './private-market-news.mjs';
export const PRIVATE_MARKET_FEATURE = 'private-market-news';
const TAG = 'private-market-news-data', REPO = 'techmuns/Sattva-Central-Research', MAX = 24 * 1024 * 1024;
export const fundingAssetPattern = /^funding-\d+-\d+-[01]-([a-f0-9]{64})\.json\.gz$/;
const assetPattern = fundingAssetPattern;
const hash = value => createHash('sha256').update(value).digest('hex');
async function bounded(response, limit) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw Error('Funding transport exceeds size budget'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export function privateMarketRelease({ env = process.env, fetcher = fetch, head = () => execFileSync('git', ['rev-parse','HEAD'], { encoding:'utf8' }).trim() } = {}) {
  if (env.GITHUB_REPOSITORY !== REPO) throw Error('Funding release repository mismatch');
  const root = `https://api.github.com/repos/${REPO}`, downloadRoot = `https://github.com/${REPO}/releases/download/${TAG}/`;
  async function api(suffix, options = {}) {
    const url = suffix === 'graphql' ? 'https://api.github.com/graphql' : suffix.startsWith('https://uploads.github.com/') ? suffix : root + suffix;
    if (url !== 'https://api.github.com/graphql' && !url.startsWith(root + '/') && !url.startsWith(`https://uploads.github.com/repos/${REPO}/`)) throw Error('Invalid funding API destination');
    const response = await fetcher(url, { ...options, headers:{ authorization:`Bearer ${env.GITHUB_TOKEN}`, accept:'application/vnd.github+json', 'user-agent':'SattvaResearchFunding', ...options.headers }, redirect:'error', signal:AbortSignal.timeout(60000) });
    if (response.status === 404 && !options.method) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw Error(`Funding release HTTP ${response.status}`); }
    return JSON.parse((await bounded(response, 4 * 1024 * 1024)).toString());
  }
  async function release(before = null) {
    // Read a bounded tail, rather than downloading an ever-growing REST release
    // object on every five-minute deployment check. Older evidence stays retained.
    const query = `query FundingCapture($before:String) { repository(owner:"techmuns",name:"Sattva-Central-Research") { release(tagName:"${TAG}") { databaseId tagName description releaseAssets(last:100,before:$before) { nodes { name size downloadUrl } pageInfo { hasPreviousPage startCursor } } } } }`;
    const result = await api('graphql', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ query, variables:{ before } }) });
    if (result?.errors?.length || !result?.data?.repository) throw Error('Funding release inventory unavailable');
    const current = result.data.repository.release; if (!current) return null;
    if (current.tagName !== TAG || !Number.isSafeInteger(current.databaseId) || !Array.isArray(current.releaseAssets?.nodes)) throw Error('Invalid funding release');
    return { id:current.databaseId, tag_name:current.tagName, body:current.description, pageInfo:current.releaseAssets.pageInfo,
      assets:current.releaseAssets.nodes.map(a => ({ name:a.name, size:a.size, state:a.size > 0 ? 'uploaded' : 'starter', browser_download_url:a.downloadUrl })) };
  }
  async function latest() {
    let current = await release(); if (!current) return null;
    for (let page = 1; page <= 500; page++) {
      const candidates = [];
      for (const asset of current.assets) if (assetPattern.test(asset.name) && asset.state === 'uploaded') {
        if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size >= MAX) throw Error('Invalid funding asset metadata');
        candidates.push(asset);
      }
      // Run, run attempt, then reservation/completion phase are monotonic within
      // this serialized workflow, including source failures in the same second.
      candidates.sort((a,b) => { const av=a.name.split('-').slice(1,4).map(Number),bv=b.name.split('-').slice(1,4).map(Number);return bv[0]-av[0] || bv[1]-av[1] || bv[2]-av[2]; });
      if (candidates.length) return { repo:REPO, feature:PRIVATE_MARKET_FEATURE, asset:candidates[0] };
      if (!current.pageInfo?.hasPreviousPage) {
        if (current.body?.includes('Capture initialized')) throw Error('Retained funding history is missing; refusing reset');
        return null;
      }
      if (!current.pageInfo.startCursor) throw Error('Incomplete funding asset cursor');
      current = await release(current.pageInfo.startCursor); if (!current) throw Error('Funding release disappeared during inventory');
    }
    throw Error('Funding asset inventory exceeds budget');
  }
  async function download(entry) {
    const asset = entry?.asset;
    if (entry?.repo !== REPO || entry.feature !== PRIVATE_MARKET_FEATURE || !assetPattern.test(asset?.name || '') || asset.browser_download_url !== downloadRoot + asset.name) throw Error('Invalid funding download');
    const response = await fetcher(asset.browser_download_url, { redirect:'follow', signal:AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(`Funding download HTTP ${response.status}`);
    const compressed = await bounded(response, MAX);
    if (compressed.length !== asset.size || hash(compressed) !== asset.name.match(assetPattern)[1]) throw Error('Funding capture integrity failed');
    return validateCapture(JSON.parse(gunzipSync(compressed, { maxOutputLength:MAX }).toString()));
  }
  async function publish(value) {
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '') || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') || head() !== env.GITHUB_SHA) throw Error('Funding publication requires the exact main-branch Actions checkout');
    const plain = JSON.stringify(validateCapture(value)); if (Buffer.byteLength(plain) > MAX) throw Error('Funding capture exceeds publication budget');
    const compressed = gzipSync(plain), phase=value.error === RESERVATION_ERROR ? 0 : 1, name = `funding-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${phase}-${hash(compressed)}.json.gz`;
    if (compressed.length >= MAX) throw Error('Compressed funding capture exceeds publication budget');
    let current = await release();
    if (!current) current = await api('/releases', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ tag_name:TAG, target_commitish:env.GITHUB_SHA, name:'Private market news — public funding facts', body:'Public factual funding tables and source-check history. No private data or publisher article bodies.', make_latest:'false' }) });
    const latestEntry = await latest();
    if (latestEntry && JSON.stringify(await download(latestEntry)) === plain) return latestEntry;
    const same = current.assets?.find(a => a.name === name && a.state === 'uploaded');
    if (!same) await api(`https://uploads.github.com/repos/${REPO}/releases/${current.id}/assets?name=${name}`, { method:'POST', headers:{ 'content-type':'application/gzip' }, body:compressed });
    if (!current.body?.includes('Capture initialized')) await api(`/releases/${current.id}`, { method:'PATCH', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ body:(current.body || '') + '\nCapture initialized' }) });
    const acknowledged = await latest();
    if (acknowledged?.asset.name !== name || JSON.stringify(await download(acknowledged)) !== plain) throw Error('Funding publication was not durably acknowledged');
    return acknowledged;
  }
  return { latest, download, publish };
}
export async function installPrivateMarket(entry, { env = process.env, fetcher = fetch, publicRoot = path.resolve('public') } = {}) {
  const value = await privateMarketRelease({ env,fetcher }).download(entry);
  const target = path.join(publicRoot, 'data/private-market-news.json');
  fs.mkdirSync(path.dirname(target), { recursive:true }); fs.writeFileSync(target + '.tmp', JSON.stringify(value)); fs.renameSync(target + '.tmp', target);
}
