import assert from 'node:assert/strict';
import { normalizeBookmark, snapshotForRow, filterBookmarks, companyKey, parseBackup } from '../public/js/core/bookmark-record.js';

const source = { ticker: 'RELIANCE', company: 'Reliance Industries', title: 'New capacity announced',
  date: '2025-03-12', summary: 'Full retained source excerpt. '.repeat(500), url: 'https://example.test/story', source: 'Exchange', token: 'must-not-persist' };
const news = snapshotForRow(source, { section: 'news' });
const alert = snapshotForRow({ id: 'alert:1', feed: 'news', sourceRecord: source, headline: source.title, day: source.date }, { section: 'daily-alerts' });
assert.equal(news.id, alert.id, 'The same news event has one notebook identity across tabs');
assert.notEqual(news.id, snapshotForRow({ ...source, ticker: 'TCS' }, { section: 'news' }).id, 'Company attribution is not collapsed');
const technical = { company: { ticker: 'RELIANCE', name: 'Reliance Industries', bar_date: '2026-09-04', screenerUrl: 'https://example.test/reliance' } };
const technicalSave = snapshotForRow(technical, { section: 'breakouts' });
assert.equal(technicalSave.company, 'Reliance Industries');
assert.equal(technicalSave.ticker, 'RELIANCE');
assert.equal(technicalSave.eventDate, '2026-09-04', 'Nested scored rows retain their actual completed session date');
assert.notEqual(technicalSave.id, snapshotForRow({ company: { ...technical.company, bar_date: '2026-09-07' } }, { section: 'breakouts' }).id, 'Later technical sessions are distinct saved events');
const holding = { title: 'Filed holding', company: 'Reliance Industries', kind: 'Investors', url: 'https://example.test/holdings', eventDate: 'Jun 26', sourceId: 'investor-a' };
assert.notEqual(normalizeBookmark(holding).id, normalizeBookmark({ ...holding, sourceId: 'investor-b' }).id, 'Two investors disclosing the same company cannot displace one another');
assert.equal(news.body, source.summary.trim(), 'Full available text survives, with no display-window truncation');
assert(!JSON.stringify(news).includes('must-not-persist'), 'Unknown feed/session fields never enter a bookmark');
assert.equal(normalizeBookmark({ ...news, url: 'javascript:alert(1)' }).url, '');
assert.equal(normalizeBookmark({ ...news, url: 'https://user:secret@example.test/' }).url, '');
assert.equal(normalizeBookmark({ ...news, url: '//example.test/' }).url, '');
assert.equal(normalizeBookmark({ ...news, links: [{ label: 'bad', url: 'data:text/html,bad' }] }).links.length, 0);
const entries = Array.from({ length: 150 }, (_, i) => normalizeBookmark({ ...news, title: `Event ${i}`, url: `https://example.test/${i}`,
  ticker: i % 2 ? 'TCS' : 'RELIANCE', company: i % 2 ? 'Tata Consultancy Services' : 'Reliance Industries',
  savedAt: '2026-09-07T12:00:00Z', note: i === 149 ? 'Follow the capacity expansion' : '' }));
assert.equal(filterBookmarks(entries).length, 150, 'Old event dates never expire from the notebook');
assert.equal(filterBookmarks(entries, { company: companyKey(news) }).length, 75);
assert.equal(filterBookmarks(entries, { query: 'tata consultancy' }).length, 75);
assert.equal(filterBookmarks(entries, { notesOnly: true, query: 'capacity expansion' })[0].title, 'Event 149', 'Search covers notes outside the first page');
assert.equal(filterBookmarks(entries, { kind: 'Earnings' }).length, 0);
const backup = { format: 'sattva-bookmarked-notebook', version: 1, entries };
assert.equal(parseBackup(backup).length, 150);
assert.throws(() => parseBackup({ ...backup, version: 2 }));
assert.throws(() => parseBackup({ ...backup, entries: [entries[0], { title: '' }] }));
console.log('PASS bookmark identities, retained snapshots, search, safe links and backup validation');
