#!/usr/bin/env node
// Additive, scheduled discovery. No on-page company fan-out, browser credentials or source edits.
// Core India search remains independent; this stage adds global queries, reviewed official IR
// documents, and exact portfolio matches from every retained broad-publisher shard.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { companyNewsArchiveRows, commitCompanyNewsArchive, observedCompanyArticles, readCompanyNewsIndex, recentArchivedCompanyNews } from './lib/company-news-archive.mjs';
import { discoveryRange, discoverNewsRange, officialDocumentLinks, officialDocumentDate } from './lib/news-discovery.mjs';
import { matchPortfolioNews } from '../public/js/data/portfolio-news-matching.js';

const DATA = fileURLToPath(new URL('../public/data', import.meta.url));
const BASE = 'https://sattva-central-research.tech-441.workers.dev';

async function bytes(url, fetcher, maximum = 5 * 1024 * 1024) {
  const res = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(18000),
    headers: { 'User-Agent': 'SattvaResearch-NewsDiscovery/1.0' } });
  if (!res.ok || Number(res.headers.get('content-length')) > maximum) throw Error('source-unavailable');
  const parts = []; let size = 0;
  for await (const part of res.body) {
    size += part.length;
    if (size > maximum) throw Error('source-too-large');
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

function pdfText(buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'sattva-news-pdf-'));
  try {
    const input = join(dir, 'document.pdf');
    writeFileSync(input, buffer);
    return execFileSync('pdftotext', ['-f', '1', '-l', '3', '-layout', input, '-'],
      { timeout: 10000, maxBuffer: 256 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function enrichCompanyNews({ dataDir = DATA, baseUrl = BASE, fetcher = fetch,
  now = Date.now(), budgetMs = 6 * 60000, gapMs = 2500, extractPdf = pdfText, maxQueries = Infinity } = {}) {
  const dir = join(dataDir, 'company-news'), index = readCompanyNewsIndex(dir);
  const entities = index.entities || [];
  if (!entities.length) throw Error('No captured portfolio registry; enrichment cannot guess the active book.');
  const head = readJson(join(dataDir, 'news.json'), {});
  const saved = readJson(join(dir, 'discovery.json'), { queries: {}, pages: {}, documents: {} });
  const state = { ...saved, queries: saved.queries || {}, pages: saved.pages || {}, documents: saved.documents || {} };
  const at = new Date(now).toISOString(), deadline = Date.now() + budgetMs;
  const incoming = [];

  // All retained broad-feed months, not only its 600-row head. Matching is exact and reviewed;
  // nonmatches stay in the market archive. Neither importance nor portfolio weight filters this.
  const broad = readJson(join(dataDir, 'market-news.json'), {});
  const pool = new Map((broad.articles || []).map(r => [r.url || r.id, r]));
  for (const shard of broad.archive || []) {
    if (!/^market-news\/\d{4}-\d{2}\.json$/.test(shard.file || '')) continue;
    for (const row of readJson(join(dataDir, shard.file), {}).articles || []) pool.set(row.url || row.id, row);
  }
  for (const row of pool.values()) for (const matched of matchPortfolioNews(row, entities)) {
    const entity = entities.find(e => e.entityId === matched.entityId);
    incoming.push(...observedCompanyArticles([{ ...row, source: row.publisher || row.source,
      date: row.publishedAt?.slice(0, 10) || null, discoverySource: 'publisher-feed' }], entity, 'publisher-feed', at));
  }

  const documents = companyNewsArchiveRows(dir).filter(r => r.discoverySource === 'official-ir');
  const documentsByUrl = new Map(documents.map(row => [row.url, row]));
  // Pages are explicitly reviewed, not links supplied by articles or a model. No generic web
  // crawl or authentication bypass. Metadata for EVERY linked PDF is archived, including undated.
  for (const entity of entities) for (const page of entity.officialPages || []) {
    if (Date.now() > deadline - 45000) break;
    const key = `${entity.entityId}|${page}`;
    try {
      const html = (await bytes(page, fetcher, 3 * 1024 * 1024)).toString('utf8');
      const links = officialDocumentLinks(html, page);
      if (!links.length && state.pages[key]?.lastResultCount) throw Error('index-shape-changed');
      for (const link of links) {
        const row = observedCompanyArticles([{ ...link, date: null, source: new URL(page).hostname,
          officialIndexUrl: page, discoverySource: 'official-ir' }], entity, page, at)[0];
        incoming.push(row);
        if (!documentsByUrl.has(row.url)) documentsByUrl.set(row.url, row);
      }
      state.pages[key] = { lastAttemptAt: at, lastSuccessAt: at, lastResultCount: links.length, error: links.length ? null : 'empty-index-unverified' };
    } catch { state.pages[key] = { ...state.pages[key], lastAttemptAt: at, error: 'index-read-failed' }; }
  }
  // Read a bounded fair queue of official documents. No inference from URL upload folders.
  const allowedHosts = new Set(entities.flatMap(e => [...(e.officialPages || []), ...(e.evidenceUrls || [])].map(u => new URL(u).hostname.replace(/^www\./, ''))));
  const docQueue = [...documentsByUrl.values()].filter(r => !r.articleBody && allowedHosts.has(new URL(r.url).hostname.replace(/^www\./, '')))
    .sort((a, b) => String(state.documents[a.url]?.lastAttemptAt || '').localeCompare(String(state.documents[b.url]?.lastAttemptAt || '')) ||
      String(b.firstSeenAt || '').localeCompare(String(a.firstSeenAt || '')));
  let docsRead = 0, docsSucceeded = 0;
  for (const row of docQueue.slice(0, 8)) {
    if (Date.now() > deadline - 45000) break;
    docsRead++;
    try {
      const buffer = await bytes(row.url, fetcher);
      if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw Error('not-a-pdf');
      const text = extractPdf(buffer).trim();
      if (text.length < 80) throw Error('no-readable-text');
      incoming.push({ ...row, date: officialDocumentDate(text) || row.date,
        articleBody: { text: text.slice(0, 6000), provenance: 'publisher-article-body', sourceUrl: row.url, fetchedAt: at, bounded: 'first-three-pdf-pages; 6000 characters' } });
      state.documents[row.url] = { lastAttemptAt: at, lastSuccessAt: at, error: null };
      docsSucceeded++;
    } catch { state.documents[row.url] = { ...state.documents[row.url], lastAttemptAt: at, error: 'document-read-failed' }; }
  }

  const jobs = entities.flatMap(entity => entity.queries.map(query => ({ entity, query, key: `${entity.entityId}|ALL|${query}` })))
    .sort((a, b) => String(state.queries[a.key]?.lastAttemptAt || '').localeCompare(String(state.queries[b.key]?.lastAttemptAt || '')));
  let attempted = 0, completed = 0;
  for (const job of jobs) {
    if (Date.now() > deadline - 20000 || attempted >= maxQueries) break;
    attempted++;
    const checkpoint = state.queries[job.key] ||= {};
    const range = checkpoint.pending?.length ? { ...checkpoint.range } : discoveryRange(checkpoint, now);
    let ranges = null;
    if (checkpoint.pending?.length) {
      // A saturated historical day cannot monopolize this query forever. Poll current/outage
      // coverage first, then resume old partitions. The incomplete leaf still blocks a green
      // coverage claim, but no longer prevents discovery of newer international stories.
      const overlapDay = new Date(now - 48 * 3600000).toISOString().slice(0, 10);
      const catchup = { from: range.to < overlapDay ? range.to : overlapDay, to: at.slice(0, 10) };
      ranges = [...new Map([catchup, ...checkpoint.pending].map(r => [`${r.from}|${r.to}`, r])).values()];
      range.to = catchup.to;
    }
    checkpoint.lastAttemptAt = at;
    checkpoint.range = range;
    const result = await discoverNewsRange({ ...range, ranges, maxReads: 5,
      read: async ({ from, to }) => {
        if (Date.now() > deadline - 20000) throw Error('budget');
        await new Promise(resolve => setTimeout(resolve, gapMs));
        const url = new URL('/api/news', baseUrl);
        url.search = new URLSearchParams({ q: job.query, from, to, country: 'ALL' });
        const response = JSON.parse((await bytes(url, fetcher)).toString('utf8'));
        // During rollout an older Worker silently substitutes IN: do not record global success.
        if (!response.ok || response.country !== 'ALL') throw Error('global-search-unavailable');
        return response;
      } });
    incoming.push(...observedCompanyArticles(result.articles.map(row => ({ ...row, discoverySource: 'global-news-search' })), job.entity, job.query, at));
    checkpoint.pending = result.unresolved;
    checkpoint.lastResultCount = result.articles.length;
    checkpoint.error = result.complete ? null : 'incomplete-discovery';
    if (result.complete) {
      completed++;
      checkpoint.lastSuccessAt = at;
      checkpoint.coveredThrough = range.to;
      if (range.reconcile) checkpoint.lastReconciledAt = at;
    }
  }
  const stale = jobs.filter(job => !state.queries[job.key]?.lastSuccessAt || state.queries[job.key].error || state.queries[job.key].pending?.length || now - Date.parse(state.queries[job.key].lastSuccessAt) > 24 * 3600000).length;
  const coverage = { capturedAt: at, plannedQueries: jobs.length, attemptedQueries: attempted, completedQueries: completed,
    staleOrIncompleteQueries: stale, pagesFailed: Object.values(state.pages).filter(p => p.error).length,
    documentsRead: docsRead, documentsPending: docQueue.length - docsSucceeded,
    note: 'Additive global and IR discovery; search-provider coverage is not exhaustive. Pending date partitions, document failures and stale queries remain retryable.' };
  writeJson(join(dir, 'discovery.json'), { ...state, coverage });
  const archive = commitCompanyNewsArchive({ dir, entities, articles: incoming, capturedAt: at });
  const byTicker = { ...head.byTicker };
  for (const entity of entities) delete byTicker[entity.key];
  const entityById = new Map(entities.map(e => [e.entityId, e]));
  for (const row of recentArchivedCompanyNews(dir, new Date(now - 30 * 86400000).toISOString().slice(0, 10))) {
    const entity = entityById.get(row.entityId);
    if (entity) (byTicker[entity.key] ||= []).push(row);
  }
  writeJson(join(dataDir, 'news.json'), { ...head, byTicker, enrichmentCoverage: coverage,
    rowCount: Object.values(byTicker).reduce((n, rows) => n + rows.length, 0),
    empty: (head.empty || []).filter(key => !byTicker[key]?.length),
    archive: { ...head.archive, articleCount: archive.articleCount } });
  return coverage;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await enrichCompanyNews();
  console.log(JSON.stringify(result));
  if (result.staleOrIncompleteQueries || result.pagesFailed) console.log('::warning::News enrichment has incomplete coverage; retained articles are preserved and incomplete work will be retried on the next schedule.');
}
