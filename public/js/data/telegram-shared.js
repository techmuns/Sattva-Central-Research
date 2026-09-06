// Public-channel data only. Shared by the artifact reader and local publication checks.
export const TELEGRAM_REPO = 'techmuns/Sattva-Central-Research';
export const TELEGRAM_WORKFLOW = 'telegram-refresh.yml';
export const TELEGRAM_ARTIFACT = 'telegram-posts-v1.json.gz';
export const TELEGRAM_COMPRESSED_LIMIT = 8 * 1024 * 1024;
export const TELEGRAM_LIMIT = 16 * 1024 * 1024;
const stamp = (v, now) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now + 300000 ? v : null;
const positive = (v) => Number.isSafeInteger(v) && v > 0;
export function validateTelegramCapture(v, now = Date.now()) {
  if (v?.schemaVersion !== 2 || v.channel !== 'researchreportss' || !Array.isArray(v.posts) || !v.posts.length || v.posts.length > 150000 ||
      !stamp(v.lastRun?.at, now) || !['ok', 'partial', 'failed'].includes(v.lastRun?.status)) throw Error('Invalid Telegram capture');
  const ids = new Set();
  const posts = v.posts.map((p) => {
    if (!positive(p?.id) || ids.has(p.id) || (!p.text && !stamp(p.publishedAt, now)) ||
        (p.text != null && (typeof p.text !== 'string' || p.text.length > 65536))) throw Error('Invalid Telegram post');
    ids.add(p.id);
    const attachments = (Array.isArray(p.attachments) ? p.attachments : []).map((a) => {
      if (a.type !== 'document' || typeof a.name !== 'string' || a.name.length > 1024) throw Error('Invalid Telegram attachment');
      return { type: 'document', name: a.name, size: typeof a.size === 'string' ? a.size.slice(0, 80) : null };
    });
    return { id: p.id, text: p.text || null, url: `https://t.me/researchreportss/${p.id}`,
      publishedAt: stamp(p.publishedAt, now), firstSeenAt: stamp(p.firstSeenAt, now),
      editedAt: stamp(p.editedAt, now), attachments,
      mediaType: ['photo', 'video', 'document'].includes(p.mediaType) ? p.mediaType : null,
      contentStatus: p.text || attachments.length || ['photo', 'video'].includes(p.mediaType) ? 'available' : 'telegram-only' };
  }).sort((a, b) => b.id - a.id);
  const api = v.route === 'mtproto';
  return { schemaVersion: 2, source: api ? 'Telegram API' : 't.me public channel pages', channel: v.channel,
    channelUrl: 'https://t.me/researchreportss', route: api ? 'mtproto' : 'embed+permalink', publishesTime: true,
    capturedAt: stamp(v.capturedAt, now), lastCheckedAt: stamp(v.lastCheckedAt, now),
    headId: posts[0].id, lowestId: posts.at(-1).id, spanFrom: posts.at(-1).id, spanTo: posts[0].id,
    historyNextId: positive(v.historyNextId) ? v.historyNextId : 0, historyComplete: v.historyComplete === true,
    discoveryNextId: positive(v.discoveryNextId) ? v.discoveryNextId : 0,
    retryIds: (v.retryIds || []).filter(positive),
    apiSafety: v.apiSafety ? { paused: v.apiSafety.paused === true || !['rate-limit', 'connection', 'cooldown', 'account-attention'].includes(v.apiSafety.reason) || !!(v.apiSafety.nextAttemptAt && !Number.isFinite(Date.parse(v.apiSafety.nextAttemptAt))),
      reason: ['rate-limit', 'connection', 'cooldown', 'account-attention'].includes(v.apiSafety.reason) ? v.apiSafety.reason : 'account-attention',
      nextAttemptAt: typeof v.apiSafety.nextAttemptAt === 'string' && Number.isFinite(Date.parse(v.apiSafety.nextAttemptAt)) ? v.apiSafety.nextAttemptAt : null,
      failures: Number.isSafeInteger(v.apiSafety.failures) && v.apiSafety.failures >= 0 ? Math.min(12, v.apiSafety.failures) : 0 } : null,
    apiState: api ? { newestSyncedId: positive(v.apiState?.newestSyncedId) ? v.apiState.newestSyncedId : 0, historyOffsetId: positive(v.apiState?.historyOffsetId) ? v.apiState.historyOffsetId : 0,
      historyComplete: v.apiState?.historyComplete === true } : null,
    latestVerifiedAt: api ? stamp(v.latestVerifiedAt, now) : null,
    lastRun: { at: v.lastRun.at, status: v.lastRun.status,
      error: v.lastRun.status === 'failed' ? 'Telegram collection failed; previous posts retained.' : null }, posts };
}
