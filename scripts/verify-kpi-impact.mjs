#!/usr/bin/env node
// scripts/verify-kpi-impact.mjs — the sector → KPI layer on AI Alerts, offline.
//
// Four things are asserted, in the order they can go wrong:
//   1. the YAML reader and the build reproduce the desk's ontology exactly, and the committed
//      public/data/sector-kpis.json is byte-for-byte what the fixture and the classification build;
//   2. every company in the book resolves to a KPI group, and the resolver neither guesses an
//      ambiguous industry nor misses one over punctuation;
//   3. every KPI any rule can name belongs to that group's own list (or is global) — so a rule can
//      never put an operator's or a bank's KPI on the wrong company;
//   4. the traps measured on the shipped captures stay shut: a GST appeal filed as "Receipt of
//      Order", a SEBI takeover-regulation shareholding disclosure, a broker's stock downgrade, the
//      customer's plant in an EPC order, an equipment maker filed under telecom, a dividend a board
//      will only "consider" — each names NO KPI, while the genuine version of each names the right ones.
// No server and no egress.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { parseYamlLite } = await import('./lib/yaml-lite.mjs');
const { buildSectorIndex, resolveGroup, labelKey } = await import('../public/js/data/sector-kpis-shared.js');
const kpi = await import('../public/js/data/kpi-impact.js');
const { announcementEvent } = await import('../public/js/data/daily-alerts.js');
const { nseRecord } = await import('../public/js/data/alert-sources.js');
const { matchKeywords } = await import('../public/js/data/news-keywords.js');
const { ATTRIBUTION_VERSION } = await import('../public/js/data/company-news-attribution.js');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ---------------------------------------------------------------------------------------
// 1. The ontology, read and rebuilt

const yaml = parseYamlLite(readFileSync('scripts/fixtures/sector-kpi-ontology.yaml', 'utf8'));
assert.equal(yaml.version, 2);
assert.equal(Object.keys(yaml.global_kpis).length, 40, 'forty global KPIs');
assert.equal(Object.keys(yaml.kpi_groups).length, 41, 'forty-one KPI groups');
const pairCount = Object.values(yaml.sector_industry_map).reduce((sum, industries) => sum + Object.keys(industries).length, 0);
assert.equal(pairCount, 644, 'the 644 (sector, industry) pairs the stocks table carries');
assert.deepEqual(yaml.global_kpis.revenue.unit_hints.slice(0, 2), ['cr', 'crore']);
assert.equal(yaml.kpi_definitions.advertising_revenue.unit_hints, yaml.kpi_definitions.arpu_media.unit_hints, 'an alias resolves to its anchor');
assert.equal(yaml.sector_industry_map['Consumer Discretionary']['Auto Parts:O.E.M.'], 'auto_components', 'a colon with no space is part of the key');
assert.equal(yaml.sector_industry_map['Energy']['Electric Utilities: Central'], 'utilities', 'a quoted key keeps its colon');
for (const bad of ['a: [1, 2]', 'a: |\n  text', 'a: "double"', 'a: 1\na: 2', 'a:\n\t- x', 'a: b # comment', '- x: y', 'a: *missing']) {
  assert.throws(() => parseYamlLite(bad), /yaml-lite/, `refuses ${JSON.stringify(bad)}`);
}

const committed = readJson('public/data/sector-kpis.json');
assert.equal(committed.source.pairs, 644);
assert.equal(committed.source.tableRows, 29465, 'one row per pair per distinct KPI name — the 23 Sep 2026 export held exactly this many');
assert.equal(Object.keys(committed.groups).length, 41);
assert.equal(committed.globals.length, 40);

// The committed file is exactly what the fixture and the committed classification build.
const scratch = mkdtempSync(join(tmpdir(), 'sector-kpis-'));
try {
  const out = join(scratch, 'sector-kpis.json');
  const run = spawnSync(process.execPath, ['scripts/build-sector-kpis.mjs'], { encoding: 'utf8', env: { ...process.env, SECTOR_KPIS_OUT: out } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(readFileSync(out, 'utf8'), readFileSync('public/data/sector-kpis.json', 'utf8'), 'public/data/sector-kpis.json is stale — re-run scripts/build-sector-kpis.mjs');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('PASS ontology: the YAML reader reproduces the file, the build reconciles to 29,465 seeded rows, and the committed JSON is current.');

// ---------------------------------------------------------------------------------------
// 2. Resolution

const index = buildSectorIndex(yaml.sector_industry_map);
const resolve = (sector, industry, extra = {}) => resolveGroup(index, { sector, industry, broadSector: extra.broadSector || sector, broadIndustry: extra.broadIndustry || industry })?.group ?? null;
assert.equal(resolve('Capital Goods', 'Heavy Electrical Equipment'), 'capital_goods');
assert.equal(resolve('Consumer Durables', 'Gems, Jewellery And Watches'), 'consumer_durables', 'punctuation is not a different industry');
assert.equal(resolve('Services', 'Road AssetsToll, Annuity, Hybrid-Annuity'), 'infrastructure', "Screener's lost dash is not a different industry");
assert.equal(resolve('Realty', 'Real Estate Investment Trusts (REITs)'), 'reit', 'the stated REIT override');
assert.equal(resolve('Financial Services', 'Private Sector Bank'), 'banks');
assert.equal(resolve('Made Up Sector', 'Made Up Industry'), null, 'no nearest guess');
assert.equal(labelKey('Dealers\uFFFD\uFFFD\uFFFDCommercial Vehicles'), labelKey('Dealers-Commercial Vehicles'), 'the replacement characters in the source compare as separators');
// An industry two taxonomies file under different groups is never resolved on its own.
const ambiguous = buildSectorIndex({ A: { Widgets: 'capital_goods' }, B: { Widgets: 'chemicals' } });
assert.equal(resolveGroup(ambiguous, { sector: 'C', industry: 'Widgets' }), null);
assert.equal(resolveGroup(ambiguous, { sector: 'A', industry: 'Widgets' }).group, 'capital_goods');
assert.throws(() => buildSectorIndex({ A: { 'Gems, Jewellery': 'x', 'Gems Jewellery': 'y' } }), /normalises onto a pair/);

const book = readJson('public/data/portfolio-companies.json').holdings.filter((h) => h.ticker);
const missing = book.filter((h) => !committed.companies[h.ticker]).map((h) => h.ticker);
assert.deepEqual(missing, [], `every listed book company resolves to a KPI group (missing: ${missing.join(', ')})`);
console.log(`PASS resolution: ${book.length} of ${book.length} listed book companies resolve; punctuation, the lost dash and REITs resolve; ambiguous industries do not.`);

// ---------------------------------------------------------------------------------------
// 3. Every rule names only its group's own KPIs

const onto = kpi.prime(committed);
const allowedFor = (group) => new Set([...committed.groups[group].kpis, ...committed.globals]);
const SAMPLE_TEXTS = [
  '', 'usfda approval', 'dcgi approval', 'ema approval', 'launch in the us', 'launch in india', 'new prepaid plans',
  'ott streaming subscribers', 'refinery', 'mw plant capacity', 'rooms hotels', 'beds hospital', 'warehouse terminal',
  'aircraft fleet', 'campus students', 'cerc tariff order', '510(k) fda', 'production sales dispatches', 'generation units',
  'cargo volumes', 'aum assets under management', 'refinery throughput', 'mine coal production', 'plant smelter production',
  'opens 5 new stores', 'opens new restaurants', 'opens new labs', 'adds 200 beds', 'signs new hotel', 'opens new campus',
];
let checked = 0;
for (const trigger of kpi.TRIGGERS) {
  for (const group of Object.keys(committed.groups)) {
    for (const text of SAMPLE_TEXTS) {
      const entry = Object.prototype.hasOwnProperty.call(trigger.groups, group) ? trigger.groups[group] : trigger.groups.default;
      const keys = new Set();
      if (Array.isArray(entry)) entry.forEach((k) => keys.add(k));
      else if (typeof entry === 'function') (entry(text) || []).forEach((k) => keys.add(k));
      else if (entry?.kpis) entry.kpis.forEach((k) => keys.add(k));
      for (const lead of Object.values(trigger.lead || {})) lead.keys.forEach((k) => keys.add(k));
      for (const key of keys) {
        assert(committed.kpis[key], `${trigger.id} names undefined KPI ${key}`);
        // A lead KPI is global by construction; everything else must be in the group's own list.
        assert(allowedFor(group).has(key), `${trigger.id} would name ${key} for ${group}, which is not one of its KPIs`);
        checked += 1;
      }
    }
  }
}
assert(checked > 1000);
console.log(`PASS rules: ${checked} (trigger, group, KPI) readings checked; every KPI a rule can name belongs to that group's own list or is global.`);

// ---------------------------------------------------------------------------------------
// 4. The item → KPI readings, and the traps

const groupOf = (ticker) => committed.companies[ticker]?.group;
const expectGroup = (ticker, group) => assert.equal(groupOf(ticker), group, `${ticker} is classified ${group}`);
for (const [ticker, group] of Object.entries({
  BHEL: 'capital_goods', SASKEN: 'it_services', TECHM: 'it_services', SBIN: 'banks', JSL: 'metals', LUPIN: 'pharma',
  GLENMARK: 'pharma', CANFINHOME: 'nbfc', 'M&M': 'auto', DCW: 'chemicals', EIHOTEL: 'hotels', BLS: 'hotels',
  TEJASNET: 'telecom', KOVAI: 'hospitals', EMBASSY: 'reit', JPPOWER: 'power', JYOTHYLAB: 'consumer_staples',
  CROMPTON: 'consumer_durables', SHREDIGCEM: 'cement', ENGINERSIN: 'infrastructure', SHOPERSTOP: 'retail',
})) expectGroup(ticker, group);

let seq = 0;
const bse = (ticker, title, subCategory = 'General', category = 'Company Update') => ({
  ...announcementEvent({ newsId: `fixture-${++seq}`, ticker, title, headline: title, subCategory, category, date: '2026-09-22', time: '10:00:00', url: `https://example.test/${seq}`, source: 'BSE' }),
  feed: 'announcements',
});
const nse = (ticker, subject, description) => ({ ...nseRecord({ ticker, company: ticker, subject, description, publishedAt: '2026-09-22T05:00:00.000Z', url: `https://example.test/nse/${++seq}` }), feed: 'nse-filings' });
const news = (ticker, headline, attribution = 'confirmed') => {
  const hits = matchKeywords(headline);
  return {
    id: `news:${++seq}`, feed: 'news', ticker, day: '2026-09-22', headline, importance: hits.some((h) => h.where === 'title') ? 'high' : 'low',
    keywordIds: hits.map((h) => h.id), keywords: hits.map((h) => h.label), direction: 'neutral',
    attribution: { version: ATTRIBUTION_VERSION, status: attribution, reason: 'fixture' },
  };
};
const names = (card) => kpi.kpiImpactOf(card, onto)?.items.map((item) => (item.value ? `${item.name} ${item.value}` : item.name)) ?? null;
const one = (event) => names({ ticker: event.ticker, events: [event] });
const reads = (event, expected, message) => assert.deepEqual(one(event), expected, message || `${event.ticker}: ${event.headline}`);

// Orders — and the orders that are not business won.
reads(bse('BHEL', 'Receipt of order worth Rs. 2,500 crore for supply of boilers', 'Award of Order / Receipt of Order'), ['Order Inflow', 'Order Book', 'Book-to-Bill Ratio']);
reads(bse('SASKEN', 'Please find enclosed details of the Order passed by the Joint Commissioner Appeals, GST Department, Bengaluru.', 'Award of Order / Receipt of Order'), null,
  'a GST appeal filed under the exchange\'s "Receipt of Order" label is not an order win');
reads(bse('BHEL', "Receipt of Order from Hon'ble NCLT, Chennai Bench", 'Scheme of Arrangement'), null, 'a tribunal order is not an order win');
reads(bse('KPIL', 'Arbitral tribunal award of Rs 210 crore on the contract awarded by NHAI', 'Litigation'), null, 'an arbitration award is not an order win, even where the filing rule matches');
reads(news('TECHM', 'Tech Mahindra wins $500 million contract from European telco'), ['Deal Wins (TCV)'], 'an IT contract is Deal Wins, not an order book');
reads(news('SBIN', 'SBI wins contract worth Rs 100 crore for payments platform'), null, 'a bank carries no order KPI');
reads(news('BHEL', 'BHEL bags order for erection and commissioning of 800 MW unit'), ['Order Inflow', 'Order Book', 'Book-to-Bill Ratio'],
  "the commissioning in an EPC order is the customer's plant, not BHEL's capacity");
reads(news('BHEL', 'BHEL order cancelled by NTPC for Rs 500 crore boiler contract'), ['Order Book'], 'a cancellation is the order book, never a win');

// Takeover-regulation disclosures, promoter buying, subsidiaries — not a business bought.
reads(nse('BHEL', 'Disclosures under Reg. 29(2) of SEBI (SAST) Regulations, 2011', 'The Exchange has received the disclosure under Regulation 29(2) of SEBI (Substantial Acquisition of Shares & Takeovers) Regulations, 2011 for BHEL'), null,
  'a SAST shareholding disclosure is not an acquisition');
reads(bse('CROMPTON', 'Promoter group has acquired equity shares of the company from open market', 'Acquisition'), null);
reads(bse('CROMPTON', 'Incorporation of a wholly owned subsidiary', 'Acquisition'), null);
reads(bse('CROMPTON', 'Completion of acquisition of 100% stake in Butterfly Gandhimathi Appliances', 'Acquisition'), ['Revenue', 'EBITDA', 'Net Debt']);
// A completed acquisition that cites the takeover regulations it was made under keeps its KPIs, as it
// keeps its high Acquisition reading in filing-signals.js; the same words about a promoter buying the
// company's own shares, or an acquisition that has not completed, still name none.
reads(bse('CROMPTON', 'Completion of acquisition of 51% stake pursuant to SEBI (SAST) Regulations, 2011', 'Acquisition'), ['Revenue', 'EBITDA', 'Net Debt'],
  'a completed acquisition citing SAST is a business bought');
reads(bse('CROMPTON', 'Completion of acquisition of shares of the Company by the promoter under SEBI (SAST) Regulations, 2011', 'Acquisition'), null,
  "a promoter's completed purchase of the company's own shares is not a business bought");
reads(bse('CROMPTON', 'Intimation under SEBI (SAST) Regulations, 2011 - acquisition of equity shares', 'Acquisition'), null,
  'the regulations named without a completed acquisition still name nothing');

// Credit ratings — and a broker's stock call, which is not one.
reads(news('JSL', 'ICRA downgrades Jindal Stainless long-term rating to AA-'), ['Finance Cost']);
reads(news('SBIN', 'Morgan Stanley downgrades SBI to underweight, cuts target price'), null, "a broker's stock rating is not a credit rating");
reads(bse('SBIN', 'Credit rating upgrade by CRISIL for long-term bank facilities', 'Credit Rating'), ['Cost of Funds'], "a bank's credit rating is its cost of funds");
reads(bse('SBIN', 'Credit rating reaffirmed by CRISIL', 'Credit Rating'), null, 'a reaffirmation moves nothing');

// Pharma: approvals and inspections are the US franchise.
reads(news('LUPIN', 'Lupin receives USFDA approval for generic diabetes drug'), ['US Revenue', 'ANDA Filings']);
reads(bse('GLENMARK', 'Glenmark receives Establishment Inspection Report from U.S. FDA for its Goa facility with VAI classification', 'Press Release / Media Release'), ['US Revenue', 'ANDA Filings']);
reads(news('GLENMARK', "USFDA issues warning letter to Glenmark's Goa plant"), ['US Revenue', 'ANDA Filings'], 'an inspection outcome counts even without a tracked keyword');
reads(bse('LUPIN', 'Board approves the draft scheme of arrangement', 'Scheme of Arrangement'), null, 'a board approval is not a regulator');

// Capital raising.
reads(news('SBIN', 'SBI raises Rs 10,000 crore via QIP'), ['Capital Adequacy Ratio', 'EPS', 'Book Value Per Share'], "a bank's QIP is capital adequacy first");
reads(nse('CANFINHOME', 'Allotment of Securities', 'Can Fin Homes Limited has informed the Exchange regarding allotment of securities pursuant to Qualified Institution Placement'), ['Capital Adequacy Ratio', 'EPS', 'Book Value Per Share']);
reads(bse('CANFINHOME', 'Allotment of equity shares under ESOP scheme 2021', 'Allotment of Equity Shares'), null, 'an ESOP allotment is not a capital raise');

// Operations: capacity, network, launches, disruption — and the supplier filed under an operator group.
reads(news('SHREDIGCEM', 'Shree Digvijay Cement announces capacity expansion of 2 MTPA'), ['Capital Expenditure', 'Volume', 'Capacity Utilization']);
reads(news('ENGINERSIN', 'EIL to execute greenfield refinery project in Kenya'), null, "a client's refinery is not EIL's capacity");
reads(bse('SHREDIGCEM', 'Company wins environmental clearance for the capacity expansion of its Sikka plant'), ['Capital Expenditure', 'Volume', 'Capacity Utilization'],
  'a clearance the company wins for its own expansion is its own capacity');
reads(news('M&M', 'Mahindra launches new electric SUV model'), ['Volumes']);
reads(bse('TEJASNET', 'Tejas Networks launches new router platform', 'Press Release / Media Release'), null, 'an equipment maker filed under telecom carries no ARPU');
reads(bse('EIHOTEL', 'EIH Limited signs management contract for new hotel in Goa with 120 rooms'), ['Room Keys']);
reads(bse('BLS', 'BLS International opens new visa application centres in Italy'), null, 'a visa-services company filed under travel carries no room keys');
reads(bse('SHOPERSTOP', 'Shoppers Stop opens 6 new stores'), ['Store Count']);
reads(bse('KOVAI', 'Kovai Medical Center adds 200 beds at its new hospital block'), ['Occupied Beds']);
reads(news('DCW', "Fire breaks out at DCW's Sahupuram plant"), ['Sales Volume', 'Capacity Utilization']);
reads(bse('JPPOWER', 'Suspension of operations at Unit 2 of the Bina thermal power plant due to flood'), ['Units Generated', 'Plant Load Factor']);
reads(bse('JPPOWER', 'Resumption of operations at Unit 2 of the Bina thermal power plant'), ['Units Generated', 'Plant Load Factor']);
reads(bse('BHEL', 'Closure of Trading Window'), null);

// Distributions.
reads(bse('JYOTHYLAB', 'Outcome of board meeting - declared interim dividend of Rs 3.5 per share', 'Outcome of Board Meeting', 'Board Meeting'), ['Dividend Per Share']);
reads(bse('JYOTHYLAB', 'Intimation of board meeting to consider interim dividend, if any', 'Board Meeting Intimation', 'Board Meeting'), null, 'a dividend a board will only consider sets no figure');
reads(bse('EMBASSY', 'Embassy Office Parks REIT declares distribution of Rs 5.8 per unit'), ['Distribution per Unit']);

// Periodic updates.
reads(bse('SBIN', 'Business update for the quarter ended September 30, 2026'), ['Advances / Loan Book', 'Deposits', 'CASA Ratio']);
reads(bse('M&M', 'Auto sales update for September 2026'), ['Volumes', 'Domestic Volumes', 'Export Volumes']);
reads(bse('SBIN', 'Clarification sought on spurt in volume'), null, "an exchange's price-and-volume query is not a business update");

// Feeds, attribution and classification that can never name a KPI.
reads({ ...news('SBIN', 'SBI raises Rs 10,000 crore via QIP'), feed: 'market-news' }, null, 'market-wide news carries no company');
reads(news('SBIN', 'SBI raises Rs 10,000 crore via QIP', 'uncertain'), null, 'unconfirmed news supports nothing');
reads({ ...news('SBIN', 'SBI raises Rs 10,000 crore via QIP'), aiEligible: false }, null);
reads({ id: 't1', feed: 'technicals', ticker: 'BHEL', kind: 'volume', volumeX: 4.2, headline: 'Volume 4.2x', importance: 'high' }, null, 'the tape names no KPI');
reads({ ...bse('BHEL', 'Receipt of order worth Rs. 2,500 crore for supply of boilers', 'Award of Order / Receipt of Order'), ticker: 'NOTACLASSIFIEDCO' }, null, 'no sector, no line');

// AN INCIDENT NAMES AN OUTPUT KPI ONLY AT A PRODUCTION SITE, and a capex figure is capacity only
// where the text says what it builds. Both were live readings before: an office fire claimed an
// outage cut output, and a digital capex programme claimed volume growth.
reads(news('JYOTHYLAB', 'Fire breaks out at Jyothy Labs corporate office'), null, 'an office fire is not a lost day of production');
reads(news('JYOTHYLAB', 'Fire at Jyothy Labs warehouse in Bhiwandi'), null, 'a warehouse fire destroys stock, not capacity');
reads(news('JYOTHYLAB', 'Major fire at Jyothy Labs factory halts production'), ['Volume Growth']);
reads(news('JYOTHYLAB', 'Jyothy Labs announces Rs 100 crore digital capex programme'), ['Capital Expenditure'], 'bare capex is spend: the Capex KPI and nothing it does not build');
assert.equal(kpi.kpiImpactOf({ ticker: 'JYOTHYLAB', events: [news('JYOTHYLAB', 'Jyothy Labs announces Rs 100 crore digital capex programme')] }, onto).items[0].triggerLabel, 'Capex plan');
reads(news('SHREDIGCEM', 'Shree Digvijay Cement plans Rs 500 crore capex to add 2 MTPA capacity'), ['Capital Expenditure', 'Volume', 'Capacity Utilization'],
  'capex that names its capacity still reads as capacity');

// A filed result is the one measured move, printed as the source reported it.
reads({ id: 'r1', feed: 'earnings', ticker: 'BHEL', headline: 'YoY quarterly result filed', resultBasis: 'YoY',
  metrics: { revenue: { label: 'Revenue', pct: 13, kind: 'normal' }, netProfit: { label: 'Net Profit', pct: null, kind: 'turnaround' } } }, ['Revenue +13%', 'PAT to profit']);
assert.equal(kpi.resultValue({ pct: -4.25, kind: 'normal' }), '−4.3%');
assert.equal(kpi.resultValue({ pct: null, kind: 'loss-widened' }), 'loss widened');
assert.equal(kpi.resultValue({ pct: 12, kind: 'unknown-kind' }), null, 'an unknown comparison is not printed');
// NOTHING IN THE PRIOR PERIOD HAS NO GROWTH RATE, BUT THE LINE WAS STILL REPORTED. The feed files
// 61 net-profit and 17 revenue comparisons as `from-zero`; dropping them lost the KPI altogether.
assert.equal(kpi.resultValue({ pct: null, kind: 'from-zero' }), 'from zero');
reads({ id: 'r2', feed: 'earnings', ticker: 'BHEL', headline: 'YoY quarterly result filed', resultBasis: 'YoY',
  metrics: { revenue: { label: 'Revenue', pct: null, kind: 'from-zero' }, netProfit: { label: 'Net Profit', pct: 8, kind: 'normal' } } }, ['Revenue from zero', 'PAT +8.0%']);
reads({ id: 'r3', feed: 'earnings', ticker: 'BHEL', headline: 'YoY quarterly result filed', resultBasis: 'YoY',
  metrics: { revenue: { label: 'Revenue', pct: null, kind: 'na' }, netProfit: null } }, null, 'a comparison the source could not make names nothing');

// Con-call highlights: the provider's words name a KPI — acronyms only in capitals, generic words never.
const call = (ticker, tags) => ({ id: `c${++seq}`, feed: 'concalls', ticker, headline: 'Con-call analysis published', tags, importance: 'high' });
reads(call('SBIN', ['▲ Cost-to-income 42.3% → 38.4%']), ['Cost to Income Ratio']);
reads(call('SBIN', ['▲ NIM expanded 20bps QoQ']), ['Net Interest Margin']);
reads(call('SBIN', ['▲ nim steady']), null, 'a lower-case acronym is a word, not a KPI');
reads(call('SBIN', ['● Capacity utilization figures undisclosed']), null, 'a disclosure gap is not a KPI in play');
reads(call('BHEL', ['▲ Record quarterly revenue, EBITDA, PAT']), ['Revenue', 'EBITDA', 'PAT']);
reads(call('BHEL', ['▲ Strong sales momentum']), null, '"sales" is too generic to name a KPI');
reads(call('LUPIN', ['▲ US EBITDA margins 34–35%']), ['EBITDA Margin'], 'the plural is the same KPI');
reads(call('TECHM', ['▲ Record ₹1,719cr revenue quarter']), ['Revenue'], 'rupee revenue is not filed under the dollar-revenue KPI');

// The card: strongest evidence first, one chip per KPI name, the rest counted.
const orderEvent = bse('BHEL', 'Receipt of order worth Rs. 2,500 crore for supply of boilers', 'Award of Order / Receipt of Order');
const card = { ticker: 'BHEL', events: [orderEvent, call('BHEL', ['▲ Record quarterly revenue, EBITDA, PAT', '▲ Order book ₹1,00,000cr'])] };
const impact = kpi.kpiImpactOf(card, onto);
assert.equal(impact.group, 'capital_goods');
assert.equal(impact.groupLabel, 'Capital Goods');
assert.deepEqual(impact.items.map((item) => item.name), ['Order Inflow', 'Order Book', 'Book-to-Bill Ratio', 'Revenue', 'EBITDA', 'PAT']);
assert.equal(impact.items[1].eventId, orderEvent.id, 'a KPI named twice is credited to the strongest event');
// EVERY KPI STAYS IN THE MODEL. The four-chip cap is the view's: search, a bookmark and an export
// read the whole list, so EBITDA and PAT here are findable by name rather than reduced to "+2".
assert.equal(impact.total, 6);
assert.deepEqual(impact.items.slice(4).map((item) => item.name), ['EBITDA', 'PAT'], 'the KPIs past the fourth chip are kept, by name');
assert.equal(impact.overflow, undefined, 'the model carries no display count');
assert.match(kpi.kpiLine(impact), /^Order Inflow · Order Book · Book-to-Bill Ratio · Revenue · EBITDA · PAT \(Capital Goods\)$/);
const { matchesSearch } = await import('../public/js/ui/ai-alert-utils.js');
assert(matchesSearch({ ticker: 'BHEL', company: 'BHEL', events: [], kpis: impact }, 'ebitda'), 'search finds a card by a KPI past the chip cap');
const cement = kpi.kpiImpactOf({ ticker: 'SHREDIGCEM', events: [news('SHREDIGCEM', 'Shree Digvijay Cement announces capacity expansion of 2 MTPA'), call('SHREDIGCEM', ['▲ Cement volume up 12%'])] }, onto);
assert.equal(cement.items.filter((item) => item.name === 'Volume').length, 1, 'one chip per KPI name, however many keys carry it');
console.log('PASS readings: orders, raises, ratings, approvals, operations, distributions, updates, results and con-call highlights name the right KPIs; every measured trap names none.');

// ---------------------------------------------------------------------------------------
// 5. The false alerts the same traps raised in the materiality rule itself

const { announcementSignal } = await import('../public/js/data/filing-signals.js');
const sast = announcementSignal({ category: 'Insider Trading / SAST', subCategory: 'Disclosures under Reg. 29(2) of SEBI (SAST) Regulations, 2011',
  title: 'Disclosures under Reg. 29(2) of SEBI (SAST) Regulations, 2011', description: 'The Exchange has received the disclosure under Regulation 29(2) of SEBI (Substantial Acquisition of Shares & Takeovers) Regulations, 2011' });
assert.equal(sast.importance, 'low', 'a takeover-regulation shareholding disclosure is not a high-importance acquisition');
assert(!sast.keywords.includes('Acquisition'), 'and it carries no Acquisition topic');
assert.match(sast.importanceReason, /Acquisition was not counted: this is a shareholding disclosure under SEBI's takeover regulations/);
// …but a filing that cites the regulations because an acquisition COMPLETED is a change of control.
const completed = announcementSignal({ category: 'Company Update', subCategory: 'Acquisition',
  title: 'Completion of acquisition of 51% stake pursuant to SEBI (SAST) Regulations, 2011' });
assert.equal(completed.importance, 'high', 'a completed acquisition citing SAST keeps its reading');
assert(completed.keywordIds.includes('acquisition'));
const openOffer = announcementSignal({ category: 'Company Update', subCategory: 'General', title: 'Public announcement of open offer for acquisition of up to 26% of the shares under SEBI (SAST) Regulations' });
assert.equal(openOffer.importance, 'high', 'an open offer IS a takeover, and stays high');
assert(openOffer.keywords.includes('Acquisition'));
const gst = announcementSignal({ category: 'Company Update', subCategory: 'Award of Order / Receipt of Order', title: 'Please find enclosed details of the Order passed by the Joint Commissioner Appeals, GST Department, Bengaluru.' });
assert.equal(gst.importance, 'low', 'a GST appeal order is not business won');
assert.deepEqual(gst.keywordIds, []);
assert.match(gst.importanceReason, /Order was not counted: this is an order a court, tribunal or tax authority passed/);
const demand = announcementSignal({ category: 'Company Update', subCategory: 'General', title: 'Receipt of tax demand order of Rs 45 crore from the Income Tax Department' });
assert.equal(demand.direction, 'negative', 'a tax demand is still read by the enforcement rule');
assert.equal(demand.importance, 'high');
const won = announcementSignal({ category: 'Company Update', subCategory: 'Award of Order / Receipt of Order', title: 'Receipt of order worth Rs 120 crore (excluding taxes) for supply of transformers' });
assert.equal(won.importance, 'high', '"excluding taxes" does not turn a supply order into a tax order');
assert(won.keywordIds.includes('receipt-of-order'));
console.log('PASS false alerts: SEBI takeover-regulation disclosures and court/tax orders no longer read as acquisitions or orders won; open offers, tax demands and real orders keep their readings.');

// ---------------------------------------------------------------------------------------
// 6. On a ranked card: the line is there, and the score is untouched

const { rankReport, clearRankingCache } = await import('../public/js/data/ai-alerts.js');
const feeds = ['announcements', 'news', 'concalls'].map((id) => ({ id, status: 'ok', reachesToday: true }));
const report = { day: '2026-09-22', scope: 'universe', feeds, events: [
  { ...orderEvent, day: '2026-09-22', company: 'BHEL', importance: 'high' },
  { ...bse('NOTACLASSIFIEDCO', 'Receipt of order worth Rs. 90 crore for supply of pumps', 'Award of Order / Receipt of Order'), day: '2026-09-22', company: 'Unclassified Co', importance: 'high' },
] };
const withKpis = rankReport(report, { holdings: [], companyMetadata: [], insightCompanies: [], sectorKpis: onto });
clearRankingCache();
const without = rankReport(report, { holdings: [], companyMetadata: [], insightCompanies: [], sectorKpis: null });
const bhel = withKpis.allCards.find((c) => c.ticker === 'BHEL');
assert.deepEqual(bhel.kpis.items.map((item) => item.name), ['Order Inflow', 'Order Book', 'Book-to-Bill Ratio']);
assert.equal(withKpis.allCards.find((c) => c.ticker === 'NOTACLASSIFIEDCO').kpis, null, 'an unresolved company carries no KPI line');
assert.equal(without.allCards.find((c) => c.ticker === 'BHEL').kpis, null, 'no ontology, no line');
assert.deepEqual(withKpis.allCards.map((c) => [c.ticker, c.score, c.priority]), without.allCards.map((c) => [c.ticker, c.score, c.priority]),
  'the KPI layer adds no score and changes no priority');
console.log('PASS ranking: cards carry the KPI line for a resolved company, none for an unresolved one, and every score and priority is unchanged.');

// ---------------------------------------------------------------------------------------
// 7. The file is re-read on the page's checks, and a gap in it is said rather than hidden

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
let served = committed;
let requests = 0;
let refuse = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (path) => {
  requests += 1;
  assert.equal(String(path), kpi.KPI_FILE);
  if (refuse) throw new Error('offline');
  return new Response(JSON.stringify(served), { headers: { 'content-type': 'application/json' } });
};
try {
  const held = kpi.prime(committed);
  assert.equal(await kpi.load(), held, 'a copy confirmed moments ago is not asked for again');
  assert.equal(requests, 0);
  clock += kpi.RECHECK_MS + 1;
  assert.equal(await kpi.load(), held, 'an unchanged file keeps the same ontology, so the ranking memo survives the check');
  assert.equal(requests, 1);
  clock += kpi.RECHECK_MS + 1;
  served = { ...committed, companies: { ...committed.companies, NEWHOLDING: { group: 'banks', sector: 'Financial Services', industry: 'Private Sector Bank', via: 'pair' } } };
  const changed = await kpi.load();
  assert.notEqual(changed, held, 'a republished file replaces the ontology without a reload');
  assert.equal(kpi.snapshot(), changed);
  assert.equal(kpi.companyContext(changed, 'NEWHOLDING').group, 'banks', 'a newly classified holding is placed on the next check');
  clock += kpi.RECHECK_MS + 1;
  refuse = true;
  assert.equal(await kpi.load(), changed, 'a failed re-read keeps the copy it had');
  assert.equal(kpi.status().state, 'ready');
  assert.match(kpi.status().recheckError, /could not be re-read/, 'and says the re-read failed');
  refuse = false;
  assert.equal(await kpi.load(), changed, 'the next check asks again at once and, finding it unchanged, keeps it');
  assert.equal(kpi.status().recheckError, null);
  kpi.prime(null);
  refuse = true;
  assert.equal(await kpi.load(), null, 'a first read that fails holds nothing');
  assert.equal(kpi.status().state, 'failed');
  refuse = false;
  kpi.prime({ ...committed, counts: { ...committed.counts, unresolved: 3, classificationFailed: 2 } });
  assert.equal(kpi.status().classificationFailed, 2, "the classification's failed re-reads travel with the file");
  assert.equal(kpi.status().unresolved, 3);
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  kpi.prime(committed);
}

// A holding whose latest re-read failed fails the scheduled job too, even though its earlier
// classification is kept — and the built file carries every failure for the source registry.
const gapScratch = mkdtempSync(join(tmpdir(), 'sector-kpis-gap-'));
try {
  const classification = readJson('public/data/company-classification.json');
  const [kept, lost] = book.map((h) => h.ticker).filter((t) => classification.companies[t]).slice(0, 2);
  delete classification.companies[lost];
  classification.failed = { [kept]: { reason: 'HTTP 503', at: '2026-09-23T01:40:00.000Z' }, [lost]: { reason: 'HTTP 404', at: '2026-09-23T01:40:05.000Z' } };
  const classificationPath = join(gapScratch, 'company-classification.json');
  const out = join(gapScratch, 'sector-kpis.json');
  writeFileSync(classificationPath, JSON.stringify(classification));
  const env = { ...process.env, SECTOR_KPIS_CLASSIFICATION: classificationPath, SECTOR_KPIS_OUT: out };
  const built = spawnSync(process.execPath, ['scripts/build-sector-kpis.mjs'], { encoding: 'utf8', env });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const payload = readJson(out);
  assert.equal(payload.counts.classificationFailed, 2);
  assert.deepEqual(payload.classificationFailed[kept], { reason: 'HTTP 503', at: '2026-09-23T01:40:00.000Z', retained: true });
  assert.equal(payload.classificationFailed[lost].retained, false);
  const check = spawnSync(process.execPath, ['scripts/build-sector-kpis.mjs', '--check-book'], { encoding: 'utf8', env });
  assert.equal(check.status, 1, 'the job fails');
  assert.match(check.stderr, new RegExp(`${kept}: latest page re-read failed \\(HTTP 503\\); the earlier classification is kept`));
  assert.match(check.stderr, new RegExp(`${lost}: page not read \\(HTTP 404\\)`));
} finally {
  rmSync(gapScratch, { recursive: true, force: true });
}
console.log('PASS freshness: the file is re-read on the page\'s checks, an unchanged file keeps its ontology, a changed one is adopted, a failed re-read keeps the held copy and says so, and a failed classification re-read is carried into the file and fails the scheduled job.');

