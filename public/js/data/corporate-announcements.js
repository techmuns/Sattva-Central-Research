// One read-only stream over the existing BSE/company captures and live NSE feed.
import { announcements } from './filings.js';
import * as nseFilings from './nse-filings.js';
import { announcementUrl, mergeAnnouncementSteps } from './announcements-shared.js';
import { createAnnouncementIdentity, filingTicker, mergeExchangeIdentities } from './announcement-identity.js';
import { capturedJson } from './company-captures.js';
import { filterByScope } from './scope.js';
import * as watchlist from '../core/watchlist.js';
import { runSteps, runStepsInSlices, yieldToInput } from '../core/slices.js';

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
  let identityKey = '', rowInputs = null, heldText = [];
  let preparingRows = null;
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

  const inputs = () => ({ base: base.rows(), nse: nse.retainedRows(), identity, held });
  const sameArray = (a, b) => a === b || !!a && a.length === b.length && a.every((row, i) => row === b[i]);
  const sameInputs = (a, b) => !!a && a.identity === b.identity && sameArray(a.base, b.base) && sameArray(a.nse, b.nse);
  function* mappedRows(input, cached, map, currentIdentity) {
    if (sameArray(cached.input, input) && cached.identity === currentIdentity) return cached;
    const output = [];
    for (const row of input) {
      output.push(map(row));
      if (output.length % 128 === 0) yield;
    }
    return { input, output, identity: currentIdentity };
  }
  function* buildRows(input) {
    // A synchronous reader can advance held while an earlier rebuild yields.
    // Keep that earlier observation ahead of the newer snapshot in the merge.
    const prior = input.prior
      ? (yield* mappedRows(input.prior, { input: null }, input.identity.row, input.identity)).output : [];
    const fromBase = yield* mappedRows(input.base, cachedBase, input.identity.row, input.identity);
    const fromNse = yield* mappedRows(input.nse, cachedNse, row => input.identity.row(nseAnnouncement(row)), input.identity);
    const fromHeld = yield* mappedRows(input.held, cachedHeld, input.identity.row, input.identity);
    const next = yield* mergeAnnouncementSteps(prior, fromHeld.output, fromBase.output, fromNse.output);
    // Compare identical bytes one row at a time. A whole-history stringify itself blocks
    // input and duplicates the complete payload; per-row checks can yield between batches.
    const text = [];
    let changed = next.length !== input.held.length;
    for (let i = 0; i < next.length; i++) {
      text.push(JSON.stringify(next[i]));
      if (text[i] !== heldText[i]) changed = true;
      if ((i + 1) % 128 === 0) yield;
    }
    return { next, text, changed, fromBase, fromNse, fromHeld };
  }
  function adopt(input, result) {
    cachedBase = result.fromBase; cachedNse = result.fromNse; cachedHeld = result.fromHeld;
    if (result.changed) { held = result.next; heldText = result.text; }
    rowInputs = { base: input.base, nse: input.nse, identity: input.identity };
    return held;
  }
  const rows = () => {
    const input = inputs();
    if (sameInputs(rowInputs, input)) return held;
    return adopt(input, runSteps(buildRows(input)));
  };
  async function prepareRows(yieldForInput = yieldToInput, { sliceMs } = {}) {
    // The underlying retained BSE stream has its own sliced merge; warm that first.
    await base.warm?.(yieldForInput);
    if (preparingRows) return preparingRows;
    preparingRows = (async () => {
      let prior = null;
      for (;;) {
        const input = { ...inputs(), prior };
        if (!prior && sameInputs(rowInputs, input)) return held;
        const result = await runStepsInSlices(buildRows(input), { yieldForInput, sliceMs });
        // Retain every fully observed snapshot, even if the source rolled over during a yield.
        // Notify readers only after the latest inputs (including identity corrections) are ready.
        if (held === input.held) {
          adopt(input, result);
          prior = null;
          if (sameInputs(input, inputs())) return held;
        } else {
          // Merge this older observation with the synchronous reader's newer answer next;
          // neither may overwrite the other or disappear because a snapshot was replaced.
          prior = result.next;
        }
      }
    })().finally(() => { preparingRows = null; });
    return preparingRows;
  }
  const emit = () => listeners.forEach((fn) => fn());
  function loadHistory() {
    if (historyPending) return historyPending;
    historyPending = Promise.allSettled([
      base.loadArchive({ onlyChanged: true }),
      nse.loadHistory(90, { updateWindow: false }),
    ]).finally(async () => {
      try { await prepareRows(); } finally { historyPending = null; emit(); }
    });
    return historyPending;
  }
  function read(initial, items) {
    if (pending) return pending;
    pending = (async () => {
      const before = (await prepareRows()).length;
      const results = await Promise.allSettled([
        initial ? base.load(items) : base.refreshSnapshot(),
        initial ? nse.load() : nse.refresh(),
        loadIdentities(),
      ]);
      nseError = results[1].status === 'rejected' ? results[1].reason.message : null;
      await prepareRows();
      emit(); // Latest announcements appear before older files finish loading.
      // A slow historical download must never hold up the next live-source check.
      void loadHistory();
      return { added: Math.max(0, rows().length - before), failed: nseError ? 1 : 0 };
    })().finally(() => { pending = null; emit(); });
    return pending;
  }
  return {
    ...base, rows, prepareRows,
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
      let active = true;
      const notify = () => { if (active) fn(); };
      const prepared = () => { void prepareRows().then(notify, notify); };
      const offBase = base.onChange(prepared), offNse = nse.onChange(prepared);
      return () => { active = false; listeners.delete(fn); offBase(); offNse(); };
    },
    startLive(live) {
      live.register(LIVE_ID, { intervalMs: POLL_MS, fetcher: () => read(false) });
      live.start(LIVE_ID, { fresh: true });
    },
    stopLive: (live) => live.stop(LIVE_ID),
  };
}

export const corporateAnnouncements = createCorporateAnnouncementsFeed();
