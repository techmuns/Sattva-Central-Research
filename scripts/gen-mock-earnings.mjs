#!/usr/bin/env node
// gen-mock-earnings.mjs — generates the ILLUSTRATIVE earnings data set.
//
//   node scripts/gen-mock-earnings.mjs
//
// Writes scripts/fixtures/mock-earnings.json and scripts/fixtures/mock-earnings-calendar.json.
//
// WHAT IS REAL AND WHAT IS NOT
//   Real:      company names, tickers, sectors and market caps — all drawn from
//              public/data/universe.json, the actual NSE-500 screener export.
//   Synthetic: every rupee, every margin, every EPS. None of it is a reported figure.
//
// These files are test fixtures outside the served public directory. They must never be loaded
// as dashboard financials or estimates. The legacy earnings loader rejects their provenance.
//
// Determinism: a seeded PRNG (mulberry32) means the same seed always produces the same
// numbers, so the committed file is reproducible and a diff is reviewable. Change SEED and
// the whole set changes; leave it alone and reruns are no-ops.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UNIVERSE_PATH = resolve(__dirname, '../public/data/universe.json');
const OUT_PATH = resolve(__dirname, './fixtures/mock-earnings.json');
const CALENDAR_PATH = resolve(__dirname, './fixtures/mock-earnings-calendar.json');

const SEED = 20260810;          // change this and every number changes
const COMPANY_COUNT = 120;
const QUARTERS = 8;
const LATEST_QUARTER = 'Q1FY27'; // Apr–Jun 2026
const SEASON_START = '2026-07-10';
const SEASON_END = '2026-08-08';
const CALENDAR_FROM = '2026-08-11';
const CALENDAR_DAYS = 30;

// ---------------------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Small, fast, and good enough for plausible-looking financials.
// ---------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const rand = (lo, hi) => lo + rng() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;
const round = (n, d = 2) => {
  const m = 10 ** d;
  return Math.round(n * m) / m;
};

// ---------------------------------------------------------------------------------------
// Sector profiles — margin levels and growth rates that look right for the sector, so a
// bank doesn't come out with a cement company's margin structure.
// opm: [lo, hi] typical operating margin band.  growth: [lo, hi] typical revenue YoY.
// ---------------------------------------------------------------------------------------
const SECTOR_PROFILE = {
  'Information Technology': { opm: [20, 27], growth: [4, 16], taxLo: 22, taxHi: 27 },
  'Financial Services': { opm: [28, 45], growth: [8, 22], taxLo: 23, taxHi: 27 },
  'Fast Moving Consumer Goods': { opm: [14, 24], growth: [3, 12], taxLo: 24, taxHi: 27 },
  Healthcare: { opm: [18, 28], growth: [6, 18], taxLo: 18, taxHi: 26 },
  'Oil, Gas & Consumable Fuels': { opm: [6, 14], growth: [-4, 12], taxLo: 24, taxHi: 30 },
  'Automobile and Auto Components': { opm: [8, 16], growth: [2, 20], taxLo: 24, taxHi: 28 },
  'Capital Goods': { opm: [9, 17], growth: [8, 24], taxLo: 24, taxHi: 28 },
  'Construction Materials': { opm: [12, 22], growth: [2, 14], taxLo: 24, taxHi: 29 },
  Construction: { opm: [7, 13], growth: [8, 20], taxLo: 25, taxHi: 29 },
  Metals: { opm: [10, 22], growth: [-8, 18], taxLo: 25, taxHi: 30 },
  Power: { opm: [18, 32], growth: [2, 12], taxLo: 20, taxHi: 27 },
  Telecommunication: { opm: [30, 42], growth: [8, 20], taxLo: 22, taxHi: 28 },
  'Consumer Durables': { opm: [10, 20], growth: [6, 22], taxLo: 24, taxHi: 28 },
  Chemicals: { opm: [12, 22], growth: [-2, 16], taxLo: 24, taxHi: 28 },
  Textiles: { opm: [8, 16], growth: [0, 14], taxLo: 25, taxHi: 29 },
  Services: { opm: [12, 24], growth: [6, 20], taxLo: 24, taxHi: 28 },
  'Consumer Services': { opm: [10, 22], growth: [8, 26], taxLo: 24, taxHi: 28 },
  Realty: { opm: [18, 30], growth: [4, 24], taxLo: 24, taxHi: 29 },
  'Forest Materials': { opm: [10, 18], growth: [0, 12], taxLo: 25, taxHi: 29 },
  'Diversified Metals': { opm: [10, 20], growth: [-4, 14], taxLo: 25, taxHi: 30 },
};
const DEFAULT_PROFILE = { opm: [10, 20], growth: [2, 15], taxLo: 24, taxHi: 28 };
const profileFor = (sector) => SECTOR_PROFILE[sector] || DEFAULT_PROFILE;

// Segment names per sector, so the split reads like the business rather than "Segment A".
const SEGMENTS = {
  'Information Technology': ['BFSI', 'Retail & CPG', 'Manufacturing', 'Healthcare & Life Sciences', 'Communications'],
  'Financial Services': ['Retail lending', 'Corporate banking', 'Treasury', 'Insurance & distribution'],
  'Fast Moving Consumer Goods': ['Home care', 'Personal care', 'Foods & refreshment', 'Others'],
  Healthcare: ['India formulations', 'US generics', 'Emerging markets', 'API & CDMO'],
  'Oil, Gas & Consumable Fuels': ['Refining & marketing', 'Petrochemicals', 'Oil & gas exploration', 'Retail'],
  'Automobile and Auto Components': ['Passenger vehicles', 'Commercial vehicles', 'Spare parts & services', 'Exports'],
  'Capital Goods': ['Projects & EPC', 'Products', 'Services & AMC', 'International'],
  'Construction Materials': ['Grey cement', 'Ready-mix concrete', 'White cement & putty'],
  Construction: ['Infrastructure', 'Buildings & factories', 'Hydrocarbon', 'International'],
  Metals: ['Long products', 'Flat products', 'Mining', 'Exports'],
  Power: ['Generation', 'Transmission', 'Distribution', 'Renewables'],
  Telecommunication: ['Mobile services India', 'Homes & broadband', 'Enterprise', 'Africa & others'],
  'Consumer Durables': ['Jewellery', 'Watches & wearables', 'Eyecare', 'Others'],
  Chemicals: ['Specialty chemicals', 'Agrochemicals', 'Bulk chemicals', 'Exports'],
};
const DEFAULT_SEGMENTS = ['Core business', 'Adjacent products', 'Services', 'Others'];
const segmentsFor = (sector) => SEGMENTS[sector] || DEFAULT_SEGMENTS;

// ---------------------------------------------------------------------------------------
// Quarter labels, walking back from the latest.
// ---------------------------------------------------------------------------------------
function quarterLabels(latestLabel, count) {
  const m = latestLabel.match(/^Q(\d)FY(\d{2})$/);
  let q = Number(m[1]);
  let fy = Number(m[2]);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.unshift(`Q${q}FY${String(fy).padStart(2, '0')}`);
    q -= 1;
    if (q === 0) {
      q = 4;
      fy -= 1;
    }
  }
  return out; // oldest first
}

function parseMarketCapCr(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/,/g, '').replace(/Cr\.?/i, '').trim());
  return Number.isFinite(n) ? n : null;
}
const tickerFromUrl = (url) => String(url || '').match(/\/company\/([^/]+)/)?.[1]?.toUpperCase() || null;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// ---------------------------------------------------------------------------------------
// One company's eight quarters.
//
// Each company gets an "archetype" that shapes the whole series, so the set contains
// recognisable stories rather than uniform noise:
//   compounder    steady high growth, expanding margins
//   steady        modest growth, flat margins
//   accelerating  growth rate rising quarter over quarter
//   decelerating  growth rate falling
//   cyclical      swings either side of zero
//   pressured     revenue grows but margins compress (cost pressure)
//   lossmaker     currently loss-making — exercises the hard-fail path
//   turnaround    a loss last quarter, profitable now
// ---------------------------------------------------------------------------------------
const ARCHETYPES = [
  ['compounder', 0.18],
  ['steady', 0.22],
  ['accelerating', 0.13],
  ['decelerating', 0.14],
  ['cyclical', 0.12],
  ['pressured', 0.11],
  ['lossmaker', 0.05],
  ['turnaround', 0.05],
];
function pickArchetype() {
  const r = rng();
  let acc = 0;
  for (const [name, weight] of ARCHETYPES) {
    acc += weight;
    if (r < acc) return name;
  }
  return 'steady';
}

function buildCompany(entry, labels) {
  const ticker = tickerFromUrl(entry['Screener URL']);
  const sector = entry.Sector || entry['Broad Sector'] || 'Services';
  const marketCap = parseMarketCapCr(entry['Market Cap']) || 5000;
  const profile = profileFor(sector);
  const archetype = pickArchetype();

  // Revenue scale is anchored to market cap so a ₹2 L Cr company doesn't post ₹50 Cr of sales.
  // Quarterly revenue ≈ market cap ÷ a sector-ish multiple, with spread.
  const salesMultiple = rand(2.5, 9);
  let revenue = Math.max(45, (marketCap / salesMultiple) / 4);

  // Baseline growth and margin for this company, inside its sector band.
  const baseGrowth = rand(profile.growth[0], profile.growth[1]);
  let opm = rand(profile.opm[0], profile.opm[1]);

  // Per-archetype trajectory knobs.
  const growthDrift =
    archetype === 'accelerating' ? rand(1.2, 3.0)
    : archetype === 'decelerating' ? rand(-3.0, -1.2)
    : archetype === 'compounder' ? rand(0.1, 0.7)
    : 0;
  const marginDrift =
    archetype === 'compounder' ? rand(0.15, 0.45)
    : archetype === 'pressured' ? rand(-0.55, -0.25)
    : archetype === 'lossmaker' ? rand(-0.8, -0.4)
    : rand(-0.12, 0.12);

  // Walk the series forward from the oldest quarter.
  const quarters = [];
  // Start eight quarters back, so the latest lands near the intended level.
  revenue = revenue / (1 + baseGrowth / 100) ** 2;
  for (let i = 0; i < labels.length; i++) {
    const step = i - (labels.length - 1);        // 0 for the latest quarter, negative before
    const growthThisQ = baseGrowth + growthDrift * (i / 2) + (archetype === 'cyclical' ? Math.sin(i * 1.3) * 9 : 0);
    // Quarterly sequential movement: the YoY rate spread over four quarters, plus noise
    // and a mild seasonal wobble.
    const seq = growthThisQ / 4 + rand(-2.6, 2.6) + Math.sin(i * 1.6) * 1.4;
    revenue = Math.max(30, revenue * (1 + seq / 100));

    let quarterOpm = opm + marginDrift * i + rand(-0.9, 0.9);
    if (archetype === 'lossmaker') quarterOpm = Math.min(quarterOpm, rand(-4, 4));
    if (archetype === 'turnaround' && i < labels.length - 1) quarterOpm = Math.min(quarterOpm, rand(-2, 5));
    quarterOpm = Math.max(-22, Math.min(58, quarterOpm));

    const operatingProfit = (revenue * quarterOpm) / 100;

    // Other income: usually small, occasionally fat enough to trip the quality rule.
    const fatOtherIncome = chance(0.1);
    const otherIncome = Math.max(0, operatingProfit * (fatOtherIncome ? rand(0.18, 0.4) : rand(0.01, 0.07)) + rand(0, 6));

    // Exceptional items in ~8% of quarters, either sign.
    const exceptionalItems = chance(0.08) ? round(operatingProfit * rand(0.06, 0.3) * (chance(0.5) ? 1 : -1), 2) : 0;

    const interestAndDep = operatingProfit > 0 ? operatingProfit * rand(0.14, 0.34) : Math.abs(operatingProfit) * rand(0.1, 0.25);
    const pbt = operatingProfit + otherIncome + exceptionalItems - interestAndDep;

    // Tax: normally in the sector band; occasionally out of it to exercise the partial branch.
    let taxRate = rand(profile.taxLo, profile.taxHi);
    if (chance(0.12)) taxRate = chance(0.5) ? rand(6, 18) : rand(31, 42);
    const taxExpense = pbt > 0 ? (pbt * taxRate) / 100 : 0;
    const netProfit = pbt - taxExpense;

    // Share count is stable per company; derive it once from the first quarter.
    quarters.push({
      quarter: labels[i],
      revenue: round(revenue, 1),
      operatingProfit: round(operatingProfit, 1),
      opm: round(quarterOpm, 2),
      netProfit: round(netProfit, 1),
      npm: round(revenue ? (netProfit / revenue) * 100 : 0, 2),
      eps: null, // filled below, once the share count is known
      otherIncome: round(otherIncome, 1),
      pbt: round(pbt, 1),
      taxExpense: round(taxExpense, 1),
      exceptionalItems,
    });
  }

  // A turnaround must actually turn: force the prior quarter negative and the latest positive.
  if (archetype === 'turnaround') {
    const prev = quarters.at(-2);
    const last = quarters.at(-1);
    if (prev.netProfit > 0) {
      prev.netProfit = round(-Math.abs(prev.netProfit) * rand(0.3, 0.9), 1);
      prev.npm = round((prev.netProfit / prev.revenue) * 100, 2);
      prev.pbt = round(prev.netProfit, 1);
      prev.taxExpense = 0;
    }
    if (last.netProfit < 0) {
      last.netProfit = round(Math.abs(last.netProfit) * rand(0.4, 1.2) + 5, 1);
      last.npm = round((last.netProfit / last.revenue) * 100, 2);
    }
  }
  // A lossmaker must actually be loss-making in the latest quarter.
  if (archetype === 'lossmaker') {
    const last = quarters.at(-1);
    if (last.netProfit > 0) {
      last.netProfit = round(-Math.abs(last.netProfit) * rand(0.4, 1.5) - 3, 1);
      last.npm = round((last.netProfit / last.revenue) * 100, 2);
      last.pbt = round(last.netProfit, 1);
      last.taxExpense = 0;
    }
  }

  // Share count in crore, scaled so EPS lands in a sane band.
  const sharesCr = Math.max(1, (quarters.at(-1).revenue * rand(0.6, 2.4)) / rand(18, 80));
  for (const q of quarters) q.eps = round(q.netProfit / sharesCr, 2);

  // Consensus: the street is close but not exact. The intended beat/miss mix is roughly
  // 45 beat / 30 miss / 25 in-line, so draw the gap from that distribution.
  const roll = rng();
  const epsGapPct = roll < 0.45 ? rand(1.5, 12) : roll < 0.75 ? rand(-11, -1.5) : rand(-0.9, 0.9);
  const revGapPct = epsGapPct > 0 ? rand(-1.5, 5) : epsGapPct < 0 ? rand(-5, 1.5) : rand(-1, 1);
  const lastQ = quarters.at(-1);
  const consensus = {
    // A negative EPS makes "estimate" arithmetic confusing; anchor off the magnitude.
    eps: round(lastQ.eps / (1 + epsGapPct / 100), 2),
    revenue: round(lastQ.revenue / (1 + revGapPct / 100), 1),
  };

  // Segment split: 3–4 segments summing to 100%.
  const names = segmentsFor(sector);
  const count = Math.min(names.length, randInt(3, 4));
  const weights = Array.from({ length: count }, () => rand(0.6, 3));
  const wTotal = weights.reduce((s, w) => s + w, 0);
  let remaining = 100;
  const segments = names.slice(0, count).map((name, i) => {
    const share = i === count - 1 ? round(remaining, 1) : round((weights[i] / wTotal) * 100, 1);
    remaining = round(remaining - share, 1);
    return { name, revenue: round((lastQ.revenue * share) / 100, 1), share };
  });

  // Report date somewhere in the season window.
  const seasonDays = Math.round((new Date(`${SEASON_END}T00:00:00Z`) - new Date(`${SEASON_START}T00:00:00Z`)) / 86400000);
  const reportedOn = isoDate(addDays(SEASON_START, randInt(0, seasonDays)));

  return {
    ticker,
    name: entry.Company,
    sector,
    industry: entry['Broad Industry'] || entry.Industry || null,
    marketCap,
    screenerUrl: entry['Screener URL'],
    quarter: labels.at(-1),
    reportedOn,
    archetype, // kept in the file so a reviewer can see why a company looks the way it does
    quarters,
    consensus,
    segments,
  };
}

// ---------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------
const universe = JSON.parse(readFileSync(UNIVERSE_PATH, 'utf8'));
const eligible = universe.filter((e) => tickerFromUrl(e['Screener URL']) && e.Company);

// Deterministic spread across the universe rather than the first 120 alphabetically, so the
// set covers a range of sizes and sectors. Stride-sample, then top up if short.
const stride = Math.max(1, Math.floor(eligible.length / COMPANY_COUNT));
const chosen = [];
const seen = new Set();
for (let i = 0; i < eligible.length && chosen.length < COMPANY_COUNT; i += stride) {
  const t = tickerFromUrl(eligible[i]['Screener URL']);
  if (seen.has(t)) continue;
  seen.add(t);
  chosen.push(eligible[i]);
}
for (let i = 0; i < eligible.length && chosen.length < COMPANY_COUNT; i++) {
  const t = tickerFromUrl(eligible[i]['Screener URL']);
  if (seen.has(t)) continue;
  seen.add(t);
  chosen.push(eligible[i]);
}

const labels = quarterLabels(LATEST_QUARTER, QUARTERS);
const companies = chosen.map((e) => buildCompany(e, labels));

const payload = {
  _provenance: 'ILLUSTRATIVE DATA. Company names, tickers, sectors and market caps are real (from public/data/universe.json). Every financial figure is synthetic, generated by scripts/gen-mock-earnings.mjs. Not a reported number.',
  generated_at: new Date().toISOString(),
  generator: 'scripts/gen-mock-earnings.mjs',
  seed: SEED,
  source: 'Mock data',
  quarter: LATEST_QUARTER,
  season_start: SEASON_START,
  season_end: SEASON_END,
  company_count: companies.length,
  companies,
};
writeFileSync(OUT_PATH, `${JSON.stringify(payload)}\n`);

// ---- upcoming results calendar: the next 30 days --------------------------------------
// Companies NOT in the reported set — you cannot be scheduled to report a quarter you have
// already reported.
const reported = new Set(companies.map((c) => c.ticker));
const upcoming = eligible.filter((e) => !reported.has(tickerFromUrl(e['Screener URL'])));
const events = [];
for (let day = 0; day < CALENDAR_DAYS; day++) {
  const date = isoDate(addDays(CALENDAR_FROM, day));
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 0) continue; // Indian boards rarely meet on a Sunday
  const n = randInt(0, 4);
  for (let i = 0; i < n && upcoming.length; i++) {
    const idx = Math.floor(rng() * upcoming.length);
    const e = upcoming.splice(idx, 1)[0];
    events.push({
      ticker: tickerFromUrl(e['Screener URL']),
      name: e.Company,
      sector: e.Sector || e['Broad Sector'] || null,
      marketCap: parseMarketCapCr(e['Market Cap']),
      date,
      quarter: LATEST_QUARTER,
      confirmed: chance(0.7), // board-meeting intimation filed vs. estimated
    });
  }
}
events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

writeFileSync(
  CALENDAR_PATH,
  `${JSON.stringify({
    _provenance: 'ILLUSTRATIVE DATA. Company names and tickers are real; the scheduled dates are synthetic, generated by scripts/gen-mock-earnings.mjs.',
    generated_at: new Date().toISOString(),
    generator: 'scripts/gen-mock-earnings.mjs',
    seed: SEED,
    source: 'Mock data',
    from: CALENDAR_FROM,
    to: isoDate(addDays(CALENDAR_FROM, CALENDAR_DAYS - 1)),
    quarter: LATEST_QUARTER,
    event_count: events.length,
    events,
  })}\n`
);

// ---- summary ---------------------------------------------------------------------------
const counts = {};
for (const c of companies) counts[c.archetype] = (counts[c.archetype] || 0) + 1;
const lastOf = (c) => c.quarters.at(-1);
const beats = companies.filter((c) => lastOf(c).eps > c.consensus.eps * 1.01).length;
const misses = companies.filter((c) => lastOf(c).eps < c.consensus.eps * 0.99).length;
console.log(`Wrote ${companies.length} companies -> ${OUT_PATH}`);
console.log(`  archetypes: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  beat/miss/in-line: ${beats} / ${misses} / ${companies.length - beats - misses}`);
console.log(`  loss-making latest quarter: ${companies.filter((c) => lastOf(c).netProfit < 0).length}`);
console.log(`  with exceptional items:     ${companies.filter((c) => lastOf(c).exceptionalItems !== 0).length}`);
console.log(`  other income > 15% of PBT:  ${companies.filter((c) => lastOf(c).pbt > 0 && lastOf(c).otherIncome / lastOf(c).pbt > 0.15).length}`);
console.log(`Wrote ${events.length} calendar events -> ${CALENDAR_PATH}`);
