import { writeFileSync, renameSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { validateScreenerConcallCapture, SCREENER_CONCALL_LIMIT, SCREENER_CONCALL_COMPRESSED_LIMIT } from '../../public/js/data/screener-concalls-shared.js';

// A parser exception alone cannot distinguish a changed calendar from an error/interstitial
// page. Require the authenticated page's recognisable calendar structure before isolating it.
export function recognisedCalendar(html, feed) {
  if (feed === 'portfolio') return /<h[1-6]\b[^>]*>\s*Upcoming\s*<\/h[1-6]\s*>/i.test(html) &&
    [...html.matchAll(/<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/gi)].some(([, list]) =>
      /<strong\b[^>]*>\s*(?:Today|Tomorrow|(?:[A-Za-z]+,?\s*)?\d{1,2}\s+[A-Za-z]+)\s*<\/strong\s*>/i.test(list) &&
      /href=["']\/company\/[^"']+["']/i.test(list) && /<li\b[^>]*>[\s\S]*?<\/li\s*>/i.test(list));
  return feed === 'upcoming' && /<table\b[^>]*\bid=["']result_list["'][^>]*>[\s\S]*?<\/table\s*>/i.test(html) &&
    ['field-company_object_display', 'field-date', 'field-time'].every(field => html.includes(field));
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
