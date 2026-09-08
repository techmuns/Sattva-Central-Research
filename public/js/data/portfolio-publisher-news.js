// Project already-published publisher records into company News immediately. This is a local
// identity join over the same reader used by Universe and All Alerts, never another collection
// job, publisher request, or per-company query. Unmatched originals remain in marketNews.
import * as marketNews from './market-news.js';
import * as coverage from './coverage.js';
import { portfolioNewsEntities } from './company-news-identity.js';
import { matchPortfolioNews } from './portfolio-news-matching.js';
import { dedupeArticles, isoDate } from './filings-shared.js';

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
  now = Date.now } = {}) {
  const listeners = new Set(), wanted = new Map();
  let combined = null, pending = null, archivePending = null, archiveError = null, publisherReadError = null, epoch = 0;
  let identityStamp = null, identities = [];
  const emit = () => listeners.forEach(fn => fn());
  base.onChange(emit);
  publishers.onChange(emit);
  book.onChange(emit);

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

  function rows() {
    const source = base.rows(), published = publishers.rows(), entities = companyIdentities();
    if (combined?.source === source && combined.published === published && combined.entities === entities) return combined.rows;
    const buckets = new Map();
    const add = row => {
      // A stable ticker joins older ticker-only search copies with newer ISIN-backed identities.
      const key = row.ticker || row.entityId || row.company;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    };
    // Head/body-backed publisher matches are preferred over an older uncertain search copy at
    // the same company URL; dedupe never crosses companies or publisher domains.
    for (const row of published) for (const match of matchPortfolioNews(row, entities)) add({
      ...match, source: row.source || row.publisher || null, date: publisherNewsDate(row),
      discoverySource: 'published-publisher-feed', publisherSourceRecord: row,
    });
    source.forEach(add);
    const value = [...buckets.values()].flatMap(dedupeArticles)
      .sort((a, b) => String(b.publishedAt || b.date || '').localeCompare(String(a.publishedAt || a.date || '')));
    combined = { source, published, entities, rows: value,
      publisherCount: value.filter(row => row.discoverySource === 'published-publisher-feed').length };
    return value;
  }

  function loadArchive() {
    if (archivePending) return archivePending;
    const generation = epoch;
    archivePending = (async () => {
      try {
        while (publishers.archiveMeta().remaining) {
          const before = publishers.archiveMeta().remaining;
          const result = await publishers.loadMore();
          if (generation !== epoch) return false;
          if (result.failed || publishers.archiveMeta().remaining >= before) throw Error('Publisher history could not be completely read.');
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
      // Publish the bounded head first, independently of company search and monthly history.
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
    const m = base.meta(), p = publishers.meta(), archive = publishers.archiveMeta();
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

  return { ...base, rows, meta,
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
    wasAskedEmpty: ticker => !rows().some(r => String(r.ticker || r.entityId || '').toUpperCase() === String(ticker).toUpperCase()) && base.wasAskedEmpty(ticker),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    invalidate() { epoch++; base.invalidate(); combined = null; pending = null; archivePending = null; archiveError = null; publisherReadError = null;
      wanted.clear(); identityStamp = null; identities = []; },
  };
}
