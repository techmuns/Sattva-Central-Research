import assert from 'node:assert/strict';
import { announcementDocumentIdentity, announcementSourceUrls } from '../../public/js/data/announcements-shared.js';

const documents = row => [...new Set([row.url, ...announcementSourceUrls(row).map(link => link.url)]
  .map(announcementDocumentIdentity).filter(Boolean))];
const noticeKey = row => JSON.stringify([row.ticker, row.date, row.time, row.title, row.referenceUrl]);
const documentKey = (row, document) => JSON.stringify([row.ticker, row.date, document]);

/** Check captured backup notices against the delivered feed, independently of its collector.
 * This proves delivery of captured records, not exhaustive coverage of the exchanges.
 */
export function verifyAnnouncementDelivery(rows, events) {
  const deliveredDocuments = new Set(), deliveredNotices = new Set();
  for (const event of events) {
    const row = event.sourceRecord;
    if (!row) continue;
    for (const document of documents(row)) deliveredDocuments.add(documentKey(row, document));
    deliveredNotices.add(noticeKey(row));
  }
  for (const row of rows) {
    const links = documents(row);
    assert(links.length ? links.some(document => deliveredDocuments.has(documentKey(row, document)))
      : deliveredNotices.has(noticeKey(row)), `Captured announcement missing from alerts: ${row.ticker} ${row.date} ${row.title}`);
  }
  return rows.length;
}
