import { createHash } from 'node:crypto';
import { announcementDocumentIdentity, announcementSources } from '../../public/js/data/announcements-shared.js';

export const ANNOUNCEMENT_PDF_LIMIT = 20 * 1024 * 1024;
export const ANNOUNCEMENT_PDF_MINIMUM = 64;
export const ANNOUNCEMENT_MATCH_WINDOW_MS = 45 * 60 * 1000;
export const ANNOUNCEMENT_HASH_DOWNLOAD_LIMIT = 6;
export const ANNOUNCEMENT_HASH_BUDGET_MS = 15_000;

const digestValue = value => /^sha256:[0-9a-f]{64}$/i.test(String(value || ''))
  ? String(value).toLowerCase() : null;

const pairIdentity = (digest, left, right) => `sha256:${createHash('sha256')
  .update(['cross-exchange-document-v1', digest, ...[left.url, right.url]
    .map(url => announcementDocumentIdentity(url) || url).sort()].join('\0'))
  .digest('hex')}`;

function exchangeSource(row) {
  const sources = announcementSources(row).map(value => String(value).toUpperCase());
  return sources.length === 1 && ['BSE', 'NSE'].includes(sources[0]) ? sources[0] : null;
}

function officialPdfUrl(value, source) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const official = source === 'BSE'
      ? host === 'bseindia.com' || host.endsWith('.bseindia.com')
      : host === 'nseindia.com' || host.endsWith('.nseindia.com');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !official
      || !/\.pdf(?:$|[?#])/i.test(url.href)) return null;
    return url.href;
  } catch { return null; }
}

function rowPdfUrl(row, source) {
  const values = [row?.url];
  for (const item of Array.isArray(row?.sourceUrls) ? row.sourceUrls : []) {
    if (typeof item === 'string') values.push(item);
    else if (String(item?.source || '').toUpperCase() === source) values.push(item?.url);
  }
  const urls = [...new Set(values.map(value => officialPdfUrl(value, source)).filter(Boolean))];
  // The BSE moves one immutable UUID attachment between AttachLive, AttachHis and Pname. The raw
  // merge keeps each retrieval URL, so accept multiple URLs only when they canonicalize to the
  // same document identity; genuinely different source documents remain ambiguous.
  const identities = new Set(urls.map(announcementDocumentIdentity).filter(Boolean));
  return identities.size === 1 ? urls[0] : null;
}

function isoDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? value : null;
}

function clockMs(value) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''));
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]), seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

function candidate(row, index) {
  const source = exchangeSource(row);
  const ticker = String(row?.ticker || '').trim().toUpperCase();
  const date = isoDay(row?.date);
  const time = clockMs(row?.time);
  const url = source ? rowPdfUrl(row, source) : null;
  return source && ticker && date && time != null && url
    ? { index, source, ticker, date, time, url, digest: digestValue(row.documentHash) }
    : null;
}

function validatePairObservations(row, pairId, values) {
  if (!Array.isArray(values) || values.length !== 2) return null;
  const observations = values.map(value => {
    if (!value || typeof value !== 'object') return null;
    const { crossExchangeDocumentId, crossExchangeObservations, ...observation } = value;
    return observation;
  });
  if (observations.some(value => !value)) return null;
  const candidates = observations.map((value, index) => candidate(value, index));
  if (candidates.some(value => !value)) return null;
  const bySource = new Map(candidates.map(value => [value.source, value]));
  const left = bySource.get('BSE'), right = bySource.get('NSE');
  if (!left || !right || bySource.size !== 2 || left.ticker !== right.ticker || left.date !== right.date
    || left.ticker !== String(row?.ticker || '').trim().toUpperCase() || left.date !== row?.date
    || !left.digest || left.digest !== right.digest || left.digest !== digestValue(row?.documentHash)
    || pairIdentity(left.digest, left, right) !== pairId) return null;
  return observations;
}

function legacyPairObservations(row, pairId) {
  const digest = digestValue(row?.documentHash);
  if (!digest) return null;
  const base = storedObservation(row);
  const observations = ['BSE', 'NSE'].map(source => {
    const url = rowPdfUrl(row, source);
    if (!url) return null;
    const providers = (Array.isArray(row.providers) ? row.providers : []).filter(provider => source === 'BSE'
      ? /\bBSE\b/i.test(provider) : !/\bBSE\b/i.test(provider));
    const observation = { ...base, source, sources: [source], url,
      sourceUrls: [{ source, url }], providers, documentHash: digest };
    if (source !== 'BSE') {
      for (const field of ['scripCode', 'newsId', 'headline', 'subject', 'subCategory', 'critical']) delete observation[field];
    }
    return observation;
  });
  return observations.some(value => !value) ? null : validatePairObservations(row, pairId, observations);
}

function pairObservations(row) {
  const pairId = digestValue(row?.crossExchangeDocumentId);
  const sources = announcementSources(row).map(value => String(value).toUpperCase());
  if (!pairId || sources.length !== 2 || sources[0] !== 'BSE' || sources[1] !== 'NSE') return null;
  if (row?.crossExchangeObservations != null) {
    return validatePairObservations(row, pairId, row.crossExchangeObservations);
  }
  // Rows created before source observations were introduced still carry a cryptographic pair ID,
  // the shared digest and both official links. Reconstruct only when those fields recompute the
  // exact stored ID; otherwise leave the row untouched and fail closed.
  return legacyPairObservations(row, pairId);
}

export function expandCrossExchangeObservations(rows) {
  if (!Array.isArray(rows)) throw TypeError('Announcement rows must be an array');
  const output = [];
  for (const row of rows) {
    const observations = pairObservations(row);
    if (observations) output.push(...observations.map(value => ({ ...value })));
    else output.push(row && typeof row === 'object' ? { ...row } : row);
  }
  return output;
}

function storedObservation(row) {
  const { crossExchangeDocumentId, crossExchangeObservations, ...observation } = row;
  return observation;
}

function comparisonCandidates(candidates, matchWindowMs) {
  const groups = new Map();
  for (const item of candidates) {
    const key = `${item.ticker}|${item.date}`;
    if (!groups.has(key)) groups.set(key, { BSE: [], NSE: [] });
    groups.get(key)[item.source].push(item);
  }
  const edges = [], included = new Set();
  for (const group of groups.values()) {
    for (const bse of group.BSE) {
      for (const nse of group.NSE) {
        if (Math.abs(bse.time - nse.time) > matchWindowMs) continue;
        edges.push([bse, nse]);
        included.add(bse.index); included.add(nse.index);
      }
    }
  }
  return { candidates: candidates.filter(item => included.has(item.index)), edges };
}

function documentHeaders(source) {
  return {
    accept: 'application/pdf,application/octet-stream;q=0.8,*/*;q=0.1',
    referer: source === 'BSE' ? 'https://www.bseindia.com/' : 'https://www.nseindia.com/',
    'user-agent': 'Sattva-Corporate-Announcements/1.0',
  };
}

async function cancelBody(response) {
  try { await response?.body?.cancel?.(); } catch { /* A close failure cannot replace the source result. */ }
}

async function fetchOfficialPdf(item, { fetcher, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = item.url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, {
      method: 'GET', redirect: 'manual', signal,
      headers: documentHeaders(item.source),
    });
    if ([301, 302, 303, 307, 308].includes(response?.status)) {
      const location = response.headers?.get?.('location');
      await cancelBody(response);
      let next = null;
      try { if (location) next = officialPdfUrl(new URL(location, url).href, item.source); } catch { /* rejected below */ }
      if (!next) throw Error('document-redirect-unofficial');
      if (redirects === 3) throw Error('document-too-many-redirects');
      url = next;
      continue;
    }
    // Custom fetch implementations can ignore redirect:manual. Revalidate any final URL they
    // expose so a redirect outside the exchange cannot acquire official provenance.
    if (response?.url && !officialPdfUrl(response.url, item.source)) {
      await cancelBody(response);
      throw Error('document-redirect-unofficial');
    }
    return response;
  }
  throw Error('document-too-many-redirects');
}

async function boundedPdfDigest(item, { fetcher, maxBytes, timeoutMs }) {
  let response;
  try { response = await fetchOfficialPdf(item, { fetcher, timeoutMs }); }
  catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw Error('document-timeout');
    throw error;
  }
  if (!response?.ok) {
    await cancelBody(response);
    throw Error(`document-http-${response?.status || 'unknown'}`);
  }
  const length = response.headers?.get?.('content-length');
  if (/^\d+$/.test(length || '') && Number(length) > maxBytes) {
    await cancelBody(response);
    throw Error('document-too-large');
  }
  if (!response.body?.getReader) throw Error('document-body-unavailable');
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let size = 0, header = Buffer.alloc(0), tail = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Error('document-too-large');
      }
      hash.update(value);
      if (header.length < 24) {
        const take = value.subarray(0, Math.min(value.byteLength, 24 - header.length));
        header = Buffer.concat([header, Buffer.from(take)], header.length + take.byteLength);
      }
      if (value.byteLength >= 4096) tail = Buffer.from(value.subarray(value.byteLength - 4096));
      else {
        tail = Buffer.concat([tail, Buffer.from(value)]);
        if (tail.length > 4096) tail = tail.subarray(tail.length - 4096);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const headerText = header.toString('latin1');
  const tailText = tail.toString('latin1').replace(/[\x00\t\f\r\n ]+$/, '');
  if (size < ANNOUNCEMENT_PDF_MINIMUM
    || !/^(?:ï»¿)?[\x00\t\r\n ]*%PDF-\d\.\d/.test(headerText)
    || !/%%EOF$/.test(tailText)) throw Error('document-not-pdf');
  const encoding = String(response.headers?.get?.('content-encoding') || '').trim().toLowerCase();
  if (/^\d+$/.test(length || '') && (!encoding || encoding === 'identity') && size !== Number(length)) {
    throw Error('document-length-mismatch');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function mapLimit(items, limit, work) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await work(items[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * Hash official, same-company/day BSE/NSE PDFs that have an opposite-exchange neighbour in the
 * filing-time window. Matching happens only after hashing: one BSE and one NSE record receive a
 * shared ID when each is the other's sole equal-digest neighbour. Repeated bytes, unreadable PDFs
 * and incomplete work remain independent records.
 */
export async function enrichCrossExchangeDocumentHashes(rows, {
  fetcher = fetch,
  maxBytes = ANNOUNCEMENT_PDF_LIMIT,
  timeoutMs = 20_000,
  concurrency = 3,
  matchWindowMs = ANNOUNCEMENT_MATCH_WINDOW_MS,
  maxDownloads = ANNOUNCEMENT_HASH_DOWNLOAD_LIMIT,
  budgetMs = ANNOUNCEMENT_HASH_BUDGET_MS,
  pairOffset = 0,
  now = Date.now,
  cache = new Map(),
} = {}) {
  if (!Array.isArray(rows)) throw TypeError('Announcement rows must be an array');
  for (const [name, value, minimum] of [
    ['maxBytes', maxBytes, 8], ['timeoutMs', timeoutMs, 1], ['concurrency', concurrency, 1], ['matchWindowMs', matchWindowMs, 0],
    ['maxDownloads', maxDownloads, 2], ['budgetMs', budgetMs, 1], ['pairOffset', pairOffset, 0],
  ]) if (!Number.isSafeInteger(value) || value < minimum) throw RangeError(`Invalid ${name}`);
  if (typeof now !== 'function') throw TypeError('Hash budget clock must be a function');
  if (!cache?.get || !cache?.set) throw TypeError('Document digest cache must be Map-like');

  // A displayed/stored cross-exchange row retains its two source observations. Reconstruct them
  // before every comparison so a later third filing can turn an earlier unique pair into an
  // ambiguous cluster without losing either original exchange record.
  const output = expandCrossExchangeObservations(rows);
  const allCandidates = output.map(candidate).filter(Boolean);
  const { candidates, edges } = comparisonCandidates(allCandidates, matchWindowMs);
  // A prior pass may have selected a pair before another same-digest row arrived. Single-source
  // rows are cheap to reconsider; clear their old pairing proof and rebuild it from this full set.
  for (const item of allCandidates) delete output[item.index].crossExchangeDocumentId;

  const pendingByUrl = new Map();
  for (const item of candidates) {
    if (!item.digest && !cache.get(item.url) && !pendingByUrl.has(item.url)) pendingByUrl.set(item.url, item);
  }
  const pending = [...pendingByUrl.values()];
  const offset = pending.length ? pairOffset % pending.length : 0;
  const ordered = [...pending.slice(offset), ...pending.slice(0, offset)];
  const needed = ordered.slice(0, maxDownloads);
  const deferredUrls = new Set(ordered.slice(maxDownloads).map(item => item.url));
  let deferredDownloads = deferredUrls.size;

  let fetched = 0, downloaded = 0, failed = 0;
  const failureReasons = new Map();
  const startedAt = now();
  const budgetDeferredUrls = new Set();
  await mapLimit(needed, concurrency, async item => {
    const remaining = budgetMs - (now() - startedAt);
    if (remaining <= 0) {
      deferredDownloads++;
      budgetDeferredUrls.add(item.url);
      return;
    }
    fetched++;
    const result = boundedPdfDigest(item, { fetcher, maxBytes, timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)) })
      .then(digest => { downloaded++; return { digest }; })
      .catch(error => {
        failed++;
        const reason = String(error?.message || error || 'document-read-failed');
        failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
        return { error: reason };
      });
    cache.set(item.url, result);
    await result;
  });

  let hashed = 0, reused = 0;
  const digests = new Map();
  for (const item of candidates) {
    const result = item.digest ? { digest: item.digest } : await cache.get(item.url);
    const digest = digestValue(result?.digest);
    if (!digest) continue;
    digests.set(item.index, digest);
    if (item.digest) reused++;
    else {
      output[item.index].documentHash = digest;
      hashed++;
    }
  }

  let compared = 0, different = 0, failedPairs = 0;
  const equalPeers = new Map();
  const unresolvedNeighbour = new Set();
  const addPeer = (item, peer) => {
    if (!equalPeers.has(item.index)) equalPeers.set(item.index, new Set());
    equalPeers.get(item.index).add(peer);
  };
  for (const [bse, nse] of edges) {
    const left = digests.get(bse.index), right = digests.get(nse.index);
    if (!left || !right) {
      failedPairs++;
      if (left) unresolvedNeighbour.add(bse.index);
      if (right) unresolvedNeighbour.add(nse.index);
      continue;
    }
    compared++;
    if (left !== right) { different++; continue; }
    addPeer(bse, nse); addPeer(nse, bse);
  }

  let matched = 0;
  const paired = new Set();
  for (const left of candidates.filter(item => item.source === 'BSE')) {
    const peers = equalPeers.get(left.index);
    if (peers?.size !== 1) continue;
    const right = [...peers][0];
    if (equalPeers.get(right.index)?.size !== 1 || unresolvedNeighbour.has(left.index)
      || unresolvedNeighbour.has(right.index) || paired.has(left.index) || paired.has(right.index)) continue;
    const digest = digests.get(left.index);
    const id = pairIdentity(digest, left, right);
    output[left.index].crossExchangeDocumentId = id;
    output[right.index].crossExchangeDocumentId = id;
    const observations = [storedObservation(output[left.index]), storedObservation(output[right.index])];
    output[left.index].crossExchangeObservations = observations;
    output[right.index].crossExchangeObservations = observations;
    paired.add(left.index); paired.add(right.index);
    matched++;
  }
  const ambiguous = [...equalPeers].filter(([index]) => !paired.has(index)).length;
  const allDeferredUrls = new Set([...deferredUrls, ...budgetDeferredUrls]);
  const deferredPairs = edges.filter(([left, right]) => allDeferredUrls.has(left.url) || allDeferredUrls.has(right.url)).length;

  return {
    rows: output,
    eligible: candidates.length,
    candidatePairs: edges.length,
    ambiguous,
    deferredPairs,
    deferredDownloads,
    nextPairOffset: pending.length ? (offset + Math.min(maxDownloads, pending.length)) % pending.length : 0,
    fetched,
    downloaded,
    failed,
    failureReasons: Object.fromEntries([...failureReasons].sort(([a], [b]) => a.localeCompare(b))),
    failedPairs,
    hashed,
    reused,
    compared,
    matched,
    different,
  };
}
