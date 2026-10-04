import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScreenerCompanyFilings, createScreenerCompanyFallback, screenerCompanyResponse } from './lib/screener-company-filings.mjs';
import { captureCompanies, captureCompanySources, readJson, writeJson } from './lib/company-capture.mjs';
import { createAnnouncementIdentity, announcementIssuerIsin } from '../public/js/data/announcement-identity.js';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';
import { companyCaptureStatusFromIndex } from '../public/js/data/company-captures.js';

const at = Date.parse('2026-10-01T16:00:00Z');
const fixture = `<html><div data-company-id="42"></div>
<section id="top"><a href="https://www.nseindia.com/get-quotes/equity?symbol=HEGAM">NSE</a></section>
<section id="quarters"><table class="data-table"><thead><tr><th></th><th>Jun 2026</th></tr></thead><tbody><tr><td>Raw PDF</td><td><a aria-label="Raw PDF" href="/company/source/quarter/42/6/2026/">PDF</a></td></tr></tbody></table></section>
<section id="documents">
<div id="company-announcements-tab"><ul><li><a href="https://www.bseindia.com/notice.pdf">Order &amp; update
<div><time datetime="2026-10-01T13:40:34+05:30">Today</time> AI-generated summary must not enter filings</div></a></li></ul></div>
<div class="documents annual-reports"><div><ul><li><a href="https://issuer.example/2026.pdf">Annual Report 2026</a></li>
<li><a href="https://issuer.example/2025.pdf">Annual Report 2025</a></li></ul></div></div>
<div class="documents concalls"><div><ul><li><div>Jul 2026</div><a title="Raw Transcript" href="https://issuer.example/transcript.pdf">Transcript</a>
<button data-url="/ai-summary">AI Summary</button><a href="https://issuer.example/presentation.pdf">PPT</a></li>
<li><div>Apr 2026</div><div>Transcript</div></li></ul></div></div></section></html>`;
const company = { ticker: 'HEG', announcementTicker: 'HEGAM', isin: 'INE545A01024' };
const parsed = parseScreenerCompanyFilings(fixture, company, at);
assert.equal(parsed.documents.length, 4);
assert.equal(parsed.skipped, 0);
assert.equal(parsed.unavailableLinks, 1);
assert.deepEqual(parsed.documents.filter(d => d.form === 'earnings_report').map(d => d.date), ['2026-06']);
assert.equal(parsed.announcements[0].title, 'Order & update');
assert(!JSON.stringify(parsed).includes('AI-generated'));
const emptyRecent = fixture.replace(/<div id="company-announcements-tab">[\s\S]*?<\/ul><\/div>/,
  '<div id="company-announcements-tab"><p class="sub">No data available.</p></div>');
const emptyParsed = parseScreenerCompanyFilings(emptyRecent, company, at);
assert.equal(emptyParsed.announcements.length, 0);
assert.equal(emptyParsed.announcementReadable, true, 'FSC explicitly reports no recent notices; this is not a parser failure');
assert.equal(parseScreenerCompanyFilings(emptyRecent.replace('No data available.', ''), company, at).announcementReadable, false,
  'an unexplained empty recent section cannot count as a successful source check');
assert.equal(parseScreenerCompanyFilings(emptyRecent.replace('company-announcements-tab', 'missing-announcements'), company, at).announcementReadable, false,
  'a missing recent section cannot be inferred from other empty document sections');
assert.throws(() => parseScreenerCompanyFilings(fixture, { ticker: 'UNRELATED' }, at), /identity not verified/);
assert.throws(() => parseScreenerCompanyFilings(fixture.slice(0, -7), company, at), /incomplete/);
const assertDocumentFailure = (html, pattern) => {
  const parsed = parseScreenerCompanyFilings(html, company, at);
  assert(parsed.skipped > 0, 'document-category failures cannot count as complete checks');
  assert.match(parsed.documentErrors.join(' '), pattern);
  assert.equal(parsed.announcements.length, 1, 'document failures cannot suppress independently valid notices');
  return parsed;
};
assertDocumentFailure(fixture.replace('annual-reports', 'unknown-reports'), /section missing/);
assertDocumentFailure(fixture.replace('documents concalls', 'documents renamed-concalls'), /concall section missing/);
const noConcalls = fixture.replace(/<div class="documents concalls">[\s\S]*?<\/section>/,
  '<div class="documents concalls"><p>No data available.</p></div></section>');
assert.equal(parseScreenerCompanyFilings(noConcalls, company, at).documents.filter(d => d.form === 'concalls').length, 0);
assertDocumentFailure(noConcalls.replace('No data available.', ''), /unverified empty concalls/);
assertDocumentFailure(fixture.replace('aria-label="Raw PDF"', 'aria-label="Changed label"'), /unverified empty quarterly reports/);
const withQuarters = section => fixture.replace(/<section id="quarters">[\s\S]*?<\/section>/, `<section id="quarters">${section}</section>`);
assert.equal(parseScreenerCompanyFilings(withQuarters('<p>No data available.</p>'), company, at).documents.length, 3);
const noPeriods = '<table class="data-table"><thead><tr><th class="text"></th></tr></thead><tbody><tr><td>Raw PDF</td></tr></tbody></table>';
assert.equal(parseScreenerCompanyFilings(withQuarters(noPeriods), company, at).documents.length, 3,
  'JAYBEE zero-period table explicitly has no quarterly report slots');
assertDocumentFailure(withQuarters(noPeriods.replace('</th>', '</th><th>Jun 2026</th>')), /unverified empty quarterly reports/);
assertDocumentFailure(withQuarters(noPeriods.replace('Raw PDF', 'New label')), /unverified empty quarterly reports/);
const partialQuarter = fixture.replace('<th>Jun 2026</th>', '<th>Jun 2026</th><th>Sep 2026</th>')
  .replace('>PDF</a></td>', '>PDF</a></td><td><a aria-label="Changed label" href="/company/source/quarter/42/9/2026/">PDF</a></td>');
const partialQuarterParsed = assertDocumentFailure(partialQuarter, /incomplete quarterly report links/);
assert.equal(partialQuarterParsed.documents.filter(d => d.form === 'earnings_report').length, 1,
  'the recognized quarterly document is retained while its unreadable neighbour stays incomplete');
const mixedPage = parseScreenerCompanyFilings(fixture.replace('</li></ul></div>', '</li><li><a href="https://www.bseindia.com/undated.pdf">Unreadable notice</a></li></ul></div>'), company, at);
const mixedResponse = screenerCompanyResponse({ ...mixedPage, fetchedAt: new Date(at).toISOString() }, 'announcements', { reason: 'not-found' });
assert.equal(mixedResponse.announcements.length, 1, 'a malformed notice cannot discard its valid neighbour');
assert.equal(mixedResponse.skipped, 1);
assert.equal(mixedResponse.limited, true);
assert.throws(() => screenerCompanyResponse({ announcementReadable: false }, 'announcements', { reason: 'not-found' }), /could not be parsed/);
assert.equal(parseScreenerCompanyFilings(fixture.replace('https://issuer.example/2026.pdf', 'javascript:alert(1)'), company, at).skipped, 1);
assert(parseScreenerCompanyFilings(fixture.replace('quarter/42/', 'quarter/99/'), company, at).skipped > 0);
const noAnnual = fixture.replace(/<div class="documents annual-reports">[\s\S]*?<div class="documents concalls">/,
  '<div class="documents annual-reports"><p>No data available.</p><a href="https://www.sebi.gov.in/filing">DRHP</a></div><div class="documents concalls">');
assert.equal(parseScreenerCompanyFilings(noAnnual, company, at).skipped, 0);
const prospectusOnly = noAnnual.replace('No data available.', '');
for (const label of ['DRHP', 'RHP']) {
  const partial = assertDocumentFailure(prospectusOnly.replace('>DRHP<', `>${label}<`), /unverified empty annual reports/);
  assert.equal(partial.documents.length, 2, 'prospectuses do not certify annual-report coverage; transcripts and quarterly reports survive');
}
let requests = 0;
const page = createScreenerCompanyFallback({ now: () => at, fetcher: async url => {
  requests++; assert(url.endsWith('/HEGAM/consolidated/')); return new Response(fixture);
} });
await Promise.all([page(company), page(company)]);
assert.equal(requests, 1, 'announcement and document fallback share a bounded page read');
let attempts = 0;
const retry = createScreenerCompanyFallback({ now: () => at, sleep: async () => {}, fetcher: async () => {
  if (++attempts === 1) throw new TypeError('fetch failed');
  return new Response(fixture);
} });
assert.equal((await retry(company)).documents.length, 4);
assert.equal(attempts, 2, 'one transport retry can recover the first connection without dropping this company');
attempts = 0;
const denied = createScreenerCompanyFallback({ sleep: async () => assert.fail('HTTP refusals are not retried'), fetcher: async () => {
  attempts++; return new Response('Denied', { status: 403 });
} });
await assert.rejects(denied(company), /HTTP 403/);
assert.equal(attempts, 1);
attempts = 0;
const offline = createScreenerCompanyFallback({ sleep: async () => {}, fetcher: async () => { attempts++; throw new TypeError('offline'); } });
await assert.rejects(offline(company), /offline/);
assert.equal(attempts, 2, 'persistent transport failure is bounded and never becomes an empty success');

const dir = mkdtempSync(join(tmpdir(), 'sattva-company-recovery-'));
try {
  writeJson(join(dir, 'universe.json'), [{ Company: 'Dhoot', 'Screener URL': 'https://www.screener.in/company/id/1286088/consolidated/' }]);
  writeJson(join(dir, 'announcement-identities.json'), { entries: [{ ticker: 'BORORENEW', isin: 'INE666D01022', bseCode: '502219' }] });
  const holdings = [
    { name: 'Borosil Renewables Limited - Warrants 13ag26', isin: 'INE666D13019', ticker: null },
    { name: 'Everest Fleet', isin: 'INE0LTR01029', ticker: null },
    { name: 'Efpl Pref 18042043', isin: 'INE0LTR03090', ticker: null },
  ];
  const scope = captureCompanies(dir, { announcements: true, holdings });
  assert.deepEqual(scope.companies.map(c => c.ticker), ['BORORENEW', 'DHOOTTRANS']);
  assert.deepEqual(scope.unresolved, []);
  assert.equal(scope.nonExchange.length, 2);
  assert(scope.nonExchange.every(c => c.exchangeFilings === 'unavailable'));
  assert.equal(announcementIssuerIsin('INE666D13019'), 'INE666D01022');
  const identity = createAnnouncementIdentity([{ ticker: 'BORORENEW', isin: 'INE666D01022' }]);
  assert.equal(identity.find(holdings[0]).ticker, 'BORORENEW');
  assert.equal(identity.find({ isin: ' ine666d13019 ' }).ticker, 'BORORENEW', 'issuer relationships preserve existing ISIN normalization');
  const entities = portfolioNewsEntities(holdings);
  for (const isin of ['INE0LTR01029', 'INE0LTR03090']) {
    const entity = entities.find(e => e.portfolioIsins.includes(isin));
    assert.equal(entity.entityId, `isin:${isin}`, 'reviewed issuer names cannot strand old news history');
    assert.equal(entity.legalName, 'Everest Fleet Private Limited');
    assert.equal(entity.ticker, null);
    assert(entity.queries.includes('Everest Fleet Private Limited'));
  }
  assert(entities.find(e => e.portfolioIsins.includes('INE666D13019')).queries.includes('Borosil Renewables Limited'));

  const capture = join(dir, 'capture');
  const oldDocument = { ticker: 'HEG', form: 'annual_report', title: 'Retained report', url: 'https://issuer.example/2020.pdf' };
  writeJson(join(capture, 'domestic/HEG.json'), { rows: [oldDocument] });
  writeJson(join(capture, 'index.json'), { version: 1, sources: { domestic: { HEG: { queryTicker: 'HEG', rowCount: 1,
    lastSuccessAt: '2026-09-01T00:00:00Z', nextRetryAt: '2026-10-02T00:00:00Z', error: { reason: 'not-found' } } } } });
  const opts = { dir: capture, companies: [company], now: () => at, spacingMs: 0, concurrency: 1,
    request: async kind => kind === 'domestic' ? { ok: true, ...parsed, fetchedAt: new Date(at).toISOString(), provider: 'Screener company page' }
      : { ok: true, announcements: parsed.announcements, limited: true, fetchedAt: new Date(at).toISOString(),
        sourceUrl: 'https://www.screener.in/company/HEGAM/consolidated/', primaryError: { reason: 'not-found' } } };
  let index = await captureCompanySources(opts);
  assert.equal(index.sources.domestic.HEG.queryTicker, 'HEGAM');
  assert.equal(index.sources.domestic.HEG.error, null);
  assert(readJson(join(capture, 'domestic/HEG.json')).rows.some(d => d.url === oldDocument.url));
  const recovered = index.sources.announcements.HEG;
  assert.equal(readJson(join(capture, 'announcements/HEG.json')).rows.length, 1);
  assert.equal(recovered.error.reason, 'limited-coverage');
  assert.equal(recovered.primaryError.reason, 'not-found');
  assert.equal(recovered.ranges.length, 0, 'a few latest notices cannot certify the requested year');
  assert(!recovered.lastSuccessAt);
  assert.equal(Date.parse(recovered.nextRetryAt) - at, 2 * 3600000);
  const status = companyCaptureStatusFromIndex(index, 'announcements', null, at);
  assert.equal(status.partial, 1); assert.equal(status.checked, 0); assert.equal(status.failed, 0);
  assert.equal(companyCaptureStatusFromIndex(index, 'announcements', null, at + 5 * 3600000).failed, 1);
  index = await captureCompanySources({ ...opts, now: () => at + 2 * 3600000,
    request: async () => ({ ok: true, announcements: emptyParsed.announcements, limited: true,
      fetchedAt: new Date(at + 2 * 3600000).toISOString(), sourceUrl: 'https://www.screener.in/company/HEGAM/consolidated/' }) });
  assert.equal(readJson(join(capture, 'announcements/HEG.json')).rows.length, 1, 'an explicitly empty recent page retains captured notices');
  assert.equal(index.sources.announcements.HEG.recovery.rowCount, 0);
  assert.equal(index.sources.announcements.HEG.error.reason, 'limited-coverage');
  assert.equal(index.sources.announcements.HEG.ranges.length, 0, 'an explicitly empty recent page cannot close historical gaps');
  index = await captureCompanySources({ ...opts, now: () => at + 4 * 3600000,
    request: async () => ({ ok: false, reason: 'upstream', message: 'Fallback failed' }) });
  assert.equal(readJson(join(capture, 'announcements/HEG.json')).rows.length, 1, 'a later outage cannot delete recovered notices');
  assert.equal(index.sources.announcements.HEG.error.reason, 'upstream');
  assert.equal(companyCaptureStatusFromIndex(index, 'announcements', null, at + 4 * 3600000).failed, 1);
  const mixedDir = join(dir, 'mixed-notices');
  const mixedIndex = await captureCompanySources({ ...opts, dir: mixedDir, maxRequests: 1, request: async () => mixedResponse });
  assert.equal(readJson(join(mixedDir, 'announcements/HEG.json')).rows.length, 1, 'valid partial notices reach durable storage');
  assert.equal(mixedIndex.sources.announcements.HEG.skipped, 1);
  assert.equal(mixedIndex.sources.announcements.HEG.error.reason, 'limited-coverage');
  assert.equal(mixedIndex.sources.announcements.HEG.lastSuccessAt, undefined);
  assert.deepEqual(mixedIndex.sources.announcements.HEG.ranges, []);
  for (const [label, html] of [
    ['concall', fixture.replace('documents concalls', 'documents renamed-concalls')],
    ['annual', fixture.replace('annual-reports', 'renamed-reports')],
    ['quarter', fixture.replace('id="quarters"', 'id="renamed-quarters"')],
    ['document-wrapper', fixture.replace('id="documents"', 'id="renamed-documents"')],
    ['document-id', fixture.replace('data-company-id', 'renamed-company-id')],
    ['partial-quarter', partialQuarter],
    ['prospectus-only', prospectusOnly],
  ]) {
    const isolatedDir = join(dir, label);
    writeJson(join(isolatedDir, 'domestic/HEG.json'), { rows: [oldDocument] });
    let reads = 0;
    const sharedRead = createScreenerCompanyFallback({ now: () => at, fetcher: async () => { reads++; return new Response(html); } });
    const isolated = await captureCompanySources({ ...opts, dir: isolatedDir, request: async kind =>
      screenerCompanyResponse(await sharedRead(company), kind, { reason: 'not-found' }) });
    assert.equal(reads, 1, 'independent parsing still shares a single bounded request');
    assert.equal(readJson(join(isolatedDir, 'announcements/HEG.json')).rows.length, 1, `${label} cannot discard valid notices`);
    assert.equal(isolated.sources.announcements.HEG.error.reason, 'limited-coverage');
    assert.equal(isolated.sources.domestic.HEG.error.reason, 'shape');
    assert(!isolated.sources.domestic.HEG.lastSuccessAt, 'a failed category cannot advance document success');
    assert(isolated.sources.domestic.HEG.skipped > 0);
    const saved = readJson(join(isolatedDir, 'domestic/HEG.json')).rows;
    assert(saved.some(row => row.url === oldDocument.url), 'old documents survive a category failure');
    assert(saved.length > 1, 'independently valid new document categories are retained too');
  }
  const missingNotices = parseScreenerCompanyFilings(fixture.replace('company-announcements-tab', 'renamed-notices'), company, at);
  assert.equal(missingNotices.skipped, 0);
  assert.equal(screenerCompanyResponse(missingNotices, 'domestic', { reason: 'not-found' }).documents.length, 4,
    'announcement failure likewise cannot discard valid documents');
  assert.throws(() => screenerCompanyResponse(missingNotices, 'announcements', { reason: 'not-found' }), /could not be parsed/);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('PASS company source aliases, exact security identities, free document fallback, retained history and explicit partial coverage');
