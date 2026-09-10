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

/** A rotating company checkpoint supplements Screener without overwriting its four-list manifest.
 * Portfolio companies due for a two-hour check lead the queue; the universe rotates by attempt
 * time so a failing company cannot starve the rest. Every read overlaps the last success by a week.
 */
export async function captureMunsInsiders(previous, companies, {
  request, now = Date.now, budgetMs = 12 * 60000, gapMs = 2500, checkpoint = () => {},
} = {}) {
  const started = now(), today = newsDay(started);
  const byTicker = structuredClone(previous?.byTicker || {});
  const list = [...new Map(companies.filter(c => c.ticker).map(c => [c.ticker.toUpperCase(), c])).entries()];
  const due = ([ticker, company]) => !!company.priority && started - Date.parse(byTicker[ticker]?.lastSuccessAt || '1970-01-01') >= 2 * 3600000;
  const queue = list.sort((a, b) => Number(due(b)) - Number(due(a)) ||
    String(byTicker[a[0]]?.checkedAt || '').localeCompare(String(byTicker[b[0]]?.checkedAt || '')));
  let gate = Promise.resolve(), nextStart = started, stopped = false;
  const state = () => ({ source: 'Muns insider disclosures via Sattva', checkedAt: new Date(now()).toISOString(),
    targetTickers: list.map(([ticker]) => ticker).sort(), byTicker });
  const pace = () => {
    const turn = gate.then(async () => {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, nextStart - now())));
      nextStart = now() + gapMs;
    });
    gate = turn; return turn;
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length && !stopped && now() - started < budgetMs) {
      const [ticker] = queue.shift(), prior = byTicker[ticker] || {};
      await pace();
      if (now() - started >= budgetMs || stopped) break;
      const checkedAt = new Date(now()).toISOString();
      const from = prior.lastSuccessAt ? shift(newsDay(prior.lastSuccessAt), -7) : shift(today, -365);
      try {
        const body = await request(ticker, from, today);
        if (body?.ok === false || !Array.isArray(body?.trades)) {
          if (['no-token', 'unauthorised'].includes(body?.reason)) stopped = true;
          throw new Error(body?.message || 'Insider source returned an unreadable response');
        }
        const incoming = body.trades.map(({ raw, ...row }) => ({ ...row, ticker }));
        if (incoming.some(r => !r.cells || typeof r.cells !== 'object' || Array.isArray(r.cells) || !Object.keys(r.cells).length)) throw new Error('Insider source returned an unreadable row');
        byTicker[ticker] = { checkedAt, lastSuccessAt: checkedAt, from: prior.from || from, to: today, error: null,
          trades: mergeInsiderTrades(prior.trades || [], incoming) };
      } catch (error) {
        byTicker[ticker] = { ...prior, checkedAt, error: error.message, trades: prior.trades || [] };
      }
      // Preserve each completed response, including failures, if the runner is interrupted later.
      checkpoint(state());
    }
  }));
  return state();
}
