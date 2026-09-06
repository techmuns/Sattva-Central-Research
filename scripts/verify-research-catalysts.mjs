#!/usr/bin/env node
// Deterministic retrieval checks: no model, network, production data or personal account.
import assert from 'node:assert/strict';
import { telegramCompanyRows, postExcerpt } from '../public/js/research/social.js';
import { providerEvidence, researchEvidenceChars } from '../public/js/research/evidence-shared.js';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { queryPlan, chooseRows, fitEvidenceToBudget } = await import('../public/js/research/estate.js');
const now = '2026-09-06T14:45:00Z';
const index = [
  { ticker: 'HEXT', name: 'Hexaware Tech.' },
  { ticker: 'OTHER', name: 'Other Company Ltd' },
];
const planFor = question => queryPlan(question, index, { scope: 'portfolio', holdings: [index[1]], now });
const message = { ticker: 'HEXT', company: 'Hexaware Technologies', messageId: 102825,
  publishedAt: '2026-09-04T10:46:00Z', url: 'https://t.me/researchreportss/102825',
  text: 'JM Financial sees 11% UPSIDE in Hexaware Technologies- Vivek Jetley to take over as CEO' };
const routine = Array.from({ length: 25 }, (_, i) => ({ ticker: 'HEXT', company: 'Hexaware Technologies',
  date: '2026-09-06', title: `Routine daily trading-volume update ${i}` }));
const byDate = (a, b) => String(b.publishedAt || b.date || '').localeCompare(String(a.publishedAt || a.date || ''));

const plan = planFor('who is the new ceo of hexaware?');
assert.deepEqual([...plan.tickers], ['HEXT']);
assert.equal(plan.companies[0].inScope, false, 'public research must not misrepresent an outside issuer as a holding');
assert.equal(plan.window.days, 60, 'a normal company question prioritizes two months of developments');
assert.equal(plan.window.explicit, false);
for (const question of ['who is the new ceo of hexaware?', 'who is the new chief executive of hexaware?', 'What changed in Hexaware management?']) {
  const selected = chooseRows([...routine, message, { ...message, ticker: 'OTHER', text: 'Other Company appointed a CEO' }], planFor(question), r => r, byDate);
  assert.equal(selected.rows[0].messageId, 102825, `${question}: an obvious event cannot be buried by newer routine issuer rows`);
  assert(selected.rows.every(row => row.ticker === 'HEXT'), 'a different issuer cannot fill a requested-company evidence gap');
}
const chiefExecutive = { ticker: 'HEXT', date: '2026-09-04', title: 'Vivek Jetley to take over as chief executive' };
const specificRole = chooseRows([
  { ticker: 'HEXT', date: '2026-09-06', title: 'Chief financial officer resignation announced' },
  chiefExecutive,
], plan, r => r, byDate);
assert.equal(specificRole.rows[0].title, chiefExecutive.title, 'CEO questions prefer the equivalent executive role over a different management change');

for (const [question, title] of [
  ['Did Hexaware win any new orders?', 'Awarded a large multi-year contract'],
  ['What changed in Hexaware earnings?', 'Operating EBITDA revised following quarterly results'],
  ['Is Hexaware raising capital?', 'QIP issue proposal involves equity dilution'],
  ['Any changes in Hexaware promoter ownership?', 'SAST disclosure records an increase in stake'],
  ['Any regulatory issues for Hexaware?', 'SEBI issues a penalty order'],
]) {
  const picked = chooseRows([...routine, { ticker: 'HEXT', date: '2026-09-04', title }], planFor(question), r => r, byDate);
  assert.equal(picked.rows[0].title, title, `${question}: useful investment evidence survives routine issuer traffic`);
}

const recentPlan = planFor('What are the latest developments at Hexaware?');
const retained = chooseRows([
  { ticker: 'HEXT', date: '2026-03-01', title: 'Earlier contract disclosure', url: 'https://example.test/old-disclosure' },
  { ticker: 'HEXT', date: '2026-08-24', title: 'Recent operating update', url: 'https://example.test/recent-disclosure' },
], recentPlan, r => r);
assert.equal(retained.rows[0].date, '2026-08-24', 'default recency works even when source order starts with old history');
assert(retained.rows.some(row => row.date === '2026-03-01'), 'recency priority cannot silently delete retained older evidence');
assert.equal(retained.rows.find(row => row.date === '2026-03-01').periodMatch, 'older', 'retained history is not represented as a recent event');
assert.equal(planFor('Hexaware developments in the last 90 days').window.days, 90);
assert.equal(planFor('Hexaware developments in the last 90 days').window.explicit, true);
assert.equal(planFor('Hexaware developments in the last 3 months').window.days, 90);
assert.doesNotThrow(() => planFor('Hexaware developments since 2026-99-99'), 'an invalid typed date cannot crash every source retrieval');
const observationOnly = chooseRows([{ ticker: 'HEXT', firstSeenAt: now, lastCheckedAt: now, title: 'Undated archived report' }], recentPlan, r => r);
assert.equal(observationOnly.rows[0].periodMatch, 'undated', 'a recent collection check cannot manufacture a recent publication date');

// The answer-bearing source is deliberately last, behind many same-issuer records.
// Local source ranking alone cannot protect it; the shared allocator must spend on relevance.
const sources = Array.from({ length: 10 }, (_, i) => ({ id: `routine-${i}`, status: 'ready', tab: 'News',
  ...chooseRows(routine.map(row => ({ ...row, text: 'Routine trading observations. '.repeat(14) })), plan, r => r) }));
sources.push({ id: 'telegram', status: 'ready', tab: 'Telegram', ...chooseRows([message], plan, r => r) });
const packet = fitEvidenceToBudget({ generatedAt: now, sources }, 3600);
const protectedMessage = packet.sources.find(source => source.id === 'telegram').rows.find(row => row.messageId === 102825);
assert(protectedMessage?.text.includes('Vivek Jetley to take over as CEO'), 'shared budget must retain the answer-bearing public post');
assert.equal(protectedMessage.url, message.url);
assert(researchEvidenceChars(packet) <= 3600);
assert(providerEvidence(packet).sources.find(source => source.id === 'telegram').rows.some(row => row.messageId === 102825));
const relatedManagement = sources.slice(0, -1).map(source => ({ ...source,
  ...chooseRows([{ ticker: 'HEXT', date: '2026-09-06', text: 'Chief financial officer resignation announced. '.repeat(10) }], plan, r => r) }));
const roleBudget = fitEvidenceToBudget({ generatedAt: now, sources: [...relatedManagement, sources.at(-1)] }, 3600);
assert(roleBudget.sources.find(source => source.id === 'telegram').rows.some(row => row.messageId === 102825),
  'related management stories in other tabs cannot consume the budget reserved for the requested CEO role');

const sourceUrl = `https://example.test/filing.pdf?document=${'a'.repeat(300)}`;
const literal = 'Company disclosure context. '.repeat(10) + 'Vivek Jetley is named chief executive, effective on the stated transition date.';
const filingPacket = fitEvidenceToBudget({ generatedAt: now, sources: [{ id: 'announcements', status: 'ready',
  ...chooseRows([{ ticker: 'HEXT', text: literal, url: sourceUrl }], plan, r => r) }] }, 2600);
const filing = filingPacket.sources[0].rows[0];
assert(filing.text.includes('Vivek Jetley'), 'literal evidence beyond metadata length remains available to the answer');
assert.equal(filing.url, sourceUrl, 'a long original disclosure address cannot be cut into a broken citation');

const aliases = telegramCompanyRows([
  { id: 1, text: message.text },
  { id: 2, text: 'Hexaware Techno Holdings announces a new plant.' },
  { id: 3, text: 'Technology companies discuss a chief executive transition.' },
], index);
assert.deepEqual(aliases.map(row => [row.id, row.ticker]), [[1, 'HEXT']], 'known company abbreviations resolve full names without matching a different issuer');
const ambiguousNames = telegramCompanyRows([
  { id: 4, text: 'Alpha Technologies announces an expansion.' },
  { id: 5, text: 'Global Technologies announces an expansion.' },
], [{ ticker: 'ALPHA', name: 'Alpha Tech.' }, { ticker: 'BETA', name: 'Alpha Technologies' }, { ticker: 'GLOBALTECH', name: 'Global Tech.' }]);
assert.deepEqual(ambiguousNames.map(row => [row.id, row.ticker]), [[4, 'BETA']], 'an abbreviation cannot overwrite a distinct exact company identity or rely on a generic lead name');
const parent = { ticker: 'VEDL', name: 'Vedanta Ltd' };
const demerged = { ticker: 'VISL', name: 'Vedanta Iron and Steel Ltd' };
assert.deepEqual(telegramCompanyRows([{ id: 6, text: 'Vedanta Iron and Steel reports a new contract.' }], [parent], [parent, demerged]), [],
  'narrowing retrieval to one company must still consult the full identity index before assigning a longer issuer name');
const shortAlpha = { ticker: 'ALPHA', name: 'Alpha Tech.' };
assert.deepEqual(telegramCompanyRows([{ id: 7, text: 'Alpha Technologies releases a report.' }], [shortAlpha], [shortAlpha, { ticker: 'BETA', name: 'Alpha Technologies' }]), [],
  'an exact identity outside the requested set still prevents an ambiguous abbreviation match');
const longPost = 'Hexaware Technologies quarterly industry commentary. ' + 'Unrelated market background. '.repeat(100) +
  'Vivek Jetley to take over as CEO. The original report describes a future transition.';
const excerpt = postExcerpt(longPost, ['Hexaware Technologies', 'ceo']);
assert(excerpt.text.includes('Vivek Jetley to take over as CEO'), 'a late event mention survives an earlier company-name match');
assert(excerpt.textTruncated, 'excerpting is disclosed instead of representing a partial post as complete');

console.log('PASS: outside-scope company identity, CEO/management synonyms, recent 60-day priority, retained history, custom periods, global evidence budget, literal text, intact citations and conservative post identity.');
