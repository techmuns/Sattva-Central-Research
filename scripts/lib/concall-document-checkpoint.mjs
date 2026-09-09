import { writeFileSync, renameSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { validateScreenerConcallCapture, SCREENER_CONCALL_LIMIT, SCREENER_CONCALL_COMPRESSED_LIMIT } from '../../public/js/data/screener-concalls-shared.js';

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
