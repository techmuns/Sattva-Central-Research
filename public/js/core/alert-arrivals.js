// Session-only receipt times. A first successful reading establishes each source's baseline;
// loading a cache, delayed initial sources and switching scope are never breaking news.
export function createAlertArrivals() {
  let scopeKey = null;
  const seen = new Map();
  const received = new Map();
  function reset(key = null) {
    scopeKey = key;
    seen.clear();
    received.clear();
  }
  return {
    reset,
    observe(report, key, now = Date.now()) {
      if (key !== scopeKey) reset(key);
      if (!report || report.cacheSavedAt || report.readError) return;
      for (const feed of report.feeds || []) {
        const previous = seen.get(feed.id);
        // Failed/partial first reads cannot establish a baseline. After a baseline exists,
        // real rows in a partial refresh are still receipts; recovery must not reannounce them.
        if (!previous && (feed.status === 'pending' || feed.status === 'failed')) continue;
        const ids = previous || new Set();
        for (const event of feed.events || []) {
          if (previous && !ids.has(event.id)) received.set(event.id, { at: now, private: !!event.private });
          ids.add(event.id);
        }
        // Keep known identities through temporary omissions, corrections and day rollovers.
        seen.set(feed.id, ids);
      }
    },
    clearPrivate() {
      for (const [id, receipt] of received) if (receipt.private) received.delete(id);
    },
    time(id) { return received.get(id)?.at || 0; },
  };
}
