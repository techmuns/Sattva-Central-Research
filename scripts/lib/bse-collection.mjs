import { BseAnnError, CATEGORIES, annUrl, compact, fetchAnnouncements, fetchCompanyAnnouncements } from '../../worker/bse-ann.mjs';

export const bseIndiaDay = (now = Date.now()) => new Date(Number(now) + 330 * 60000).toISOString().slice(0, 10);

const isoDay = (value) => { const day = compact(value); return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`; };
const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// A multi-day backlog must not keep restarting because today's total changes. Validate the
// original interval first, then keep closed history and the live day in disjoint windows.
// `maxDays` also bounds each closed window, oldest first. After a long outage one walk of the
// whole backlog can outlast the job running it, and a stopped run writes nothing, so every later
// run would start the same walk again. Short windows complete one at a time and move the watermark.
export function bseCollectionWindows(range, today = bseIndiaDay(), { maxDays = Infinity, lastCompleteTo = null } = {}) {
  annUrl({ ...range, category: CATEGORIES[0] });
  annUrl({ from: today, to: today, category: CATEGORIES[0] });
  if (maxDays !== Infinity && !(Number.isSafeInteger(maxDays) && maxDays >= 1)) {
    throw new TypeError('BSE collection windows need a whole number of days, at least one.');
  }
  const current = compact(today);
  if (compact(range.from) >= current) return [range];
  const day = isoDay(current);
  const live = compact(range.to) >= current;
  const closed = live ? { ...range, to: addDays(day, -1) } : range;
  return [...splitWindow(closed, maxDays, lastCompleteTo), ...(live ? [{ ...range, from: day }] : [])];
}

function splitWindow(range, maxDays, lastCompleteTo) {
  if (maxDays === Infinity) return [range];
  const last = isoDay(range.to), mark = compact(lastCompleteTo) ? isoDay(lastCompleteTo) : null, windows = [];
  for (let from = isoDay(range.from); from <= last;) {
    let to = addDays(from, maxDays - 1);
    // A resumed run re-reads a few days up to the previous watermark. A window ending exactly on
    // it would move nothing, so it takes the next day as well: every completed window makes progress.
    if (to === mark && mark < last) to = addDays(to, 1);
    if (to > last) to = last;
    windows.push({ ...range, from, to });
    from = addDays(to, 1);
  }
  return windows;
}

function appendWindow(rows, observed, captured, context) {
  for (const row of captured.rows) {
    // Rows without NEWSID cannot duplicate across disjoint, adapter-validated dates. A NEWSID
    // moved to another date while reading must still fail, as it would in one paginated walk.
    if (row.newsId && observed.has(row.newsId)) {
      throw new BseAnnError('shape', 'BSE repeated an announcement across capture windows.', { ...context, newsId: row.newsId });
    }
    if (row.newsId) observed.add(row.newsId);
    rows.push(row);
  }
}

export function bseLastCompleteTo(capture) {
  return capture?.lastCompleteTo || (!capture?.shortfall?.length && !Object.keys(capture?.failed || {}).length
    && capture?.coversUniverse !== false ? capture?.to : null) || null;
}

export function bseCaptureCoverage(result, previous = null) {
  const failedWindows = result.failedWindows || [];
  return {
    coversUniverse: !failedWindows.length && !result.shortfall.length && !Object.keys(result.unknownCategories).length,
    lastCompleteTo: [bseLastCompleteTo(previous), result.completeTo].filter(Boolean).sort().at(-1) || null,
    failed: failedWindows.length ? { 'BSE collection': { reason: 'partial',
      message: 'Some BSE category/date windows could not be fully checked.', windows: failedWindows } } : [],
    failedWindows,
  };
}

// A new filing can shift every subsequent page. Restart the affected walk from page one;
// never join rows from different attempts or relax the adapter's completeness checks.
async function stableWalk(read, { fetchImpl = fetch, attempts = 3, retryDelayMs = 1000,
  onRetry = null, ...options } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3
    || !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30000) {
    throw new TypeError('BSE collection allows 1–3 attempts and a retry delay of 0–30000ms.');
  }
  let requests = 0;
  const countedFetch = (...args) => { requests++; return fetchImpl(...args); };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await read({ ...options, fetchImpl: countedFetch });
      return { ...result, requests };
    } catch (error) {
      const detail = error?.detail;
      const changedCount = error instanceof BseAnnError && error.reason === 'shape'
        && Number.isSafeInteger(detail?.declared) && Number.isSafeInteger(detail?.pageDeclared)
        && detail.declared !== detail.pageDeclared;
      // Access denials, malformed data, repeated rows and ignored filters are not page drift.
      if (!changedCount || attempt === attempts) throw error;
      onRetry?.({ attempt, nextAttempt: attempt + 1, error });
      if (retryDelayMs) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
}

export async function collectBseAnnouncements({ categories = CATEGORIES, ...range }, {
  today, allowPartial = false, maxDays = Infinity, lastCompleteTo = null, deadline = Infinity, now = Date.now, ...options
} = {}) {
  if (!Array.isArray(categories) || !categories.length) {
    throw new TypeError('BSE collection requires at least one named category.');
  }
  const windows = bseCollectionWindows(range, today, { maxDays, lastCompleteTo });
  const result = { rows: [], byCategory: {}, unknownCategories: {}, requests: 0, shortfall: [], failedWindows: [], completeTo: null };
  const observed = new Map(categories.map(category => [category, new Set()]));
  let contiguous = true, stopped = null;
  // Finish every historical category before touching the live day. A live failure cannot undo
  // a closed, fully checked interval, and a historical gap cannot be skipped by a later success.
  for (const window of windows) {
    let complete = true;
    for (const category of categories) {
      const counts = result.byCategory[category] ||= { declared: 0, collected: 0, pages: 0 };
      // A run that has spent its time stops between walks, never inside one, and names every
      // window it left unread. Only completed windows move the watermark the next run resumes from.
      if (!stopped && now() >= deadline) {
        stopped = new BseAnnError('budget', 'This run reached its time budget before reading this window; the next run resumes from the last complete window.');
        if (!allowPartial) throw stopped;
      }
      if (stopped) {
        complete = false;
        counts.declared = null;
        result.failedWindows.push({ category, from: window.from, to: window.to, reason: stopped.reason, message: stopped.message });
        continue;
      }
      const partial = new Map();
      let requests = 0, validatedPages = 0, captured;
      try {
        captured = await stableWalk(
          readOptions => fetchAnnouncements({ ...window, categories: [category] }, readOptions), {
            ...options,
            fetchImpl: (...args) => { requests++; return (options.fetchImpl || fetch)(...args); },
            onPage: value => {
              validatedPages++;
              if (allowPartial) for (const row of value.rows) partial.set(row.newsId || JSON.stringify(row), row);
              options.onPage?.(value);
            },
          },
        );
      } catch (error) {
        if (!allowPartial || !(error instanceof BseAnnError)) throw error;
        complete = false;
        result.failedWindows.push({ category, from: window.from, to: window.to, reason: error.reason, message: error.message });
        captured = { rows: [...partial.values()], byCategory: { [category]: {
          declared: null, collected: partial.size, pages: validatedPages,
        } }, unknownCategories: {}, shortfall: [] };
      }
      appendWindow(result.rows, observed.get(category), captured, { category });
      const current = captured.byCategory[category];
      counts.declared = counts.declared === null || current.declared === null ? null : counts.declared + current.declared;
      counts.collected += current.collected;
      counts.pages += current.pages;
      for (const [name, count] of Object.entries(captured.unknownCategories)) {
        result.unknownCategories[name] = (result.unknownCategories[name] || 0) + count;
      }
      result.shortfall.push(...captured.shortfall);
      result.requests += requests;
      if (captured.shortfall.length || Object.keys(captured.unknownCategories).length) complete = false;
    }
    contiguous &&= complete;
    if (contiguous) {
      const to = compact(window.to);
      result.completeTo = `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}`;
    }
  }
  return result;
}

export async function collectBseCompanyAnnouncements(range, { today, ...options } = {}) {
  const windows = bseCollectionWindows(range, today), observed = new Set();
  const result = { rows: [], scripCode: String(range.scripCode || '').trim(), declared: 0, collected: 0, pages: 0, requests: 0 };
  for (const window of windows) {
    const captured = await stableWalk(readOptions => fetchCompanyAnnouncements(window, readOptions), options);
    appendWindow(result.rows, observed, captured, { scripCode: result.scripCode });
    for (const key of ['declared', 'collected', 'pages', 'requests']) result[key] += captured[key];
  }
  return result;
}
