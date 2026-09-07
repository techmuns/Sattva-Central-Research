// Source success, publication dates and a browser/cache read are different clocks.
export const TELEGRAM_FRESH_MS = 30 * 60 * 1000;
export function telegramReadHealth(meta = {}, now = Date.now()) {
  const checked = Date.parse(meta.lastCheckedAt || '');
  const validCheck = Number.isFinite(checked) && checked <= now + 60000;
  const paused = meta.apiSafety?.paused === true ||
    Date.parse(meta.apiSafety?.nextAttemptAt || '') > now || Date.parse(meta.publicSafety?.nextAttemptAt || '') > now;
  const failed = !!(meta.reason || meta.lastRun?.status === 'failed' || meta.delivery?.collectorLatestFailed ||
    meta.delivery?.degraded || paused);
  const partial = meta.lastRun?.status === 'partial' || Number(meta.pending ?? meta.retryIds?.length) > 0;
  const stale = validCheck && now - checked > TELEGRAM_FRESH_MS;
  return { at: validCheck ? meta.lastCheckedAt : null, failed, partial, paused, stale,
    maxAgeMs: TELEGRAM_FRESH_MS,
    state: failed || partial ? 'partial' : !validCheck ? 'unknown' : stale ? 'stale' : 'checked' };
}
