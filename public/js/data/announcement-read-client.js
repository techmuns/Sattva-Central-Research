// One requested document, one browser flight. Keep the shared read alive across popup closures.
import { announcementDocumentIdentity } from './announcements-shared.js';
import { READ_VERSION } from './announcement-read-shared.js';

const cache = new Map(), inflight = new Map();
const RESPONSE_BYTES = 128 * 1024;
const EXCHANGES = new Set(['bseindia.com', 'www.bseindia.com', 'nsearchives.nseindia.com', 'archives.nseindia.com']);
const unavailable = () => ({ state: 'failed', reason: 'read-unavailable' });

function keyFor(row) {
  for (const value of [row.url, ...(row.sourceUrls || []).map((s) => typeof s === 'string' ? s : s?.url)]) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !EXCHANGES.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) continue;
      url.hash = '';
      return `${READ_VERSION}:${announcementDocumentIdentity(url.href) || url.href}`;
    } catch { /* unusable source */ }
  }
  return `${READ_VERSION}:${row.id}:${row.url || ''}`;
}

async function consume(response, progress) {
  if (!/application\/x-ndjson/i.test(response.headers.get('content-type') || '')) {
    if (!/json/i.test(response.headers.get('content-type') || '')) return unavailable();
    const body = await response.json().catch(() => null);
    return body?.ok ? body : { state: 'failed', reason: body?.reason || 'upstream' };
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return unavailable(); // EOF without a validated result is a failed read.
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_BYTES) return unavailable();
      buffer += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'result') return event.ok ? event : { state: 'failed', reason: event.reason || 'read-unavailable' };
        if (event.type === 'progress') progress(event);
      }
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Related history is optional context. It never delays opening a saved or new reading. */
export async function requestAnnouncementRead(row, related = [], onProgress = null) {
  const key = keyFor(row);
  if (cache.has(key)) return cache.get(key);
  if (!inflight.has(key)) {
    const job = { listeners: new Set(), progress: null };
    const publish = (value) => { job.progress = value; for (const listener of job.listeners) listener(value); };
    job.promise = (async () => {
      let read;
      try {
        const response = await fetch('api/announcement-read', {
          method: 'POST', signal: AbortSignal.timeout(95_000),
          headers: { 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
          body: JSON.stringify({ id: row.id, url: row.url, sourceUrls: row.sourceUrls, title: row.title, company: row.company,
            ticker: row.ticker, date: row.date, time: row.time, category: row.category, subCategory: row.subCategory, summary: row.summary,
            categories: row.categories, mcapCr: row.mcapCr, sector: row.group,
            related: related.filter((m) => m.id !== row.id).map((m) => ({ date: m.date, title: m.title, source: (m.sources || [])[0] || null })) }),
        });
        read = await consume(response, publish);
      } catch { read = unavailable(); }
      if (read.state === 'ready' || (read.state === 'failed' && !read.retryAt && read.reason !== 'read-unavailable')) cache.set(key, read);
      return read;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  const job = inflight.get(key);
  if (onProgress) { job.listeners.add(onProgress); if (job.progress) onProgress(job.progress); }
  try { return await job.promise; }
  finally { if (onProgress) job.listeners.delete(onProgress); }
}
