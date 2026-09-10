#!/usr/bin/env node
// Offline checks for the NSE XBRL filing reader. No server and no egress: the fixtures beside this
// script are two real filings captured from NSE's archive on 10 Sep 2026 — the order announcement
// the reader reported (Man Industries, REG30 Para B) and a four-block director/auditor change
// (RailTel), which is the case that made grouping necessary rather than cosmetic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockKey, humanLabel, isHeaderBlock, isXbrlFilingUrl, parseXbrlFiling } from '../public/js/data/nse-xbrl-shared.js';

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

console.log(`\n${checks} NSE XBRL filing checks passed.`);
