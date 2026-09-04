// One read-only stream over the existing BSE/company captures and live NSE feed.
import { announcements } from './filings.js';
import * as nseFilings from './nse-filings.js';
import { announcementUrl, mergeAnnouncements } from './announcements-shared.js';
import { createAnnouncementIdentity, filingTicker, mergeExchangeIdentities } from './announcement-identity.js';
import { capturedJson } from './company-captures.js';
import { filterByScope } from './scope.js';
import * as watchlist from '../core/watchlist.js';

export const LIVE_ID = 'corporate-announcements';
export const POLL_MS = 90_000;

export function nseAnnouncement(row) {
  const time = Date.parse(row.publishedAt || '');
  const ist = Number.isFinite(time) ? new Date(time + 19800000).toISOString() : null;
  return { ...row, title: row.subject || row.description || null, summary: row.description || null,
    date: ist?.slice(0, 10) || null, time: ist?.slice(11, 19) || null,
    url: announcementUrl(row.url), source: 'NSE', sources: ['NSE'], providers: ['NSE announcements RSS'] };
}

export function createCorporateAnnouncementsFeed({ base = announcements, nse = nseFilings,
  readIdentities = () => capturedJson('data/announcement-identities.json'),
  readNseIdentities = () => capturedJson('data/filing-capture/nse-identities.json') } = {}) {
  let pending = null, historyPending = null, held = [], nseError = null;
  let identity = createAnnouncementIdentity(), identityError = null, identityRevision = null;
  let bseIdentities = [], nseIdentityError = null;
  const nseDirectories = { sme: [], equity: [] };
  async function loadBseIdentities() {
    try {
      const { value, stale } = await readIdentities();
      if (value?.version !== 1 || !Array.isArray(value.entries) || !Number.isFinite(Date.parse(value.capturedAt))) throw new Error('Exchange company identities could not be read.');
      if (identityRevision !== value.capturedAt) {
        bseIdentities = value.entries;
        identityRevision = value.capturedAt;
      }
      identityError = stale ? 'Using saved exchange company identities.' : null;
    } catch (error) { identityError = error.message; }
  }
  async function loadNseIdentities() {
    try {
      const { value, stale } = await readNseIdentities();
      if (value?.version !== 1 || !value.directories) throw new Error('NSE company identities could not be read.');
      nseIdentityError = stale ? 'Using saved NSE company identities.' : null;
      for (const kind of ['sme', 'equity']) {
        const directory = value.directories[kind];
        if (Array.isArray(directory?.entries)) nseDirectories[kind] = directory.entries;
        if (!Array.isArray(directory?.entries) || directory.error) nseIdentityError = 'Some NSE company identities could not be checked; verified mappings are retained.';
      }
    } catch (error) { nseIdentityError = error.message; }
  }
  async function loadIdentities() {
    await Promise.all([loadBseIdentities(), loadNseIdentities()]);
    identity = createAnnouncementIdentity(mergeExchangeIdentities(bseIdentities, nseDirectories.sme, nseDirectories.equity));
  }
  const listeners = new Set();
  const rows = () => {
    held = mergeAnnouncements(held.map(identity.row), base.rows().map(identity.row), nse.retainedRows().map(nseAnnouncement).map(identity.row));
    return held;
  };
  const emit = () => listeners.forEach((fn) => fn());
  function loadHistory() {
    if (historyPending) return historyPending;
    historyPending = Promise.allSettled([
      base.loadArchive({ onlyChanged: true }),
      nse.loadHistory(90, { updateWindow: false }),
    ]).finally(() => { historyPending = null; emit(); });
    return historyPending;
  }
  function read(initial, items) {
    if (pending) return pending;
    pending = (async () => {
      const before = rows().length;
      const results = await Promise.allSettled([
        initial ? base.load(items) : base.refreshSnapshot(),
        initial ? nse.load() : nse.refresh(),
        loadIdentities(),
      ]);
      nseError = results[1].status === 'rejected' ? results[1].reason.message : null;
      emit(); // Latest announcements appear before older files finish loading.
      // A slow historical download must never hold up the next live-source check.
      void loadHistory();
      return { added: Math.max(0, rows().length - before), failed: nseError ? 1 : 0 };
    })().finally(() => { pending = null; emit(); });
    return pending;
  }
  return {
    ...base, rows,
    forTicker: (ticker) => {
      const wanted = identity.key({ ticker: filingTicker(ticker) });
      return wanted ? rows().filter(row => identity.key(row) === wanted) : [];
    },
    filterByScope(list, scope, holdings) {
      if (scope === 'universe') return filterByScope(list, scope, holdings);
      const companies = scope === 'portfolio' ? holdings : watchlist.all();
      const wanted = new Set(companies.map(identity.key).filter(Boolean));
      return list.filter(row => wanted.has(identity.key(row)));
    },
    meta() {
      const m = base.meta(), list = rows();
      return { ...m, rowCount: list.length, covered: new Set(list.map((row) => row.ticker).filter(Boolean)).size,
        reason: list.length ? null : m.reason, identity: { capturedAt: identityRevision, error: identityError || nseIdentityError },
        nse: { ...nse.meta(), error: nseError } };
    },
    load: (items) => read(true, items),
    loadArchive: loadHistory,
    refresh: () => read(false),
    onChange(fn) {
      listeners.add(fn);
      const offBase = base.onChange(fn), offNse = nse.onChange(fn);
      return () => { listeners.delete(fn); offBase(); offNse(); };
    },
    startLive(live) {
      live.register(LIVE_ID, { intervalMs: POLL_MS, fetcher: () => read(false) });
      live.start(LIVE_ID, { fresh: true });
    },
    stopLive: (live) => live.stop(LIVE_ID),
  };
}

export const corporateAnnouncements = createCorporateAnnouncementsFeed();
