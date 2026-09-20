import { contentTag } from './http.mjs';
// All ownership arithmetic runs in the collector / Worker, never in the browser.
export const MF_OBJECT = 'mutual-funds:v1';
export const MF_ORIGIN = 'https://sattva-central-research.tech-441.workers.dev';
export const MF_ENDPOINT = `${MF_ORIGIN}/api/mutual-funds/collector`;
export const MF_WORKFLOW = 'mutual-funds-refresh.yml';
export const MF_INTERVAL = 15 * 60000;
export const validIsin = value => /^IN[A-Z0-9]{10}$/.test(value || '');
export const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function monthKey(value) {
  if (/^20\d\d-(0[1-9]|1[0-2])(?:-|$)/.test(value || '')) return value.slice(0,7);
  const m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ -](\d{2}|20\d\d)$/i.exec(value || '');
  return m ? `${m[2].length === 2 ? '20' : ''}${m[2]}-${String(['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase())+1).padStart(2,'0')}` : null;
}
export function previousMonth(month) {
  const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth()-1); return d.toISOString().slice(0,7);
}
export const targetMonth = (now = Date.now()) => previousMonth(new Date(now).toISOString().slice(0,7));
export function change(current, prior) {
  if (number(current) === null || number(prior) === null) return { change: null, changePct: null, action: 'Pending' };
  const delta = current - prior;
  return { change: delta, changePct: prior > 0 ? delta/prior*100 : null,
    action: !delta ? 'No material change' : prior === 0 ? 'New' : current === 0 ? 'Exited' : delta > 0 ? 'Added' : 'Reduced' };
}
export function mergeCompany(previous, incoming) {
  if (!validIsin(incoming?.isin) || !Array.isArray(incoming.funds)) throw Error('Invalid company');
  const funds = new Map((previous?.funds || []).map(f => [f.id, structuredClone(f)]));
  for (const next of incoming.funds) {
    if (typeof next.id !== 'string' || !next.id || next.id.length > 300 || !next.months) throw Error('Invalid fund');
    const old = funds.get(next.id);
    const months = { ...old?.months };
    for (const [month, point] of Object.entries(next.months)) {
      if (monthKey(month) !== month || !point || (point.shares !== null && (!Number.isSafeInteger(point.shares) || point.shares < 0))) throw Error('Invalid holding');
      const prior = months[month];
      // A missing or older observation cannot retract a known disclosure.
      if (prior && ((Date.parse(point.checkedAt)||0) < (Date.parse(prior.checkedAt)||0) || (point.shares === null && prior.shares !== null))) continue;
      months[month] = point;
    }
    funds.set(next.id, { ...old, ...next, months });
  }
  const denominator = incoming.denominator && (!previous?.denominator || incoming.denominator.checkedAt >= previous.denominator.checkedAt)
    ? incoming.denominator : previous?.denominator || null;
  return { ...previous, ...incoming, denominator, funds: [...funds.values()] };
}
export function projectCompany(company, { month = null, now = Date.now() } = {}) {
  const months = [...new Set(company.funds.flatMap(f => Object.keys(f.months)))].filter(m => m <= targetMonth(now)).sort().reverse();
  const latest = month || months[0] || targetMonth(now), prior = previousMonth(latest);
  const funds = company.funds.map(f => {
    const points = Object.fromEntries(Object.entries(f.months).map(([m,p])=>[m,{...p,...change(p.shares,f.months[previousMonth(m)]?.shares)}]));
    const current = points[latest], older = points[prior];
    return { ...f, months: points, current: current || null, prior: older || null, ...change(current?.shares, older?.shares) };
  }).filter(f => Object.values(f.months).some(p => p.shares > 0));
  const current = funds.filter(f => number(f.current?.shares) !== null);
  const comparable = funds.filter(f => f.change !== null);
  const added = comparable.filter(f => f.change > 0), reduced = comparable.filter(f => f.change < 0);
  const totalShares = current.length ? current.reduce((s,f) => s+f.current.shares,0) : null;
  const netChange = comparable.length ? comparable.reduce((s,f) => s+f.change,0) : null;
  const denominator = company.denominator;
  const denominatorFresh = denominator?.shares > 0 && Number.isSafeInteger(denominator.shares) && now-Date.parse(denominator.checkedAt) >= -60000 && now-Date.parse(denominator.checkedAt) <= 7*86400000;
  const companyPct = totalShares !== null && denominatorFresh ? totalShares/denominator.shares*100 : null;
  const topBuyer = added.sort((a,b)=>b.change-a.change)[0], topSeller = reduced.sort((a,b)=>a.change-b.change)[0];
  const fmt = n => Math.abs(n).toLocaleString('en-IN');
  const insight = netChange === null ? 'Comparable monthly disclosures are not available yet.'
    : `${added.length} funds added; ${reduced.length} reduced. Net ${netChange < 0 ? '−' : '+'}${fmt(netChange)} shares.${topBuyer ? ` Largest addition: ${topBuyer.name} (+${fmt(topBuyer.change)}).` : ''}${topSeller ? ` Largest reduction: ${topSeller.name} (−${fmt(topSeller.change)}).` : ''}`;
  return { ...company, months, month: latest, priorMonth: prior, funds,
    totalShares, netChange, addedShares: comparable.length ? added.reduce((s,f)=>s+f.change,0) : null,
    reducedShares: comparable.length ? -reduced.reduce((s,f)=>s+f.change,0) : null,
    addedFunds: added.length, reducedFunds: reduced.length, holders: current.filter(f=>f.current.shares>0).length,
    comparableFunds: comparable.length, pendingFunds: funds.length-comparable.length,
    companyPct: companyPct <= 100 ? companyPct : null, denominatorFresh,
    direction: netChange === null ? 'Pending' : netChange > 0 ? 'Added' : netChange < 0 ? 'Reduced' : 'No material change',
    insight, topBuyer: topBuyer ? { name:topBuyer.name,change:topBuyer.change } : null,
    topSeller: topSeller ? { name:topSeller.name,change:topSeller.change } : null,
    disclosureCheckedAt: current.map(f=>f.current.checkedAt).filter(Boolean).sort().at(-1) || null };
}
export function summaryOf(projected) {
  const { funds, ...summary } = projected;
  return summary;
}
export function coverageState(meta, now = Date.now()) {
  const amcs = meta?.amcs || [], target = targetMonth(now);
  const current = amcs.filter(a => a.month === target && a.status === 'ok');
  const age=now-Date.parse(meta?.checkedAt);
  const stale = !Number.isFinite(age) || age < -60000 || age > 45*60000;
  return { state: !amcs.length ? 'unavailable' : stale ? 'stale' : current.length !== amcs.length || meta?.state !== 'complete' ? 'partial' : 'current',
    targetMonth: target, currentAmcs: current.length, totalAmcs: amcs.length, checkedAt: meta?.checkedAt || null };
}

export const companyRevision = company => contentTag(JSON.stringify({...company,denominatorVerifiedAt:company.denominator?.checkedAt||null},(key,value)=>["checkedAt","fetchedAt","revision"].includes(key)?undefined:value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value));
