#!/usr/bin/env node
// Fixture tests for the catalyst engine behind AI Recommendations. No network, no server.
// Every trap the engine closes is asserted here with the filing wording that once fooled it,
// and the shipped publication (public/data/ai-catalysts.json), when present, is checked for shape.
//   node scripts/verify-catalyst-engine.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyFiling, prepareFiling, scoreCompany, materiality, filingStatement, tidyStatement, decay, CATALYSTS } from '../public/js/data/catalyst-engine.js';
import { sectorWeight, playbookFor, inferGroup, SECTOR_PLAYBOOKS } from '../public/js/data/catalyst-playbooks.js';
import { validateIdeas, createRecommendationFeed } from '../public/js/data/ai-recommendations.js';

let passed = 0;
const pending = [];
const test = (name, fn) => {
  const done = () => { passed++; console.log(`ok  ${name}`); };
  const r = fn();
  if (r?.then) pending.push(r.then(done)); else done();
};
const types = (row) => classifyFiling(row).map((c) => c.type);
const filing = (headline, extra = {}) => ({ headline, date: '2026-10-20', source: 'BSE', url: 'https://www.bseindia.com/x.pdf', ...extra });

// ---------------------------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------------------------
test('a sized order is an order win with its amount', () => {
  const p = prepareFiling(filing('KEC International wins New Orders of Rs. 1,303 crores', { subCategory: 'Award of Order / Receipt of Order' }));
  assert.deepEqual(p.catalysts.map((c) => c.type), ['order-win']);
  assert.equal(p.amountCr, 1303);
});
test('a court or tax "order" is never business won', () => {
  assert.deepEqual(types(filing('Receipt Of Order From Karnataka GST Dept', { subCategory: 'Award of Order / Receipt of Order' })), ['legal-risk']);
  assert.ok(!types(filing('Order passed by the Joint Commissioner Appeals, GST Department')).includes('order-win'));
});
test('the LODR citation is not a SEBI action', () => {
  assert.deepEqual(types(filing('Pursuant to Regulation 44(3) of SEBI LODR 2015 and Notice of Postal Ballot dated 29th May, 2026, we attached the Results of Postal Ballot through remote e-voting')), []);
  assert.deepEqual(types(filing('Voting Results and Scrutinizer Reports of the meetings of Equity Shareholders convened pursuant to the Order of the Hon\'ble NCLT')), []);
});
test('newspaper copies, certificates and news clarifications say nothing', () => {
  assert.deepEqual(types(filing('Copy of Newspaper Publication')), []);
  assert.deepEqual(types(filing('Certificate under SEBI (Depositories and Participants) Regulations, 2018')), []);
  assert.deepEqual(types(filing('The Exchange has sought clarification from SAIL with respect to recent news item captioned SAIL eyes 5% FPO')), []);
});
test('a statutory auditor resigning is a governance flag; an internal auditor is not', () => {
  const hit = classifyFiling(filing('Resignation of Statutory Auditors'));
  assert.equal(hit[0].type, 'governance'); assert.equal(hit[0].kind, 'auditor-exit');
  assert.ok(!types(filing('Resignation of Internal Auditor of the company')).includes('governance'));
});
test('commissioning is capacity, except inside an order\'s scope', () => {
  assert.deepEqual(types(filing('Commencement of commercial production at the new plant at Ludhiana')), ['capacity-live']);
  assert.deepEqual(types(filing('Order worth Rs 450 crore for supply, erection and commissioning of a 660 MW unit')), ['order-win']);
});
test('"cable fire safety" is a product, not a fire', () => {
  assert.deepEqual(types(filing('Hindalco Commissions India\'s First Superfine ATH Plant, Strengthening Cable Fire Safety')), ['capacity-live']);
  assert.deepEqual(types(filing('Intimation of Fire Incident at Factory Premises')), ['disruption']);
});
test('a USFDA warning letter is an adverse inspection; a SEBI warning letter is not', () => {
  assert.deepEqual(types(filing('Unit I of Eugia Pharma received a Warning Letter from US FDA')), ['inspection-adverse']);
  assert.ok(!types(filing('Reply to the SEBI administrative warning letter dated September 10, 2026')).includes('inspection-adverse'));
  assert.deepEqual(types(filing('Lupin Receives EIR from U.S. FDA for its Somerset Facility with VAI Classification')), ['inspection-clean']);
});
test('a subsidiary\'s voluntary liquidation is not distress; the company\'s own default is', () => {
  assert.ok(!types(filing('Voluntary liquidation of Argoid Analytics Private Limited, a wholly owned subsidiary')).includes('distress'));
  assert.ok(!types(filing('Liquidation of a stepdownsubsidiary of the Company')).includes('distress'));
  assert.deepEqual(types(filing('Intimation of default in the payment of principal and interest to banks by the company')), ['distress']);
});
test('a bare CIRP label from a creditor is weak; the company\'s own CIRP is not', () => {
  assert.ok(classifyFiling(filing('Corporate Insolvency Resolution Process'))[0].weight < 0.5);
  assert.ok(classifyFiling(filing('Outcome of meeting of Committee of Creditors of the company under CIRP'))[0].weight >= 0.8);
});
test('credit upgrades count; ESG ratings do not', () => {
  assert.deepEqual(types(filing('ICRA has upgraded JSW Steel Limited\'s long-term credit rating to [ICRA]AA+; stable outlook')), ['rating-up']);
  assert.deepEqual(types(filing('Revision in ESG Rating: Upgrade in Impact Rating to 80 from 76')), []);
  assert.deepEqual(types(filing('CARE Ratings downgrades the bank facilities of the company to CARE BB')), ['rating-down']);
});
test('a demerger unlocks value; a routine amalgamation notice does not', () => {
  assert.deepEqual(types(filing('Board approves demerger of the consumer business into a separately listed company')), ['value-unlock']);
  assert.ok(!types(filing('Update on Scheme of Amalgamation (Merger by Absorption) of wholly owned subsidiary')).includes('value-unlock'));
});
test('a buyback returns capital; a meeting to consider one is a weaker intent', () => {
  assert.equal(classifyFiling(filing('Board approves buyback of equity shares through tender offer'))[0].type, 'capital-return');
  assert.ok(classifyFiling(filing('Board meeting to consider buyback of equity shares'))[0].weight < 1);
  assert.deepEqual(types(filing('Buyback of NCDs')), []);
});
test('promoter warrants are an infusion; a QIP is a neutral capital raise; ESOPs are nothing', () => {
  assert.deepEqual(types(filing('Allotment of warrants on a preferential basis to Promoter Group entity')), ['promoter-infusion']);
  assert.deepEqual(types(filing('The Company raises INR 1500 Cr through Qualified Institutions Placement')), ['growth-capital']);
  assert.equal(CATALYSTS['growth-capital'].tone, 0);
  assert.deepEqual(types(filing('Allotment of equity shares under ESOP scheme on a preferential basis')), []);
});
test('a favourable order is a legal win; an appeal dismissed against a demand is not', () => {
  assert.deepEqual(types(filing('Favorable appellate order in Income Tax Matter for Assessment Year 2024-25')), ['legal-win']);
  assert.ok(!types(filing('The Joint Commissioner (Appeals) has dismissed the appeal filed against the demand order passed by Superintendent, Central Tax')).includes('legal-win'));
  assert.ok(!types(filing('Board meeting held on 14.07.2026 in its meeting appointed a director')).includes('legal-win'));
});
test('buying a stake inside the group is not a deal; buying a business is', () => {
  assert.ok(!types(filing('Acquisition of 49% direct stake in Welspun Special Coating Private Limited, a step down wholly-owned subsidiary of the Company')).includes('deal'));
  assert.deepEqual(types(filing('Acquisition of 70% stake in SN Genelab Private Limited from its existing shareholders. Post acquisition, S N Gene shall become a Subsidiary of the Company')), ['deal']);
  assert.ok(!types(filing('Acquisition of India Infoline Foundation')).includes('deal'));
});
test('winning an insolvent business is an acquisition, not distress', () => {
  assert.deepEqual(types(filing('Identification of Company\'s subsidiary as Successful Resolution Applicant for Bhilai Jaypee Cement Limited')), ['deal']);
});
test('a company\'s own order band states a size without a number', () => {
  const p = prepareFiling(filing('L&T Energy CarbonLite Solutions Secures LNTP for 1,600 MW Thermal Power Plant (Major*) Order', { subCategory: 'Award of Order / Receipt of Order' }));
  assert.equal(p.amountCr, 5000); assert.equal(p.amountBand, true);
  assert.notEqual(prepareFiling(filing('Order for an Ultra Mega Power Project substation worth Rs 120 crore', { subCategory: 'Award of Order / Receipt of Order' })).amountCr, 15000);
});
test('the statement is the most informative of the filing\'s fields', () => {
  assert.equal(filingStatement({ summary: 'JSW Steel Limited has informed the Exchange about Credit Rating', headline: 'India Ratings & Research upgrades JSW Steel Limited to IND AA+, Outlook stable.', subject: 'Announcement under Regulation 30 (LODR)-Credit Rating', subCategory: 'Credit Rating' }),
    'India Ratings & Research upgrades JSW Steel Limited to IND AA+, Outlook stable');
  assert.equal(tidyStatement('Intimation under Regulation 30 of the SEBI (LODR) Regulations, 2015 - Commissioning of Project'), 'Commissioning of Project');
  assert.equal(tidyStatement('We are pleased to inform all stakeholders that the Company has secured export orders worth ~USD 54.81 million'), 'The Company has secured export orders worth ~USD 54.81 million');
});

// ---------------------------------------------------------------------------------------------
// size, sector, time
// ---------------------------------------------------------------------------------------------
test('materiality rises with size against revenue and against market cap', () => {
  const r = (x) => materiality(x, { quarterRevenueCr: 1000, type: 'order-win' }).factor;
  assert.ok(r(20) < r(150) && r(150) < r(600) && r(600) < r(1200) && r(1200) < r(2500));
  const m = (x) => materiality(x, { mcapCr: 10000, type: 'legal-risk' }).factor;
  assert.ok(m(5) < m(60) && m(60) < m(250) && m(250) < m(700));
  assert.ok(materiality(null, { type: 'legal-risk' }).factor < 1, 'an unsized legal matter is discounted');
});
test('recency halves on the half-life', () => {
  assert.equal(decay(0, 60), 1); assert.ok(Math.abs(decay(60, 60) - 0.5) < 1e-9);
});
test('sector playbooks: a bank wins no orders, pharma lives on approvals', () => {
  assert.equal(sectorWeight('banks', 'order-win'), 0);
  assert.ok(sectorWeight('pharma', 'approval') > 1.5 && sectorWeight('capital_goods', 'order-win') > 1.4);
  assert.equal(sectorWeight('unknown_group', 'order-win'), 1);
  assert.ok(playbookFor('banks').lens && playbookFor('nope').lens);
  for (const [g, p] of Object.entries(SECTOR_PLAYBOOKS)) {
    assert.ok(p.lens && Array.isArray(p.watch) && p.watch.length, `${g} has a lens and a watch list`);
    for (const t of Object.keys(p.weights || {})) assert.ok(CATALYSTS[t] || t === 'earnings', `${g} weights a known catalyst (${t})`);
  }
  assert.equal(inferGroup('Pharmaceuticals'), 'pharma'); assert.equal(inferGroup('Private Sector Bank'), 'banks'); assert.equal(inferGroup(''), null);
});

// ---------------------------------------------------------------------------------------------
// scoring a company
// ---------------------------------------------------------------------------------------------
const NOW = Date.parse('2026-10-30T06:00:00Z');
const base = {
  ticker: 'FIXCAP', name: 'Fixture Capital Goods Ltd', group: 'capital_goods', groupLabel: 'Capital Goods', mcapCr: 12000,
  price: { cmp: 500, asOf: '2026-10-29', changePct: 1.2 }, trades: [], investorMoves: [], brokerReports: [], filings: [],
  result: { resultDate: '2026-10-25', basis: 'Consolidated', revenue: { current: 1000, prior: 800, pct: 25, kind: 'normal' }, netProfit: { current: 120, prior: 90, pct: 33, kind: 'normal' } },
  quarter: 'Q2 FY27',
};
const orderFiling = (amount, date = '2026-10-20') => ({ ...prepareFiling(filing(`Fixture wins order worth Rs ${amount} crore from NHAI`, { date, subCategory: 'Award of Order / Receipt of Order' })) });

test('orders twice the quarter\'s revenue and a strong quarter make an opportunity, with the ratio stated', () => {
  const idea = scoreCompany({ ...base, filings: [orderFiling(1200), orderFiling(800, '2026-10-05')] }, { now: NOW });
  assert.equal(idea.stance, 'opportunity');
  assert.equal(idea.orderSummary.totalCr, 2000); assert.equal(idea.orderSummary.toQuarterRevenue, 2);
  assert.match(idea.headline, /₹2,000 Cr of new orders across 2 filings/);
  assert.match(idea.headline, /2\.0× the latest quarter's revenue/);
  assert.ok(idea.pillars.growth > 20 && idea.pillars.earnings > 10);
  assert.ok(idea.evidence.every((e) => e.title && e.date));
});
test('a tax demand worth 8% of the company turns the same idea Mixed or Risk, and says so', () => {
  const demand = prepareFiling(filing('Receipt of tax demand order of Rs 960 crore from the Income Tax Department', { date: '2026-10-22' }));
  assert.deepEqual(demand.catalysts.map((c) => c.type), ['legal-risk']);
  const idea = scoreCompany({ ...base, filings: [orderFiling(1200), demand] }, { now: NOW });
  assert.ok(['mixed', 'risk'].includes(idea.stance), idea.stance);
  assert.ok(idea.risks.some((r) => /tax demand/i.test(r)));
});
test('the same order filed on both exchanges counts once', () => {
  const bse = orderFiling(700), nse = { ...orderFiling(700), source: 'NSE', url: 'https://nsearchives.nseindia.com/x.pdf' };
  const idea = scoreCompany({ ...base, filings: [bse, nse] }, { now: NOW });
  assert.equal(idea.orderSummary.count, 1);
});
test('a bank\'s "order" earns nothing', () => {
  const idea = scoreCompany({ ...base, group: 'banks', groupLabel: 'Banks', filings: [orderFiling(5000)] }, { now: NOW });
  assert.ok(!idea.evidence.some((e) => e.type === 'order-win'));
});
test('a profit collapse is never "earnings momentum", whatever revenue did', () => {
  const idea = scoreCompany({ ...base, result: { ...base.result, revenue: { current: 1750, prior: 1000, pct: 75, kind: 'normal' }, netProfit: { current: 32, prior: 100, pct: -68, kind: 'normal' } } }, { now: NOW });
  assert.ok(!idea.evidence.some((e) => e.type === 'earnings-beat'));
  assert.ok(idea.evidence.some((e) => e.type === 'earnings-miss'));
});
test('price strength alone is not an opportunity', () => {
  const t = { above_200dma: true, above_50dma: true, relative_strength_6m: 0.4, high_proximity_pct: 0.97, consolidation_breakout: { breaks_out: true, volume_confirm: true }, bar_date: '2026-10-29' };
  const idea = scoreCompany({ ...base, result: null, technicals: t }, { now: NOW });
  assert.notEqual(idea.stance, 'opportunity');
});
test('an auditor resignation makes a risk alert even beside a good quarter', () => {
  const exit = prepareFiling(filing('Resignation of Statutory Auditors of the Company', { date: '2026-10-25' }));
  const idea = scoreCompany({ ...base, result: { ...base.result, netProfit: { current: 95, prior: 90, pct: 5, kind: 'normal' }, revenue: { current: 1000, prior: 960, pct: 4, kind: 'normal' } }, filings: [exit] }, { now: NOW });
  assert.ok(['risk', 'mixed'].includes(idea.stance)); assert.ok(idea.risk >= 25);
});
test('evidence older than the window is ignored', () => {
  const old = orderFiling(5000, '2026-01-02');
  const idea = scoreCompany({ ...base, result: null, filings: [old] }, { now: NOW });
  assert.equal(idea, null);
});
test('no number is invented: every amount on the evidence came from the filing text', () => {
  const f = orderFiling(1303);
  const idea = scoreCompany({ ...base, filings: [f] }, { now: NOW });
  const order = idea.evidence.find((e) => e.type === 'order-win');
  assert.equal(order.amountCr, 1303); assert.ok(order.title.includes('1303'));
  assert.ok(!('target' in idea) && !('probability' in idea));
});

// ---------------------------------------------------------------------------------------------
// the reader and the shipped publication
// ---------------------------------------------------------------------------------------------
test('the reader rejects a malformed publication and accepts a valid one', () => {
  assert.throws(() => validateIdeas({ version: 1, stage: 'research-candidates', rows: [] }));
  const idea = scoreCompany({ ...base, filings: [orderFiling(1200)] }, { now: NOW });
  const ok = { version: 2, stage: 'catalyst-ideas', generatedAt: new Date(NOW).toISOString(), rowCount: 1, ideas: [{ ...idea, id: 'FIXCAP:x', rank: 1 }] };
  assert.equal(validateIdeas(ok), ok);
  assert.throws(() => validateIdeas({ ...ok, rowCount: 2 }));
});
test('a failed refresh keeps the ideas already held', async () => {
  const idea = scoreCompany({ ...base, filings: [orderFiling(1200)] }, { now: NOW });
  const pub = { version: 2, stage: 'catalyst-ideas', generatedAt: new Date(NOW).toISOString(), rowCount: 1, ideas: [{ ...idea, id: 'FIXCAP:x', rank: 1 }] };
  let fail = false;
  const fetcher = async (url) => (fail || url.includes('ai-recommendations') ? new Response('', { status: 404 }) : new Response(JSON.stringify(pub), { status: 200 }));
  const f = createRecommendationFeed({ fetcher, readSaved: async () => null, save: async () => {} });
  return f.refresh().then(async () => {
    assert.equal(f.rows().length, 1);
    fail = true; await f.refresh();
    assert.equal(f.rows().length, 1); assert.ok(f.meta().error);
  });
});

const shipped = new URL('../public/data/ai-catalysts.json', import.meta.url);
if (fs.existsSync(shipped)) {
  test('the shipped publication is valid, ranked and linked', () => {
    const pub = validateIdeas(JSON.parse(fs.readFileSync(shipped, 'utf8')));
    assert.ok(pub.ideas.length > 0);
    assert.deepEqual(pub.ideas.map((i) => i.rank), pub.ideas.map((_, i) => i + 1));
    for (const i of pub.ideas) {
      assert.ok(i.conviction >= 0 && i.conviction <= 100 && i.risk >= 0 && i.risk <= 100, `${i.ticker} scores in range`);
      for (const e of i.evidence) {
        if (e.url) assert.match(e.url, /^https:\/\//, `${i.ticker} links over https`);
        if (e.valueCr && i.mcapCr) assert.ok(e.valueCr < i.mcapCr, `${i.ticker}: a disclosed trade (${e.valueCr} Cr) is smaller than the company (${i.mcapCr} Cr)`);
      }
    }
  });
}

await Promise.all(pending);
console.log(`\n${passed} catalyst-engine checks passed`);
