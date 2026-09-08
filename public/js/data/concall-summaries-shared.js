// Private Screener summary contract. Source IDs, never a guessed company/quarter, join the reader.
export const SUMMARY_WORKFLOW = 'screener-summaries-refresh.yml';
export const SUMMARY_REPO = 'techmuns/Sattva-Central-Research';
export const SUMMARY_ORIGIN = 'https://sattva-central-research.tech-441.workers.dev';
export const SUMMARY_OBJECT = 'screener-account-summaries-v1';
export const SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SUMMARY_REQUEST_BUDGET = 60;
export const SUMMARY_INTERVAL_MS = 30 * 60 * 1000;
export const SUMMARY_CRON_OFFSET_MS = 11 * 60 * 1000; // Workflow runs at :11/:41 UTC.
export const SUMMARY_GAP_MS = 15000;
export const SUMMARY_BODY_LIMIT = 128 * 1024;
export const SUMMARY_RECORD_LIMIT = 50000;
export const SUMMARY_INVENTORY_BATCH = 250;
export const SUMMARY_TRANSPORT_LIMIT = 8 * 1024 * 1024;
// Observed in the signed-in browser on 8 September. A deployment cannot forget that refusal.
export const SUMMARY_INITIAL_STOP = '2026-09-09T06:48:00.000Z';
export const SUMMARY_FAILURES = new Set(['rate-limited', 'access-denied', 'session-expired',
  'source-unavailable', 'structure-changed', 'identity', 'not-published', 'interrupted']);

export function summaryId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['www.screener.in', 'screener.in'].includes(parsed.hostname) ||
        parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return /^\/concalls\/summary\/([1-9]\d{0,19})\/$/.exec(parsed.pathname)?.[1] || null;
  } catch { return null; }
}
export const summaryUrl = id => /^[1-9]\d{0,19}$/.test(id || '') ? `https://www.screener.in/concalls/summary/${id}/` : null;
export const summaryIdsForRow = row => [...new Set((row?.documents || []).map(d => summaryId(d.url)).filter(Boolean))];

function cleanText(value, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Error('Invalid summary text');
  return value.trim();
}
export function validateSummaryBody(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 600) throw Error('Invalid summary body');
  const title = cleanText(value.title, 500);
  const blocks = value.blocks.map(block => {
    if (['heading', 'paragraph', 'quote'].includes(block?.type)) return { type: block.type, text: cleanText(block.text) };
    if (block?.type === 'list' && Array.isArray(block.items) && block.items.length && block.items.length <= 200)
      return { type: 'list', ordered: block.ordered === true, items: block.items.map(item => cleanText(item)) };
    if (block?.type === 'table' && Array.isArray(block.rows) && block.rows.length && block.rows.length <= 200 &&
        block.rows.every(row => Array.isArray(row) && row.length && row.length <= 30))
      return { type: 'table', rows: block.rows.map(row => row.map(cell => typeof cell === 'string' && !cell.trim() ? '' : cleanText(cell, 4000))) };
    throw Error('Invalid summary block');
  });
  const result = { title, blocks };
  if (new TextEncoder().encode(JSON.stringify(result)).length > SUMMARY_BODY_LIMIT) throw Error('Summary too large');
  if (blocks.map(block => block.text || JSON.stringify(block.items || block.rows)).join(' ').length < 100) throw Error('Summary content is incomplete');
  return result;
}

function coverageStateMessage(state) {
  if (!state) return 'Screener summaries have not been checked.';
  if (state.reason === 'no-session') return 'Sign in through Munshot to read private Screener summaries.';
  if (state.reason === 'access') return 'This session is not authorised to read the private Screener summaries.';
  if (state.enabled === false) return 'Screener summary collection is not enabled.';
  const coverage = state.discoveryStatus === 'checking' ? 'Summary coverage is being refreshed. Saved summaries remain readable.'
    : state.discoveryStatus === 'not-started' ? 'Summary coverage has not been checked yet.'
    : state.discoveryStatus === 'stale' ? 'Summary coverage is stale. New holdings or calls may not have been checked. Saved summaries remain readable.'
    : state.discoveryStatus !== 'ok' ? 'Summary coverage could not be refreshed. Saved summaries remain readable; new holdings or calls may be pending.'
    : `${state.ready || 0} summaries saved · ${state.pending || 0} awaiting collection.`;
  const pause = state.cooldownUntil && Date.parse(state.cooldownUntil) > Date.now()
    ? 'Screener summary collection is paused after a source limit or refusal. Saved summaries remain readable.' : '';
  return [coverage, pause].filter(Boolean).join(' ');
}

export function summaryScheduleMessage(state, now = Date.now()) {
  if (state?.enabled !== true) return '';
  const schedule = state.schedule;
  if (!schedule?.started) return 'The collection timer has not started yet.';
  const failures = {
    unavailable: 'The collection timer could not check or start a collection run.',
    'recent-run-failed': 'The latest scheduled collection run failed.',
    'run-overdue': 'The scheduled collection run is overdue.',
  };
  if (failures[schedule.reason]) return failures[schedule.reason];
  if (!Number.isFinite(schedule.alarmAt)) return 'The collection timer has no next check scheduled.';
  if (schedule.alarmAt < now - 5 * 60000) return 'The collection timer is overdue.';
  return '';
}
export function summaryStateMessage(state) {
  return [coverageStateMessage(state), summaryScheduleMessage(state)].filter(Boolean).join(' ');
}
