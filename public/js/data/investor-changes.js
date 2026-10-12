// Changes use dated trades for activity and dated observations for holdings. Never add the two.
import { deriveMoves, quarterOrder } from './finology-shared.js';
import { newsDay as indiaDay } from './news-window.js';
const recentDays = (days, today) => ({ from: new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10), to: today });
export { indiaDay };

export const PERIODS = [
  { id: 'today', label: 'Today' }, { id: '3d', label: '3 days' }, { id: '7d', label: '7 days' },
  { id: 'month', label: 'This month' }, { id: 'quarter', label: 'This quarter' },
  { id: '6m', label: '6 months' }, { id: 'year', label: '1 year' }, { id: 'itd', label: 'ITD' },
];
const iso = (date) => date.toISOString().slice(0, 10);
export function periodRange(period, today = indiaDay()) {
  if (['today', '3d', '7d'].includes(period)) return recentDays(period === 'today' ? 1 : Number.parseInt(period, 10), today);
  const [y, m, d] = today.split('-').map(Number);
  let from = null;
  if (period === 'month') from = iso(new Date(Date.UTC(y, m - 1, 1)));
  if (period === 'quarter') from = iso(new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1)));
  if (period === '6m' || period === 'year') {
    const month = new Date(Date.UTC(y, m - 1 - (period === '6m' ? 6 : 12), 1));
    const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    from = iso(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(d, last))));
  }
  return { from, to: today };
}
export const inPeriod = (row, range) => !!row.date && row.date <= range.to && (!range.from || row.date >= range.from);

// Full names only. Punctuation and equivalent legal suffixes are harmless; substring/fuzzy
// matches can attribute one person's trade to another. Ambiguous identities are left unmatched.
export const identity = (value) => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/\b(pvt|private)\b/g, 'private').replace(/\b(ltd|limited)\b/g, 'limited')
  .replace(/[^a-z0-9]/g, '');
export function identityIndex(people) {
  const index = new Map(), candidates = new Map();
  for (const person of people) for (const name of [person.name, ...(person.aliases || [])]) {
    const key = identity(name);
    if (!key) continue;
    const values = candidates.get(key) || [];
    if (!values.some((p) => p.id === person.id)) values.push(person);
    candidates.set(key, values);
  }
  for (const [key, values] of candidates) {
    const verified = values.map((p) => p.verifiedNames?.find((n) => identity(n.name) === key)?.entityId);
    index.set(key, values.length === 1 ? values[0] : verified.every(Boolean) && new Set(verified).size === 1 ? values : null);
  }
  return index;
}
const field = (cells, names) => {
  const key = Object.keys(cells || {}).find((key) => names.includes(key.toLowerCase()));
  return key ? String(cells[key] ?? '').trim() : '';
};
export const dealCategory = (row) => {
  const value = field(row.cells, ['trade category']).toLowerCase();
  return /^bulk(?: deal)?$/.test(value) ? 'Bulk deal' : /^block(?: deal)?$/.test(value) ? 'Block deal' : null;
};
export const bulkDealKey = (row) => [dealCategory(row), row.ticker, row.date, identity(row.cells?.Insider), row.cells?.Transaction,
  String(row.cells?.['Trade Shares'] || '').replace(/,/g, ''), String(row.cells?.Price || '').replace(/,/g, ''), row.cells?.Exchange || ''].join('|');
export function preserveBulkDeals(incoming, previous = []) {
  const result = [...incoming], seen = new Set(incoming.filter(dealCategory).map(bulkDealKey));
  for (const row of previous.filter(dealCategory)) {
    if (!seen.has(bulkDealKey(row))) { result.push(row); seen.add(bulkDealKey(row)); }
  }
  return result;
}
export function matchedDeals(rows, people) {
  const index = identityIndex(people), seen = new Map(), events = [];
  for (const row of rows) {
    const category = dealCategory(row);
    if (!category) continue; // A renamed tab does not turn SAST/insider filings into bulk deals.
    const reportedName = field(row.cells, ['insider', 'client name', 'client', 'person', 'name']);
    const match = index.get(identity(reportedName));
    if (!match) continue;
    const transaction = field(row.cells, ['transaction', 'buy/sell', 'side']).toLowerCase();
    const action = /^(buy|bought|purchase)$/.test(transaction) ? 'buy' : /^(sell|sold|sale)$/.test(transaction) ? 'sell' : null;
    if (!action) continue;
    const quantity = field(row.cells, ['trade shares', 'quantity']);
    const price = field(row.cells, ['price']);
    for (const person of Array.isArray(match) ? match : [match]) {
      const key = [person.id, category, row.exchangeSecurity || row.ticker, row.date, identity(reportedName), action, quantity.replace(/,/g, ''), price.replace(/,/g, ''), field(row.cells, ['exchange'])].join('|');
      if (seen.has(key)) {
        const event = seen.get(key);
        event.evidence.push(row);
        continue;
      }
      const event = { id: key, date: row.date, person: person.name, personId: person.id,
        company: field(row.cells, ['company']) || row.ticker, ticker: row.ticker,
        action, quantity: quantity || null, value: field(row.cells, ['trade value']) || null,
        source: `${category}${row.cells?.Exchange ? ` · ${row.cells.Exchange}` : ''}`, reportedName, raw: row, evidence: [row], url: row.url || null };
      seen.set(key, event);
      events.push(event);
    }
  }
  return events;
}
/** Ledger events retain uncertain carried dates and transfers with their own labels. */
export function managerTrades(managers) {
  return managers.flatMap(m => (m.transactions || []).map(t => ({ id: `${m.id}|${t.id}`, date: t.date,
    person: m.name, personId: m.id, company: t.security, ticker: t.ticker, action: t.side,
    quantity: t.quantity, amount: t.amount, source: t.dateSheet ? 'Family ledger · date unverified' : t.transfer ? 'Family ledger · transfer' : 'Family ledger',
    dateKind: 'ledger', raw: t, evidence: [], reportedName: null })));
}
const quarterEnd = (label) => {
  const order = quarterOrder(label), year = Math.floor(order / 100), month = order % 100;
  return order && [3, 6, 9, 12].includes(month) ? iso(new Date(Date.UTC(year, month, 0))) : null;
};
// Both quarter-end dates travel with each observation; neither is a trade date.
export const quarterEndDate = quarterEnd;
export function investorHoldings(books, investors, today = indiaDay()) {
  const names = new Map(investors.map((i) => [i.slug, i.name])), events = [];
  for (const book of books) {
    const quarters = (book.quarters || []).filter((q) => quarterEnd(q) && quarterEnd(q) < today)
      .sort((a, b) => quarterOrder(b) - quarterOrder(a));
    for (let i = 0; i < quarters.length - 1; i++) {
      const latest = quarters[i], prior = quarters[i + 1];
      for (const move of deriveMoves({ ...book, quarters: [latest, prior] }, today).moves) {
        if (['held', 'unknown', 'awaiting'].includes(move.action)) continue;
        events.push({ ...move, id: `holding|${book.slug}|${move.companySlug}|${latest}`,
          date: quarterEnd(latest), from: quarterEnd(prior), period: `${prior} → ${latest}`,
          priorLabel: prior, latestLabel: latest, dateKind: 'pattern',
          sourceCheckedAt: book.sourceCheckedAt || book.fetchedAt || null,
          person: names.get(book.slug) || book.name, personId: book.slug, source: 'Quarterly disclosure', unit: '% of company' });
      }
    }
  }
  return events;
}
