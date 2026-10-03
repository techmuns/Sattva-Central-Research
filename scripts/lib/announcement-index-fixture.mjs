// A REAL-DATA ANNOUNCEMENT INDEX THAT BUILDS IN SECONDS — for the checks, not for production.
//
// The runner's index is built from the whole retained stream (about 190,000 filings, a minute and
// several gigabytes). The checks need real filings but not all of them, so this builds the same
// index with the same code (announcement-index-build.js) from the two committed exchange-wide
// captures alone: BSE's date capture and NSE's live snapshot — a few thousand real filings with
// their real subjects, companies, market caps and events.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildIndex } from '../../public/js/data/announcement-index-build.js';
import { createAnnouncementIdentity, mergeExchangeIdentities } from '../../public/js/data/announcement-identity.js';
import { mergeAnnouncements, nseAnnouncement } from '../../public/js/data/announcements-shared.js';
import { profilesFrom, writeIndexMembers, captureIdentities } from './announcement-index-build.mjs';

const read = (root, path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

export function fixtureStream(root) {
  const bse = read(root, 'data/corp-announcements.json');
  const nse = read(root, 'data/nse-announcements.json');
  const ids = read(root, 'data/announcement-identities.json');
  let nseIds = { directories: {} };
  try { nseIds = read(root, 'data/filing-capture/nse-identities.json'); } catch { /* BSE identities alone still resolve most rows */ }
  const identity = createAnnouncementIdentity(mergeExchangeIdentities(ids.entries || [], nseIds.directories?.sme?.entries || [], nseIds.directories?.equity?.entries || []));
  const base = Object.entries(bse.byTicker || {}).flatMap(([ticker, rows]) => rows.map((r) => identity.row({ ...r, ticker: r.ticker || ticker })));
  const live = (nse.rows || []).map(nseAnnouncement).map(identity.row);
  const rows = mergeAnnouncements([], base, live);
  const feed = { companyKey: (r) => identity.key(r), companyIdentity: (r) => ({ ...r, ...identity.find(r) }) };
  return { rows, feed, identity, meta: { capturedAt: bse.capturedAt || null, windowDays: bse.windowDays ?? null, coversUniverse: bse.coversUniverse ?? null, nse: { capturedAt: nse.capturedAt || null } } };
}

/** Build and write the fixture index; returns the written index and the build. */
export function buildFixtureIndex(outDir, { root, now = Date.now() } = {}) {
  const { rows, feed, meta } = fixtureStream(root);
  const profiles = profilesFrom(root);
  const built = buildIndex({ rows, feed, profiles });
  const index = writeIndexMembers({ outDir, built, now, meta: { ...meta, profiles: profiles.meta }, captures: captureIdentities(root) });
  return { index, built, rows };
}
