// Durable public captures on GitHub Releases. Private-source transports are separate.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { validateCapture } from './private-market-news.mjs';
export const PRIVATE_MARKET_FEATURE = 'private-market-news';
const TAG = 'private-market-news-data', REPO = 'techmuns/Sattva-Central-Research', MAX = 24 * 1024 * 1024;
const assetPattern = /^funding-\d+-\d+-([a-f0-9]{64})\.json\.gz$/;
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
    const url = suffix.startsWith('https://uploads.github.com/') ? suffix : root + suffix;
    if (!url.startsWith(root + '/') && !url.startsWith(`https://uploads.github.com/repos/${REPO}/`)) throw Error('Invalid funding API destination');
    const response = await fetcher(url, { ...options, headers:{ authorization:`Bearer ${env.GITHUB_TOKEN}`, accept:'application/vnd.github+json', 'user-agent':'SattvaResearchFunding', ...options.headers }, redirect:'error', signal:AbortSignal.timeout(60000) });
    if (response.status === 404 && !options.method) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw Error(`Funding release HTTP ${response.status}`); }
    return JSON.parse((await bounded(response, 4 * 1024 * 1024)).toString());
  }
  async function release() {
    const current = await api(`/releases/tags/${TAG}`); if (!current) return null;
    if (current.tag_name !== TAG || !Number.isSafeInteger(current.id)) throw Error('Invalid funding release');
    return current;
  }
  async function latest() {
    const current = await release(); if (!current) return null;
    let latestAsset = null;
    for (let page = 1; page <= 500; page++) {
      const assets = await api(`/releases/${current.id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(assets)) throw Error('Funding asset inventory unavailable');
      for (const asset of assets) if (assetPattern.test(asset.name) && asset.state === 'uploaded' && asset.size > 0 && asset.size < MAX && (!latestAsset || asset.id > latestAsset.id)) latestAsset = asset;
      if (assets.length < 100) {
        if (!latestAsset && current.body?.includes('Capture initialized')) throw Error('Retained funding history is missing; refusing reset');
        return latestAsset ? { repo:REPO, feature:PRIVATE_MARKET_FEATURE, asset:latestAsset } : null;
      }
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
    const compressed = gzipSync(plain), name = `funding-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${hash(compressed)}.json.gz`;
    let current = await release();
    if (!current) current = await api('/releases', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ tag_name:TAG, target_commitish:env.GITHUB_SHA, name:'Private market news — public funding facts', body:'Public factual funding tables and source-check history. No private data or publisher article bodies.', make_latest:'false' }) });
    const latestEntry = await latest();
    if (latestEntry && JSON.stringify(await download(latestEntry)) === plain) return latestEntry;
    const same = current.assets?.find(a => a.name === name && a.state === 'uploaded');
    if (!same) await api(`https://uploads.github.com/repos/${REPO}/releases/${current.id}/assets?name=${name}`, { method:'POST', headers:{ 'content-type':'application/gzip' }, body:compressed });
    if (!current.body?.includes('Capture initialized')) await api(`/releases/${current.id}`, { method:'PATCH', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ body:(current.body || '') + '\nCapture initialized' }) });
    return latest();
  }
  return { latest, download, publish };
}
export async function installPrivateMarket(entry, { env = process.env, fetcher = fetch, publicRoot = path.resolve('public') } = {}) {
  const value = await privateMarketRelease({ env,fetcher }).download(entry);
  const target = path.join(publicRoot, 'data/private-market-news.json');
  fs.mkdirSync(path.dirname(target), { recursive:true }); fs.writeFileSync(target + '.tmp', JSON.stringify(value)); fs.renameSync(target + '.tmp', target);
}
