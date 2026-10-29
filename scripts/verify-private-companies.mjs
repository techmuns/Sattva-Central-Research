// The family's private companies on the Private Market tab: which book lines count, and how a funding
// record's company name joins one. No server, no egress.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nameKey, privateCompaniesFromBook, privateCompanyMatcher } from '../public/js/data/private-companies.js';

// The shipped book: every line the resolver marks unlisted is a private company, and nothing else is.
const book = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url)));
const companies = privateCompaniesFromBook(book.holdings);
const unlisted = book.holdings.filter((h) => h.listed === false && !h.ticker && !/warrant/i.test(`${h.name} ${h.bookName} ${h.reason}`));
assert.equal(companies.reduce((n, c) => n + c.isins.length, 0), unlisted.length, 'every unlisted line is one private company');
for (const c of companies) {
  assert.match(c.id, /^private:[a-z0-9]+$/);
  for (const isin of c.isins) {
    const line = book.holdings.find((h) => h.isin === isin);
    assert.equal(line.listed, false, `${c.name} is an unlisted book line`);
    assert(!/warrant/i.test(`${line.name} ${line.reason}`), `${c.name} is not warrants on a listed company`);
  }
}
assert(!companies.some((c) => /warrant/i.test(c.name)), 'warrant lines are never private companies');

// Exact names only: the brand, the legal name and the book name match; a prefix, a suffix or a
// different company does not.
const fixture = privateCompaniesFromBook([
  { isin: 'INE000F00001', name: 'Fixture Brand', bookName: 'Fixture Company 7 Private Limited', ticker: null, listed: false, reason: 'unlisted — private company, held directly' },
  { isin: 'INE000F00002', name: 'Alpha Labs', bookName: 'Alpha Labs Ltd', ticker: null, listed: false, reason: 'unlisted — private company, held directly' },
  { isin: 'INE000F00003', name: 'Beta — warrants', bookName: 'Beta Ltd Warrants', ticker: null, listed: false, reason: 'warrants, not the equity line' },
  { isin: 'INE000F00004', name: 'Gamma', bookName: 'Gamma Ltd', ticker: 'GAMMA', listed: true },
]);
assert.deepEqual(fixture.map((c) => c.name), ['Alpha Labs', 'Fixture Brand']);
const match = privateCompanyMatcher(fixture);
assert.equal(match('Fixture Company 7')?.name, 'Fixture Brand', 'the legal name joins its brand');
assert.equal(match('Fixture Brand Pvt. Ltd.')?.name, 'Fixture Brand', 'legal suffixes do not matter');
assert.equal(match('Alpha Labs')?.name, 'Alpha Labs');
assert.equal(match('Alpha'), null, 'no prefix match');
assert.equal(match('Alpha Labs AI'), null, 'no suffix match');
assert.equal(match('Beta'), null, 'warrants are not a private company');
assert.equal(match('Gamma'), null, 'a listed line is not a private company');

// A live book that no longer holds a line drops it.
assert.deepEqual(privateCompaniesFromBook([
  { isin: 'INE000F00001', name: 'Fixture Brand', bookName: 'Fixture Company 7 Private Limited', ticker: null, listed: false },
  { isin: 'INE000F00002', name: 'Alpha Labs', bookName: 'Alpha Labs Ltd', ticker: null, listed: false },
], new Set(['INE000F00002'])).map((c) => c.name), ['Alpha Labs']);

// A name two companies share matches neither, because it cannot say which one it means.
const shared = privateCompanyMatcher([{ name: 'Delta', aliases: ['Common Name'] }, { name: 'Epsilon', aliases: ['Common Name'] }]);
assert.equal(shared('Common Name'), null);
assert.equal(shared('Delta')?.name, 'Delta');
assert.equal(nameKey('Waterwala Labs Private Limited'), nameKey('waterwala labs'));

console.log(`PASS private companies: ${companies.length} from the shipped book (${companies.map((c) => c.name).join(', ') || 'none'}), exact-name joins, warrants and listed lines excluded, live-book membership.`);
