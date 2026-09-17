// Project already-published publisher records into company News immediately. This is a local
// identity join over the same reader used by Universe and All Alerts, never another collection
// job, publisher request, or per-company query. Unmatched originals remain in marketNews.
import * as marketNews from './market-news.js';
import * as coverage from './coverage.js';
import { portfolioNewsEntities } from './company-news-identity.js';
import { matchPortfolioNews } from './portfolio-news-matching.js';
import { dedupeArticles, isoDate } from './filings-shared.js';
import { inNewsWindow } from './news-window.js';
import { holdsTicker } from './row-ticker-index.js';
import { runSteps, runStepsInSlices } from '../core/slices.js';

const indianDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
/** An explicit publisher calendar date wins; only an instant fallback needs timezone conversion. */
export function publisherNewsDate(row = {}) {
  const date = isoDate(row.date);
  const midnight = date && Date.parse(`${date}T00:00:00Z`);
  if (Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === date) return date;
  const instant = row.publishedAt && Date.parse(row.publishedAt);
  if (!Number.isFinite(instant)) return null;
  const parts = Object.fromEntries(indianDay.formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function withPortfolioPublisherNews(base, { publishers = marketNews, book = coverage,
  now = Date.now, window: readingWindow = () => null, include = () => true } = {}) {
  const listeners = new Set(), wanted = new Map();
  let combined = null, pending = null, archivePending = null, archiveError = null, publisherReadError = null, epoch = 0;
  let identityStamp = null, identities = [];
  const emit = () => listeners.forEach(fn => fn());
  const yieldToInput = () => typeof window === 'undefined' ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 0));
  async function warmPublished(yieldForInput = yieldToInput) {
    const published = publishers.rows(), entities = companyIdentities(), window = readingWindow();
    let started = performance.now();
    for (const row of published) {
      if (inNewsWindow(row, window) && include(row)) matchPortfolioNews(row, entities);
      if (performance.now() - started >= 12) { await yieldForInput(); started = performance.now(); }
    }
  }
  // A publisher change is announced after its stories' matches are warm, in slices, so the first
  // `rows()` a listener makes pays for the join rather than for every new story's match. Rows are
  // always current when read; only the announcement waits for the warm-up.
  const announcePublishers = () => { warmPublished().then(() => prepareRows()).catch(() => {}).then(emit); };
  // A source announcement moves this counter; a sliced rebuild in flight checks it between slices
  // instead of asking the readers beneath for their rows, which can itself be a cold rebuild.
  let sourceRevision = 0;
  // A base or book change is announced after the join is prepared in slices too, so the first
  // synchronous read after any announcement finds it ready. Rows are current whenever read.
  const announcePrepared = () => { prepareRows().catch(() => {}).then(emit); };
  const offBase = base.onChange(() => { sourceRevision++; announcePrepared(); }),
    offPublishers = publishers.onChange(() => { sourceRevision++; announcePublishers(); }),
    offBook = book.onChange(() => { sourceRevision++; announcePrepared(); });

  function companyIdentities() {
    const holdings = book.holdings();
    const signature = JSON.stringify([holdings.map(h => [h.isin, h.ticker, h.name, h.bookName]), [...wanted.values()]]);
    if (signature === identityStamp) return identities;
    // Current holdings win over a ticker-only picker identity. Scope remains a consumer decision;
    // leaving the portfolio must not erase historical publisher records from Universe.
    const current = portfolioNewsEntities(holdings), tickers = new Set(current.map(e => e.ticker).filter(Boolean));
    identities = [...current, ...[...wanted.values()].filter(e => !tickers.has(e.ticker) && !current.some(c => c.entityId === e.entityId))];
    identityStamp = signature;
    return identities;
  }

  // THE PROJECTED ROW IS BUILT ONCE PER (MATCH, PUBLISHER ROW). `matchPortfolioNews` already
  // returns the same decorated object for the same story and identity, but this projection spread
  // it into a fresh object on every rebuild — and the reader rebuilds whenever the publisher
  // capture or the company head moves. Every cache downstream is keyed on the row object
  // (attribution, story reading, canonical address, publication day), so a fresh object per
  // rebuild made all of them miss for every projected story at once: the whole history was
  // re-read on a switch from AI Alerts to All Alerts. Both inputs are immutable, so the pair is
  // the key and the projected row is exactly the same value it was.
  const projected = new WeakMap();
  const projection = (match, row) => {
    const hit = projected.get(match);
    if (hit && hit.row === row) return hit.value;
    const value = { ...match, source: row.source || row.publisher || null, date: publisherNewsDate(row),
      discoverySource: 'published-publisher-feed', publisherSourceRecord: row };
    projected.set(match, { row, value });
    return value;
  };
  // The join is one generator, driven synchronously by `rows()` or in ~12ms slices by
  // `prepareRows()` before a publisher announcement reaches a consumer. Same rows, same order.
  const newestFirst = (a, b) => a === b ? 0 : a.length === b.length ? (b > a ? 1 : -1) : b.localeCompare(a);
  function* buildRows(source, published, entities, window) {
    const buckets = new Map();
    const add = row => {
      // A stable ticker joins older ticker-only search copies with newer ISIN-backed identities.
      const key = row.ticker || row.entityId || row.company;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    };
    // Head/body-backed publisher matches are preferred over an older uncertain search copy at
    // the same company URL; dedupe never crosses companies or publisher domains.
    let counted = 0;
    for (const row of published) {
      if (inNewsWindow(row, window) && include(row)) for (const match of matchPortfolioNews(row, entities)) add(projection(match, row));
      if (++counted % 512 === 0) yield;
    }
    source.filter(row => inNewsWindow(row, window)).forEach(add);
    const value = [];
    for (const list of buckets.values()) {
      for (const row of dedupeArticles(list)) value.push(row);
      yield;
    }
    const stamp = row => String(row.publishedAt || row.date || '');
    value.sort((a, b) => newestFirst(stamp(a), stamp(b)));
    return value;
  }
  const install = (source, published, entities, windowKey, value) => {
    combined = { source, published, entities, windowKey, rows: value,
      publisherCount: value.filter(row => row.discoverySource === 'published-publisher-feed').length };
  };
  function rows() {
    const source = base.rows(), published = publishers.rows(), entities = companyIdentities();
    const window = readingWindow(), windowKey = JSON.stringify(window);
    if (combined?.source === source && combined.published === published && combined.entities === entities && combined.windowKey === windowKey) return combined.rows;
    const value = runSteps(buildRows(source, published, entities, window));
    install(source, published, entities, windowKey, value);
    return value;
  }
  // One preparation in flight: a second caller shares it rather than driving a second rebuild.
  let preparing = null;
  function prepareRows(yieldForInput = yieldToInput) {
    if (!preparing) preparing = prepareOnce(yieldForInput).finally(() => { preparing = null; });
    return preparing;
  }
  // A build the source churn abandoned is tried again against the newer state, a few times: a
  // preparation that gives up during a cold load leaves the next synchronous read to rebuild
  // the join in one task, which is exactly what it exists to prevent.
  async function prepareOnce(yieldForInput) {
    for (let attempt = 0; attempt < 4; attempt++) {
      // The reader beneath attributes every held row on its first read after a change; warm that
      // in slices before asking it for rows, so this preparation never pays for it in one task.
      await base.warm?.(yieldForInput);
      await base.prepareRows?.(yieldForInput);
      const at = sourceRevision, generation = epoch;
      const source = base.rows(), published = publishers.rows(), entities = companyIdentities();
      const window = readingWindow(), windowKey = JSON.stringify(window);
      const ready = () => combined?.source === source && combined.published === published && combined.entities === entities && combined.windowKey === windowKey;
      if (ready()) return;
      const current = () => sourceRevision === at && epoch === generation && JSON.stringify(readingWindow()) === windowKey;
      const value = await runStepsInSlices(buildRows(source, published, entities, window), { yieldForInput, keepGoing: current });
      if (value && current() && !ready()) install(source, published, entities, windowKey, value);
      if (value || epoch !== generation) return;
    }
  }

  function loadArchive() {
    if (archivePending) return archivePending;
    const generation = epoch;
    archivePending = (async () => {
      try {
        const window = readingWindow();
        while (publishers.archiveMeta(window).remaining) {
          const before = publishers.archiveMeta(window).remaining;
          const result = await publishers.loadMore(window);
          if (generation !== epoch) return false;
          if (result.failed || publishers.archiveMeta(window).remaining >= before) throw Error('Publisher history could not be completely read.');
        }
        archiveError = null;
        return true;
      } catch {
        if (generation === epoch) archiveError = 'Some publisher history could not be read. Previously loaded stories remain visible.';
        return false;
      }
    })().finally(() => { if (generation === epoch) { archivePending = null; emit(); } });
    return archivePending;
  }

  function checkPublishers({ refresh = false } = {}) {
    if (pending) return pending;
    const generation = epoch;
    pending = (async () => {
      const outcome = refresh && publishers.isLoaded() ? await publishers.refresh() : await publishers.load();
      if (generation !== epoch) return { available: false };
      publisherReadError = publishers.meta().lastReadFailed ? 'Publisher capture could not be revalidated.' : null;
      // Publish the bounded head first, independently of company search and monthly history —
      // with its join built in slices, so the announcement does not cost a consumer one task.
      try { await prepareRows(yieldToInput); } catch { /* The synchronous read still answers. */ }
      if (generation !== epoch) return { available: false };
      emit();
      const history = await loadArchive();
      return { available: !publishers.meta().lastReadFailed, changed: !!outcome?.changed,
        partial: !history || !!publishers.meta().lastReadFailed };
    })().catch(() => {
      if (generation === epoch) publisherReadError = 'Publisher capture could not be revalidated.';
      return { available: false, partial: true };
    })
      .finally(() => { if (generation === epoch) { pending = null; emit(); } });
    return pending;
  }

  function meta() {
    const m = base.meta(), p = publishers.meta(), archive = publishers.archiveMeta(readingWindow());
    const required = ['moneycontrol', 'business-standard', 'mint', 'economic-times', 'investing'];
    const badSource = required.some(id => !p.sources?.some(s => s.id === id)) || p.sources.some(s => !s.ok ||
      !Number.isInteger(s.feeds) || s.feeds < (s.id === 'moneycontrol' ? 1 : 3) ||
      (s.id !== 'moneycontrol' || s.feedsOk != null) && (!Number.isInteger(s.feedsOk) || s.feedsOk !== s.feeds) || !Number.isFinite(Date.parse(s.capturedAt)) ||
      Date.parse(s.capturedAt) > now() + 600000 || now() - Date.parse(s.capturedAt) > 2 * 3600000);
    const failed = p.lastReadFailed || !!publisherReadError || !!archiveError || (p.loaded && badSource);
    const publisherStatus = failed ? (p.count ? 'partial' : 'unavailable') : !p.loaded ? 'pending' : 'ok';
    return { ...m, rowCount: rows().length,
      newsDelivery: { ...m.newsDelivery, publishers: {
        status: publisherStatus, pending: !!pending, error: publisherReadError || (p.lastReadFailed ? 'Publisher capture could not be revalidated.' : null) || archiveError ||
          (p.loaded && badSource ? 'Some publisher feeds are stale or incomplete.' : null),
        capturedAt: p.capturedAt, checkedAt: p.sources?.length && p.sources.every(s => Number.isFinite(Date.parse(s.capturedAt)))
          ? new Date(Math.min(...p.sources.map(s => Date.parse(s.capturedAt)))).toISOString() : null,
        readerCheckedAt: p.checkedAt, sources: p.sources,
        historyPending: !!archivePending || archive.remaining > 0, historyError: archiveError,
        matchedRows: combined?.publisherCount || 0,
      } },
    };
  }

  return { ...base, rows, meta, prepareRows,
    // Warm the readings `rows()` will hit — the company head below, then each published story's
    // portfolio match — in ~12ms slices, so the synchronous rebuild pays only for the join.
    async warm(yieldForInput = () => Promise.resolve()) {
      await base.warm?.(yieldForInput);
      await warmPublished(yieldForInput);
      await prepareRows(yieldForInput);
    },
    setWanted(items = []) {
      for (const item of items) if (item && typeof item === 'object') {
        const entity = item.entityId ? item : portfolioNewsEntities([item])[0];
        if (entity) wanted.set(entity.ticker || entity.entityId, entity);
      }
      return base.setWanted(items);
    },
    async seed(...args) { await Promise.all([base.seed(...args), checkPublishers()]); },
    async load(items = [], ...args) {
      this.setWanted(items);
      await Promise.all([base.load(items, ...args), checkPublishers()]);
    },
    async refreshSnapshot(...args) {
      const [core, extra] = await Promise.all([base.refreshSnapshot(...args), checkPublishers({ refresh: true })]);
      return { ...core, available: core.available || extra.available, changed: !!core.changed || !!extra.changed,
        partial: !!core.partial || !core.available || !!extra.partial };
    },
    async refresh(...args) {
      const [core, extra] = await Promise.all([base.refresh(...args), checkPublishers({ refresh: true })]);
      return { ...core, partial: !!core.partial || !!extra.partial };
    },
    forTicker: ticker => rows().filter(r => String(r.ticker || r.entityId || '').toUpperCase() === String(ticker).toUpperCase()),
    // Set membership, not a scan: see js/data/row-ticker-index.js. `base.wasAskedEmpty` still
    // decides whether the company was actually checked — this only answers whether we hold a row.
    wasAskedEmpty: ticker => !holdsTicker(rows(), ticker) && base.wasAskedEmpty(ticker),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    invalidate() { epoch++; base.invalidate(); combined = null; pending = null; archivePending = null; archiveError = null; publisherReadError = null;
      wanted.clear(); identityStamp = null; identities = []; },
    dispose() { epoch++; offBase(); offPublishers(); offBook(); listeners.clear(); combined = null;
      base.dispose?.(); },
  };
}
