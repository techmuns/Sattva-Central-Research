// Offline contract for the filing-type reading behind Corp Announcements' Show row.
//
// Every assertion here is a collision that was checked by hand against the shipped captures: the
// order of the rules in announcement-types.js is the definition, so a reordering that changes one of
// these answers is a change in what the desk sees, not a refactor.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ANNOUNCEMENT_TYPES, OTHER_TYPE, announcementTypeOf, countTypes, loadHiddenTypes, saveHiddenTypes,
  DEFAULT_HIDDEN_TYPES, HIDDEN_TYPES_KEY, isDefaultSelection,
} from '../public/js/data/announcement-types.js';

const type = (row) => announcementTypeOf(row).id;
const bse = (subCategory, title, category = 'Company Update') => ({ category, subCategory, title });
const nse = (subject, description = null) => ({ subCategory: null, title: subject, summary: description });

// The desk's own examples, filed under BSE's catch-all — only the subject line can place them.
assert.equal(type(bse('General', 'Intimation regarding loss of share certificates')), 'routine');
assert.equal(type(bse('General', 'Issue of duplicate share certificate')), 'routine');
assert.equal(type(bse('General', 'Please find enclosed herewith Demat Report for the month ended August, 2026')), 'routine');
assert.equal(type(bse('General', 'Intimation under Regulation 13(3) - statement of investor complaints')), 'routine');
// The bulk of the noise, by the exchange's own label.
assert.equal(type(bse('Newspaper Publication', 'Newspaper publication of unaudited financial results')), 'routine',
  'a newspaper copy of a result is routine before it is a result');
assert.equal(type(nse('Declaration of NAV', 'DSP Asset Managers has informed the Exchange that the Net Asset Value (per unit) …')), 'routine');
assert.equal(type(nse('Copy of Newspaper Publication')), 'routine');
assert.equal(type(nse('Trading Window-XBRL')), 'routine');
assert.equal(type(nse('Confirmation of Redemption/Payment of Interest and Principal')), 'routine');
assert.equal(type(bse('Certificate under Reg. 74 (5) of SEBI (DP) Regulations, 2018', 'Certificate')), 'routine');
assert.equal(type(bse('Change in Registered Office Address', 'Shifting of registered office')), 'routine');

// Read from the exchange's label first…
assert.equal(type(bse('Financial Results', 'Unaudited results', 'Result')), 'results');
assert.equal(type(bse('Outcome of Board Meeting', 'Outcome of Board Meeting - approval of unaudited financial results', 'Board Meeting')), 'board-meeting',
  "the exchange's own sub-category wins over the subject line");
assert.equal(type(bse('Award of Order / Receipt of Order', 'Receipt of order')), 'orders');
assert.equal(type(nse('Bagging/Receiving of orders/contracts  (Sub-para 4-Para B)')), 'orders');
assert.equal(type(bse('Credit Rating', 'Credit rating')), 'credit-rating');
assert.equal(type(nse('Credit Rating- Revision')), 'credit-rating');
assert.equal(type(bse('Book Closure', 'Book closure', 'Corp. Action')), 'corporate-action');
assert.equal(type(nse('Record Date Updates')), 'corporate-action');
assert.equal(type(bse('Allotment of ESOP / ESPS', 'Allotment')), 'capital');
assert.equal(type(nse('Alteration Of Capital and Fund Raising-XBRL')), 'capital');
assert.equal(type(bse('Acquisition', 'Acquisition of a stake')), 'deals');
assert.equal(type(bse('Scheme of Arrangement', 'Scheme')), 'deals');
assert.equal(type(nse('Disclosure under SEBI Takeover Regulations')), 'regulatory', 'a takeover-regulation disclosure is not a takeover');
assert.equal(type(bse('Change in Management', 'Appointment')), 'management');
assert.equal(type(nse('Change in Directors/KMP/SMP/Auditor/RTA')), 'management');
assert.equal(type(nse('Analysts/Institutional Investor Meet/Con. Call Updates')), 'investor-meet');
assert.equal(type(bse('Press Release / Media Release', 'Press release')), 'investor-meet');
assert.equal(type(bse('AGM', 'Notice of AGM', 'AGM/EGM')), 'shareholder-meeting');
assert.equal(type(nse('Shareholders meeting')), 'shareholder-meeting');
assert.equal(type(bse('Court Convened Meeting', 'Notice', 'AGM/EGM')), 'shareholder-meeting', 'a court-convened meeting is a meeting before it is a court matter');
assert.equal(type(bse('Clarification', 'Clarification on price movement')), 'regulatory');
assert.equal(type(nse('Spurt in Volume')), 'regulatory');
assert.equal(type(nse('Corporate Insolvency Resolution Process-XBRL')), 'regulatory');

// …and the subject line only where the exchange's label is a catch-all.
assert.equal(type(bse('General', 'Intimation of receipt of Letter of Award for supply of 2,500 MW')), 'orders');
assert.equal(type(bse('General', 'Interaction with Electronic Media')), 'investor-meet');
assert.equal(type(nse('General Updates', 'Tembo Global Industries Limited has informed the Exchange regarding Reschedule of Investors /Analyst Meet |SUBJECT: Updates')), 'investor-meet',
  "NSE's description places a catch-all subject");

// A filing no rule recognises is Other, not a nearest guess — and says why.
const other = announcementTypeOf(bse('General', 'Please find attached'));
assert.equal(other.id, OTHER_TYPE);
assert.equal(other.from, null);
assert.equal(type(nse('Updates', 'Updates |SUBJECT: Updates')), OTHER_TYPE);
assert.equal(type(bse('General', 'Intimation under Regulation 30 of the SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015')), OTHER_TYPE,
  'a bare Regulation 30 intimation says nothing about the event');
assert.equal(type(bse('Zzz', 'Zzz', 'New Listing')), 'capital', "BSE's category is the last resort");
assert.equal(type(bse('General', 'Zzz', 'Company Update')), OTHER_TYPE, 'Company Update is a catch-all category, not a type');

// The reading names what it read.
const read = announcementTypeOf(bse('Newspaper Publication', 'Advertisement'));
assert.deepEqual([read.from, read.text, read.routine], ['sub-category', 'Newspaper Publication', true]);
assert.equal(announcementTypeOf(nse('Declaration of NAV')).from, 'subject');
assert.equal(announcementTypeOf(bse('General', 'Loss of share certificate')).from, 'subject');
assert.equal(announcementTypeOf(nse('General Updates', 'X has informed the Exchange about Credit Rating |SUBJECT: General Updates')).from, 'description');
assert.equal(announcementTypeOf(bse('Zzz', 'Zzz', 'Result')).from, 'category');
assert.equal(announcementTypeOf(bse('Newspaper Publication', '<BR>Advertisement<BR>')).text, 'Newspaper Publication', 'markup never reaches the reading');

// The vocabulary: unique ids, exactly one routine type, Other last and never hidden by default.
assert.equal(new Set(ANNOUNCEMENT_TYPES.map((t) => t.id)).size, ANNOUNCEMENT_TYPES.length);
assert.deepEqual(ANNOUNCEMENT_TYPES.filter((t) => t.routine).map((t) => t.id), ['routine']);
assert.equal(ANNOUNCEMENT_TYPES.at(-1).id, OTHER_TYPE);
assert.deepEqual([...DEFAULT_HIDDEN_TYPES], ['routine']);
for (const t of ANNOUNCEMENT_TYPES) assert(t.label && t.hint, `${t.id} carries a label and a hint`);

// Counts cover every type, even at zero, in vocabulary order, and honour a keep predicate.
const sample = [bse('Newspaper Publication', 'Ad'), bse('Financial Results', 'Results', 'Result'), nse('Declaration of NAV')];
const counts = countTypes(sample);
assert.deepEqual([...counts.keys()], ANNOUNCEMENT_TYPES.map((t) => t.id));
assert.equal(counts.get('routine'), 2);
assert.equal(counts.get('results'), 1);
assert.equal(counts.get('deals'), 0);
assert.equal(countTypes(sample, (row) => row.subCategory !== 'Newspaper Publication').get('routine'), 1);

// The shipped captures classify without throwing and every row lands on a known type.
const shippedBse = Object.values(JSON.parse(readFileSync('public/data/corp-announcements.json', 'utf8')).byTicker).flat();
const shippedNse = JSON.parse(readFileSync('public/data/nse-announcements.json', 'utf8')).rows
  .map((r) => ({ ...r, title: r.subject || r.description || null, summary: r.description || null }));
const shipped = [...shippedBse, ...shippedNse];
const known = new Set(ANNOUNCEMENT_TYPES.map((t) => t.id));
for (const row of shipped) assert(known.has(type(row)));
const shippedCounts = countTypes(shipped);
assert.equal([...shippedCounts.values()].reduce((a, b) => a + b, 0), shipped.length);
assert(shippedCounts.get(OTHER_TYPE) / shipped.length < 0.5, 'most filings carry a label the rules recognise');

// THE ROUTINE SHARE IS A FACT ABOUT THE WEEK, NOT ABOUT THESE RULES, so it is not asserted as a
// floor. This used to read `routine / shipped > 0.1` on the reasoning that the share is material and
// that is why the filter exists — true of the capture it was written against, and not a property of
// anything in this file. Measured on two shipped captures nine days apart, with these rules
// unchanged: 1,542 of 5,251 (29%) over 7-9 September, and 147 of 2,085 (7%) over 15-17 September.
// `ANN_KEEP_DAYS` keeps three days and which three is the calendar's business — 981 newspaper copies
// in the first window against 93 in the second, because those cluster after a results deadline while
// mid-September is AGM season, and the NSE half is a live window that is nearly empty overnight. So
// the floor failed on `main` with nothing wrong and no fix available except waiting for the market.
//
// What IS ours is that the rules still match the labels the exchanges actually send, so that is what
// is asserted now: every shipped row whose OWN EXCHANGE LABEL carries a confirmed routine marker must
// read as routine. Deleting any one of these markers from RE.routine fails this — verified against
// the shipped capture for each of the three it carries, with the constructed cases above removed so
// that only this block could fail: dropping `newspaper` alone takes 67 of the 133 routine-labelled
// rows off the type, and reads them as `deals`.
//
// It reads the exchange's label alone (BSE's sub-category, or NSE's subject where there is none) and
// never the subject line beneath it, because the label is what the rules read FIRST: an AGM notice
// whose subject says "Newspaper Publication for Annual General Meeting" is filed by BSE under `AGM`
// and correctly reads as a shareholder meeting. Scanning the subject too made 43 such rows look like
// failures of a rule that was working exactly as documented.
const ROUTINE_MARKERS = [/newspaper/i, /trading window/i, /registered office/i, /\bnav\b|net asset value/i];
const exchangeLabel = (row) => String(row.subCategory || row.title || '').replace(/<[^>]+>/g, ' ').trim();
const routineLabelled = shipped.filter((row) => ROUTINE_MARKERS.some((re) => re.test(exchangeLabel(row))));
// A check that can pass by matching nothing is not a check. Measured: 133 rows in the thinner
// capture and 1,471 in the wider one, so a floor of 20 has room for a short week and still fails a
// capture too thin to say anything — which is a different fault, and the message names both.
assert(routineLabelled.length >= 20,
  `the shipped captures carry ${routineLabelled.length} routine-labelled filings; under 20 means the capture is thin, not that the rules changed`);
for (const row of routineLabelled) {
  assert.equal(type(row), 'routine', `"${exchangeLabel(row)}" is an exchange routine label and must read as routine`);
}

// The device memory stores the set switched OFF, keeps an explicit empty choice, and defaults otherwise.
const store = new Map();
const fake = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
assert.deepEqual([...loadHiddenTypes(fake)], ['routine'], 'never chose → the default');
saveHiddenTypes(new Set(), fake);
assert.equal(store.get(HIDDEN_TYPES_KEY), '{"hidden":[]}');
assert.deepEqual([...loadHiddenTypes(fake)], [], 'an empty choice is a choice, not the default');
saveHiddenTypes(new Set(['shareholder-meeting', 'not-a-type']), fake);
assert.deepEqual([...loadHiddenTypes(fake)], ['shareholder-meeting'], 'unknown ids are dropped on both sides');
assert(!isDefaultSelection(loadHiddenTypes(fake)));
assert(isDefaultSelection(new Set(DEFAULT_HIDDEN_TYPES)));
store.set(HIDDEN_TYPES_KEY, 'not json');
assert.deepEqual([...loadHiddenTypes(fake)], ['routine'], 'a corrupt record falls back to the default');
assert.deepEqual([...loadHiddenTypes({ getItem() { throw new Error('blocked'); } })], ['routine'], 'blocked storage falls back');
assert.deepEqual(saveHiddenTypes(new Set(['routine']), { setItem() { throw new Error('quota'); } }), ['routine'], 'a failed save keeps the session choice');

console.log(`PASS announcement types: routine filings read from the exchange label or the subject line, catch-alls stay Other, ${shipped.length} shipped filings classify (${shippedCounts.get('routine')} routine), device memory stores the switched-off set`);
