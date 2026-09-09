import { writeFileSync, renameSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { validateScreenerConcallCapture, SCREENER_CONCALL_LIMIT, SCREENER_CONCALL_COMPRESSED_LIMIT } from '../../public/js/data/screener-concalls-shared.js';
import { upcomingDay } from './screener-upcoming.mjs';

const plain = value => value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').trim();
function balanced(html) {
  const stack = [];
  for (const [, closing, tag] of html.matchAll(/<(\/)?(ul|li|table|tbody|thead|tr|td|th|a|strong|span)\b[^>]*>/gi)) {
    if (closing) { if (stack.pop() !== tag.toLowerCase()) return false; }
    else stack.push(tag.toLowerCase());
  }
  return stack.length === 0;
}

function completePortfolioList(list, day) {
  if (!balanced(list)) return false;
  let dated = false, companies = 0;
  const rows = [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)];
  if (!rows.length || plain(list.replace(/<li\b[^>]*>[\s\S]*?<\/li\s*>/gi, ''))) return false;
  for (const [, row] of rows) {
    if (/<li\b/i.test(row)) return false;
    const headings = [...row.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/gi)];
    if (headings.length) {
      if (headings.length !== 1 || !upcomingDay(plain(headings[0][1]), day) || /<a\b/i.test(row) || (dated && !companies)) return false;
      dated = true;
      companies = 0;
      continue;
    }
    const links = [...row.matchAll(/<a\b[^>]*href=["']\/company\/[^/"'?#]+\/(?:consolidated\/)?["'][^>]*>([\s\S]*?)<\/a\s*>/gi)];
    if (!dated || links.length !== 1 || !plain(links[0][1])) return false;
    // A company name alone is not an event. Accept renamed badge classes only when a complete,
    // nonempty event span follows that company's closed link in the same closed row.
    const tail = row.slice(links[0].index + links[0][0].length);
    if (![...tail.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span\s*>/gi)].some(([, body]) => plain(body))) return false;
    companies++;
  }
  return dated && companies > 0;
}

// A parser exception alone cannot distinguish a changed calendar from an error/interstitial
// page. Require the authenticated page's recognisable calendar structure before isolating it.
export function recognisedCalendar(raw, feed, observedAt = new Date().toISOString()) {
  // Inspect the original response, not page.content(): browsers silently repair truncated tags.
  const html = String(raw).replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  if (!/<html\b/i.test(html) || !/<\/html\s*>\s*$/i.test(html) || !balanced(html)) return false;
  // The live watchlist uses a tab label, not a heading element. Its tag is layout; the explicit
  // label plus complete dated company list (and the caller's authentication checks) is evidence.
  if (feed === 'portfolio') {
    const observed = Date.parse(observedAt);
    if (!Number.isFinite(observed) || !/>\s*Upcoming\s*</i.test(html)) return false;
    const lists = [...html.matchAll(/<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/gi)]
      .map(([, list]) => list).filter(list => /<strong\b/i.test(list) && /href=["']\/company\//i.test(list));
    return lists.length === 1 && completePortfolioList(lists[0], new Date(observed + 19800000).toISOString().slice(0, 10));
  }
  if (feed !== 'upcoming') return false;
  const tables = [...html.matchAll(/<table\b[^>]*\bid=["']result_list["'][^>]*>([\s\S]*?)<\/table\s*>/gi)];
  if (tables.length !== 1) return false;
  const rows = [...tables[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)]
    .map(([, row]) => row).filter(row => /\bfield-/.test(row));
  return rows.length > 0 && rows.every(row => ['field-company_object_display', 'field-date', 'field-time'].every(field =>
    [...row.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)].some(([, , attrs, body]) =>
      attrs.includes(field) && plain(body))));
}

// Only public document metadata is checkpointed. Paid bodies and browser/account state never
// enter an Actions artifact. The pending state cannot authorise summary collection after a crash.
export function writeDocumentCheckpoint(path, capture, outcome = 'pending') {
  validateScreenerConcallCapture(capture);
  if (!capture.fullHistory || !['pending', 'complete', 'calendar-shape', 'blocked'].includes(outcome))
    throw Error('Invalid document checkpoint');
  const { portfolioUpcoming, upcoming, upcomingPublishedTotal, upcomingPagesFetched, upcomingDuplicatesRemoved,
    documentCheckpoint, ...documents } = capture;
  const value = { ...documents, documentCheckpoint: { version: 1, outcome } };
  const json = JSON.stringify(value), bytes = gzipSync(json);
  if (Buffer.byteLength(json) > SCREENER_CONCALL_LIMIT || bytes.length > SCREENER_CONCALL_COMPRESSED_LIMIT)
    throw Error('Document checkpoint exceeds artifact limits');
  writeFileSync(`${path}.tmp`, bytes, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return value;
}
