#!/usr/bin/env node
// Offline checks for the NSE XBRL filing reader — the panel's parser, the bounded reading the team
// brief prints, and the page a link out of that brief lands on. No server and no egress: two of the
// fixtures beside this script are real filings captured from NSE's archive on 10 Sep 2026 — the
// order announcement the reader reported (Man Industries, REG30 Para B) and a four-block
// director/auditor change (RailTel), which is the case that made grouping necessary rather than
// cosmetic. The third (`reg30-restructuring-acquisition`) is CONSTRUCTED and says so in its own
// first lines: it reproduces the shape of the form behind the "Acquisition (including agreement to
// acquire)" rows the desk could not read, whose real documents this sandbox cannot reach.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockKey, factStatement, filingFacts, filingParticulars, filingParticularsLine, humanLabel, isHeaderBlock, isXbrlFilingUrl, readableFilingUrl, parseXbrlFiling } from '../public/js/data/nse-xbrl-shared.js';
import { renderFilingFailure, renderFilingPage } from '../worker/filing-page.mjs';

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`PASS ${label}`); };
const fixture = (name) => readFileSync(new URL(`./fixtures/nse-xbrl/${name}.xml`, import.meta.url), 'utf8');

check('the reader accepts an NSE XBRL announcement and refuses everything else', () => {
  assert.equal(isXbrlFilingUrl('https://nsearchives.nseindia.com/corporate/xbrl/REG30_PARA_B_897_WebXMLFile_20260910_180615065.xml'), true);
  // The PDF half of the same feed is already readable and must keep opening as itself.
  assert.equal(isXbrlFilingUrl('https://nsearchives.nseindia.com/corporate/MANINDS_10092026135546_order.pdf'), false);
  // THE ROUTE BEHIND THIS IS A FETCHER, so the guard is the whole of its allow-list. A hostname
  // that merely ENDS like the archive is somebody else's, and http is not the archive at all.
  assert.equal(isXbrlFilingUrl('https://nsearchives.nseindia.com.attacker.test/corporate/xbrl/a.xml'), false);
  assert.equal(isXbrlFilingUrl('https://evil.test/corporate/xbrl/a.xml'), false);
  assert.equal(isXbrlFilingUrl('http://nsearchives.nseindia.com/corporate/xbrl/a.xml'), false);
  assert.equal(isXbrlFilingUrl('https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml'), false);
  assert.equal(isXbrlFilingUrl('https://nsearchives.nseindia.com/corporate/xbrl/../../etc/passwd.xml'), false);
  // NSE publishes Integrated Filings as readable iXBRL HTML already; those are not ours to lay out.
  assert.equal(isXbrlFilingUrl('https://nsearchives.nseindia.com/corporate/ixbrl/INTEGRATED_FILING_iXBRL_WEB.html'), false);
  assert.equal(isXbrlFilingUrl(''), false);
  assert.equal(isXbrlFilingUrl(null), false);
});

check('navigation is readable for every company and form, while source identities stay intact', () => {
  for (const form of ['SAIIM', 'REG30_PARA_B', 'ChangeInManagement', 'FUTURE_FORM']) {
    const url = `https://nsearchives.nseindia.com/corporate/xbrl/${form}_company.xml?version=1&source=NSE`;
    const link = new URL(readableFilingUrl(url), 'https://dashboard.test');
    assert.equal(link.pathname, '/filing');
    assert.equal(link.searchParams.get('src'), url);
    assert.equal(readableFilingUrl(link.href), link.href, 'already readable links stay stable');
  }
  for (const url of ['https://nsearchives.nseindia.com/corporate/letter.pdf', 'https://example.test/file.xml']) {
    assert.equal(readableFilingUrl(url), url);
  }
});

check('the reported PB Fintech analyst meeting preserves all 25 filed facts', () => {
  const filing = parseXbrlFiling(fixture('analyst-meet-pbfintech'));
  assert.equal(filing.company, 'PB Fintech Limited');
  assert.equal(filing.symbol, 'POLICYBZR');
  assert.equal(filing.factCount, 25);
  const values = filingFacts(filing).map(fact => fact.value);
  for (const value of ['2026-09-24', '15:30:00', 'Sell side Analyst Call', 'Virtual meeting']) assert.ok(values.includes(value));
});

check('a tag becomes its own words, and SEBI’s acronyms survive it', () => {
  assert.equal(humanLabel('NSESymbol'), 'NSE symbol');
  assert.equal(humanLabel('ISIN'), 'ISIN');
  assert.equal(humanLabel('NameOfTheCompany'), 'Name of the company');
  assert.equal(humanLabel('LEIOrCINOrRegistrationNumberOfTheCounterparty'), 'LEI or CIN or registration number of the counterparty');
  assert.equal(humanLabel('AmountOfTheOrdersOrContracts'), 'Amount of the orders or contracts');
  // A repeated block's index is a word of its own, so "Change in management 1" reads as a heading.
  assert.equal(humanLabel('ChangeInManagement1'), 'Change in management 1');
});

check('the instant and duration halves of one block are one block', () => {
  assert.equal(blockKey('MainI'), blockKey('MainD'));
  assert.equal(blockKey('D_ChangeInManagement1'), 'ChangeInManagement1');
  assert.equal(blockKey('I_ChangeInManagement1'), 'ChangeInManagement1');
  assert.equal(blockKey('OneI'), 'One');
  assert.equal(blockKey('PriorOrPostFactoIntimation_D'), 'PriorOrPostFactoIntimation');
  // ...and two genuinely different blocks stay apart.
  assert.notEqual(blockKey('D_ChangeInManagement1'), blockKey('D_ChangeInManagement2'));
  assert.notEqual(blockKey('I_ActionsTaken1'), blockKey('I_ActionsTaken1_PersonsAgainstWhomActionsTaken1'));
  assert.equal(isHeaderBlock(blockKey('MainI')), true);
  assert.equal(isHeaderBlock(blockKey('D_ChangeInManagement1')), false);
});

check('the order announcement the reader reported renders as its own fields', () => {
  const filing = parseXbrlFiling(fixture('reg30-para-b-orders'));
  assert.equal(filing.ok, true);
  assert.equal(filing.company, 'Man Industries (India) Limited');
  assert.equal(filing.symbol, 'MANINDS');
  assert.equal(filing.isin, 'INE993A01026');
  assert.equal(filing.scripCode, '513269');
  const facts = filing.blocks.flatMap((b) => b.facts);
  assert.ok(facts.length >= 15, `expected the filing's fields, got ${facts.length}`);
  // THE FIELDS ARE WHY THIS IS WORTH RENDERING. The RSS row carries one truncated sentence; the
  // document carries the counterparty, the amount and the execution window as separate statements.
  const value = (label) => facts.find((f) => f.label === label)?.value;
  assert.equal(value('NSE symbol'), 'MANINDS');
  assert.equal(value('Name of the entity awarding the orders or contracts'), 'Domestic and International Customers');
  assert.ok(value('Amount of the orders or contracts'), 'the order value is a field of its own');
  // VALUES TRAVEL VERBATIM. Nothing here re-words the company's answer into ours.
  assert.equal(value('Whether event or information disclosed is an outcome of the board meeting'), 'false');
  assert.equal(value('Date of occurrence of event or information'), '2026-09-10');
  // ...and no fact is a raw tag or an XML fragment by the time it reaches the panel.
  for (const f of facts) {
    assert.ok(f.label && !/[<>]/.test(f.label), `label carries markup: ${f.label}`);
    assert.ok(!/<in-capmkt:/.test(f.value), `value carries markup: ${f.value}`);
  }
});

check('four auditor re-appointments render as four blocks, not one contradictory record', () => {
  const filing = parseXbrlFiling(fixture('change-in-management'));
  assert.equal(filing.company, 'RAILTEL CORPORATION OF INDIA LIMITED');
  assert.equal(filing.symbol, 'RAILTEL');
  const repeated = filing.blocks.filter((b) => /^Change in management/i.test(b.title || ''));
  assert.equal(repeated.length, 4);
  const names = repeated.map((b) => b.facts.find((f) => f.label === 'Name of designated person')?.value);
  assert.deepEqual(names, ['LUNAWAT & CO', 'S C AJMERA & CO', 'S PODDAR & CO', 'MSPR & CO']);
  // The header is the filing's identification and carries no heading of its own.
  assert.equal(filing.blocks[0].title, null);
  assert.equal(filing.blocks[0].facts[0].label, 'NSE symbol');
  // XML entities are decoded once, on the way in — the panel escapes for the DOM separately.
  assert.ok(!names.some((n) => n.includes('&amp;')));
});

check('a body that is not the filing is not an empty filing', () => {
  // Akamai's refusal is a small page carrying whatever status it likes. The parser's own answer —
  // no facts — is what the route turns into a named failure, rather than an empty document.
  assert.equal(parseXbrlFiling('<html><body>Access Denied</body></html>').ok, false);
  assert.equal(parseXbrlFiling('').ok, false);
  assert.equal(parseXbrlFiling(null).ok, false);
  // A well-formed instance with no facts in it is equally not a filing to show anybody.
  assert.equal(parseXbrlFiling('<xbrli:xbrl></xbrli:xbrl>').ok, false);
});

check('a field the company left blank is not rendered as a finding', () => {
  const xml = '<xbrli:xbrl><in-capmkt:NameOfTheCompany contextRef="MainI">Example Limited</in-capmkt:NameOfTheCompany>'
    + '<in-capmkt:NatureOfOrdersOrContracts contextRef="MainI">   </in-capmkt:NatureOfOrdersOrContracts>'
    + '<in-capmkt:AmountOfTheOrdersOrContracts contextRef="MainI" unitRef="INR" decimals="0">6000000000</in-capmkt:AmountOfTheOrdersOrContracts>'
    + '</xbrli:xbrl>';
  const filing = parseXbrlFiling(xml);
  const facts = filing.blocks.flatMap((b) => b.facts);
  assert.equal(facts.length, 2);
  assert.ok(!facts.some((f) => f.label === 'Nature of orders or contracts'));
  // The unit is the document's own declaration and travels with the number; the digits are untouched.
  const amount = facts.find((f) => f.label === 'Amount of the orders or contracts');
  assert.equal(amount.value, '6000000000');
  assert.equal(amount.unit, 'INR');
});

check('a fact this code has never seen still reaches the reader', () => {
  // READ BY SHAPE, NOT BY FIELD NAME. SEBI extend the taxonomy on their own schedule, and a form
  // published next month must arrive laid out rather than dropped.
  const xml = '<xbrli:xbrl><in-capmkt:SomeFieldNobodyHasWrittenYet contextRef="MainI">A value</in-capmkt:SomeFieldNobodyHasWrittenYet></xbrli:xbrl>';
  const filing = parseXbrlFiling(xml);
  assert.equal(filing.ok, true);
  assert.equal(filing.blocks[0].facts[0].label, 'Some field nobody has written yet');
  assert.equal(filing.blocks[0].facts[0].value, 'A value');
  // ...and the identification fields it does not carry stay absent rather than being guessed.
  assert.equal(filing.company, null);
  assert.equal(filing.symbol, null);
});

// ---- the bounded reading the team brief prints ------------------------------------------------
//
// WHAT THIS IS ABOUT. The brief printed "Acquisition (including agreement to acquire)" and nothing
// else, which names a FORM and not an event — the desk's report, in their words: it does not tell
// them anything. The document behind that row carries the particulars as separate facts, so the
// brief now reads it. These checks are that the reading reproduces and never composes.

check('a filing line leads with a declared figure, then the filing’s own order', () => {
  const filing = parseXbrlFiling(fixture('reg30-restructuring-acquisition'));
  const { facts, omitted, total } = filingParticulars(filing);
  assert.ok(facts.length > 1 && facts.length <= 6);
  // The one figure first: a number the company declared is the particular a reader cannot guess
  // from the category, and a form that opens with clauses of the regulation would push it out.
  assert.equal(facts[0].label, 'Cost of acquisition or the price at which the shares are acquired');
  assert.equal(facts[0].value, '1850000000', 'the filed digits are untouched');
  assert.equal(facts[0].unit, 'INR');
  // ...and what the desk actually asked for: what was acquired, not merely that something was.
  const labels = facts.map((f) => f.label);
  assert.ok(labels.includes('Name of the target entity'));
  assert.equal(facts.find((f) => f.label === 'Name of the target entity').value, 'Meridian Analytics Private Limited');
  // Everything after the leading figure is in the document's own order — nothing is ranked.
  const order = filingFacts(filing).map((f) => f.label);
  const rest = labels.slice(1);
  assert.deepEqual(rest, [...rest].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'the filing decides the order');
  // A bounded view that hides its own bound claims the filing says less than it does.
  assert.equal(omitted, total - facts.length);
  assert.ok(omitted > 0, 'this filing carries more than a line holds');
  assert.equal(total, filingFacts(filing).length);
});

check('the identification fields are not spent on a line that already names the company', () => {
  const filing = parseXbrlFiling(fixture('reg30-para-b-orders'));
  const labels = filingFacts(filing).map((f) => f.label);
  for (const identity of ['NSE symbol', 'Name of the company', 'ISIN', 'Scrip code', 'MSEI symbol']) {
    assert.ok(!labels.includes(identity), `${identity} is the filing's identification, not a particular`);
  }
  // They are still on the FILING, which is what the page and the panel render.
  assert.equal(filing.company, 'Man Industries (India) Limited');
  assert.ok(filing.blocks[0].facts.some((f) => f.label === 'NSE symbol'));
});

check('the order announcement’s line carries the amount and the counterparty', () => {
  const line = filingParticularsLine(parseXbrlFiling(fixture('reg30-para-b-orders')));
  assert.ok(line.startsWith('Amount of the orders or contracts: 6000000000 INR'), line);
  assert.ok(line.includes('Name of the entity awarding the orders or contracts: Domestic and International Customers'), line);
  // Nothing is combined into a sentence of ours: every entry is `label: value` as filed.
  for (const part of line.split(' · ')) assert.match(part, /^[^:]+: .+$/);
});

check('one statement repeated across a form’s repeated blocks is printed once', () => {
  const { facts, omitted } = filingParticulars(parseXbrlFiling(fixture('change-in-management')));
  const statements = facts.map(factStatement);
  assert.equal(new Set(statements).size, statements.length, 'no line says one thing twice');
  // The four auditors are four different statements and stay four.
  assert.ok(statements.filter((s) => s.startsWith('Name of designated person:')).length > 1);
  assert.ok(omitted > 0, 'what was folded away is still counted');
  // `pure` is the taxonomy's unit for a number that has no unit, so it is the one unit not printed.
  assert.ok(statements.includes('Number of persons or entities for whom change is being reported: 4'));
});

check('a long value is clipped visibly, never re-worded', () => {
  const long = 'A '.repeat(200) + 'end.';
  const xml = `<xbrli:xbrl><in-capmkt:SignificantTermsAndConditions contextRef="MainI">${long}</in-capmkt:SignificantTermsAndConditions></xbrli:xbrl>`;
  const [fact] = filingParticulars(parseXbrlFiling(xml)).facts;
  assert.equal(fact.clipped, true);
  assert.ok(fact.value.endsWith('…'), 'the cut is visible');
  assert.ok(long.startsWith(fact.value.slice(0, -1).trimEnd()), 'what is shown is the filing’s own text, unchanged');
  assert.ok(fact.value.length < 200);
});

check('a filing with nothing but identification yields no line rather than an empty one', () => {
  const xml = '<xbrli:xbrl><in-capmkt:NameOfTheCompany contextRef="MainI">Example Limited</in-capmkt:NameOfTheCompany>'
    + '<in-capmkt:NSESymbol contextRef="MainI">EXAMPLE</in-capmkt:NSESymbol></xbrli:xbrl>';
  const { facts, omitted, total } = filingParticulars(parseXbrlFiling(xml));
  assert.deepEqual(facts, []);
  assert.equal(total, 0);
  assert.equal(omitted, 0);
});

// ---- the page a link out of the brief lands on -------------------------------------------------

check('the filing page renders the exchange’s own facts, with the original linked', () => {
  const url = 'https://nsearchives.nseindia.com/corporate/xbrl/REG30_Restructuring_19824_WebXMLFile_20260917_130215982.xml';
  const filing = parseXbrlFiling(fixture('reg30-restructuring-acquisition'));
  const html = renderFilingPage({ filing, url, dashboardUrl: 'https://example.test' });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('<title>Aditya Birla Capital Limited</title>'));
  // EVERY FACT, not the bounded line — this is the whole document, which is the point of the page.
  for (const fact of filingFacts(filing)) {
    assert.ok(html.includes(fact.label), `missing label ${fact.label}`);
    assert.ok(html.includes(fact.value.replace(/&/g, '&amp;')), `missing value ${fact.value}`);
  }
  assert.ok(html.includes('ISIN INE674K01013') && html.includes('BSE 540691'));
  assert.ok(html.includes(`href="${url}"`), 'the original document stays one click away');
  assert.ok(html.includes('20 fields as filed'));
  // It has to survive a mail client's browser with nothing else loaded, and carry no live code.
  assert.ok(!html.includes('<script') && !html.includes('<link '), 'no script, no stylesheet');
  assert.ok(!/ on[a-z]+=/i.test(html), 'no inline handlers');
});

check('the filing page escapes the exchange’s text', () => {
  const xml = '<xbrli:xbrl><in-capmkt:NameOfTheCompany contextRef="MainI">&lt;script&gt;alert(1)&lt;/script&gt;</in-capmkt:NameOfTheCompany></xbrli:xbrl>';
  const html = renderFilingPage({ filing: parseXbrlFiling(xml), url: 'https://nsearchives.nseindia.com/corporate/xbrl/a.xml' });
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

check('a filing that could not be read names the failure and keeps the document reachable', () => {
  const url = 'https://nsearchives.nseindia.com/corporate/xbrl/a.xml';
  const html = renderFilingFailure({ url, reason: 'unreachable', error: 'NSE HTTP 403' });
  assert.ok(html.includes('NSE could not be read for this filing just now'));
  assert.ok(html.includes('Please try again shortly'));
  assert.ok(html.includes(`href="${readableFilingUrl(url)}"`), 'retry opens the readable page');
  assert.ok(html.includes('View raw XML on NSE (technical file)'));
  assert.ok(!html.includes('Open the original file on NSE'));
  assert.ok(html.includes(`href="${url}"`));
  // An address that is not one of these filings is a different statement, and offers no NSE link.
  const other = renderFilingFailure({ url: 'https://evil.test/x', reason: 'unsupported' });
  assert.ok(other.includes('not one of NSE'));
  assert.ok(!other.includes('href="https://evil.test/x"'), 'the page never links an address it refused');
});

console.log(`\n${checks} NSE XBRL filing checks passed.`);
