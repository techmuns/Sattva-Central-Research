// data/announcement-query.js — ONE CORPORATE ANNOUNCEMENTS QUERY, PAGE BY PAGE.
//
// The tab asks one question at a time — a period, a scope, categories, a market-cap range, a search
// or one company — and receives one ranked page, the total and the facet counts. The Worker's index
// object answers it (POST /api/announcement-index/query), so the browser no longer downloads and
// merges ~190,000 filings to show a hundred. Where the index cannot be read, the same question is
// answered by the local engine (announcement-query-local.js) over the captures, as the tab always
// could — and the tab says which one answered.
//
// ORDER: newest day first; within a day, by relevance (the base reading plus the desk's shared
// feedback); then by time. Every matching filing stays in the result — ranking moves a filing within
// its day and never removes one.
import { normaliseQuery, PAGE_DEFAULT } from './announcement-index-shared.js';
import * as local from './announcement-query-local.js';
import { currentModel, onChange as onModelChange, loadModel, modelRevision, serverModelRevision } from './relevance-feedback.js';

const SERVER_RETRY_MS = 5 * 60_000;
export const EXPORT_MAX = 25_000;

const sameQuery = (a, b) => JSON.stringify({ ...a, offset: 0, limit: 0 }) === JSON.stringify({ ...b, offset: 0, limit: 0 });

export function createAnnouncementQuery({ pageSize = 200, fetchImpl = (...a) => fetch(...a), engine = local } = {}) {
  let mode = 'unknown'; // 'server' | 'local'
  let serverRetryAt = 0;
  let serverReason = null;
  let query = normaliseQuery({});
  let rows = [], total = null, facets = null, companies = null, index = null, unmatched = [];
  let nextOffset = null;
  let state = 'idle'; // 'loading' | 'more' | 'ready' | 'failed'
  // A quiet re-ask (a poll, a refresh, new filings) keeps the rows and the 'ready' state on screen —
  // no placeholders, no repaint — until its answer lands.
  let refreshing = false;
  let error = null;
  let generation = 0;
  // False once the table that asked has gone (suspend()): preparation in this browser stops then,
  // rather than competing with whatever the reader opened next. The next question resumes it.
  let active = true;
  // A vote or new filings while the table was away: re-ask once, quietly, when it comes back.
  let missed = false;
  const resume = () => {
    if (active) return;
    active = true;
    if (missed && state !== 'idle') { missed = false; queueMicrotask(() => { void run({ append: false, quiet: true }); }); }
  };
  let checkedAt = null;
  let modelSeen = modelRevision();
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* a listener's own failure */ } });

  // A vote anywhere re-orders this list: re-run the first page when the shared model moves.
  onModelChange(() => {
    if (modelRevision() === modelSeen || state === 'idle') return;
    if (!active) { missed = true; return; }
    modelSeen = modelRevision();
    void run({ append: false, quiet: true });
  });
  // In local mode, filings arriving in the captures re-ask the question; preparation progress only
  // repaints. Filings that arrive while a question is being answered are not lost: the answer is
  // asked again as soon as the current one lands.
  let stale = false;
  engine.onChange?.(() => {
    if (mode !== 'local' || state === 'idle') return;
    if (!active) { missed = true; return; }
    if (state === 'ready' && !refreshing) void run({ append: false, quiet: true });
    else stale = true;
  });
  engine.onProgress?.(() => { if (mode === 'local' && state === 'loading') emit(); });

  async function ask(q, keepGoing = () => true) {
    if (mode !== 'local' || Date.now() >= serverRetryAt) {
      try {
        const response = await fetchImpl('api/announcement-index/query', {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ ...q, modelRevision: serverModelRevision() }),
        });
        const isJson = /json/.test(response.headers.get('content-type') || '');
        const body = isJson ? await response.json().catch(() => null) : null;
        if (response.ok && body?.ok) { mode = 'server'; serverReason = null; return body; }
        if (body?.reason === 'invalid-request') throw Object.assign(new Error(body.message || 'The query was refused'), { reason: 'invalid-request' });
        if (body?.reason === 'rate-limited') throw Object.assign(new Error('Too many requests — wait a moment.'), { reason: 'rate-limited' });
        // No index object (a static copy), or no build yet: answer here, and look again later.
        serverReason = body?.reason || (isJson ? `HTTP ${response.status}` : 'no-worker');
      } catch (failure) {
        if (failure?.reason === 'invalid-request' || failure?.reason === 'rate-limited') throw failure;
        serverReason = 'unreachable';
      }
      mode = 'local';
      serverRetryAt = Date.now() + SERVER_RETRY_MS;
    }
    const answer = await engine.query(q, { model: currentModel(), keepGoing: () => active && keepGoing(), prepareWhile: () => active });
    if (!answer && !keepGoing()) throw Object.assign(new Error('Superseded by a newer question'), { reason: 'superseded' });
    if (!answer) throw Object.assign(new Error('The announcements could not be prepared'), { reason: 'local-failed' });
    return answer;
  }

  async function run({ append = false, quiet = false } = {}) {
    const mine = ++generation;
    const q = { ...query, offset: append ? rows.length : 0, limit: append ? pageSize : Math.max(pageSize, quiet ? rows.length : 0) };
    q.limit = Math.min(q.limit, 500);
    if (append) state = 'more';
    else if (!quiet || state !== 'ready') state = 'loading';
    refreshing = quiet && state === 'ready';
    if (!quiet) emit();
    try {
      void loadModel();
      const answer = await ask(q, () => mine === generation);
      if (mine !== generation) return;
      // A re-ask that changed nothing keeps the very same rows, so the table (and the reader's
      // focused search field, scroll position and open lists) is left exactly as it was.
      const next = append ? [...rows, ...answer.rows] : answer.rows;
      if (append || JSON.stringify(next) !== JSON.stringify(rows)) rows = next;
      total = answer.total; facets = answer.facets; companies = answer.companies; index = answer.index;
      unmatched = answer.unmatched || [];
      nextOffset = rows.length < total ? rows.length : null;
      error = null;
      state = 'ready';
      refreshing = false;
      checkedAt = new Date().toISOString();
      modelSeen = modelRevision();
      if (stale && mode === 'local') { stale = false; queueMicrotask(() => { void run({ append: false, quiet: true }); }); }
    } catch (failure) {
      if (mine !== generation) return;
      error = { reason: failure?.reason || 'failed', message: String(failure?.message || failure) };
      state = rows.length ? 'ready' : 'failed';
      refreshing = false;
    }
    emit();
  }

  return {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Replace the question. Returns true when it changed, and the caller should show loading. */
    setQuery(next) {
      resume();
      const q = normaliseQuery({ ...next, offset: 0, limit: pageSize });
      if (sameQuery(q, query) && state !== 'idle') return false;
      query = q;
      rows = []; total = null; nextOffset = null; facets = null;
      state = 'idle';
      return true;
    },
    query: () => query,
    load: () => { resume(); return run({ append: false }); },
    /** The table has gone: stop preparing in this browser (a question asked later resumes it). */
    suspend() { active = false; generation++; },
    /** Re-ask the current question in place (a poll, a refresh): the reader's rows stay until the answer lands. */
    refresh: () => run({ append: false, quiet: true }),
    loadMore() {
      if (state !== 'ready' || nextOffset === null) return Promise.resolve();
      return run({ append: true });
    },
    isLoaded: () => state === 'ready' || state === 'more' || (state === 'failed'),
    rows: () => rows,
    meta: () => ({ mode, serverReason, state, refreshing, error, total, facets, companies, index, unmatched, nextOffset, checkedAt, loaded: rows.length,
      progress: mode === 'local' ? engine.buildProgress?.() : null }),
    async event(id, range = {}) {
      if (mode === 'server') {
        const params = new URLSearchParams({ id, first: range.first || '', last: range.last || '' });
        const response = await fetchImpl(`api/announcement-index/event?${params}`, { headers: { accept: 'application/json' } });
        const body = /json/.test(response.headers.get('content-type') || '') ? await response.json().catch(() => null) : null;
        if (!response.ok || !body?.ok) throw new Error(body?.message || 'The related filings could not be read');
        return body;
      }
      return engine.event(id);
    },
    /** Every matching filing, page by page, up to EXPORT_MAX — for the export, never for the screen. */
    async all(onProgress = () => {}) {
      const out = [];
      let offset = 0;
      for (;;) {
        const answer = await ask({ ...query, offset, limit: 500 });
        out.push(...answer.rows);
        onProgress(out.length, answer.total);
        if (answer.nextOffset === null || out.length >= Math.min(answer.total, EXPORT_MAX)) return { rows: out.slice(0, EXPORT_MAX), total: answer.total };
        offset = answer.nextOffset;
      }
    },
    mode: () => mode,
    pageSize,
    startLive: (live) => engine.startLive?.(live),
    stopLive: (live) => engine.stopLive?.(live),
    PAGE_DEFAULT,
  };
}
