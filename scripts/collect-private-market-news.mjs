#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SOURCE, discover, parseArticle, mergeArticle, emptyCapture, validateCapture } from './lib/private-market-news.mjs';

// At most 32 sequential public requests per six-hour walk; no immediate retries.
// A refusal stops the entire walk and persists a 24-hour source cooldown.
export function collectionDue(state, now = Date.now()) { return !(Date.parse(state.cooldownUntil || '') > now || Date.parse(state.attemptedAt || '') > now - 6 * 3600000); }
export async function collect(state, { request = fetch, now = () => new Date().toISOString(), sleep = ms => new Promise(r => setTimeout(r, ms)), budget = 32, gapMs = 3000, archivePages = 2, checkpoint = () => {}, reservation = null } = {}) {
  validateCapture(state);
  if (Date.parse(state.cooldownUntil || '') > Date.parse(now()) || reservation !== state.attemptedAt && !collectionDue(state, Date.parse(now()))) return state;
  state.attemptedAt = now(); state.error = null; let requests = 0; let stopped = false;
  async function read(url, options = {}) {
    if (requests >= budget) throw Error('Request budget exhausted');
    if (requests++) await sleep(gapMs);
    const response = await request(url, { ...options, headers: { 'user-agent': 'SattvaResearchFunding/1.0 (+https://github.com/techmuns/Sattva-Central-Research)', ...options.headers }, signal: AbortSignal.timeout(45000), redirect: 'error' });
    if (!response.ok) {
      if ([401,403,429].includes(response.status)) {
        const retry = Number(response.headers.get('retry-after')) * 1000 || Date.parse(response.headers.get('retry-after') || '') - Date.parse(now());
        state.cooldownUntil = new Date(Date.parse(now()) + Math.max(86400000, Number.isFinite(retry) ? Math.min(retry, 7 * 86400000) : 0)).toISOString(); stopped = true;
      }
      await response.body?.cancel(); throw Error(`Inc42 HTTP ${response.status}`);
    }
    const body = await response.text(); if (body.length > 4 * 1024 * 1024) throw Error('Source response too large');
    if (/cf-chl-|just a moment|verify you are human/i.test(body.slice(0,10000))) { state.cooldownUntil = new Date(Date.parse(now()) + 86400000).toISOString(); stopped = true; throw Error('Inc42 access challenge'); }
    return body;
  }
  function add(articles) {
    for (const article of articles) if (!state.articles.some(a => a.url === article.url)) state.articles.push({ ...article, status: 'pending', firstSeenAt: now() });
  }
  try {
    const listing = discover(await read(SOURCE));
    if (!listing.articles.length || !listing.ajax || !listing.query || listing.ajax.ajax_url !== 'https://inc42.com/wp-admin/admin-ajax.php') throw Error('Funding archive schema changed');
    add(listing.articles); state.sourceCheckedAt = now(); state.cooldownUntil = null; checkpoint(state);
    const maxPage = Number(listing.ajax.max_page);
    if (!Number.isSafeInteger(maxPage) || maxPage < 1 || maxPage > 1000) throw Error('Invalid archive page count');
    if (state.archive.maxPage && maxPage !== state.archive.maxPage) { state.archive.nextPage = 2; state.archive.complete = false; }
    state.archive.maxPage = maxPage;
    // Re-scan the public Load More inventory after a full pass. Listing movement cannot
    // strand older links behind a page number which used to mean something else.
    if (state.archive.complete && Date.parse(state.archive.checkedAt || '') < Date.parse(now()) - 7 * 86400000) { state.archive.nextPage = 2; state.archive.complete = false; }
    for (let i = 0; i < archivePages && !state.archive.complete && requests < budget - 2; i++) {
      if (state.archive.nextPage > maxPage) { state.archive.complete = true; state.archive.checkedAt = now(); break; }
      const body = new URLSearchParams({ action: 'inc42_loadmore_tag_posts', nonce: listing.ajax.api_nonce, page: String(state.archive.nextPage), query: listing.query });
      const found = discover(await read(listing.ajax.ajax_url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }));
      if (!found.articles.length) throw Error(`Archive page ${state.archive.nextPage} contained no funding links`);
      add(found.articles); state.archive.nextPage++;
      if (state.archive.nextPage > maxPage) { state.archive.complete = true; state.archive.checkedAt = now(); }
      checkpoint(state);
      console.log(`Archive page ${state.archive.nextPage - 1}/${maxPage}: ${state.articles.length} roundups discovered`);
    }
    const latest = new Set(listing.articles.slice(0, 2).map(a => a.url));
    const queue = state.articles.filter(a => a.status === 'pending' || !a.attemptedAt || Date.parse(a.retryAfter || '') <= Date.parse(now()) || latest.has(a.url))
      .sort((a,b) => Number(latest.has(b.url)) - Number(latest.has(a.url)) || Number(a.status !== 'pending') - Number(b.status !== 'pending') || (a.attemptedAt || '').localeCompare(b.attemptedAt || ''));
    for (const article of queue) {
      if (requests >= budget || stopped) break;
      try {
        const parsed = parseArticle(await read(article.url), article); mergeArticle(state, article, parsed, now());
        console.log(`${parsed.status}: ${article.url} (${parsed.rows.length} rows)`);
        checkpoint(state);
      } catch (error) {
        article.status = 'failed'; article.error = error.message; article.attemptedAt = now(); article.retryAfter = new Date(Date.parse(now()) + 86400000).toISOString();
        state.error = error.message;
        checkpoint(state);
        if (stopped) break;
      }
    }
  } catch (error) { state.error = error.message; }
  state.generatedAt = now(); state.lastRun = { requests, budget, pending: state.articles.filter(a => a.status === 'pending').length };
  return validateCapture(state);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = path.resolve(process.env.PRIVATE_MARKET_FILE || 'public/data/private-market-news.json');
  const state = fs.existsSync(file) ? validateCapture(JSON.parse(fs.readFileSync(file))) : emptyCapture();
  const checkpoint = value => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };
  await collect(state, { budget: Math.min(1000, Math.max(4, Number(process.env.PRIVATE_MARKET_BUDGET || 32))), archivePages: Number(process.env.PRIVATE_MARKET_ARCHIVE_PAGES || 2), checkpoint });
  checkpoint(state);
  console.log(JSON.stringify({ deals: state.deals.length, articles: state.articles.length, archive: state.archive, lastRun: state.lastRun, sourceCheckedAt: state.sourceCheckedAt, error: state.error, cooldownUntil: state.cooldownUntil }));
}
