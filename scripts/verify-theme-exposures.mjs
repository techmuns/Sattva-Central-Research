#!/usr/bin/env node
// Indirect theme exposure (public/js/data/theme-exposures.js): the reviewed map, the headline
// match, the labelled copies, their path through the alert assembly and the precomputed pool, and
// how AI Alerts ranks and words them. Offline; reads the shipped captures for the funnel check.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const themes = await import('../public/js/data/theme-exposures.js');
const { THEMES, themeReadings, readAcrossOf, mapThemeExposureEvents, isThemeExposureContext, themeSignature, THEME_EXPOSURE_WEIGHT } = themes;
const { newsCanSupportAI, isRelatedNewsContext } = await import('../public/js/data/company-news-attribution.js');
const { storyRecord } = await import('../public/js/data/alert-stories-shared.js');
const { aiEventTypes } = await import('../public/js/data/ai-alert-types.js');
const { portfolioNewsEntities } = await import('../public/js/data/company-news-identity.js');
const { createPortfolioProjection, portfolioProjectionSignature } = await import('../public/js/data/alert-pool-projection.js');
const { driversFromEvent } = await import('../public/js/data/alert-drivers.js');

const GLP1 = THEMES.find(theme => theme.id === 'glp1');
const exposure = ticker => GLP1.exposures.find(e => e.ticker === ticker);
const tickersOf = readings => readings.flatMap(r => r.exposures.map(e => e.ticker));

// ── 1. The reviewed map ─────────────────────────────────────────────────────────────────────
const book = JSON.parse(readFileSync(join(ROOT, 'public/data/portfolio-companies.json'), 'utf8'));
const bookRows = book.holdings;
// Sattva carries no tracked-universe.json: a tracked listed company is one the technicals capture
// or Moneycontrol's ticker map names.
const readData = file => JSON.parse(readFileSync(join(ROOT, 'public/data', file), 'utf8'));
const tracked = new Set([...readData('technicals.json').companies.map(c => c.ticker),
  ...Object.values(readData('mc-ticker-map.json').map || {}).map(e => e.ticker)].filter(Boolean));
const segmentIds = new Set(GLP1.segments.map(([id]) => id));
for (const theme of THEMES) {
  assert.match(theme.id, /^[a-z0-9-]+$/);
  for (const [from, to, text] of theme.readAcross) {
    assert(theme.segments.some(([id]) => id === from) && theme.segments.some(([id]) => id === to), `read-across ${from}→${to} names real segments`);
    assert(/\b(?:potential|could|bears? on)\b/.test(text), `read-across "${text}" states a mechanism, never a verdict`);
    assert(!/\b(?:will|hurts?|helps?|benefits?|positive|negative)\b/i.test(text), `read-across "${text}" carries no direction`);
  }
  const seen = new Set();
  for (const e of theme.exposures) {
    assert.match(e.ticker, /^[A-Z0-9&-]+$/);
    assert(!seen.has(e.ticker), `${e.ticker} is mapped once`); seen.add(e.ticker);
    assert(tracked.has(e.ticker), `${e.ticker} is a tracked listed company`);
    assert(e.names instanceof RegExp && e.names.test(e.name), `${e.ticker}'s name pattern names it`);
    assert(e.segments.length && e.segments.every(id => segmentIds.has(id)), `${e.ticker} names real segments`);
    assert(e.role.length > 10, `${e.ticker} states its role`);
    assert(e.evidence.length >= 1, `${e.ticker} cites the source that states its exposure`);
    for (const item of e.evidence) {
      assert.match(item.url, /^https:\/\//, `${e.ticker} evidence is an https link`);
      assert.match(item.day, /^\d{4}-\d{2}-\d{2}$/);
      assert(item.publisher && item.headline, `${e.ticker} evidence names its publisher and headline`);
    }
    const held = bookRows.find(row => row.ticker === e.ticker);
    if (held) assert.equal(e.isin, held.isin, `${e.ticker}'s ISIN is the book's`);
  }
}
// Gland and Biocon are in the book and plausible, and no captured source states their exposure.
assert(!exposure('GLAND') && !exposure('BIOCON'), 'an exposure without a cited source is not mapped');
assert.doesNotThrow(() => JSON.parse(JSON.stringify(themeSignature())));
assert.equal(JSON.stringify(themeSignature()), JSON.stringify(themeSignature()), 'the signature is stable');
console.log(`PASS: ${THEMES.length} theme, ${GLP1.exposures.length} exposures, every one cited and resolvable.`);

// ── 2. The headline match ───────────────────────────────────────────────────────────────────
{
  const [r] = themeReadings("EU regulator recommends approval of Eli Lilly's oral GLP-1 pill orforglipron");
  assert(r?.high, 'a regulator recommending a competitor oral pill is decisive');
  assert.deepEqual(r.actors, ['Eli Lilly']);
  assert(r.stages.some(s => s.id === 'regulatory') && r.segments.some(s => s.id === 'oral'));
  assert.equal(readAcrossOf(r.theme, r.segments, exposure('ONESOURCE')), 'Oral GLP-1 pills are a potential substitute for injectable pens and cartridges.');
  assert.equal(readAcrossOf(r.theme, r.segments, exposure('GLENMARK')), 'Oral GLP-1 pills could compete with injectable generic semaglutide.');
  assert(tickersOf([r]).includes('ONESOURCE') && tickersOf([r]).includes('GLENMARK'));
}
assert(themeReadings('From Jab to Pills: Novo Nordisk, Eli Lilly set to take obesity drug battle to India')[0]?.high,
  'the competing technology with a named originator is decisive without a stage word');
{
  const [r] = themeReadings("Dr Reddy's launches new generic Ozempic brands amid Obeda supply disruption");
  assert(r.high && r.peers.includes("Dr Reddy's Laboratories"));
  assert(!tickersOf([r]).includes('DRREDDY'), 'a story naming the company is its own news, not an indirect copy');
  assert.equal(readAcrossOf(r.theme, r.segments, exposure('GLENMARK')), 'Another generic launch or patent change bears on competition and pricing for generic semaglutide.');
  assert.equal(readAcrossOf(r.theme, r.segments, exposure('SHAILY')), 'Generic semaglutide launches bear on demand for injectable pens and cartridges.');
}
assert(!tickersOf(themeReadings('OneSource gets Saudi nod for Ozempic generic, partner Hikma will commercialise')).includes('ONESOURCE'));
assert.equal(themeReadings("US judge rejects Novo Nordisk bid to halt Eli Lilly's weight-loss drug ads")[0]?.high, false,
  'an originators\' advertising fight is context, not a decisive development');
assert(themeReadings("Novo's semaglutide protection weakens after European ruling")[0]?.high, 'a patent ruling is decisive');
for (const headline of [
  'Heineken warns UK pubs: Weight-loss drugs could hit beer sales',
  'Beauty firms chase Ozempic face market as weight-loss drugs boom',
  'Counterfeit Ozempic case: 2 Indians indicted in US',
  'Ozempic maker Novo Nordisk sets sights on hair-loss market',
  'GLP-1 medicine use without expert advice dangerous: Doctors',
  'Study explores genetic link between GLP-1 drugs and male pattern hair loss',
  'Eli Lilly opens a new office in Bengaluru',
  'Nifty ends higher as banks rally',
  '',
]) assert.deepEqual(themeReadings(headline), [], `no indirect copy for "${headline}"`);
assert.equal(themeReadings('Wegovy pill launch'), themeReadings('Wegovy pill launch'), 'one reading per headline');
console.log('PASS: decisive competitor developments read high; demand-side, crime, lifestyle and theme-word-only headlines read nothing.');

// ── 3. The labelled copies ──────────────────────────────────────────────────────────────────
const day = '2026-10-28';
const holdings = [
  { ticker: 'ONESOURCE', name: 'Onesource Special', isin: 'INE013P01021', listed: true, sector: 'Health Care' },
  { ticker: 'GLENMARK', name: 'Glenmark Pharmaceuticals Ltd', isin: 'INE935A01035', listed: true, sector: 'Health Care' },
  { ticker: 'ALPHA', name: 'Alpha Industries', isin: 'INE000A01001', listed: true, sector: 'Industrials' },
];
const entities = portfolioNewsEntities(holdings);
const market = (id, headline, extra = {}) => ({ id, feed: 'market-news', feedLabel: 'Market news', tab: 'news', ticker: null, entityId: null,
  company: 'Market-wide', day, time: '10:15', at: `${day}T04:45:00Z`, headline, detail: 'Standfirst', url: `https://example.test/${id}`,
  kind: 'record', direction: 'neutral', importance: 'low', severity: 'update', aiEligible: false, keywords: [],
  sourceRecord: { id, title: headline, summary: 'Standfirst', url: `https://example.test/${id}`, publisher: 'Business Standard', publishedAt: `${day}T04:45:00Z` }, ...extra });
const lilly = market('mcnews:lilly', "EU regulator recommends approval of Eli Lilly's oral GLP-1 pill orforglipron");
const plain = market('mcnews:plain', 'Nifty ends higher as banks rally');
assert.equal(mapThemeExposureEvents('market-news', [plain], entities)[0], plain);
const unmatched = [plain];
assert.equal(mapThemeExposureEvents('market-news', unmatched, entities), unmatched, 'no match returns the input array itself');
const input = [lilly, plain];
assert.equal(mapThemeExposureEvents('news', input, entities), input, 'only market-wide stories are mapped');
const mapped = mapThemeExposureEvents('market-news', input, entities);
assert.equal(mapThemeExposureEvents('market-news', input, entities), mapped, 'the same input maps to the same array');
assert.notEqual(mapThemeExposureEvents('market-news', input, portfolioNewsEntities(holdings.slice(1))), mapped, 'a changed book re-maps');
assert.equal(mapped.length, 2 + GLP1.exposures.length);
assert.equal(new Set(mapped.map(e => e.id)).size, mapped.length, 'every copy has its own id');
const copy = mapped.find(e => e.ticker === 'ONESOURCE');
assert.equal(copy.id, 'mcnews:lilly:theme:glp1:ONESOURCE');
assert.equal(copy.feed, 'market-news');
assert.equal(copy.company, 'OneSource Specialty Pharma');
assert.equal(copy.entityId, 'isin:INE013P01021', 'a book company carries its portfolio identity');
assert.equal(mapped.find(e => e.ticker === 'DRREDDY').entityId, null);
assert.equal(copy.direction, 'neutral', 'no direction');
assert.equal(copy.importance, 'high');
assert.equal(copy.aiEligible, false);
assert.equal(copy.namesCompany, false);
assert.equal(copy.attribution.status, 'theme');
assert(isThemeExposureContext(copy) && !isThemeExposureContext(lilly));
assert(!newsCanSupportAI(copy), 'an indirect copy never supports AI scoring as company news');
assert(!isRelatedNewsContext(copy));
assert.equal(storyRecord(copy), null, 'an indirect copy is never sent for story grouping');
assert.deepEqual(aiEventTypes(copy), ['indirect']);
assert.deepEqual(driversFromEvent(copy), [], 'an indirect copy names no driver');
assert.match(copy.detail, /^Indirect — this story does not name OneSource Specialty Pharma\. Exposure: /);
assert.equal(copy.themeExposure.readAcross, 'Oral GLP-1 pills are a potential substitute for injectable pens and cartridges.');
assert.equal(copy.sourceRecord.attribution, undefined, 'the copy keeps the publisher record, not a company attribution');
assert.equal(lilly.ticker, null, 'the original story is untouched');
// A story the discovery mapping attributed to a holding is that holding's own news.
const named = { ...market('mcnews:glen', 'Glenmark and Novo Nordisk unveil oral semaglutide plan in India'),
  id: 'mcnews:glen:entity:isin:INE935A01035', ticker: 'GLENMARK', entityId: 'isin:INE935A01035', company: 'Glenmark' };
const namedMapped = mapThemeExposureEvents('market-news', [named], entities);
assert(!namedMapped.some(e => isThemeExposureContext(e) && e.ticker === 'GLENMARK'));
assert(namedMapped.some(e => e.id === 'mcnews:glen:theme:glp1:ONESOURCE'), 'the other exposures still get copies, under the story\'s base id');
console.log('PASS: copies are labelled, neutral, refused as company news and grouping input, and never made for a company the story names.');

// ── 4. Through the alert assembly and the precomputed pool ──────────────────────────────────
const { assemble, matchesAlertScope } = await import('../public/js/data/daily-alerts.js');
const { scopeMatcher } = await import('../public/js/data/scope.js');
const { POOL_FEEDS } = await import('../public/js/data/alert-pool-shared.js');
const { assembleFeedEvents } = await import('../public/js/data/alert-pool-format.js');
const { writePoolMembers, readMember, verifyPoolMembers } = await import('./lib/alert-pool-build.mjs');
const scopeContext = { scope: 'portfolio', wanted: scopeMatcher('portfolio', holdings), entityIds: new Set(entities.map(e => e.entityId)) };
assert(matchesAlertScope(copy, scopeContext), 'a book company\'s copy is in Portfolio scope');
assert(!matchesAlertScope(mapped.find(e => e.ticker === 'DRREDDY'), scopeContext), 'a non-holding\'s copy is not');
assert(!matchesAlertScope(lilly, scopeContext), 'the tickerless original stays out of a narrowed scope');
const heineken = market('mcnews:beer', 'Heineken warns UK pubs: Weight-loss drugs could hit beer sales');
const feedsWith = (events) => new Map([['market-news', { id: 'market-news', label: 'Market news', tab: 'news', status: 'ok', asOf: day, reachesToday: true, events }]]);
const portfolio = assemble({ day, scope: 'portfolio', holdings, includeHistory: true, settledFeeds: feedsWith([lilly, plain, heineken]) });
const indirect = portfolio.events.filter(isThemeExposureContext);
assert.deepEqual(indirect.map(e => e.ticker).sort(), ['GLENMARK', 'ONESOURCE'], 'Portfolio gets exactly the book companies\' copies');
const marketFeed = portfolio.feeds.find(f => f.id === 'market-news');
assert.equal(marketFeed.sourceCount, 3, 'copies are derived readings, not source records');
const universe = assemble({ day, scope: 'universe', holdings, includeHistory: true, settledFeeds: feedsWith([lilly, plain, heineken]) });
assert.equal(universe.events.filter(isThemeExposureContext).length, GLP1.exposures.length);
assert(universe.events.some(e => e.id === lilly.id), 'Universe keeps the original story too');
// The pool's portfolio slice keeps a story that bears on the book, so both paths build the same copies.
const reading = createPortfolioProjection(holdings);
assert.equal(reading(lilly).keep, true, 'a theme story bearing on the book stays in the portfolio slice');
assert.equal(reading(heineken).keep, false);
assert.equal(reading(plain).keep, false);
assert.equal(createPortfolioProjection([holdings[2]])(lilly).keep, false, 'a book with no exposure keeps no theme story');
assert.equal(JSON.parse(portfolioProjectionSignature(holdings))[0], 'portfolio-pool-v2', 'slices built before theme keeping are refused');
assert.deepEqual(JSON.parse(portfolioProjectionSignature(holdings))[1].themes, themeSignature(), 'an edited theme invalidates the slice');
const out = mkdtempSync(join(tmpdir(), 'theme-exposures-'));
try {
  const sourceFeeds = POOL_FEEDS.map(id => ({ id, label: id, status: 'ok', asOf: day, reachesToday: true,
    events: id === 'market-news' ? [lilly, plain, heineken] : [] }));
  const index = writePoolMembers({ outDir: out, sourceFeeds, day, now: Date.parse(day), book: holdings, newsMeta: {}, captures: {} });
  verifyPoolMembers({ outDir: out, sourceFeeds, index });
  const full = index.ai.map(entry => readMember(out, entry.member));
  const selected = index.portfolioAi.entries.map(entry => readMember(out, entry.member));
  const settle = (shards, prepared) => new Map(sourceFeeds.map(feed => [feed.id, { ...feed, events: assembleFeedEvents(shards, feed.id),
    ...(prepared ? { preparedProjection: index.portfolioAi.sourceStats[feed.id] } : {}) }]));
  const a = assemble({ day, scope: 'portfolio', holdings, includeHistory: true, settledFeeds: settle(full, false) });
  const b = assemble({ day, scope: 'portfolio', holdings, includeHistory: true, settledFeeds: settle(selected, true) });
  assert.deepEqual(b.events, a.events, 'the portfolio slice and the complete pool build identical indirect copies');
  assert.deepEqual(b.meta, a.meta, 'and identical counts');
  assert.deepEqual(a.events.filter(isThemeExposureContext).map(e => e.ticker).sort(), ['GLENMARK', 'ONESOURCE']);
} finally { rmSync(out, { recursive: true, force: true }); }
console.log('PASS: copies are made before scope, enter Portfolio only for book companies, and the pool slice builds the same copies.');

// ── 5. How AI Alerts ranks and words them ───────────────────────────────────────────────────
const { rankReport, clearRankingCache, evidenceTag, MIN_SCORE, MUST_SEE_SCORE } = await import('../public/js/data/ai-alerts.js');
const feeds = [{ id: 'market-news', status: 'ok', reachesToday: true }, { id: 'announcements', status: 'ok', reachesToday: true }];
const rank = (events, scope = 'portfolio') => { clearRankingCache(); return rankReport({ day, scope, feeds, events }, { holdings, sectorKpis: null }); };
{
  const report = rank(portfolio.events);
  const card = report.cards.find(c => c.ticker === 'ONESOURCE');
  assert(card, 'one decisive indirect story today surfaces a book company on its own');
  assert.equal(card.score, MIN_SCORE, '30 + 6 + 16 + 12 is exactly the surfacing line');
  assert(card.score < MUST_SEE_SCORE);
  assert.equal(card.priority, 'important');
  assert.deepEqual(card.badge, { id: 'indirect', label: 'Indirect exposure', tone: 'caution' });
  assert.equal(card.insight, `Indirect (GLP-1): EU regulator recommends approval of Eli Lilly's oral GLP-1 pill orforglipron. Oral GLP-1 pills are a potential substitute for injectable pens and cartridges.`);
  assert.equal(card.materialPortfolioEvent, false, 'an indirect story never holds a card for the review window');
  assert.deepEqual(card.directions, { positive: 0, negative: 0, neutral: 0 }, 'it is not the company\'s own evidence');
  assert.deepEqual(card.confluence, []);
  assert.equal(evidenceTag(card.events[0]), 'INDIRECT');
  assert(card.scoreBreakdown.some(p => p.label === 'Indirect exposure (GLP-1) weight' && p.points === THEME_EXPOSURE_WEIGHT));
  assert(!card.scoreBreakdown.some(p => /independent feeds/.test(p.label)), 'no corroboration bonus');
  const glen = report.cards.find(c => c.ticker === 'GLENMARK');
  assert.match(glen.insight, /Oral GLP-1 pills could compete with injectable generic semaglutide\.$/);
}
{
  const yesterday = portfolio.events.filter(isThemeExposureContext).map(e => ({ ...e, id: `${e.id}:y`, day: '2026-10-27' }));
  assert(!rank(yesterday).cards.some(c => c.ticker === 'ONESOURCE'), 'an indirect story alone ages out after its day');
  const low = mapThemeExposureEvents('market-news', [market('mcnews:ads', "US judge rejects Novo Nordisk bid to halt Eli Lilly's weight-loss drug ads")], entities)
    .filter(e => e.ticker === 'ONESOURCE');
  assert.equal(low[0].importance, 'low');
  assert(!rank(low).cards.some(c => c.ticker === 'ONESOURCE'), 'a low-importance indirect story never surfaces a card');
  const filing = { id: 'bse:onesource:1', feed: 'announcements', feedLabel: 'Announcements', ticker: 'ONESOURCE', company: 'OneSource Specialty Pharma',
    day, headline: 'OneSource Specialty Pharma: Outcome of board meeting approving capacity expansion', url: 'https://example.test/filing',
    importance: 'high', direction: 'positive', aiEligible: true, kind: 'filing' };
  const both = rank([filing, copy]).cards.find(c => c.ticker === 'ONESOURCE');
  assert.equal(both.topEvent.id, filing.id, 'the company\'s own filing outranks an indirect story');
  assert.notEqual(both.badge.id, 'indirect');
  assert(!both.insight.startsWith('Indirect'));
  assert(both.events.some(isThemeExposureContext), 'the indirect story stays on the card as a row');
  assert.deepEqual(both.directions, { positive: 1, negative: 0, neutral: 0 }, 'only the filing sets the direction');
  const twice = [copy, { ...copy, id: `${copy.id}:syndicated`, url: 'https://example.test/syndicated' }];
  assert.equal(rank(twice).cards.find(c => c.ticker === 'ONESOURCE').events.length, 1, 'a syndicated headline sits on a card once');
  const accounts = ["Dr Reddy's launches new generic Ozempic brands amid Obeda supply disruption",
    "Dr Reddy's rolls out new generic Ozempic brands amid Obeda supply disruption"]
    .flatMap((headline, i) => mapThemeExposureEvents('market-news', [market(`mcnews:drl${i}`, headline)], entities).filter(e => e.ticker === 'ONESOURCE'));
  assert.equal(accounts.length, 2);
  assert.equal(rank(accounts).cards.find(c => c.ticker === 'ONESOURCE').events.length, 1, 'two publishers\' accounts of one development are one indirect row');
  const vague = mapThemeExposureEvents('market-news', [market('mcnews:drl-a', "Dr Reddy's on track to restart semaglutide rollout; Canada to drive initial demand")], entities)
    .find(e => e.ticker === 'ONESOURCE');
  assert.equal(vague.themeExposure.readAcross, `Exposure: ${exposure('ONESOURCE').role}.`, 'with no related segment the row states the company\'s own exposure');
  const kept = rank([vague, ...accounts]).cards.find(c => c.ticker === 'ONESOURCE').events;
  assert.equal(kept.length, 1);
  assert.notEqual(kept[0].id, vague.id, 'the fold keeps the account that says most about how it bears');
  const lillyDay = ["Eli Lilly's oral GLP-1 orforglipron shows 12% weight loss in phase 3 trial",
    "EU regulator recommends approval of Eli Lilly's oral GLP-1 pill orforglipron"]
    .flatMap((headline, i) => mapThemeExposureEvents('market-news', [market(`mcnews:lly${i}`, headline)], entities).filter(e => e.ticker === 'ONESOURCE'));
  assert(lillyDay.every(e => e.importance === 'high'));
  assert.equal(rank(lillyDay).cards.find(c => c.ticker === 'ONESOURCE').events.length, 2,
    'one actor\'s trial readout and its approval on the same day are two developments, not one');
  assert(!rank([filing, ...low]).cards.find(c => c.ticker === 'ONESOURCE').events.some(isThemeExposureContext),
    'a low-importance indirect story does not join a card at all; All Alerts keeps it');
  assert(!rank(universe.events, 'universe').cards.some(c => c.ticker === 'DRREDDY'), 'outside the book an indirect story alone does not surface');
}
{
  // Compact, the default view: the row names the story as indirect and says how it bears.
  const { compactCards, compactRows } = await import('../public/js/data/ai-alerts-compact.js');
  const destination = (event) => ({ href: event.url, external: true, label: 'source', ariaLabel: 'source' });
  const only = compactCards(rank(portfolio.events).cards.filter(c => c.ticker === 'ONESOURCE')).cards;
  const [row] = compactRows(only, { destination }).rows;
  assert.equal(row.kind, 'indirect');
  assert.equal(row.kindLabel, 'Indirect · GLP-1');
  assert.equal(row.text, "EU regulator recommends approval of Eli Lilly's oral GLP-1 pill orforglipron. Oral GLP-1 pills are a potential substitute for injectable pens and cartridges.");
  assert.equal(row.href, lilly.url);
  const filing = { id: 'bse:onesource:2', feed: 'announcements', feedLabel: 'Announcements', ticker: 'ONESOURCE', company: 'OneSource Specialty Pharma',
    day, headline: 'OneSource Specialty Pharma: Outcome of board meeting approving capacity expansion', url: 'https://example.test/filing-2',
    importance: 'high', direction: 'positive', aiEligible: true, kind: 'filing', filingSubject: 'Outcome of board meeting approving capacity expansion' };
  const ownFirst = compactRows(compactCards(rank([copy, filing]).cards).cards, { destination }).rows.find(r => r.ticker === 'ONESOURCE');
  assert.equal(ownFirst.kind, 'filing', 'the company\'s own evidence leads its Compact row');
  const novo = mapThemeExposureEvents('market-news', [market('mcnews:novo-q3', 'Novo Nordisk Q3 results: Wegovy sales beat, oral pill launch on track')], entities)
    .find(e => e.ticker === 'ONESOURCE');
  const result = { id: 'mc:onesource:q2', feed: 'earnings', feedLabel: 'Earnings', ticker: 'ONESOURCE', company: 'OneSource Specialty Pharma', day,
    headline: 'Result filed', importance: 'high', direction: 'positive', aiEligible: true, url: 'https://example.test/result', resultBasis: 'YOY' };
  const resultRow = compactRows(compactCards(rank([novo, result]).cards).cards, { destination }).rows.find(r => r.ticker === 'ONESOURCE');
  assert.equal(resultRow.folded, 0, 'another company\'s results story is not folded into this company\'s result');
}
console.log('PASS: an indirect story surfaces a book company on its day only, is labelled as indirect, and never outranks or colours the company\'s own evidence.');

// ── 6. The shipped captures: the funnel stays narrow ────────────────────────────────────────
{
  const files = [];
  const walk = dir => { if (!existsSync(dir)) return; for (const name of readdirSync(dir)) { const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path); else if (/\.json(\.gz)?$/.test(name)) files.push(path); } };
  walk(join(ROOT, 'public/data/market-news'));
  files.push(join(ROOT, 'public/data/market-news.json'));
  const stories = new Map();
  const visit = node => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node.title === 'string' && node.url) { stories.set(node.url, node.title); return; }
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value); };
  for (const file of files) { try { let body = readFileSync(file); if (file.endsWith('.gz')) body = gunzipSync(body); visit(JSON.parse(body)); } catch { /* a partial shard is not this test's subject */ } }
  const titles = [...stories.values()];
  const matched = titles.filter(title => themeReadings(title).length);
  const decisive = matched.filter(title => themeReadings(title).some(r => r.high));
  assert(titles.length > 1000, 'the shipped market-wide captures were read');
  assert(matched.length / titles.length < 0.005, `the theme matches a narrow slice of market-wide stories (${matched.length} of ${titles.length})`);
  const jab = titles.find(title => /^From Jab to Pills/.test(title));
  if (jab) assert(themeReadings(jab)[0].high, 'the shipped oral-pill story reads decisive');
  console.log(`PASS: shipped captures — ${titles.length} market-wide stories, ${matched.length} bear on a mapped theme, ${decisive.length} decisive.`);
}
