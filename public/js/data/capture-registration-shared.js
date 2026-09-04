export const CAPTURE_REGISTRY_SHARDS = 4;
export const CAPTURE_REGISTRY_LIMIT = 250; // Per shard; bounds the scheduled request backlog.
export const CAPTURE_REGISTRATION_BATCH = 50;
export const captureRegistryShard = isin => [...isin].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 0) % CAPTURE_REGISTRY_SHARDS;
export function registeredCompany(company) {
  if (!/^IN[A-Z0-9]{10}$/.test(company?.isin || '') || !/^[A-Z0-9&._-]{1,50}$/.test(company?.ticker || '') ||
      typeof company.name !== 'string' || !company.name.trim() || company.name.length > 200) throw new Error('Invalid capture company');
  return { isin: company.isin, ticker: company.ticker, name: company.name };
}
