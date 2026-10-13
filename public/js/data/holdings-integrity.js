// Shared by the coverage screen and the scheduled audit. Targets are operating policies,
// not regulatory deadlines. A successful fetch never establishes portfolio completeness.
import { comparisonPeriods, summarise, disclosureStatus, periodEnd } from './finology-shared.js';
import { currentRelation } from './public-holdings-shared.js';

export const POLICY = { investorHours: 30, bulkHours: 72, entityReviewDays: 90 };
const ageDays = (value, now) => Number.isFinite(Date.parse(value)) ? Math.max(0, (Date.parse(now) - Date.parse(value)) / 86400000) : Infinity;

export function assessCoverage({ snapshot = {}, deals = {}, exchange = null, evidence = {}, publicHoldings = null, now = new Date().toISOString() } = {}) {
  const rows = [];
  for (const investor of snapshot.investors || []) {
    const book = snapshot.books?.[investor.slug], issues = [];
    const fetchedAt = book?.sourceCheckedAt || book?.fetchedAt || null;
    if (!book) issues.push('Book unavailable');
    else {
      if (snapshot.failed?.[investor.slug] || book.stale) issues.push('Refresh failed; last successful book retained');
      if (ageDays(fetchedAt, now) * 24 > POLICY.investorHours) issues.push('Source check overdue');
      const comparison = comparisonPeriods(book, now.slice(0, 10)), totals = summarise(book, now.slice(0, 10));
      if (!comparison.comparable) issues.push('Consecutive completed quarters unavailable');
      if (!totals.latestQuarter || ageDays(periodEnd(totals.latestQuarter), now) > 135) issues.push('Quarterly disclosures overdue');
      const unresolved = book.holdings.filter((h) => [comparison.latest, comparison.prior].filter(Boolean).some((q) =>
        ['unknown', 'filing_due'].includes(disclosureStatus(h, q))));
      if (unresolved.length) issues.push(`${unresolved.length} rows have unconfirmed comparison cells`);
      if (totals.offCycleCount) issues.push(`${totals.offCycleCount} later updates; not a complete quarterly book`);
      if (totals.missingValues) issues.push(`${totals.missingValues} disclosed stakes lack usable valuations`);
    }
    const relations = (evidence.relations || []).filter((r) => r.investorSlugs?.includes(investor.slug));
    rows.push({ id: investor.slug, name: investor.name, kind: 'investor', fetchedAt,
      asOf: book ? summarise(book, now.slice(0, 10)).latestQuarter : null, issues,
      identity: relations.length ? `${relations.length} evidenced relationship(s); full coverage unverified` : 'Associated entities not reviewed',
      sourceUrl: `https://ticker.finology.in/investor/${encodeURIComponent(investor.slug)}` });
  }
  const sourceIssues = [];
  if (!(snapshot.investors || []).length) sourceIssues.push('Investor list unavailable');
  if (exchange) {
    if (ageDays(exchange.checkedAt, now) * 24 > POLICY.bulkHours || exchange.sources?.length !== 4 || exchange.sources.some((s) => s.ok !== true)) sourceIssues.push('NSE/BSE bulk/block feed overdue or failed');
    if (exchange.deliveryError) sourceIssues.push('NSE/BSE live delivery unavailable; saved reports retained');
  } else if (ageDays(deals.bulkDeals?.capturedAt, now) * 24 > POLICY.bulkHours || deals.bulkDeals?.error) sourceIssues.push('Bulk/block feed overdue or failed');
  if (!publicHoldings) sourceIssues.push('Public disclosure reconciliation unavailable');
  else {
    if (ageDays(publicHoldings.captureCheckedAt, now) * 24 > POLICY.investorHours) sourceIssues.push('Exchange shareholding capture overdue');
    if (publicHoldings.sources?.length !== 3 || publicHoldings.sources.some((s) => !s.ok)) sourceIssues.push('Some exchange shareholding indexes could not be read');
    if (publicHoldings.coverage?.pending) sourceIssues.push(`${publicHoldings.coverage.pending} exchange filings await a successful read`);
    if (publicHoldings.coverage?.partial) sourceIssues.push(`${publicHoldings.coverage.partial} exchange filings contain unresolved rows`);
    if (publicHoldings.coverage?.failedRefresh) sourceIssues.push(`${publicHoldings.coverage.failedRefresh} exchange filing refreshes failed; last successful reads retained`);
    if (publicHoldings.securityMaster?.ok === false) sourceIssues.push('NSE security identifier check failed; retained identities used where available');
    for (const row of rows) {
      const profile = publicHoldings.profiles?.find((p) => p.id === row.id && p.kind === 'investor');
      if (profile?.issues) row.issues.push(`${profile.issues} public-source checks need review`);
      row.identity = `${profile?.matches || 0} latest public disclosures matched; ${profile?.relations || 0} verified entity links`;
    }
  }
  if ((evidence.relations || []).some((r) => ageDays(r.verifiedAt, now) > POLICY.entityReviewDays)) sourceIssues.push('Some entity relationships need renewed review');
  return { evaluatedAt: now, rows, issues: sourceIssues, attention: rows.filter((r) => r.issues.length).length,
    total: rows.length, complete: false, policy: POLICY };
}

// Relations expand public-deal discovery while preserving the exact reported holder on each row.
export function withVerifiedEntities(people, evidence, kind, today = new Date().toISOString()) {
  return people.map((person) => {
    const relations = (evidence?.relations || []).filter((r) => currentRelation(r, today) && (kind === 'investor' ? r.investorSlugs : r.managerIds)?.includes(person.id));
    const verifiedNames = relations.flatMap((r) => [r.legalName, ...(r.aliases || [])].map((name) => ({ name, entityId: r.entityId,
      kind: r.kind, relationship: r.relationship, sourceUrl: r.sourceUrl, verifiedAt: r.verifiedAt })));
    return { ...person, verifiedNames, aliases: [...(person.aliases || []), ...verifiedNames.map((r) => r.name)] };
  });
}
