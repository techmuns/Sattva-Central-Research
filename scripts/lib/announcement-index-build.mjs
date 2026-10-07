// THE CORPORATE ANNOUNCEMENTS INDEX BUILD, AS A LIBRARY. `scripts/build-announcement-index.mjs` is the
// runner's command line over it; `scripts/verify-announcement-index.mjs` calls the same functions, so
// what the tests prove about an index is proven about the index the runner publishes.
//
// THE ROWS ARE THE BROWSER'S ROWS. The stream is loaded by the browser's own feed module
// (public/js/data/corporate-announcements.js) over the committed captures, answered offline — the
// same arrangement the alert pool uses — so the merge, the de-duplication across exchanges and the
// company identities are exactly what the tab used to compute on every visit. This build adds four
// readings to each row and nothing else: category tags, a base relevance score, market cap, and the
// event it belongs to. No capture, retention rule or source is changed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { CATEGORY_VERSION } from '../../public/js/data/announcement-categories.js';
import { RELEVANCE_VERSION } from '../../public/js/data/relevance.js';
import { STITCH_VERSION } from '../../public/js/data/event-stitching.js';
import { buildCompanyProfiles } from '../../public/js/data/company-profile.js';
import { captureRevision, captureStamp } from '../../public/js/data/alert-pool-shared.js';
import { INDEX_CONTRACT, INDEX_MEMBER, COMPANIES_MEMBER, UNDATED, packMember, dayFacets } from '../../public/js/data/announcement-index-shared.js';

/** The committed files this index is built from, by the name its status reports them under. */
export const INDEX_CAPTURES = {
  bse: '/data/corp-announcements.json',
  bseArchive: '/data/announcements-archive/index.json',
  companyRecent: '/data/filing-capture/announcements-recent.json',
  companyIndex: '/data/filing-capture/index.json',
  nseHistory: '/data/nse-filings/index.json',
  nseSnapshot: '/data/nse-announcements.json',
  recovery: '/data/screener-announcements.json',
  identities: '/data/announcement-identities.json',
  nseIdentities: '/data/filing-capture/nse-identities.json',
  tickerMap: '/data/mc-ticker-map.json',
  technicals: '/data/technicals.json',
  sectorKpis: '/data/sector-kpis.json',
};

const readJson = (root, path) => { try { return JSON.parse(readFileSync(resolve(root, `.${path}`), 'utf8')); } catch { return null; } };

export function captureIdentities(root) {
  return Object.fromEntries(Object.entries(INDEX_CAPTURES).map(([name, path]) => {
    const body = readJson(root, path);
    return [name, { path, revision: body ? captureRevision(body) : null, capturedAt: body ? captureStamp(body) : null }];
  }));
}

/**
 * A fetch answering every route the feed asks for from the committed files. Company files are
 * requested URL-encoded (`M%26M.json`), so the path is decoded before it is resolved — without that,
 * every ticker with an ampersand reads as missing.
 */
export function offlineFetch(root) {
  const LIVE = { 'api/nse-announcements': 'data/nse-announcements.json' };
  return async (input) => {
    let path = String(input).split('?')[0];
    try { path = decodeURIComponent(path); } catch { /* keep the raw path */ }
    if (/^https?:/.test(path)) return new Response('{}', { status: 503 });
    const target = resolve(root, LIVE[path] || path);
    if (!target.startsWith(root + '/')) return new Response('{}', { status: 403 });
    try { return new Response(readFileSync(target), { headers: { 'content-type': 'application/json' } }); }
    catch { return new Response('{}', { status: 404 }); }
  };
}

/** Load the whole retained stream exactly as the Corporate Announcements tab does. */
export async function loadStream() {
  const { corporateAnnouncements: feed } = await import('../../public/js/data/corporate-announcements.js');
  await feed.load([]);
  await feed.loadArchive();
  return { feed, rows: feed.rows(), meta: feed.meta() };
}

export { buildIndex, buildIndexSteps } from '../../public/js/data/announcement-index-build.js';

/**
 * Write index.json, companies.json.gz and one pack per month — each day its own gzip segment inside
 * the pack, so a reader takes exactly the days it needs with one byte range.
 */
export function writeIndexMembers({ outDir, built, now, meta, captures }) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'packs'), { recursive: true });
  const days = [...built.byDay.keys()].sort((a, b) => (a === UNDATED ? 1 : b === UNDATED ? -1 : b.localeCompare(a)));
  const byPack = new Map();
  for (const day of days) {
    const month = day === UNDATED ? UNDATED : day.slice(0, 7);
    if (!byPack.has(month)) byPack.set(month, []);
    byPack.get(month).push(day);
  }
  const dayEntries = [];
  const packs = [];
  for (const [month, list] of byPack) {
    const parts = [];
    let offset = 0;
    for (const day of list) {
      const rows = built.byDay.get(day);
      const gz = gzipSync(JSON.stringify({ day, rows }), { level: 9 });
      dayEntries.push({ day, rows: rows.length, member: packMember(month), offset, length: gz.length, hash: createHash('sha256').update(gz).digest('hex').slice(0, 32),
        facets: dayFacets(rows, (idx) => built.companies[idx]) });
      parts.push(gz);
      offset += gz.length;
    }
    const bytes = Buffer.concat(parts);
    writeFileSync(join(outDir, packMember(month)), bytes);
    packs.push({ member: packMember(month), month, bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex').slice(0, 32) });
  }
  const companiesGz = gzipSync(JSON.stringify(built.companies), { level: 9 });
  writeFileSync(join(outDir, COMPANIES_MEMBER), companiesGz);
  const dated = dayEntries.filter((d) => d.day !== UNDATED);
  const index = {
    version: 1, contract: INDEX_CONTRACT, builtAt: new Date(now).toISOString(),
    versions: { categories: CATEGORY_VERSION, relevance: RELEVANCE_VERSION, stitching: STITCH_VERSION },
    counts: built.counts,
    range: { from: dated.at(-1)?.day || null, to: dated[0]?.day || null, undated: built.byDay.get(UNDATED)?.length || 0 },
    companies: { member: COMPANIES_MEMBER, count: built.companies.length, bytes: companiesGz.length, hash: createHash('sha256').update(companiesGz).digest('hex').slice(0, 32) },
    dict: { sources: built.dict.sources.list, providers: built.dict.providers.list },
    days: dayEntries, packs, captures, meta,
  };
  writeFileSync(join(outDir, INDEX_MEMBER), JSON.stringify(index));
  return index;
}

/** Every day segment decodes, lies inside its pack, and carries the rows the build produced. */
export function verifyIndexMembers({ outDir, index, built }) {
  const packs = new Map();
  for (const entry of index.days) {
    if (!packs.has(entry.member)) packs.set(entry.member, readFileSync(join(outDir, entry.member)));
    const bytes = packs.get(entry.member).subarray(entry.offset, entry.offset + entry.length);
    assert.equal(bytes.length, entry.length, `${entry.day}: segment lies inside its pack`);
    const segment = JSON.parse(gunzipSync(bytes).toString('utf8'));
    assert.equal(segment.day, entry.day);
    assert.deepEqual(segment.rows, built.byDay.get(entry.day), `${entry.day}: rows round-trip`);
  }
  const companies = JSON.parse(gunzipSync(readFileSync(join(outDir, COMPANIES_MEMBER))).toString('utf8'));
  assert.deepEqual(companies, built.companies);
  assert.equal(index.days.reduce((n, d) => n + d.rows, 0), built.counts.rows, 'every row is in exactly one day segment');
}

export function profilesFrom(root) {
  return buildCompanyProfiles({
    tickerMap: readJson(root, INDEX_CAPTURES.tickerMap), earnings: readJson(root, '/data/earnings-live.json'),
    technicals: readJson(root, INDEX_CAPTURES.technicals), sectorKpis: readJson(root, INDEX_CAPTURES.sectorKpis),
  });
}
