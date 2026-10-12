// Pure validation shared by the authenticated bridge and server-backed size reader.
export function validHoldings(holdings) {
  return Array.isArray(holdings) && holdings.length <= 2000 && holdings.every((h) => typeof h?.isin === 'string' && /^[A-Z]{2}[A-Z0-9]{10}$/.test(h.isin) && typeof h.name === 'string' && h.name.length <= 300 &&
      typeof h.sector === 'string' && h.sector.length <= 200 && (h.ticker === null || (typeof h.ticker === 'string' && /^[A-Z0-9&.-]{1,30}$/.test(h.ticker))));
}

export function validPositionSizes(value, startedAt = Date.now()) {
  const sizes = value?.sizes;
  const checked = Date.parse(sizes?.checkedAt || '');
  const bookDay = Date.parse(`${sizes?.bookAsOf}T00:00:00Z`);
  if (!sizes || sizes.basis !== 'listed-market-value' || typeof sizes.complete !== 'boolean' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(sizes.bookAsOf) || !Number.isFinite(bookDay) || new Date(bookDay).toISOString().slice(0, 10) !== sizes.bookAsOf ||
      !Number.isSafeInteger(sizes.archiveVersion) || sizes.archiveVersion < 0 ||
      !Number.isFinite(checked) || checked < startedAt - 1000 || checked > Date.now() + 10_000 ||
      !validHoldings(value.holdings) || new Set(value.holdings.map((h) => h.isin)).size !== value.holdings.length ||
      JSON.stringify(value).length > 1_500_000) return false;
  if (!sizes.complete) return value.holdings.every((h) => h.weightPct === null);
  return value.holdings.every((h) => Number.isFinite(h.weightPct) && h.weightPct >= 0 && h.weightPct <= 100) &&
    Math.abs(value.holdings.reduce((sum, h) => sum + h.weightPct, 0) - 100) < 0.001;
}

