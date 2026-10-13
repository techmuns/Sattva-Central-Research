// Bounded, resumable reads of public published analysis. No generated/paid report requests.
import { fetchScanPage, mergeScans } from './stockscans.mjs';

export function newConcallHistory(head) {
  const quarters = [...new Set([String(head.meta.quarter), ...(head.meta.quarters || [])])];
  if (quarters.length > 12) throw Error('Published quarter history exceeds the collection bound');
  const currentComplete = head.meta.next == null;
  if (currentComplete && head.rows.length < head.meta.total) throw Error('Published current quarter ended before its declared row count');
  return { quarters, quarterIndex: currentComplete ? 1 : 0, offset: head.meta.next || 0, rows: head.rows,
    count: head.rows.length, total: head.meta.total, checks: currentComplete ? [{ quarter: String(head.meta.quarter),
      count: head.rows.length, total: head.meta.total, checkedAt: head.meta.fetchedAt }] : [], complete: currentComplete && quarters.length === 1,
    retryAt: 0, error: null, leasedUntil: 0 };
}

export async function advanceConcallHistory(state, { fetchImpl = fetch, maxPages = 5, gapMs = 4000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), save = async () => {} } = {}) {
  let next = { ...state, rows: [...state.rows], checks: [...state.checks] };
  if (next.complete || next.retryAt > Date.now()) return next;
  try {
    for (let pageNumber = 0; pageNumber < maxPages && !next.complete; pageNumber++) {
      await sleep(gapMs);
      const quarter = next.quarters[next.quarterIndex];
      const page = await fetchScanPage({ quarter, offset: next.offset }, fetchImpl);
      if (next.rows.length + page.rows.length > 50000) throw Error('Published analysis history reached its explicit retention bound');
      next.rows = mergeScans(page.rows, next.rows);
      next.count = (next.offset ? next.count : 0) + page.rows.length;
      if (page.total != null) next.total = page.total;
      if (page.next == null) {
        if (next.total != null && next.count < next.total) throw Error('Published quarter ended before its declared row count');
        next.checks.push({ quarter, count: next.count, total: next.total, checkedAt: new Date().toISOString() });
        next.quarterIndex++; next.offset = 0; next.count = 0; next.total = null;
        next.complete = next.quarterIndex >= next.quarters.length;
      } else next.offset = page.next;
      next.error = null; next.retryAt = 0;
      if (await save(next) === false) return next; // A newer cache owner resumes from its checkpoint.
    }
  } catch (error) {
    next.error = error.message; next.retryAt = Date.now() + (error.retryAfterMs || 60000);
  }
  next.leasedUntil = 0;
  await save(next);
  return next;
}
