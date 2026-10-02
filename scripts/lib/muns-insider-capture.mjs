import { mergeInsiderTrades } from '../../public/js/data/insider-history.js';
import { newsDay } from '../../public/js/data/news-window.js';
import { exchangeRows } from '../../public/js/data/exchange-deals-shared.js';

const shift = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function insiderCaptureCompanies(companies, retained, exchange) {
  const seen = new Map(companies.map(c => [c.ticker, c]));
  // Universe means the companies in this dashboard's retained market feed as well as its book.
  for (const ticker of [...Object.keys(retained.byTicker || {}), ...exchangeRows(exchange).map(r => r.ticker)]) {
    if (!seen.has(ticker)) seen.set(ticker, { ticker, priority: false });
  }
  return [...seen.values()];
}

// A failed company is retried at the front of the next run, not after a full rotation of ~3,800
// companies (about thirteen runs), so a passing outage clears in one run. The lane is capped so a
// long list of failures cannot starve the rest of the universe.
export const RETRY_LANE = 60;
// The source answers HTTP 500 for some companies on every identifier, every time (measured
// 2 October 2026: HEG by NSE symbol, IndiGrid, Mindspace and JB Chemicals by symbol and by BSE
// code), while it answers the rest. A refusal repeated over a day is a gap in the source, not an
// outage: the company is named as one the source does not serve, rechecked weekly, and no longer
// holds the run red. A timeout or network failure is never classified this way.
export const UNSUPPORTED_AFTER = 3;
export const UNSUPPORTED_MIN_MS = 24 * 3600000;
export const UNSUPPORTED_RECHECK_MS = 7 * 24 * 3600000;
// What still fails the run: the capture itself failing, a run in which companies that answered
// before start failing together (an outage), or a transient failure that retries have not cleared.
export const STUCK_AFTER_MS = 48 * 3600000;
export const OUTAGE_RATE = 0.25;
export const OUTAGE_MIN = 20;

// The source's refusal of one company, as opposed to a failure to reach the source at all.
const refusedBy = (body) => body?.ok === false && (body?.status === 500 || body?.reason === 'not-found');

/** Other identifiers for one company: its BSE scrip code for an NSE symbol, or its NSE symbol for a code. */
export function insiderAlternates(securityMap = {}) {
  const codeFor = new Map();
  for (const [code, security] of Object.entries(securityMap || {})) {
    const symbol = String(security?.ticker || '').toUpperCase();
    if (!symbol || symbol === code) continue;
    codeFor.set(symbol, codeFor.has(symbol) && codeFor.get(symbol) !== code ? null : code);
  }
  return (ticker, company) => {
    const t = String(ticker || '').toUpperCase();
    if (/^\d{6}$/.test(t)) {
      const symbol = String(securityMap?.[t]?.ticker || '').toUpperCase();
      return symbol && symbol !== t ? [symbol] : [];
    }
    return [company?.bseCode, codeFor.get(t)].filter(Boolean).map(String);
  };
}

/** A rotating company checkpoint supplements Screener without overwriting its four-list manifest.
 * Portfolio companies due for a two-hour check lead the queue, then companies whose last check
 * failed, then the universe by attempt time. Every read overlaps the last success by a week.
 */
export async function captureMunsInsiders(previous, companies, {
  request, now = Date.now, budgetMs = 12 * 60000, gapMs = 2500, checkpoint = () => {},
  alternates = (ticker, company) => (company?.bseCode ? [String(company.bseCode)] : []), retryLane = RETRY_LANE,
} = {}) {
  const started = now(), today = newsDay(started);
  const byTicker = structuredClone(previous?.byTicker || {});
  const list = [...new Map(companies.filter(c => c.ticker).map(c => [c.ticker.toUpperCase(), c])).entries()];
  const entry = (ticker) => byTicker[ticker] || {};
  const due = ([ticker, company]) => !!company.priority && started - Date.parse(entry(ticker).lastSuccessAt || '1970-01-01') >= 2 * 3600000;
  const byAge = (a, b) => String(entry(a[0]).checkedAt || '').localeCompare(String(entry(b[0]).checkedAt || ''));
  const eligible = list.filter(([ticker]) => !entry(ticker).unsupported
    || started - Date.parse(entry(ticker).checkedAt || '1970-01-01') >= UNSUPPORTED_RECHECK_MS);
  const lead = eligible.filter(due).sort(byAge);
  const retry = eligible.filter((c) => !due(c) && entry(c[0]).error && !entry(c[0]).unsupported).sort(byAge).slice(0, retryLane);
  const picked = new Set([...lead, ...retry].map(([ticker]) => ticker));
  // Workers consume the queue; coverage must keep every intended company throughout the run.
  const queue = [...lead, ...retry, ...eligible.filter(([ticker]) => !picked.has(ticker)).sort(byAge)];
  let gate = Promise.resolve(), nextStart = started, stopped = null;
  const run = { startedAt: new Date(started).toISOString(), attempted: 0, failed: 0, healthyAttempted: 0, healthyFailed: 0 };
  const state = () => ({ source: 'Muns insider disclosures via Sattva', checkedAt: new Date(now()).toISOString(),
    targetTickers: list.map(([ticker]) => ticker).sort(), byTicker, run,
    ...(stopped ? { error: `The insider source refused this deployment (${stopped}); the run stopped.` } : {}) });
  const pace = () => {
    const turn = gate.then(async () => {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, nextStart - now())));
      nextStart = now() + gapMs;
    });
    gate = turn; return turn;
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length && !stopped && now() - started < budgetMs) {
      const [ticker, company] = queue.shift(), prior = byTicker[ticker] || {};
      await pace();
      if (now() - started >= budgetMs || stopped) break;
      const checkedAt = new Date(now()).toISOString();
      const from = prior.lastSuccessAt ? shift(newsDay(prior.lastSuccessAt), -7) : shift(today, -365);
      // The identifier that last answered goes first, then the company's own, then the others.
      const ids = [...new Set([prior.via, ticker, ...alternates(ticker, company)].filter(Boolean).map(String))];
      let refused = false, tried = 0;
      run.attempted++;
      if (!prior.error) run.healthyAttempted++;
      try {
        let body = null, via = null;
        for (const id of ids) {
          if (tried) { await pace(); if (now() - started >= budgetMs || stopped) break; }
          tried++;
          // A refusal counts only when every identifier was refused; a timeout on any is transient.
          refused = false;
          body = await request(id, from, today);
          if (body?.ok !== false && Array.isArray(body?.trades)) { via = id; break; }
          if (['no-token', 'unauthorised'].includes(body?.reason)) stopped = body.reason;
          // Only the source refusing this company is worth asking again under another identifier.
          if (!(refused = refusedBy(body))) break;
        }
        if (!via) throw new Error(body?.message || 'Insider source returned an unreadable response');
        const incoming = body.trades.map(({ raw, ...row }) => ({ ...row, ticker }));
        if (incoming.some(r => !r.cells || typeof r.cells !== 'object' || Array.isArray(r.cells) || !Object.keys(r.cells).length)) throw new Error('Insider source returned an unreadable row');
        byTicker[ticker] = { checkedAt, lastSuccessAt: checkedAt, from: prior.from || from, to: today, error: null,
          ...(via !== ticker ? { via } : {}), trades: mergeInsiderTrades(prior.trades || [], incoming) };
      } catch (error) {
        const errorKind = refused && tried === ids.length ? 'refused' : 'transient';
        const failures = (prior.error ? prior.failures || 1 : 0) + 1;
        const firstFailedAt = prior.error ? prior.firstFailedAt || prior.checkedAt || checkedAt : checkedAt;
        const unsupported = errorKind === 'refused' && failures >= UNSUPPORTED_AFTER
          && Date.parse(checkedAt) - Date.parse(firstFailedAt) >= UNSUPPORTED_MIN_MS;
        byTicker[ticker] = { ...prior, checkedAt, error: error.message, errorKind, failures, firstFailedAt,
          unsupported, trades: prior.trades || [] };
        if (!unsupported) delete byTicker[ticker].unsupported;
        run.failed++;
        if (!prior.error) run.healthyFailed++;
      }
      // Preserve each completed response, including failures, if the runner is interrupted later.
      checkpoint(state());
    }
  }));
  return state();
}

const named = (entries) => entries.slice(0, 8).map(([ticker]) => ticker).join(', ') + (entries.length > 8 ? ` and ${entries.length - 8} more` : '');

/** Whether the capture ran well enough to call the run green, and what it should say either way. */
export function insiderCaptureHealth(insiders, now = Date.now()) {
  if (!insiders) return { ok: false, problems: ['The insider capture did not run.'], notes: [] };
  const entries = Object.entries(insiders.byTicker || {});
  const problems = [], notes = [];
  if (insiders.error) problems.push(insiders.error);
  const run = insiders.run || {};
  if (run.healthyAttempted >= OUTAGE_MIN && run.healthyFailed / run.healthyAttempted > OUTAGE_RATE) {
    problems.push(`${run.healthyFailed} of ${run.healthyAttempted} companies that answered last time failed this run; the source looks unavailable.`);
  }
  const stuck = entries.filter(([, e]) => e.error && !e.unsupported && e.errorKind === 'transient'
    && (e.failures || 1) >= UNSUPPORTED_AFTER && now - Date.parse(e.firstFailedAt || e.checkedAt) >= STUCK_AFTER_MS);
  if (stuck.length) problems.push(`${stuck.length} companies have failed every retry for over ${STUCK_AFTER_MS / 3600000} hours: ${named(stuck)}.`);
  const unsupported = entries.filter(([, e]) => e.unsupported);
  if (unsupported.length) notes.push(`${unsupported.length} companies the source refuses on every identifier; retained disclosures are kept and each is rechecked weekly: ${named(unsupported)}.`);
  const waiting = entries.filter(([, e]) => e.error && !e.unsupported);
  if (waiting.length) notes.push(`${waiting.length} failed company checks are retained and lead the next run: ${named(waiting)}.`);
  if (Number.isFinite(run.attempted)) notes.push(`This run checked ${run.attempted} companies; ${run.failed} failed.`);
  return { ok: !problems.length, problems, notes };
}
