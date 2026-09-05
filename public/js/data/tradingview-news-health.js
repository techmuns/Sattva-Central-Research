// Same freshness contract for the reader and the independent operational watchdog.
// A successful HTTP read of our static file is NOT a fresh check of every portfolio symbol.
export function assessTradingViewCoverage(coverage, { now = Date.now() } = {}) {
  const critical = [], warnings = [];
  const add = (list, code, count = 1) => list.push({ code, count });
  const validTime = value => Number.isFinite(Date.parse(value || '')) && Date.parse(value) <= now + 600000;
  if (!coverage || !validTime(coverage.checkedAt) || !(coverage.activeCompanies > 0) ||
      !Number.isInteger(coverage.plannedSymbols) || coverage.plannedSymbols < 0 ||
      !Number.isInteger(coverage.staleOrFailedSymbols) || coverage.staleOrFailedSymbols < 0) {
    add(critical, 'coverage-missing-or-invalid');
  } else {
    // Fixed operational target: a corrupted snapshot cannot extend its own freshness allowance.
    if (now - Date.parse(coverage.checkedAt) > 45 * 60000) add(critical, 'capture-stale');
    if (!coverage.plannedSymbols) add(critical, 'no-verified-symbols');
    if (coverage.staleOrFailedSymbols) add(critical, 'symbol-reads-stale-or-failed', coverage.staleOrFailedSymbols);
    if (coverage.plannedSymbols && (!validTime(coverage.oldestSuccessAt) || now - Date.parse(coverage.oldestSuccessAt) > 45 * 60000))
      add(critical, 'portfolio-sweep-incomplete-or-stale');
    if (Date.parse(coverage.blockedUntil || '') > now) add(critical, 'source-backoff');
    if (coverage.portfolioError) add(critical, 'portfolio-membership-unverified');
    if (coverage.unresolvedCompanies) add(warnings, 'companies-without-verified-symbols', coverage.unresolvedCompanies);
    if (coverage.possibleGapSymbols) add(warnings, 'possible-public-window-gaps', coverage.possibleGapSymbols);
    if (coverage.restrictedHeadlines) add(warnings, 'restricted-headlines-not-extracted', coverage.restrictedHeadlines);
  }
  return { ok: !critical.length, status: critical.length ? 'critical' : warnings.length ? 'warning' : 'ok', critical, warnings };
}
