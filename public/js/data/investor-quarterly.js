// Pure cross-investor comparison. One closed quarter pair, one company identity and
// one vote per investor; missing data never becomes evidence of no activity.
import { classifyHolding, companyKey, filedPair, isFiledQuarter, isMove, quarterOrder, round2 } from './finology-shared.js';

export function summariseQuarter(books, { include = null, limit = 5, investors = [] } = {}) {
  const names = new Map(investors.map((i) => [i.slug, i.name]));
  const uniqueBooks = [...new Map(books.map((b) => [b.slug, b])).values()];
  const latest = uniqueBooks.flatMap((b) => b.quarters).filter((q) => isFiledQuarter(q))
    .sort((a, b) => quarterOrder(b) - quarterOrder(a))[0] || null;
  const n = quarterOrder(latest);
  const priorOrder = n == null ? null : n % 100 === 3 ? n - 91 : n - 3;
  const prior = uniqueBooks.flatMap((b) => b.quarters).find((q) => priorOrder != null && quarterOrder(q) === priorOrder) || null;
  const moves = [], excludedBooks = [];
  let comparableBooks = 0, singleQuarterBooks = 0;
  for (const b of uniqueBooks) {
    const l = b.quarters.find((q) => latest && quarterOrder(q) === n);
    const p = b.quarters.find((q) => prior && quarterOrder(q) === priorOrder);
    if (!l || !p) {
      if (b.quarters.filter((q) => isFiledQuarter(q)).length < 2) singleQuarterBooks++;
      excludedBooks.push({ slug: b.slug, investor: names.get(b.slug) || b.name, latest: filedPair(b.quarters)[0] });
      continue;
    }
    comparableBooks++;
    for (const h of b.holdings) {
      if (include && !include(h.company, h)) continue;
      const change = classifyHolding(h, l, p);
      if (change) moves.push({ ...h, ...change, investor: names.get(b.slug) || b.name, slug: b.slug, latest: l, prior: p });
    }
  }
  const counts = { new: 0, exited: 0, added: 0, trimmed: 0, held: 0, awaiting: 0 };
  for (const m of moves) counts[m.action]++;
  const group = (actions) => {
    const byCompany = new Map();
    for (const m of moves) {
      if (!actions.includes(m.action)) continue;
      const key = companyKey(m);
      if (!byCompany.has(key)) byCompany.set(key, { company: m.company, companySlug: m.companySlug, investors: new Map() });
      byCompany.get(key).investors.set(m.slug, { investor: m.investor, slug: m.slug, action: m.action, deltaPp: m.deltaPp, now: m.now });
    }
    return [...byCompany.values()].map((c) => {
      const investors = [...c.investors.values()];
      const sized = investors.filter((i) => i.deltaPp != null).length;
      return { ...c, investors, count: investors.length, sized,
        // A partial sum can look like the total across all holders. Only show a complete sum.
        sumPp: sized === investors.length ? round2(investors.reduce((a, i) => a + i.deltaPp, 0)) : null };
    }).filter((c) => c.count > 1).sort((a, b) => b.count - a.count || Math.abs(b.sumPp || 0) - Math.abs(a.sumPp || 0) || a.company.localeCompare(b.company));
  };
  const buys = group(['new', 'added']), exits = group(['exited', 'trimmed']);
  const byAction = (action) => moves.filter((m) => m.action === action);
  return {
    latest, prior, counts, total: moves.length, pairs: latest && prior ? [{ latest, prior }] : [],
    comparableBooks, singleQuarterBooks, excludedBooks,
    loadedBooks: uniqueBooks.length,
    missingBooks: investors.filter((i) => !uniqueBooks.some((b) => b.slug === i.slug)).length,
    contributingBooks: new Set(moves.filter((m) => isMove(m.action)).map((m) => m.slug)).size,
    coveredBooks: new Set(moves.map((m) => m.slug)).size,
    consensusBuys: buys.slice(0, limit), consensusExits: exits.slice(0, limit),
    consensusBuyCount: buys.length, consensusExitCount: exits.length,
    newEntrants: byAction('new').sort((a, b) => b.now - a.now),
    topAdds: byAction('added').sort((a, b) => b.deltaPp - a.deltaPp),
    topTrims: byAction('trimmed').sort((a, b) => a.deltaPp - b.deltaPp),
    exits: byAction('exited'),
  };
}
