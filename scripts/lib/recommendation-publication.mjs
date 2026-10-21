// Public reader output only. Analysis and restart databases stay on GitHub Actions/Releases.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const RECOMMENDATION_FEATURE = 'recommendations';
export const recommendationAsset = /^recommendations-(\d+)-(\d+)-([a-f0-9]{64})\.json$/;
const MAX = 8 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
async function bytes(response, limit) {
  if (!response.ok) throw Error(`Recommendation publication HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw Error('Recommendation publication exceeds budget'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export function recommendationPublication({env=process.env,fetcher=fetch}={}) {
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !env.GITHUB_TOKEN) throw Error('Recommendation repository configuration unavailable');
  const root = `https://api.github.com/repos/${repo}`;
  const headers = {authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','user-agent':'ResearchRecommendationPublication'};
  const api = async suffix => JSON.parse((await bytes(await fetcher(root+suffix,{headers,redirect:'error',signal:AbortSignal.timeout(30000)}),4*1024*1024)).toString());
  async function latest() {
    const candidates = []; let complete = false;
    for (let page=1;page<=10;page++) {
      const releases = await api(`/releases?per_page=100&page=${page}`);
      if (!Array.isArray(releases) || releases.length > 100) throw Error('Invalid recommendation release inventory');
      for (const release of releases.filter(r => /^recommendation-foundation-\d{4}-\d{2}$/.test(r.tag_name) && !r.draft)) {
        let done = false;
        for (let p=1;p<=10;p++) {
          const assets = await api(`/releases/${release.id}/assets?per_page=100&page=${p}`);
          if (!Array.isArray(assets) || assets.length > 100) throw Error('Invalid recommendation asset inventory');
          for (const asset of assets) if (recommendationAsset.test(asset.name) && asset.state === 'uploaded' && Number.isSafeInteger(asset.id) && asset.id>0 && asset.size>0 && asset.size<=MAX) candidates.push({repo,feature:RECOMMENDATION_FEATURE,tag:release.tag_name,asset});
          if (assets.length<100) { done=true;break; }
        }
        if (!done) throw Error('Recommendation asset inventory incomplete');
      }
      if (releases.length<100) {complete=true;break;}
    }
    if (!complete) throw Error('Recommendation release inventory incomplete');
    return candidates.sort((a,b)=>b.asset.id-a.asset.id)[0] || null;
  }
  async function download(entry) {
    const asset=entry?.asset, match=asset?.name?.match(recommendationAsset);
    if (entry?.repo!==repo || entry?.feature!==RECOMMENDATION_FEATURE || !match || !/^recommendation-foundation-\d{4}-\d{2}$/.test(entry.tag) || asset.browser_download_url!==`https://github.com/${repo}/releases/download/${entry.tag}/${asset.name}` || !(asset.size>0 && asset.size<=MAX)) throw Error('Invalid recommendation destination');
    const body = await bytes(await fetcher(asset.browser_download_url,{redirect:'follow',signal:AbortSignal.timeout(60000)}),MAX);
    if (body.length!==asset.size || sha(body)!==match[3]) throw Error('Recommendation output integrity failed');
    const value=JSON.parse(body.toString());
    if (value.version!==1 || value.repository!==repo || value.sourceRun!==match[1] || !Array.isArray(value.rows) || value.rowCount!==value.rows.length || !Number.isFinite(Date.parse(value.generatedAt)) || !Number.isSafeInteger(value.foundationAsset?.id) || !value.foundationAsset?.name?.startsWith(`foundation-${match[1]}-${match[2]}-`)) throw Error('Recommendation output context mismatch');
    return value;
  }
  return {latest,download};
}
export async function installRecommendations(entry,{env=process.env,fetcher=fetch,publicRoot=path.resolve('public')}={}) {
  const value=await recommendationPublication({env,fetcher}).download(entry);
  const target=path.join(publicRoot,'data/ai-recommendations.json');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target+'.tmp',JSON.stringify(value));fs.renameSync(target+'.tmp',target);
}
