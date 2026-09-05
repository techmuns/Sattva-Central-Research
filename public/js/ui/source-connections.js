// Customer-facing vocabulary over the real source state. Presentation never changes health.
export function sourceConnection(item, { online = globalThis.navigator?.onLine !== false } = {}) {
  const state = item.readState;
  if (!online && state === 'read') return { label: 'Saved copy', cls: 'is-saved', connected: false };
  if (state === 'read') return { label: 'Connected', cls: 'is-live', connected: true };
  if (state === 'dated') return { label: 'Refresh due', cls: 'is-saved', connected: false };
  if (state === 'unconfirmed') return { label: 'Saved copy', cls: 'is-saved', connected: false };
  if (state === 'unavailable' || item.status === 'unreadable') return { label: 'Connection paused', cls: 'is-saved', connected: false };
  if (state === 'partial' || item.status === 'partial') return { label: 'Partial coverage', cls: 'is-saved', connected: false };
  if (state === 'unchecked') return { label: 'Ready to check', cls: 'is-pending', connected: false };
  if (item.status === 'static') return { label: 'Reference data', cls: 'is-static', connected: false };
  if (item.status === 'derived') return { label: 'Computed', cls: 'is-static', connected: false };
  if (item.status === 'ondemand') return { label: 'On request', cls: 'is-ondemand', connected: false };
  if (item.status === 'adding') return { label: 'Connecting', cls: 'is-ondemand', connected: false };
  if (item.status === 'live') return { label: 'Scheduled', cls: 'is-scheduled', connected: false };
  return { label: 'Setup required', cls: 'is-pending', connected: false };
}

export function sourceReadState({ at, failed = false, partial = false, maxAgeMs = 45 * 60000 }, now = Date.now()) {
  if (failed) return 'unavailable';
  const time = typeof at === 'number' ? at : Date.parse(at || '');
  if (!Number.isFinite(time) || time > now + 600000) return 'unchecked';
  if (now - time > maxAgeMs) return 'dated';
  return partial ? 'partial' : 'read';
}

export function sourceSummary(groups) {
  const items = groups.flatMap(g => g.items);
  return { total: items.length, connected: items.filter(i => sourceConnection(i).connected).length,
    automatic: items.filter(i => ['live', 'partial', 'adding'].includes(i.status)).length,
    onRequest: items.filter(i => i.status === 'ondemand').length,
    reference: items.filter(i => ['static', 'derived'].includes(i.status)).length };
}
