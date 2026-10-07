// A STAND-IN WORKER FOR THE ANNOUNCEMENT ROUTES — the real route handlers and the real store classes,
// behind a plain Node HTTP server that also serves `public/` the way `python3 -m http.server` does.
//
// It exists so the Corporate Announcements, News and All Alerts checks can drive the server path
// end to end — query, event, profiles, AI Read, feedback — with no wrangler, no egress and no second
// copy of the rules. The index is read from a directory the runner's own build wrote; SQLite is
// node:sqlite in memory; the AI Read's document and model calls go to a stub the test supplies.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AnnouncementIndexStore } from '../../worker/announcement-index-store.mjs';
import { RelevanceFeedbackStore } from '../../worker/relevance-feedback-store.mjs';
import { AnnouncementReadStore } from '../../worker/announcement-read-store.mjs';
import { handleAnnouncementIndex } from '../../worker/announcement-index.mjs';
import { handleAnnouncementRead } from '../../worker/announcement-read.mjs';
import { handleRelevanceFeedback } from '../../worker/relevance-feedback.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

export function sqliteStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows, one: () => rows[0] }; } },
    transactionSync: (fn) => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
}

/** A directory-backed artifact source with the same two calls as worker/announcement-index-store.mjs. */
export function directorySource(dir, { id = 1, createdAt = new Date().toISOString(), counter = { reads: 0 } } = {}) {
  return {
    async latest() { return { id, createdAt }; },
    async member(_id, name, range) {
      counter.reads++;
      const bytes = readFileSync(join(dir, name));
      return new Uint8Array(range ? bytes.subarray(range.offset, range.offset + range.length) : bytes);
    },
  };
}

/**
 * @param {object} o
 * @param {string} o.indexDir            the built index (scripts/build-announcement-index.mjs output); null serves no index
 * @param {string} o.publicDir
 * @param {Function} [o.readFetcher]     the AI Read's fetch (documents and the model)
 * @param {Function} [o.now]
 */
export async function startAnnouncementServer({ indexDir = null, publicDir, readFetcher = null, now = Date.now, port = 0, nseLive = 'off' } = {}) {
  const root = resolve(publicDir);
  const readAsset = async (path) => { try { return JSON.parse(readFileSync(join(root, path))); } catch { return null; } };
  const feedback = new RelevanceFeedbackStore(sqliteStorage(), { now });
  const counter = { reads: 0 };
  const index = indexDir
    ? new AnnouncementIndexStore(null, { NSE_LIVE: nseLive }, { source: directorySource(indexDir, { counter }), readAsset, now, model: async () => feedback.model() })
    : null;
  const readEnv = { CLAUDE_KEY: 'ABSKtest-key-not-real', BEDROCK_REGION: 'ap-south-1' };
  const reads = new AnnouncementReadStore(sqliteStorage(), readEnv, { fetcher: readFetcher || (async () => new Response('', { status: 503 })), now });
  const settled = async (work) => {
    try { return await work(); } catch (error) {
      const message = String(error?.message || error);
      return { ok: false, reason: error?.reason || (/^Invalid /.test(message) ? 'invalid-request' : 'index-unavailable'), message };
    }
  };
  const registry = {
    getByName(name) {
      if (name === 'relevance-feedback:v1') return { feedbackApply: async (v) => feedback.apply(v), feedbackModel: async () => feedback.model(), feedbackMine: async (d) => feedback.mine(d) };
      if (name === 'announcement-read:v1') return { announcementRead: (input) => settled(() => reads.read(input)), announcementReadStatus: () => settled(() => reads.status()) };
      if (name === 'announcement-index:v1') {
        if (!index) {
          const none = async () => ({ ok: false, reason: 'index-unavailable', message: 'No announcement index has been published yet.' });
          return { annIndexQuery: none, annIndexEvent: none, annIndexProfiles: none, annIndexStatus: none };
        }
        return {
          annIndexQuery: (input) => settled(() => index.query(input)),
          annIndexEvent: (id, range) => settled(() => index.event(id, range)),
          annIndexProfiles: () => settled(() => index.profiles()),
          annIndexStatus: () => settled(() => index.status()),
        };
      }
      throw new Error(`No stand-in object ${name}`);
    },
  };
  const allow = { limit: async () => ({ success: true }) };
  const env = { CAPTURE_REGISTRY: registry, RELEVANCE_FEEDBACK_LIMITER: allow, ANNOUNCEMENT_READ_LIMITER: allow, ANNOUNCEMENT_INDEX_LIMITER: allow };
  const stats = { queries: 0, reads: 0, votes: 0 };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname.startsWith('/api/announcement-index/') ? handleAnnouncementIndex
      : url.pathname === '/api/announcement-read' || url.pathname === '/api/announcement-read/status' ? handleAnnouncementRead
        : url.pathname.startsWith('/api/relevance/') ? handleRelevanceFeedback : null;
    if (route) {
      if (url.pathname.endsWith('/query')) stats.queries++;
      if (url.pathname === '/api/announcement-read') stats.reads++;
      if (url.pathname === '/api/relevance/feedback') stats.votes++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const response = await route(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    // Everything else exactly as a static origin answers it — including a 404 page for /api/*.
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403); res.end(); return; }
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>404</h1>');
    }
  });
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/`, server, index, feedback, reads, stats, counter, close: () => new Promise((done) => server.close(done)) };
}
