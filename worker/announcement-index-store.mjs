// THE CORPORATE ANNOUNCEMENTS INDEX OBJECT — one fixed object (announcement-index:v1) on the provisioned
// CaptureRegistry class that answers the tab's filtered, ranked, paginated queries.
//
// WHY AN OBJECT AND NOT THE ROUTE. The public Worker runs on a CPU budget measured in milliseconds
// (worker/breakouts.mjs measured a 3 MB parse exceeding it). Decoding a month of filings, scanning
// it and ranking it is real work, and a Durable Object has the budget for it and a memory that lasts
// between requests — so the decoded days stay warm and the next reader's query costs a scan, not a
// download. The route in front of it only validates and caches.
//
// WHERE THE DATA COMES FROM. The runner's build (scripts/build-announcement-index.mjs) publishes one
// Actions artifact per build: index.json, the company table, and one pack per month holding each day
// as its own gzip segment. This object reads them by byte range (worker/artifact-reader.mjs), checks
// for a newer build at most once a minute, and keeps decoded days in a bounded LRU keyed by each
// segment's own hash — so a new build costs only the days that actually changed.
//
// FRESHER THAN THE LAST BUILD. NSE's live announcements feed is read here too, at most every two
// minutes, the same way /api/nse-announcements reads it; a live filing whose document the index does
// not already hold is tagged, scored and placed into its day — the tab is never behind the exchange
// by a build's latency. Live rows join no stitched event until the next build stitches them.
//
// A FAILED READ IS NEVER AN EMPTY RESULT. No index at all is `index-unavailable` and the browser
// falls back to reading the captures itself, exactly as it did before this object existed. A failed
// re-check keeps serving the build already held, labelled stale with its reason.
import {
  INDEX_CONTRACT, INDEX_ARTIFACT, INDEX_WORKFLOW, INDEX_MEMBER, UNDATED, ROW, normaliseQuery, queryKey, periodRange, createSelection,
  displayRow, encodeRow, haystackOf, dayFacets, BAND_ORDER,
} from '../public/js/data/announcement-index-shared.js';
import { ANNOUNCEMENT_CATEGORIES } from '../public/js/data/announcement-categories.js';
import { MCAP_BANDS, MCAP_UNKNOWN } from '../public/js/data/company-profile.js';
import { createAnnouncementIdentity, mergeExchangeIdentities } from '../public/js/data/announcement-identity.js';
import { announcementDocumentIdentity, nseAnnouncement } from '../public/js/data/announcements-shared.js';
import { categoriesOf } from '../public/js/data/announcement-categories.js';
import { relevanceReading } from '../public/js/data/relevance.js';
import { EMPTY_MODEL } from '../public/js/data/relevance-feedback-shared.js';
import { latestArtifact, readDirectory, memberBytes, gunzip } from './artifact-reader.mjs';
import { FEED_URL as NSE_FEED_URL, HEADERS as NSE_HEADERS, parseAnnouncements, assertShape, buildResolver, resolveAll } from './nse-ann.mjs';

export const ANNOUNCEMENT_INDEX_OBJECT = 'announcement-index:v1';
export const CHECK_MS = 60_000;
export const QUERY_TTL_MS = 120_000;
export const LIVE_MS = 120_000;
export const IDENTITY_MS = 10 * 60_000;
export const MODEL_MS = 30_000;
// Decoded days held between requests, estimated from the decoded JSON size. A month of the
// exchange-wide stream decodes to roughly 40-60 MB, so the most recent weeks stay warm.
export const SEGMENT_BUDGET = 48 * 1024 * 1024;
const QUERY_CACHE = 24;

/** The artifact, read by byte range. Tests pass a directory-backed source with the same four calls. */
export function artifactSource(env, { fetcher = fetch } = {}) {
  const cfg = { repo: env.GH_REPO, token: env.GH_DISPATCH_TOKEN, fetchImpl: fetcher, label: 'announcement index' };
  let directory = null;
  const dir = async (id) => {
    if (directory?.artifactId !== id) directory = await readDirectory(id, { ...cfg, signal: AbortSignal.timeout(20000) });
    return directory;
  };
  return {
    async latest() { return latestArtifact({ ...cfg, workflow: INDEX_WORKFLOW, artifact: INDEX_ARTIFACT, signal: AbortSignal.timeout(20000) }); },
    async member(id, name, range = null) {
      const d = await dir(id);
      return memberBytes(d, name, { ...cfg, signal: AbortSignal.timeout(25000) }, range || {});
    },
  };
}

const text = (bytes) => new TextDecoder().decode(bytes);

// Which queries the stored per-day counts can answer: no text, no scope list, no single company, at
// most one category, and a size filter that is a whole band (or none, or "not available").
const BAND_IDS = new Set(MCAP_BANDS.map((b) => b.id));
export function skippable(q, entries) {
  return !q.q && q.scope === 'universe' && !q.company && q.categories.length <= 1
    && (q.mcap === 'all' || q.mcap === MCAP_UNKNOWN || BAND_IDS.has(q.mcap)) && entries.every((e) => e.facets);
}
function allowedBands(mcap) {
  if (mcap === 'all') return BAND_ORDER.map((_, i) => i);
  return [BAND_ORDER.indexOf(mcap)].filter((i) => i >= 0);
}
const isGzip = (bytes) => bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b;

export class AnnouncementIndexStore {
  constructor(storage, env = {}, { source = null, fetcher = (...a) => fetch(...a), now = Date.now, readAsset = null, model = null } = {}) {
    this.storage = storage;
    this.env = env;
    this.fetcher = fetcher;
    this.now = now;
    this.source = source || artifactSource(env, { fetcher });
    this.readAsset = readAsset || (async (path) => {
      const response = await env.ASSETS.fetch(new Request(new URL(path, 'https://assets.local')));
      return response.ok ? response.json() : null;
    });
    this.readModel = model || (async () => {
      if (!env.CAPTURE_REGISTRY) return EMPTY_MODEL;
      return env.CAPTURE_REGISTRY.getByName('relevance-feedback:v1').feedbackModel();
    });
    this.current = null; this.checkedAt = 0; this.checkError = null; this.loading = null;
    this.segments = new Map(); this.segmentBytes = 0;
    this.queries = new Map();
    this.identity = null; this.identityAt = 0;
    this.live = { at: 0, rows: [], error: null, pending: null };
    this.modelCache = { at: 0, value: EMPTY_MODEL };
  }

  // ---- the build ------------------------------------------------------------------------------

  async ensureCurrent() {
    if (this.current && this.now() - this.checkedAt < CHECK_MS) return this.current;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const latest = await this.source.latest();
        if (!latest) throw Object.assign(new Error('No announcement index has been published yet.'), { reason: 'index-unavailable' });
        if (this.current?.id !== latest.id) {
          const raw = await this.source.member(latest.id, INDEX_MEMBER);
          const index = JSON.parse(text(isGzip(raw) ? await gunzip(raw) : raw));
          if (index?.contract !== INDEX_CONTRACT || index.version !== 1 || !Array.isArray(index.days)) throw new Error('The published announcement index has an unfamiliar contract');
          const companies = JSON.parse(text(await gunzip(await this.source.member(latest.id, index.companies.member))));
          if (!Array.isArray(companies)) throw new Error('The announcement index company table is unreadable');
          const byKey = new Map(companies.map((c, i) => [c.k, i]));
          this.current = { id: latest.id, createdAt: latest.createdAt, index, companies, byKey, overlay: [], overlayByKey: new Map(),
            dict: { sources: index.dict.sources, providers: index.dict.providers }, days: new Map(index.days.map((d) => [d.day, d])) };
          this.queries.clear();
          this.live.at = 0;
        }
        this.checkedAt = this.now();
        this.checkError = null;
        return this.current;
      } catch (error) {
        this.checkError = error.message;
        this.checkedAt = this.now();
        if (this.current) return this.current;
        throw Object.assign(error, { reason: error.reason || 'index-unavailable' });
      } finally { this.loading = null; }
    })();
    return this.loading;
  }

  /**
   * Visit the decoded days for these entries, in the order given, reading each pack with one byte
   * range per run of consecutive uncached days. Decoded days go into the LRU on the way past, so a
   * whole-history scan stays inside the memory budget: nothing here holds every day at once.
   */
  async forEachSegment(entries, visit) {
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      const hit = this.segments.get(entry.hash);
      if (hit) { this.segments.delete(entry.hash); this.segments.set(entry.hash, hit); visit(hit); i++; continue; }
      const run = [entry];
      let end = entry.offset + entry.length;
      while (i + run.length < entries.length) {
        const next = entries[i + run.length];
        if (next.member !== entry.member || next.offset !== end || this.segments.has(next.hash) || end - entry.offset > 8 * 1024 * 1024) break;
        run.push(next);
        end = next.offset + next.length;
      }
      const bytes = await this.source.member(this.current.id, entry.member, { offset: entry.offset, length: end - entry.offset });
      for (const e of run) {
        const json = text(await gunzip(bytes.subarray(e.offset - entry.offset, e.offset - entry.offset + e.length)));
        const segment = JSON.parse(json);
        if (segment.day !== e.day || !Array.isArray(segment.rows)) throw new Error(`Announcement index segment ${e.day} is unreadable`);
        // A decoded day costs more heap than its JSON text; 2.5 bytes per character is a conservative
        // estimate, and the budget is far below an isolate's memory so the object is never reset.
        const held = { day: e.day, rows: segment.rows, hay: null, docs: null, bytes: Math.round(json.length * 2.5) };
        this.remember(e.hash, held);
        visit(held);
      }
      i += run.length;
    }
  }

  async segmentsFor(entries) {
    const out = [];
    await this.forEachSegment(entries, (segment) => out.push(segment));
    return out;
  }

  // Eviction drops the OLDEST days first, not the least recently used: a whole-history scan touches
  // every day newest-first, and plain LRU would then evict exactly the recent days nearly every query
  // reads. Recent days stay warm; old months are decoded again when a long query reaches them.
  remember(hash, segment) {
    this.segments.set(hash, segment);
    this.segmentBytes += segment.bytes;
    if (this.segmentBytes <= SEGMENT_BUDGET) return;
    const oldest = [...this.segments.entries()].sort((a, b) => (a[1].day === UNDATED ? -1 : b[1].day === UNDATED ? 1 : a[1].day.localeCompare(b[1].day)));
    for (const [key, held] of oldest) {
      if (this.segmentBytes <= SEGMENT_BUDGET * 0.85 || this.segments.size <= 2) break;
      if (key === hash) continue;
      this.segments.delete(key);
      this.segmentBytes -= held.bytes;
    }
  }

  // ---- identity and scope ------------------------------------------------------------------------

  async identityFor() {
    if (this.identity && this.now() - this.identityAt < IDENTITY_MS) return this.identity;
    try {
      const [bse, nse] = await Promise.all([this.readAsset('/data/announcement-identities.json'), this.readAsset('/data/filing-capture/nse-identities.json')]);
      const entries = mergeExchangeIdentities(Array.isArray(bse?.entries) ? bse.entries : [], nse?.directories?.sme?.entries || [], nse?.directories?.equity?.entries || []);
      this.identity = createAnnouncementIdentity(entries);
      this.identityAt = this.now();
    } catch (error) {
      if (!this.identity) this.identity = createAnnouncementIdentity([]);
    }
    return this.identity;
  }

  /** Company-table positions for the caller's companies, and the ones the index holds no filing for. */
  async resolve(entries) {
    const identity = await this.identityFor();
    const found = new Set(), unmatched = [];
    for (const entry of entries) {
      const company = { ticker: entry.ticker, isin: entry.isin, bseCode: entry.bseCode, scripCode: entry.bseCode, name: entry.name, company: entry.name };
      const key = identity.key(company);
      const idx = key == null ? undefined : this.companyIndexOf(key);
      if (idx === undefined) unmatched.push(entry.ticker || entry.isin || entry.bseCode);
      else found.add(idx);
    }
    return { found, unmatched };
  }
  companyIndexOf(key) {
    const c = this.current;
    if (c.byKey.has(key)) return c.byKey.get(key);
    if (c.overlayByKey.has(key)) return c.overlayByKey.get(key);
    return undefined;
  }
  companyAt(idx) {
    const c = this.current;
    return idx < c.companies.length ? c.companies[idx] : c.overlay[idx - c.companies.length];
  }

  // ---- live NSE ---------------------------------------------------------------------------------

  async refreshLive(todayEntries) {
    if (this.now() - this.live.at < LIVE_MS) return;
    if (this.live.pending) return this.live.pending;
    this.live.pending = (async () => {
      try {
        const response = await this.fetcher(NSE_FEED_URL, { headers: NSE_HEADERS, signal: AbortSignal.timeout(12000) });
        const xml = await response.text();
        if (!response.ok) throw new Error(`NSE HTTP ${response.status}`);
        assertShape(xml, { status: response.status });
        const [mc, tech, book] = await Promise.all([this.readAsset('/data/mc-ticker-map.json'), this.readAsset('/data/technicals.json'), this.readAsset('/data/portfolio-companies.json')]);
        const resolver = buildResolver({ book: book?.holdings || [], mcMap: mc?.map || {}, tech: tech?.rows || tech?.companies || [] });
        const identity = await this.identityFor();
        const held = new Set();
        for (const segment of await this.segmentsFor(todayEntries)) {
          if (!segment.docs) segment.docs = new Set(segment.rows.map((r) => r[ROW.DOC]).filter(Boolean));
          for (const doc of segment.docs) held.add(doc);
        }
        const dict = { sources: { list: this.current.dict.sources, index: new Map(this.current.dict.sources.map((v, i) => [JSON.stringify(v), i])) },
          providers: { list: this.current.dict.providers, index: new Map(this.current.dict.providers.map((v, i) => [JSON.stringify(v), i])) } };
        const rows = [];
        for (const raw of resolveAll(parseAnnouncements(xml), resolver)) {
          const row = identity.row(nseAnnouncement(raw));
          const doc = announcementDocumentIdentity(row.url) || '';
          if (!row.date || (doc && held.has(doc))) continue;
          const key = identity.key(row) || (row.company ? `name:${row.company.toUpperCase()}` : null);
          let idx = key == null ? -1 : this.companyIndexOf(key);
          if (idx === undefined) {
            idx = this.current.companies.length + this.current.overlay.length;
            this.current.overlay.push({ k: key, t: row.ticker || null, i: row.isin || null, s: row.scripCode || null, n: row.company || null, m: null, b: 'unknown', g: null });
            this.current.overlayByKey.set(key, idx);
          }
          const company = idx >= 0 ? this.companyAt(idx) : {};
          const tags = categoriesOf(row, 'filing');
          const reading = relevanceReading(row, { kind: 'filing', profile: { mcapCr: company.m, band: company.b, group: company.g }, categories: tags.ids, weakCategories: tags.weak });
          const facts = reading.facts;
          rows.push({ day: row.date, row: encodeRow({ id: `live:${doc || row.url || `${key}|${row.date}|${row.time}|${row.title}`}`, time: row.time, title: row.title, subCategory: '', category: '',
            sources: row.sources, url: row.url, extraUrls: [], categories: tags.ids, weak: tags.weak, base: reading.base, impact: facts.impact, direction: facts.direction,
            prospective: facts.prospective, processUpdate: facts.processUpdate, providers: row.providers, summary: row.summary ? String(row.summary).slice(0, 400) : '', doc, company: row.company || '' },
          { companyIdx: idx, dict }) });
        }
        this.current.dict = { sources: dict.sources.list, providers: dict.providers.list };
        this.live = { at: this.now(), rows, error: null, pending: null };
      } catch (error) {
        this.live = { ...this.live, at: this.now(), error: String(error?.message || error), pending: null };
      }
      this.queries.clear();
    })();
    return this.live.pending;
  }

  // ---- the query --------------------------------------------------------------------------------

  // A reader that has just voted names the model revision it already holds; a cached model older than
  // that is re-read at once, so the vote re-orders the list now rather than when the cache expires.
  async model(wanted = null) {
    const fresh = this.now() - this.modelCache.at < MODEL_MS;
    if (fresh && (!wanted || wanted === this.modelCache.value?.revision)) return this.modelCache.value;
    try {
      const value = await this.readModel();
      this.modelCache = { at: this.now(), value: value && value.version ? value : EMPTY_MODEL };
    } catch { this.modelCache = { at: this.now(), value: this.modelCache.value || EMPTY_MODEL }; }
    return this.modelCache.value;
  }

  async query(input = {}) {
    const q = normaliseQuery(input);
    const wantedModel = /^fb\d+-[0-9a-f]{1,8}-\d{1,7}$/.test(String(input.modelRevision || '')) ? input.modelRevision : null;
    const current = await this.ensureCurrent();
    const range = periodRange(q.period, this.now());
    const entries = current.index.days.filter((d) => (d.day === UNDATED ? range.undated : range.dated && d.day >= range.from && d.day <= range.to));
    const todayEntries = entries.filter((d) => d.day === range.to || d.day === current.index.range?.to);
    if (range.dated && todayEntries.length && this.env.NSE_LIVE !== 'off') await this.refreshLive(todayEntries);
    const model = await this.model(wantedModel);
    if (skippable(q, entries)) {
      const answer = await this.skipQuery(q, entries, range, model);
      if (answer) return answer;
    }
    const scope = q.scope === 'universe' ? null : await this.resolve(q.companies);
    const pick = q.company ? await this.resolve([q.company]) : null;
    const key = `${current.id}|${this.live.at}|${model.revision || ''}|${queryKey(q, scope ? [...scope.found] : null)}|${pick ? [...pick.found].join(',') : ''}`;
    const table = this.companyTable();
    const want = (position) => position >= q.offset && position < q.offset + q.limit;
    const display = (row, day, score) => displayRow(row, day, { companies: table, dict: this.current.dict, score: Math.round(score * 100) / 100 });
    let selection = this.queries.get(key);
    let rows = [];
    if (!selection || this.now() - selection.at > QUERY_TTL_MS) {
      const liveByDay = new Map();
      for (const { day, row } of this.live.rows) {
        if (day === UNDATED ? !range.undated : !(range.dated && day >= range.from && day <= range.to)) continue;
        if (!liveByDay.has(day)) liveByDay.set(day, []);
        liveByDay.get(day).push(row);
      }
      // A live day the build does not have yet (the build ran before midnight) is a day of its own.
      const ordered = [...entries];
      for (const day of liveByDay.keys()) if (!current.days.has(day)) ordered.push({ day, live: true });
      ordered.sort((a, b) => (a.day === UNDATED ? 1 : b.day === UNDATED ? -1 : b.day.localeCompare(a.day)));
      const page = new Map();
      const accumulator = createSelection(q, {
        companyAt: (idx) => this.companyAt(idx), wantedCompanies: scope?.found || null, companyFilter: pick?.found || null, model,
        haystack: (row, company, segment, i) => {
          if (!segment.hay) segment.hay = new Array(segment.rows.length);
          return segment.hay[i] ??= haystackOf(row, company);
        },
        onSelected: (day, i, position, score, row) => { if (want(position)) page.set(position, display(row, day, score)); },
      });
      const withLive = (segment) => {
        const extra = liveByDay.get(segment.day);
        return extra?.length ? { day: segment.day, rows: [...segment.rows, ...extra], hay: null } : segment;
      };
      // Live-only days are newer than anything the build holds, so they come first; the stored days
      // follow newest first (undated last), read pack by pack in contiguous runs.
      for (const entry of ordered) if (entry.live) accumulator.add({ day: entry.day, rows: liveByDay.get(entry.day), hay: null });
      await this.forEachSegment(ordered.filter((e) => !e.live), (segment) => accumulator.add(withLive(segment)));
      selection = { at: this.now(), ...accumulator.result(), liveByDay };
      this.queries.set(key, selection);
      while (this.queries.size > QUERY_CACHE) this.queries.delete(this.queries.keys().next().value);
      rows = [...page.keys()].sort((a, b) => a - b).map((position) => page.get(position));
    } else {
      // A later page of a query already ranked: decode only the days it reaches.
      const slice = selection.selected.slice(q.offset, q.offset + q.limit);
      const days = new Set(slice.map(([day]) => day));
      const decoded = new Map();
      await this.forEachSegment(entries.filter((e) => days.has(e.day)), (segment) => decoded.set(segment.day, segment));
      rows = slice.map(([day, i, score]) => {
        const base = decoded.get(day);
        const extra = selection.liveByDay.get(day) || [];
        const row = base && i < base.rows.length ? base.rows[i] : extra[i - (base?.rows.length || 0)];
        return row ? display(row, day, score) : null;
      }).filter(Boolean);
    }
    return {
      ok: true, rows, total: selection.total, companies: selection.companies, facets: selection.facets,
      offset: q.offset, limit: q.limit, nextOffset: q.offset + rows.length < selection.total ? q.offset + rows.length : null,
      unmatched: scope?.unmatched?.slice(0, 200) || [],
      index: this.describe(),
    };
  }

  liveFor(range, current) {
    const liveByDay = new Map();
    for (const { day, row } of this.live.rows) {
      if (day === UNDATED ? !range.undated : !(range.dated && day >= range.from && day <= range.to)) continue;
      if (!liveByDay.has(day)) liveByDay.set(day, []);
      liveByDay.get(day).push(row);
    }
    const ordered = [];
    for (const day of liveByDay.keys()) if (!current.days.has(day)) ordered.push({ day, live: true });
    return { liveByDay, liveOnly: ordered };
  }

  /**
   * THE DEFAULT VIEW, WITHOUT READING THE WHOLE HISTORY. An unfiltered query — or one narrowed only
   * to one category and one size band — takes every day's row count from the facet counts the build
   * wrote (dayFacets), skips the days before the page without decoding them, and decodes only the days
   * the page shows. The answer is identical to the full scan's; a day whose decoded count disagrees
   * with its stored count sends the query down the full scan instead (returns null).
   */
  async skipQuery(q, entries, range, model) {
    const current = this.current;
    const { liveByDay, liveOnly } = this.liveFor(range, current);
    const liveFacets = new Map([...liveByDay].map(([day, rows]) => [day, dayFacets(rows, (idx) => this.companyAt(idx))]));
    const ordered = [...liveOnly, ...entries].sort((a, b) => (a.day === UNDATED ? 1 : b.day === UNDATED ? -1 : b.day.localeCompare(a.day)));
    const bands = allowedBands(q.mcap);
    const cat = q.categories[0] || '*';
    const at = (facets, key, b) => facets?.[key]?.[b] || 0;
    const both = (e, key, b) => at(e.facets, key, b) + at(liveFacets.get(e.day), key, b);
    const dayCount = (e) => bands.reduce((n, b) => n + both(e, cat, b), 0);
    let total = 0;
    const categoryFacet = Object.fromEntries(ANNOUNCEMENT_CATEGORIES.map((c) => [c.id, 0]));
    const bandFacet = Object.fromEntries(BAND_ORDER.map((b) => [b, 0]));
    const counts = new Map();
    for (const e of ordered) {
      const n = dayCount(e);
      counts.set(e.day, n);
      total += n;
      for (const c of ANNOUNCEMENT_CATEGORIES) for (const b of bands) categoryFacet[c.id] += both(e, c.id, b);
      BAND_ORDER.forEach((band, b) => { bandFacet[band] += both(e, cat, b); });
    }
    const wanted = [];
    let position = 0;
    for (const e of ordered) {
      const n = counts.get(e.day);
      if (!n) continue;
      if (position >= q.offset + q.limit) break;
      if (position + n > q.offset) wanted.push({ entry: e, start: position });
      position += n;
    }
    const table = this.companyTable();
    const page = [];
    let consistent = true;
    const take = (segment, start) => {
      const extra = liveByDay.get(segment.day);
      const rows = extra?.length ? (segment.live ? extra : [...segment.rows, ...extra]) : segment.rows;
      const selection = createSelection(q, { companyAt: (idx) => this.companyAt(idx), model });
      selection.add({ day: segment.day, rows, hay: null });
      const { selected } = selection.result();
      if (selected.length !== counts.get(segment.day)) { consistent = false; return; }
      selected.forEach(([day, i, score], k) => {
        const position = start + k;
        if (position >= q.offset && position < q.offset + q.limit) {
          page.push(displayRow(rows[i], day, { companies: table, dict: current.dict, score: Math.round(score * 100) / 100 }));
        }
      });
    };
    const starts = new Map(wanted.map((w) => [w.entry.day, w.start]));
    for (const w of wanted) if (w.entry.live) take({ day: w.entry.day, rows: [], live: true }, w.start);
    await this.forEachSegment(wanted.filter((w) => !w.entry.live).map((w) => w.entry), (segment) => take(segment, starts.get(segment.day)));
    if (!consistent) return null;
    return {
      ok: true, rows: page, total, companies: null, facets: { categories: categoryFacet, bands: bandFacet },
      offset: q.offset, limit: q.limit, nextOffset: q.offset + page.length < total ? q.offset + page.length : null,
      unmatched: [], index: this.describe(),
    };
  }

  companyTable() {
    const c = this.current;
    return new Proxy(c.companies, { get: (target, prop) => {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return this.companyAt(Number(prop));
      return target[prop];
    } });
  }

  /** Every filing in one stitched event, oldest first, read from the days the event spans. */
  async event(eventId, { first = null, last = null } = {}) {
    if (!/^ev:[a-z0-9]{2,40}$/.test(String(eventId || ''))) throw Object.assign(new Error('Invalid event id'), { reason: 'invalid-request' });
    const current = await this.ensureCurrent();
    const lo = /^\d{4}-\d{2}-\d{2}$/.test(first || '') ? first : null, hi = /^\d{4}-\d{2}-\d{2}$/.test(last || '') ? last : null;
    const entries = current.index.days.filter((d) => d.day !== UNDATED && (!lo || d.day >= lo) && (!hi || d.day <= hi));
    if (!lo || !hi || entries.length > 400) throw Object.assign(new Error('An event needs its first and last day'), { reason: 'invalid-request' });
    const members = [];
    for (const segment of await this.segmentsFor(entries)) {
      for (const row of segment.rows) if (row[ROW.EVENT] === eventId) members.push(displayRow(row, segment.day, { companies: this.companyTable(), dict: current.dict }));
    }
    members.sort((a, b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`));
    return { ok: true, id: eventId, members, index: this.describe() };
  }

  /**
   * Market cap, size band and sector group per company — the ranking inputs News and All Alerts need
   * for rows the index does not hold. Positional: [ticker, bseCode, isin, mcapCr, band, group].
   * Only companies with something to say are listed; an absent company reads as size unknown.
   */
  async profiles() {
    const current = await this.ensureCurrent();
    const rows = [];
    for (const c of current.companies) {
      if (!(c.t || c.s || c.i) || (!Number.isFinite(c.m) && !c.g)) continue;
      rows.push([c.t || null, c.s || null, c.i || null, Number.isFinite(c.m) ? c.m : null, c.b || 'unknown', c.g || null]);
    }
    return { ok: true, version: 1, fields: ['ticker', 'bseCode', 'isin', 'mcapCr', 'band', 'group'], rows,
      builtAt: current.index.builtAt, mcapAsOf: current.index.meta?.profiles || null };
  }

  describe() {
    const c = this.current;
    if (!c) return null;
    return { artifact: c.id, builtAt: c.index.builtAt, createdAt: c.createdAt, counts: c.index.counts, range: c.index.range, versions: c.index.versions,
      stale: !!this.checkError, error: this.checkError, live: { at: this.live.at ? new Date(this.live.at).toISOString() : null, rows: this.live.rows.length, error: this.live.error },
      meta: c.index.meta || null, captures: c.index.captures || null };
  }

  async status() {
    try { await this.ensureCurrent(); } catch (error) { return { ok: false, reason: error.reason || 'index-unavailable', message: error.message }; }
    return { ok: true, index: this.describe(), segmentsHeld: this.segments.size, segmentBytes: this.segmentBytes, queriesHeld: this.queries.size };
  }
}
