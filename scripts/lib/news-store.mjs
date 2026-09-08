// scripts/lib/news-store.mjs — the market-news capture on disk, shared by every scraper that
// contributes to it.
//
// TWO FILES, AND THE SPLIT IS THE WHOLE DESIGN.
//
//   public/data/market-news.json          the HEAD — the newest N stories, and the only file a
//                                         visitor downloads on arrival. Bounded, ~400 KB, and
//                                         revalidated with a 304 on every later visit.
//   public/data/market-news/<YYYY-MM>.json the ARCHIVE — one shard per month, holding every story
//                                         ever captured for it. Fetched only by a reader who has
//                                         scrolled to the end of the head.
//
// This used to be one file trimmed to 600 stories, which meant every run DELETED whatever had
// fallen past the six-hundredth — about thirteen days of history, unrecoverably, because a
// publisher's own listing only reaches back so far. A bounded first paint and unbounded history
// stop being in tension once they are separate files.
//
// WHY IT IS SHARED. Several scrapers write here — the Moneycontrol listing walk and the RSS reader
// today — and each must MERGE into what is already committed rather than replace it. A scraper
// that wrote only its own publisher's stories would delete every other publisher's on each run,
// which is the same discard this module exists to end, arrived at from a different direction.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { readNewsJson, writeNewsJson } from './news-json-storage.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const HEAD_FILE = resolve(__dirname, '../../public/data/market-news.json');
export const ARCHIVE_DIR = resolve(__dirname, '../../public/data/market-news');
const SHARD = /^(\d{4}-\d{2})\.json$/;

/** A Moneycontrol id is the bare article number; every other publisher's is `<feed>:<url>`. */
export const isMcId = (id) => /^\d+$/.test(String(id || ''));

export const keyOf = (a) => String(a?.id || a?.url || '');

/**
 * Newest first.
 *
 * The publisher's own time where there is one. Where there is not — Moneycontrol stories whose
 * per-article date budget was not reached — the id, which is approximately monotonic in publication
 * order for that one publisher. The browser sorts the same list far more carefully (see
 * `sortRows` in public/js/data/market-news.js, which anchors an undated story to its dated
 * neighbours); this ordering only has to be stable and roughly right, because all it decides is
 * which stories land in the head.
 */
export const byNewest = (a, b) => {
  const at = Date.parse(a?.publishedAt || '');
  const bt = Date.parse(b?.publishedAt || '');
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
  if (isMcId(a?.id) && isMcId(b?.id)) return Number(b.id) - Number(a.id);
  if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(bt) ? 1 : -1;
  return String(b?.publishedAt || b?.firstSeenAt || '').localeCompare(String(a?.publishedAt || a?.firstSeenAt || ''));
};

/**
 * Which shard a story is filed under.
 *
 * The publisher's own date wherever they gave one, and otherwise when this dashboard first saw the
 * story. That fallback is a fact about US, so the shard says so in its own provenance rather than
 * letting a reader take every date in it as the publisher's — and it is only ever used to decide
 * which FILE a story lives in. The story's own `publishedAt` stays null and still renders as
 * "time not published".
 */
export const monthOf = (a) => {
  const d = String(a?.publishedAt || a?.firstSeenAt || '');
  return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : null;
};

export function loadHead() {
  if (!existsSync(HEAD_FILE)) return { articles: [], newestId: null, capturedAt: null, sources: [] };
  try {
    const prev = readNewsJson(HEAD_FILE);
    return {
      articles: Array.isArray(prev.articles) ? prev.articles : [],
      newestId: prev.newestId || null,
      capturedAt: prev.capturedAt || null,
      sources: Array.isArray(prev.sources) ? prev.sources : [],
    };
  } catch {
    throw new Error('Existing market-news head could not be read; refusing to overwrite it');
  }
}

export function readShard(month) {
  const f = resolve(ARCHIVE_DIR, `${month}.json`);
  if (!existsSync(f)) return [];
  try {
    const j = readNewsJson(f);
    return Array.isArray(j.articles) ? j.articles : [];
  } catch {
    // A shard that cannot be parsed is NOT treated as an empty month. Returning [] here would let
    // this run rewrite the file with only the stories it happens to be holding, which is exactly
    // the discard this module exists to stop. Fail loudly instead.
    throw new Error(`archive shard ${month}.json exists but could not be parsed — refusing to overwrite it`);
  }
}

/** Every story on disk, head and archive together. The repair path and the merge both need it. */
export function loadEverything() {
  const head = loadHead();
  const all = new Map(head.articles.map((a) => [keyOf(a), a]));
  for (const m of shardMonths()) {
    for (const a of readShard(m)) {
      const k = keyOf(a);
      if (!all.has(k)) all.set(k, a);
    }
  }
  return { head, all };
}

export const shardMonths = () =>
  (existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR) : [])
    .map((f) => SHARD.exec(f))
    .filter(Boolean)
    .map((m) => m[1])
    .sort((a, b) => b.localeCompare(a));

function writeShard(month, list) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const rows = [...list].sort(byNewest);
  const dates = rows.map((a) => a.publishedAt || a.firstSeenAt).filter(Boolean).sort();
  writeNewsJson(
    resolve(ARCHIVE_DIR, `${month}.json`),
    {
      _provenance:
        'One month of market-wide news, as each publisher published it. Headlines, standfirsts and section names are theirs, ' +
        'reproduced unchanged; the article stays on their site. A story is filed under this month by the publisher\'s own date ' +
        'where they gave one, and otherwise by the date this dashboard first saw it — so a story with `publishedAt: null` may sit ' +
        'one month later than it was published. Its own time is never invented: it stays null and renders as "time not published".',
      generator: 'scripts/lib/news-store.mjs',
      month,
      articleCount: rows.length,
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
      articles: rows,
    },
  );
}

/**
 * The manifest the browser walks to scroll past the head, newest month first.
 *
 * Read off the DIRECTORY rather than accumulated in memory, so a shard written by an earlier run —
 * or restored by hand — is listed by the next run without anything having to remember it.
 *
 * `inHead` is how much of the month the head already carries, counted here because this is the only
 * place holding both sets. Without it the browser cannot tell a month it already has in full from
 * one it has never seen, and a reader's first scroll to the end would download every shard to
 * discover it had learned nothing. On a young archive the head is a window onto every month there
 * is, so that is 400 KB to add zero stories.
 */
export function archiveManifest(headKeys = new Set()) {
  return shardMonths().map((month) => {
    const j = readNewsJson(resolve(ARCHIVE_DIR, `${month}.json`));
    const rows = Array.isArray(j.articles) ? j.articles : [];
    return {
      month,
      file: `market-news/${month}.json`,
      count: rows.length,
      inHead: rows.reduce((n, a) => n + (headKeys.has(keyOf(a)) ? 1 : 0), 0),
      from: j.from || null,
      to: j.to || null,
    };
  });
}

/**
 * Merge this run's stories into the capture and write both files.
 *
 * `sources` describes only the publishers THIS run read. Entries for publishers it did not touch
 * are carried forward from the committed file rather than dropped — otherwise the RSS job would
 * erase Moneycontrol's provenance every twenty minutes and the Moneycontrol job would erase the
 * four RSS publishers', and the reader would be told the feed has one source whichever ran last.
 */
export function commit({ articles, capturedAt, head = 600, sources = [], extra = {} }) {
  const merged = new Map(articles.map((a) => [keyOf(a), a]));
  const all = [...merged.values()].sort(byNewest);

  // FILE EVERY STORY BEFORE TRIMMING ANYTHING. The head is a window onto this, not the set of
  // stories that survive — a story leaving the head has already been written to its month.
  const touched = new Map();
  let undatable = 0;
  for (const a of all) {
    const m = monthOf(a);
    if (!m) { undatable += 1; continue; }
    if (!touched.has(m)) touched.set(m, new Map(readShard(m).map((x) => [keyOf(x), x])));
    touched.get(m).set(keyOf(a), a);
  }
  for (const [month, rows] of touched) writeShard(month, [...rows.values()]);

  const kept = all.slice(0, head);
  const withDate = kept.filter((a) => a.publishedAt).length;
  const archive = archiveManifest(new Set(kept.map(keyOf)));
  const archived = archive.reduce((n, s) => n + s.count, 0);

  const prior = loadHead().sources || [];
  const ids = new Set(sources.map((s) => s.id));
  const allSources = [...sources, ...prior.filter((s) => !ids.has(s.id))].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const payload = {
    _provenance:
      'Market-wide news from several publishers, each read from their own feed. Headlines, standfirsts and section names are theirs, ' +
      'reproduced unchanged; the article stays on their site and every row links to it and names who published it. Nothing here is ' +
      'summarised, scored or ranked by this dashboard.',
    generator: 'scripts/lib/news-store.mjs',
    capturedAt,
    // Per publisher: when they were last read, and whether that read worked. A publisher refusing
    // us is a different fact from a publisher with nothing new, and both are different from a
    // publisher we have not read at all — so all three are recorded rather than inferred from a count.
    sources: allSources,
    // The newest MONEYCONTROL id specifically, because that is what their top-up walk stops at.
    // The newest story overall is usually somebody else's and would stop that walk immediately.
    newestId: all.find((a) => isMcId(a.id))?.id || null,
    articleCount: kept.length,
    withPublishedAt: withDate,
    withoutPublishedAt: kept.length - withDate,
    keep: head,
    archive,
    archivedCount: archived,
    ...extra,
    articles: kept,
  };
  writeNewsJson(HEAD_FILE, payload);
  return { kept, all, archive, archived, withDate, undatable, payload };
}
