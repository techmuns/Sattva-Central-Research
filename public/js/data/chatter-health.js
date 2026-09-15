// Readability, source-check freshness and historical coverage are separate facts.
export const CHATTER_SOURCES = ['valuepickr', 'news', 'tradingqna'];
export function chatterHealth(meta, now = Date.now()) {
  if (!meta?.readable) return { state: meta?.checking ? 'checking' : 'unavailable', label: meta?.checking ? 'Checking for updates' : 'Unavailable', checkedAt: null };
  const sources = meta.collection?.sources;
  const checks = CHATTER_SOURCES.map(key => sources?.[key]);
  const times = checks.map(source => Date.parse(source?.lastSuccessAt || ''));
  const known = times.every(time => Number.isFinite(time) && time <= now + 60000);
  const checkedAt = known ? Math.min(...times) : null;
  if (meta.checking) return { state: 'checking', label: 'Checking for updates', checkedAt };
  if (!meta.ok || meta.error) return { state: 'failed', label: 'Update unavailable · Saved data', checkedAt };
  if (!known) return { state: 'unconfirmed', label: 'Source checks unconfirmed', checkedAt };
  const interval = Math.max(120, Number(meta.collection.intervalMinutes) || 120) * 60000;
  if (now - checkedAt > interval * 2) return { state: 'delayed', label: 'Collection delayed', checkedAt };
  if (checks.some(source => source.state !== 'ok')) return { state: 'partial', label: 'Some source checks incomplete', checkedAt };
  return { state: 'updated', label: 'Updated', checkedAt };
}
