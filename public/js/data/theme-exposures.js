// data/theme-exposures.js — INDIRECT EXPOSURE: A STORY ABOUT ANOTHER COMPANY IN A MARKET A COMPANY
// SELLS INTO (ported from Glow, 29 October 2026). See docs/THEME-EXPOSURES.md.
//
// The desk's ask (28 October 2026): Eli Lilly getting an EU recommendation for an oral GLP-1 pill
// bears on OneSource, which makes injectable GLP-1 pens, and on the Indian generic semaglutide
// sellers — and nothing on this dashboard connected them, because every rule that puts a story on a
// company's card requires the story to NAME the company. Those rules are right: a story about Lilly
// is not OneSource news, and a keyword is a topic, never a direction. What was missing is a third
// relationship beside "names the company" and "names a reviewed related entity": EXPOSED THROUGH A
// THEME, read off a map that says which segment of which market each company sells into.
//
// PHASE ONE IS THIS FILE AND NOTHING ELSE. A reviewed map, a deterministic match on the publisher's
// HEADLINE, and a labelled copy of the story on each exposed company. No model call, no new
// collection, no direction. Five rules hold it up:
//
// 1. AN EXPOSURE NEEDS A CITED SOURCE. Every company below carries the captured story that states
//    its exposure, in that publisher's words. A company with no such source is not mapped, however
//    obvious its exposure seems — Gland Pharma and Biocon are both in the book and both plausible,
//    and neither has a captured source saying so yet. Add one by adding its evidence.
// 2. ONLY THE HEADLINE PROMOTES. The publisher chose it; a standfirst is a paragraph that happened
//    to contain a word (news-keywords.js rule 0). A theme word plus a named actor, or a decisive
//    development in a named segment, is required before a copy exists at all.
// 3. A STORY THAT NAMES THE COMPANY IS ITS OWN NEWS, NOT AN INDIRECT READING. A company the headline
//    names, or that the portfolio discovery mapping already attributed the story to, gets no copy.
// 4. NO DIRECTION. The copy is neutral. The read-across sentence is a reviewed statement about how
//    two segments relate ("a potential substitute"), never a measured or predicted effect.
// 5. INDIRECT IS NEVER DIRECT. The copy's attribution status is `theme`: it cannot support AI
//    scoring as company news (`newsCanSupportAI`), cannot corroborate, set a card's direction, keep
//    a card for the review window, name a KPI or a driver, or join a story development — and it is
//    never sent for story grouping, which is a model call.
import { ATTRIBUTION_VERSION } from './company-news-attribution.js';

export const THEME_EXPOSURE_VERSION = 1;

/** The source weight an indirect reading carries — company news's, so one decisive story on a
 * book company published today reaches MIN_SCORE (30 + 6 + 16 + 12 = 64) and ages out next day. */
export const THEME_EXPOSURE_WEIGHT = 6;

const GLP1 = {
  id: 'glp1',
  label: 'GLP-1 / obesity drugs',
  short: 'GLP-1',
  // The theme is named in the headline by a molecule, a brand or the class.
  terms: /\b(?:glp[- ]?1s?|semaglutide|tirzepatide|orforglipron|liraglutide|retatrutide|cagrisema|survodutide|wegovy|ozempic|rybelsus|mounjaro|zepbound|saxenda|(?:weight[- ]loss|obesity|anti[- ]obesity|weight[- ]management)\s+(?:drugs?|pills?|jabs?|injections?|shots?|treatments?|medicines?|medications?|therap(?:y|ies)))\b/i,
  // Demand-side, lifestyle and crime stories are a different exposure; no company here is mapped
  // to them, and reading them onto pen makers and generic sellers would be noise.
  exclude: /\b(?:beer|pubs?|alcohol|beverages?|snacks?|food(?:s|makers?)?|groceries|restaurants?|beauty|cosmetics?|fashion|apparel|clothing|airlines?|counterfeit|fake|smuggl\w*|nobel|hair[- ]loss|side[- ]effects?)\b/i,
  // The originators and challengers whose developments move this market.
  actors: [
    ['Eli Lilly', /\b(?:eli\s+)?lilly\b/i],
    ['Novo Nordisk', /\bnovo(?:\s+nordisk)?\b/i],
    ['Pfizer', /\bpfizer\b/i],
    ['Amgen', /\bamgen\b/i],
    ['Roche', /\broche\b/i],
    ['AstraZeneca', /\bastrazeneca\b/i],
    ['Boehringer Ingelheim', /\bboehringer\b/i],
    ['Zealand Pharma', /\bzealand\b/i],
    ['Viking Therapeutics', /\bviking therapeutics\b/i],
    ['Structure Therapeutics', /\bstructure therapeutics\b/i],
    ['Metsera', /\bmetsera\b/i],
    ['Hengrui', /\bhengrui\b/i],
  ],
  // What happened. A stage is what makes a story a development rather than a commentary.
  stages: [
    ['regulatory', 'regulatory decision', /\b(?:approv\w*|recommend\w*|chmp|fda|ema|cdsco|dcgi|mhra|nod|clearance|authori[sz]\w*)\b/i],
    ['launch', 'launch', /\b(?:launch\w*|relaunch\w*|roll(?:s|ed|ing)?[- ]?outs?|debut\w*|introduc\w*)\b/i],
    ['pricing', 'pricing', /\b(?:price[sd]?|pricing|price cuts?|discount\w*|cheaper)\b/i],
    ['trial', 'trial result', /\b(?:trials?|phase\s*(?:[123]|i{1,3})|readouts?|efficacy)\b/i],
    // Patent and exclusivity rulings decide when generics may launch. A court fight between two
    // originators over their advertising does not, and is left as context.
    ['patent', 'patent ruling', /\b(?:patents?|exclusivity|protection|ruling|injunction|infring\w*)\b/i],
    ['supply', 'supply change', /\b(?:shortages?|supply|supplies|recall\w*)\b/i],
  ],
  // Which part of the market the story is about.
  segments: [
    ['oral', 'oral pill', /\b(?:oral|pills?|tablets?)\b/i],
    ['injectable', 'injectable', /\b(?:inject\w*|jabs?|pens?|auto[- ]?injectors?|cartridges?|vials?|syringes?)\b/i],
    ['generic', 'generic', /\b(?:generics?|biosimilars?|copycat|compounded|anda|copies)\b/i],
  ],
  // How a story's segment bears on a company's segment. First matching pair wins; the oral pairs
  // lead because a competing technology is the case this map was asked for. Reviewed statements of
  // a mechanism — "potential", "could", "bears on" — never a measured or predicted effect.
  readAcross: [
    ['oral', 'injectable', 'Oral GLP-1 pills are a potential substitute for injectable pens and cartridges.'],
    ['oral', 'generic', 'Oral GLP-1 pills could compete with injectable generic semaglutide.'],
    ['generic', 'generic', 'Another generic launch or patent change bears on competition and pricing for generic semaglutide.'],
    ['generic', 'injectable', 'Generic semaglutide launches bear on demand for injectable pens and cartridges.'],
    ['injectable', 'injectable', 'Injectable GLP-1 developments bear on demand for pens and cartridges.'],
  ],
  // Every exposure is the company's own segment, worded from the cited source, and the source.
  // `names` is how a headline names the company — such a story is its own news, never a copy.
  exposures: [
    {
      ticker: 'ONESOURCE', isin: 'INE013P01021', name: 'OneSource Specialty Pharma', names: /\bone\s?source\b/i,
      segments: ['injectable', 'generic'],
      role: 'Makes injectable GLP-1 pens and cartridges and supplies generic semaglutide through partners',
      evidence: [
        { publisher: 'Value Research', day: '2026-09-18', headline: 'OneSource Specialty Pharma stock: what the FY28 bet rests on',
          passage: 'We look at the weight-loss pen opportunity, the capacity built and the risks.',
          url: 'https://www.valueresearchonline.com/stories/229674/onesource-specialty-pharma-stock-fy28-weight-loss-bet/' },
        { publisher: 'Moneycontrol', day: '2026-02-11', headline: 'OneSource gets Saudi nod for Ozempic generic, partner Hikma will commercialise',
          url: 'https://www.moneycontrol.com/news/business/stocks/onesource-gets-saudi-nod-for-ozempic-generic-partner-hikma-will-commercialise-13823978.html' },
      ],
    },
    {
      ticker: 'SHAILY', isin: null, name: 'Shaily Engineering Plastics', names: /\bshaily\b/i,
      segments: ['injectable'],
      role: 'Makes GLP-1 pen devices',
      evidence: [
        { publisher: 'TradingView', day: '2026-08-11', headline: 'Buy Shaily Engineering; target of Rs 4074: Motilal Oswal',
          passage: 'Healthcare revenue surged 84% YoY (in line), driven by increasing traction in GLP-1 pen volume',
          url: 'https://www.tradingview.com/news/moneycontrol:91125e580094b:0-buy-shaily-engineering-target-of-rs-4074-motilal-oswal/' },
        { publisher: 'Whalesbook', day: '2026-09-18', headline: 'Shaily Engineering Expands GLP-1 Capacity to 75 Million Units',
          passage: 'Shaily Engineering targets 75M unit capacity by FY27 amid GLP-1 demand.',
          url: 'https://whalesbook.com/news/English/healthcarebiotech/Shaily-Engineering-Expands-GLP-1-Capacity-to-75-Million-Units/6aacb102ed7f8e81734f673a' },
      ],
    },
    {
      ticker: 'GLENMARK', isin: 'INE935A01035', name: 'Glenmark Pharmaceuticals', names: /\bglenmark\b/i,
      segments: ['generic'],
      role: 'Sells generic semaglutide (GLIPIQ) in India',
      evidence: [
        { publisher: 'scanx.trade', day: '2026-10-05', headline: 'Glenmark Pharmaceuticals Launches GLIPIQ® (Semaglutide) in India with Weekly Treatment Starting at ₹325',
          url: 'https://news.google.com/rss/articles/CBMi7AFBVV95cUxNdTluSWpFMTBqTG04UEU4MkswcUMzUFJVVG41dmpMNGVxbjNkTEp5dTlkY1JhakVFUjRtUzk3RGRwVTNtcTFsR0tEN1M0TzBjUVMzalI3aks4QWdVb0d1RFl5bFFpTDQ1MHVFVE5FcGZfT25CM2N3cVE1YVFuVjF1bnJESFBHbVdIcm9QMEFNWklVZjJ6YWh2Si1idUwxc2tFdTVZTjhDRTltRW1VWmpFZ3JCOTFZaDBzb2d2Z1M0MzZCTFc1emZLSFJRVlRfaFdrR3N2UkFWdGNiR0NpNU14VExxNG5lQVRlYjJDcQ?oc=5' },
      ],
    },
    {
      ticker: 'DRREDDY', isin: null, name: "Dr Reddy's Laboratories", names: /\bdr\.?\s*reddy\W?s?\b/i,
      segments: ['generic'],
      role: 'Sells generic semaglutide in India and Canada',
      evidence: [
        { publisher: 'Economic Times', day: '2026-10-25', headline: "Dr Reddy's bets on generic semaglutide, biosimilars",
          passage: 'A relaunch of generic semaglutide and the US launch of abatacept biosimilar are anticipated for future growth.',
          url: 'https://economictimes.indiatimes.com/industry/healthcare/biotech/pharmaceuticals/dr-reddys-pioneering-the-future-with-generic-semaglutide-and-expanding-biosimilar-portfolio/articleshow/135197404.cms' },
      ],
    },
    {
      ticker: 'SUNPHARMA', isin: null, name: 'Sun Pharmaceutical Industries', names: /\bsun\s+pharma\w*\b/i,
      segments: ['generic'],
      role: 'Sells generic semaglutide in India',
      evidence: [
        { publisher: 'Livemint', day: '2026-08-11', headline: 'Delhi HC directs Sun Pharma to take permission before launching semaglutide',
          passage: 'Sun Pharma is currently the second-largest generic semaglutide player in the domestic market, after Torrent.',
          url: 'https://livemint.com/companies/delhi-hc-directs-sun-pharma-to-take-permission-before-launching-semaglutide-weight-loss-drug-ozempic-wegovy-11786450955811.html' },
      ],
    },
    {
      ticker: 'TORNTPHARM', isin: null, name: 'Torrent Pharmaceuticals', names: /\btorrent\s+pharma\w*\b/i,
      segments: ['generic'],
      role: 'Sells generic semaglutide in India',
      evidence: [
        { publisher: 'Livemint', day: '2026-08-11', headline: 'Delhi HC directs Sun Pharma to take permission before launching semaglutide',
          passage: 'Sun Pharma is currently the second-largest generic semaglutide player in the domestic market, after Torrent.',
          url: 'https://livemint.com/companies/delhi-hc-directs-sun-pharma-to-take-permission-before-launching-semaglutide-weight-loss-drug-ozempic-wegovy-11786450955811.html' },
      ],
    },
    {
      ticker: 'NATCOPHARM', isin: null, name: 'Natco Pharma', names: /\bnatco\b/i,
      segments: ['generic'],
      role: 'Sells generic semaglutide in India',
      evidence: [
        { publisher: 'Scrip', day: '2026-09-03', headline: 'Natco Rules Out Semaglutide Filings In Canada And Brazil',
          passage: 'Natco has ruled out generic semaglutide filings in Canada and Brazil as competition intensifies in both markets, while its Indian brand faces aggressive pricing and limited profitability.',
          url: 'https://insights.citeline.com/generics-bulletin/business/strategy/natco-rules-out-semaglutide-filings-in-canada-and-brazil-RVARH3YRQNFT7EI3IGZMEZHFUE' },
      ],
    },
    {
      ticker: 'ERIS', isin: null, name: 'Eris Lifesciences', names: /\beris\b/i,
      segments: ['generic'],
      role: 'Launching semaglutide in India with Natco',
      evidence: [
        { publisher: 'Alice Blue', day: '2026-09-30', headline: 'Eris Lifesciences: Stock in focus after company partners with Natco Pharma to launch Semaglutide in India',
          url: 'https://news.google.com/rss/articles/CBMi0wFBVV95cUxOeWV0MXBiTTEwS0NNUUxuUEFIV0R4TVZpeTdDaFJ3UGZDWXBObWNYMC0wYXpxMUVNc1lyWmtpVDRLa3o5eDRJTWpORHI1SWhNVE5Jb0NESldEd3pHeXdaZkxzcjNETnBiR2ZodUM3T3FoYnVKWlREdU5uZkZoX2ZkQVRKSWJPQ3BWOHVEYm05QV85S3QxWHg4Zl8zdXdNc2VQcU4xTWtENHlBTWhkWjV2S2tVX3cyVEpBTVRwZlQxVmI4OWl6N18zSTVQb0xWZU9NWm1n?oc=5' },
      ],
    },
  ],
};

/** The reviewed themes. A theme is added by adding an entry, every exposure with its evidence. */
export const THEMES = Object.freeze([GLP1]);

/**
 * Everything the theme match reads, as plain data. The portfolio slice of the precomputed alert pool
 * keeps a market-wide story only when it can matter to the book, so it carries this in its
 * signature: an edited theme makes every slice built before the edit ineligible rather than
 * silently missing the stories the edit now maps.
 */
export function themeSignature() {
  return [THEME_EXPOSURE_VERSION, ...THEMES.map((theme) => [theme.id, theme.terms.source, theme.exclude.source,
    theme.actors.map(([, test]) => test.source), theme.stages.map(([, , test]) => test.source),
    theme.segments.map(([, , test]) => test.source),
    theme.exposures.map((exposure) => [exposure.ticker, exposure.isin || null, exposure.names.source])])];
}

/** The exposed companies a headline bears on, by ticker — for callers that only need membership. */
export function themeExposureTickers(headline) {
  return themeReadings(headline).flatMap((reading) => reading.exposures.map((exposure) => exposure.ticker));
}

/** True for the copy this module makes, and for nothing else. */
export function isThemeExposureContext(event) {
  return !!event?.themeExposure && event.attribution?.status === 'theme';
}

const named = (pairs, text) => pairs.filter(([, , test]) => test.test(text)).map(([id, label]) => ({ id, label }));

// One reading per headline. The distinct headlines are the cost and the answer depends on nothing
// else, so it is kept per string in a bounded map, cleared when it outgrows it.
const readingCache = new Map();
/**
 * What a headline says about each reviewed theme: `[]` when it bears on none. A reading names the
 * actors, peers, stages and segments it matched, whether it is decisive (`high`), and the exposed
 * companies a copy may be made for — never one the headline names.
 */
export function themeReadings(headline) {
  const text = String(headline || '');
  if (!text) return [];
  const hit = readingCache.get(text);
  if (hit) return hit;
  const readings = [];
  for (const theme of THEMES) {
    if (!theme.terms.test(text) || theme.exclude.test(text)) continue;
    const actors = theme.actors.filter(([, test]) => test.test(text)).map(([name]) => name);
    const peers = theme.exposures.filter((exposure) => exposure.names.test(text));
    const stages = named(theme.stages, text);
    const segments = named(theme.segments, text);
    const someone = actors.length > 0 || peers.length > 0;
    // A theme word alone ("GLP-1 medicine use without expert advice dangerous") is commentary. A
    // named originator or peer, or a development in a named segment, is required for any copy.
    if (!someone && !(stages.length && segments.length)) continue;
    const oral = segments.some((segment) => segment.id === 'oral');
    // Decisive: somebody named, and either something happened or it is the competing technology.
    const high = someone && (stages.length > 0 || oral);
    const exposures = theme.exposures.filter((exposure) => !peers.includes(exposure));
    if (!exposures.length) continue;
    readings.push({ theme, actors, peers: peers.map((exposure) => exposure.name), stages, segments, high, exposures });
  }
  if (readingCache.size >= 8192) readingCache.clear();
  readingCache.set(text, readings);
  return readings;
}

/**
 * The reviewed sentence for how a story's segments bear on a company's — or, where the story names
 * no segment the map relates, the company's own exposure, which is what put the story here.
 */
export function readAcrossOf(theme, segments, exposure) {
  const story = new Set(segments.map((segment) => segment.id));
  const pair = theme.readAcross.find(([from, to]) => story.has(from) && exposure.segments.includes(to));
  return pair ? pair[2] : `Exposure: ${exposure.role}.`;
}

/**
 * Which development an indirect copy reports, for folding several publishers' accounts of it into
 * one card row: the theme, the day, who it names and WHAT KIND of development it is. The kind is
 * the first stage the headline names, in the theme's own stage order, so Lilly's trial readout and
 * Lilly's approval on one day stay two rows, while "launches" and "rolls out" of one generic launch
 * fold. A headline naming no stage folds only with others naming none.
 */
export function themeDevelopmentKey(event) {
  const exposure = event.themeExposure;
  return ['theme', exposure.theme, event.day, [...exposure.actors, ...exposure.peers].sort().join('|'),
    exposure.stages[0] || 'none'].join(':');
}

/** How specific an indirect reading is: a related segment, then a stated development. */
export function themeSpecificity(event) {
  const exposure = event?.themeExposure;
  return exposure ? exposure.segments.length * 2 + exposure.stages.length : 0;
}

const list = (items) => items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

function themeCopy(event, base, reading, exposure, entity) {
  const { theme } = reading;
  const readAcross = readAcrossOf(theme, reading.segments, exposure);
  const source = exposure.evidence[0];
  const company = exposure.name;
  const about = [...reading.actors, ...reading.peers];
  const what = [...reading.stages.map((stage) => stage.label), ...reading.segments.map((segment) => segment.label)];
  const importanceReason = reading.high
    ? `High: the headline names ${list(about)} and a ${list(what.length ? what : ['development'])} in the ${theme.label} market. Indirect: it does not name ${company}.`
    : `Low: the headline is about the ${theme.label} market but names no decisive development. Indirect: it does not name ${company}.`;
  const record = event.sourceRecord && typeof event.sourceRecord === 'object' ? event.sourceRecord : {};
  return {
    ...event,
    id: `${base}:theme:${theme.id}:${exposure.ticker}`,
    ticker: exposure.ticker,
    entityId: entity?.entityId || null,
    company,
    issuer: null,
    // The publisher's own record, without any company attribution a discovery copy carried.
    sourceRecord: { title: record.title ?? event.headline, summary: record.summary ?? null, url: record.url ?? event.url,
      publisher: record.publisher ?? record.source ?? null, publishedAt: record.publishedAt ?? event.at ?? null },
    direction: 'neutral',
    importance: reading.high ? 'high' : 'low',
    severity: 'update',
    signalReason: 'Indirect exposure: direction not graded. The read-across is a reviewed mapping, not a measured effect.',
    importanceReason,
    reason: 'Indirect exposure: direction not graded.',
    keywords: [],
    namesCompany: false,
    aiEligible: false,
    attribution: { version: ATTRIBUTION_VERSION, status: 'theme', themeId: theme.id,
      reason: `Indirect: the story does not name ${company}. ${company} is mapped to the ${theme.label} market — ${exposure.role} (${source.publisher}, ${source.day}).` },
    themeExposure: {
      version: THEME_EXPOSURE_VERSION,
      theme: theme.id,
      label: theme.label,
      short: theme.short,
      role: exposure.role,
      readAcross,
      actors: reading.actors,
      peers: reading.peers,
      stages: reading.stages.map((stage) => stage.id),
      segments: reading.segments.map((segment) => segment.id),
      evidence: exposure.evidence.map(({ publisher, day, headline, url }) => ({ publisher, day, headline, url })),
    },
    detail: `Indirect — this story does not name ${company}. Exposure: ${exposure.role} (${source.publisher}, ${source.day}). ${readAcross}`,
  };
}

const baseIdOf = (event) => {
  const id = String(event.id || '');
  const at = id.indexOf(':entity:');
  return at < 0 ? id : id.slice(0, at);
};

/**
 * The market-wide feed's events, plus one labelled copy of each theme story per exposed company.
 *
 * Runs in the alert assembly beside the portfolio discovery mapping and before scope, so a copy
 * reaches a narrowed scope exactly when its company is in it — the pool and the live path build the
 * same copies, because both hand the assembly the same market-wide events. Returns the input array
 * itself when nothing matched, and the same output array for the same input, so nothing downstream
 * that is keyed on the feed's events is invalidated by this pass.
 */
const mappings = new WeakMap();
export function mapThemeExposureEvents(feedId, events, portfolioEntities = []) {
  if (feedId !== 'market-news' || !Array.isArray(events) || !events.length) return events;
  const held = mappings.get(events);
  if (held && held.entities === portfolioEntities) return held.value;
  // Stories the discovery mapping already attributed to a company are that company's own news.
  const attributed = new Map();
  for (const event of events) {
    if (!event?.ticker || !String(event.id || '').includes(':entity:')) continue;
    const base = baseIdOf(event);
    if (!attributed.has(base)) attributed.set(base, new Set());
    attributed.get(base).add(String(event.ticker).toUpperCase());
  }
  const entityFor = new Map();
  for (const entity of portfolioEntities || []) {
    if (entity?.ticker) entityFor.set(String(entity.ticker).toUpperCase(), entity);
    for (const isin of entity?.portfolioIsins || []) entityFor.set(String(isin).toUpperCase(), entity);
  }
  const seen = new Set();
  let copies = null;
  for (const event of events) {
    if (!event || isThemeExposureContext(event) || !event.url) continue;
    const readings = themeReadings(event.headline);
    if (!readings.length) continue;
    const base = baseIdOf(event);
    if (seen.has(base)) continue;
    seen.add(base);
    const already = attributed.get(base);
    for (const reading of readings) for (const exposure of reading.exposures) {
      if (already?.has(exposure.ticker)) continue;
      const entity = entityFor.get(exposure.ticker) || (exposure.isin && entityFor.get(exposure.isin)) || null;
      (copies ||= []).push(themeCopy(event, base, reading, exposure, entity));
    }
  }
  const value = copies ? [...events, ...copies] : events;
  mappings.set(events, { entities: portfolioEntities, value });
  return value;
}
