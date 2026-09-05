// Pure contract for Screener's company Insights capture. The collector, Worker and browser all
// validate the same public shape; credentials, HTML and account state never enter the artifact.

export const SCREENER_INSIGHTS_ID = 'screener-insights';
export const SCREENER_INSIGHTS_REPO = 'techmuns/Sattva-Central-Research';
export const SCREENER_INSIGHTS_WORKFLOW = 'screener-insights-refresh.yml';
export const SCREENER_INSIGHTS_ARTIFACT = 'screener-insights-v1.json.gz';
export const SCREENER_INSIGHTS_LIMIT = 24 * 1024 * 1024;
export const SCREENER_INSIGHTS_COMPRESSED_LIMIT = 4 * 1024 * 1024;
export const SCREENER_INSIGHTS_FRESH_MS = 36 * 60 * 60 * 1000;
export const SCREENER_INSIGHTS_MAX_COMPANIES = 1_000;
export const SCREENER_INSIGHTS_MAX_METRICS = 40;
export const SCREENER_INSIGHTS_MAX_POINTS = 16;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^[A-Z0-9&-]{1,30}$/;
const PERIODICITIES = new Set(['quarterly', 'yearly']);

export function safeInsightUrl(value, { screener = false } = {}) {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://www.screener.in');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (screener && (url.protocol !== 'https:' || !['screener.in', 'www.screener.in'].includes(url.hostname))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export const screenerInsightKey = (row = {}) =>
  `${String(row.companyKey || '').toUpperCase()}|${row.periodicity || ''}|${String(row.metric || '').trim().toLowerCase()}`;

function validPoint(point) {
  return !!point && DAY.test(point.period || '') && typeof point.label === 'string' && point.label.length <= 40 &&
    typeof point.value === 'string' && point.value.length <= 80 &&
    (point.numeric === null || point.numeric === undefined || Number.isFinite(point.numeric)) &&
    (!point.source || (
      typeof point.source.title === 'string' && point.source.title.length <= 180 &&
      (!point.source.quote || (typeof point.source.quote === 'string' && point.source.quote.length <= 500)) &&
      (!point.source.page || (typeof point.source.page === 'string' && point.source.page.length <= 30)) &&
      (!point.source.url || !!safeInsightUrl(point.source.url))
    ));
}

export function validateScreenerInsightRows(rows) {
  if (!Array.isArray(rows) || rows.length > SCREENER_INSIGHTS_MAX_METRICS) throw Error('Invalid Screener insight rows');
  const ids = new Set();
  for (const row of rows) {
    const id = screenerInsightKey(row);
    if (!row || !id || typeof row.metric !== 'string' || !row.metric.trim() || row.metric.length > 180 ||
        (row.unit !== null && row.unit !== undefined && (typeof row.unit !== 'string' || row.unit.length > 50)) ||
        !PERIODICITIES.has(row.periodicity) || !Array.isArray(row.values) || !row.values.length ||
        row.values.length > SCREENER_INSIGHTS_MAX_POINTS || !row.values.every(validPoint) || ids.has(id)) {
      throw Error('Invalid Screener insight record');
    }
    const periods = row.values.map((point) => point.period);
    if (new Set(periods).size !== periods.length || [...periods].sort().join('|') !== periods.join('|')) {
      throw Error('Invalid Screener insight periods');
    }
    ids.add(id);
  }
  return rows;
}

export function validateScreenerInsightCompanies(companies) {
  if (!Array.isArray(companies) || companies.length > SCREENER_INSIGHTS_MAX_COMPANIES) throw Error('Invalid Screener insight companies');
  const keys = new Set();
  for (const company of companies) {
    const companyKey = String(company?.companyKey || '').toUpperCase();
    const url = safeInsightUrl(company?.companyUrl, { screener: true });
    const companyPath = url ? /^\/company\/([^/]+)\/(?:consolidated\/)?$/.exec(new URL(url).pathname) : null;
    if (!companyKey || companyKey.length > 80 || keys.has(companyKey) || typeof company.name !== 'string' ||
        !company.name.trim() || company.name.length > 300 || !url ||
        !companyPath || decodeURIComponent(companyPath[1]).toUpperCase() !== companyKey ||
        (company.ticker !== null && company.ticker !== undefined && !TICKER.test(company.ticker)) ||
        typeof company.inPortfolio !== 'boolean' || typeof company.inUniverse !== 'boolean' ||
        !Number.isFinite(Date.parse(company.checkedAt || '')) || !Array.isArray(company.rows)) {
      throw Error('Invalid Screener insight company');
    }
    validateScreenerInsightRows(company.rows);
    keys.add(companyKey);
  }
  return companies;
}

export function validateScreenerInsightsCapture(capture, now = Date.now()) {
  const checkedAt = Date.parse(capture?.checkedAt || '');
  if (capture?.version !== 1 || capture.sourceId !== SCREENER_INSIGHTS_ID || !Number.isFinite(checkedAt) ||
      checkedAt > now + 60_000 || !Number.isSafeInteger(capture.targetCount) || capture.targetCount < 1 ||
      !Number.isSafeInteger(capture.checkedCount) || capture.checkedCount < 0 || capture.checkedCount > capture.targetCount ||
      !Number.isSafeInteger(capture.failedCount) || capture.failedCount < 0 || typeof capture.fullCoverage !== 'boolean' ||
      !Array.isArray(capture.companies) || capture.companies.length > capture.targetCount ||
      !Array.isArray(capture.targetKeys) || capture.targetKeys.length !== capture.targetCount ||
      new Set(capture.targetKeys).size !== capture.targetKeys.length ||
      capture.targetKeys.some((key) => typeof key !== 'string' || !key || key.length > 80)) {
    throw Error('Invalid Screener insights capture');
  }
  validateScreenerInsightCompanies(capture.companies);
  if (capture.companies.some((company) => !capture.targetKeys.includes(company.companyKey))) throw Error('Unexpected Screener insight company');
  if (capture.fullCoverage && (capture.failedCount || capture.companies.length !== capture.targetCount)) throw Error('Incomplete Screener insights capture');
  return capture;
}

/** Replace every company checked now, retain unvisited companies, and forget removed targets. */
export function mergeScreenerInsightsCapture(current, previous = null, now = Date.now()) {
  validateScreenerInsightsCapture(current, now);
  if (!previous) return current;
  validateScreenerInsightsCapture(previous, now);
  const targets = new Set(current.targetKeys);
  const companies = new Map(previous.companies.filter((company) => targets.has(company.companyKey)).map((company) => [company.companyKey, company]));
  for (const company of current.companies) companies.set(company.companyKey, company);
  const merged = {
    ...current,
    companies: [...companies.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  merged.fullCoverage = merged.failedCount === 0 && merged.companies.length === merged.targetCount;
  return validateScreenerInsightsCapture(merged, now);
}
