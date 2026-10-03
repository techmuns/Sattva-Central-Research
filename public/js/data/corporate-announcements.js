// One read-only stream over the existing BSE/company captures and live NSE feed.
import { announcements } from './filings.js';
import * as nseFilings from './nse-filings.js';
import { mergeAnnouncements, nseAnnouncement } from './announcements-shared.js';
import { createAnnouncementIdentity, filingTicker, mergeExchangeIdentities } from './announcement-identity.js';
import { capturedJson } from './company-captures.js';
import { filterByScope } from './scope.js';
import * as watchlist from '../core/watchlist.js';

export const LIVE_ID = 'corporate-announcements';
export const POLL_MS = 90_000;

export { nseAnnouncement };

export function createCorporateAnnouncementsFeed({ base = announcements, nse = nseFilings,
  readIdentities = () => capturedJson('data/announcement-identities.json'),
  readNseIdentities = () => capturedJson('data/filing-capture/nse-identities.json') } = {}) {
  let pending = null, historyPending = null, held = [], nseError = null;
  let identity = createAnnouncementIdentity(), identityError = null, identityRevision = null;
  let bseIdentities = [], nseIdentityError = null;
  let identityKey = '', rowInputs = null, heldText = '';
  let identityGeneration = 0;
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
    const entries = mergeExchangeIdentities(bseIdentities, nseDirectories.sme, nseDirectories.equity);
    const nextKey = JSON.stringify(entries);
    if (nextKey !== identityKey) { identity = createAnnouncementIdentity(entries); identityKey = nextKey; identityGeneration++; }
  }
  const listeners = new Set();
  let cachedBase = { input: null, output: null, identity: null };
  let cachedNse = { input: null, output: null, identity: null };
  let cachedHeld = { input: null, output: null, identity: null };

  const rows = () => {
    const baseRows = base.rows(), nseRows = nse.retainedRows();
    if (rowInputs?.identity === identity && rowInputs.base === baseRows && rowInputs.nse === nseRows) return held;

    if (cachedBase.input !== baseRows || cachedBase.identity !== identity) {
      cachedBase.input = baseRows;
      cachedBase.identity = identity;
      cachedBase.output = baseRows.map(identity.row);
    }
    if (cachedNse.input !== nseRows || cachedNse.identity !== identity) {
      cachedNse.input = nseRows;
      cachedNse.identity = identity;
      cachedNse.output = nseRows.map(nseAnnouncement).map(identity.row);
    }

    // In a partial-feed loop, a newly-built nseRows array can contain the same objects as before.
    // If neither base nor NSE changed their actual object references, the merge is identical.
    if (rowInputs?.base && rowInputs?.base.length === baseRows.length && rowInputs?.base.every((r, i) => r === baseRows[i]) &&
        rowInputs?.nse && rowInputs?.nse.length === nseRows.length && rowInputs?.nse.every((r, i) => r === nseRows[i]) &&
        rowInputs?.identity === identity) {
      rowInputs = { base: baseRows, nse: nseRows, identity };
      return held;
    }

    if (cachedHeld.input !== held || cachedHeld.identity !== identity) {
      cachedHeld.input = held;
      cachedHeld.identity = identity;
      cachedHeld.output = held.map(identity.row);
    }
    const next = mergeAnnouncements(cachedHeld.output, cachedBase.output, cachedNse.output);
    // A successful response can replace objects without changing any filing.
    // Compare once per source arrival; ordinary rows/meta reads keep the fast
    // reference path above and unchanged responses keep the reader's controls.
    const nextText = JSON.stringify(next);
    if (nextText !== heldText) { held = next; heldText = nextText; }
    rowInputs = { base: baseRows, nse: nseRows, identity };
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
    companyKey: company => identity.key(company),
    companyIdentity: company => ({ ...company, ...identity.find(company) }),
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
        reason: list.length ? null : m.reason, identity: { capturedAt: identityRevision, revision: identityGeneration, error: identityError || nseIdentityError },
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
