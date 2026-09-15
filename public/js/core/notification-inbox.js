// Device-local notification receipts. Source feeds and their retained history are untouched.
const STORAGE_KEY = 'sattva:notification-inbox:v1';
const safeHref = value => typeof value === 'string' && (/^#\//.test(value) || /^https:\/\//i.test(value)) ? value : null;
const safeImage = value => typeof value === 'string' && /^https:\/\//i.test(value) ? value : null;
const time = value => typeof value === 'string' && !/^\d+$/.test(value) ? Date.parse(value) : Number(value);
const validTime = value => value != null && Number.isFinite(time(value)) && time(value) >= 0 && time(value) <= 8640000000000000;

export function createInbox({ storage = () => globalThis.localStorage, now = Date.now } = {}) {
  const records = new Map(), suppressed = new Set(), listeners = new Set();
  let saved = true, timer = null, announced = 0;
  function normalize(row) {
    if (!row || typeof row.id !== 'string' || !row.id) return null;
    if (validTime(row.dismissedAt)) return { id: row.id, dismissedAt: time(row.dismissedAt) };
    if (row.private === true && !row.title) return { id: row.id, private: true, readAt: validTime(row.readAt) ? time(row.readAt) : null };
    if (typeof row.title !== 'string' || !row.title.trim()) return null;
    return { id: row.id, kind: typeof row.kind === 'string' ? row.kind : 'system', title: row.title,
      detail: typeof row.detail === 'string' ? row.detail : '', href: safeHref(row.href), image: safeImage(row.image),
      ...(row.kind === 'research' ? { private: true } : {}),
      at: validTime(row.at) ? time(row.at) : now(), receivedAt: validTime(row.receivedAt) ? time(row.receivedAt) : now(),
      readAt: validTime(row.readAt) ? time(row.readAt) : null };
  }
  function merge(row) {
    const entry = normalize(row);
    if (!entry) return;
    const old = records.get(entry.id);
    if (old?.dismissedAt != null) return;
    if (entry.dismissedAt != null) { records.set(entry.id, entry); return; }
    records.set(entry.id, old ? { ...entry, ...old, readAt: old.readAt ?? entry.readAt } : entry);
  }
  function read(incoming) {
    try {
      const raw = incoming === undefined ? storage()?.getItem(STORAGE_KEY) : incoming;
      if (!raw) return;
      const body = JSON.parse(raw);
      if (body?.version !== 1 || !Array.isArray(body.items)) throw new Error('Unreadable inbox');
      for (const row of body.items) merge(row);
    } catch { saved = false; }
  }
  const emit = () => { for (const listener of [...listeners]) listener(); };
  function flush() {
    clearTimeout(timer); timer = null;
    // Merge other open tabs before writing. Read/dismiss receipts only move forward.
    read();
    try {
      const target = storage();
      if (!target) throw new Error('Storage unavailable');
      // Private research conversations stay in their existing session. Persist only a receipt,
      // never the question, title, answer or session link carried by the notification.
      const value = JSON.stringify({ version: 1, items: [...records.values()].sort((a, b) => a.id.localeCompare(b.id)).map(row => row.private
        ? { id: row.id, private: true, readAt: row.readAt } : row) });
      // Stable serialization also lets tabs reconcile racing writes without an event loop.
      if (target.getItem(STORAGE_KEY) !== value) target.setItem(STORAGE_KEY, value);
      saved = true;
    } catch { saved = false; }
    emit();
  }
  const changed = () => { clearTimeout(timer); timer = setTimeout(flush, 80); emit(); };
  read();
  return {
    push({ key, kind = 'system', title, detail = '', href = null, image = null, at = now() }) {
      if (typeof title !== 'string' || !title.trim()) return false;
      const id = String(key || (kind === 'research' ? `research:${now()}:${announced}` : `${kind}:${title}:${at}`));
      if (suppressed.has(id) || records.has(id)) return false;
      merge({ id, kind, title, detail, href, image, at, receivedAt: now(), readAt: null });
      announced++; changed(); return true;
    },
    suppress(keys) { for (const key of keys) suppressed.add(String(key)); },
    items: () => [...records.values()].filter(row => row.dismissedAt == null && row.title).sort((a, b) => b.receivedAt - a.receivedAt || b.at - a.at || a.id.localeCompare(b.id)),
    read(ids) {
      for (const id of ids) { const row = records.get(id); if (row && row.dismissedAt == null && row.readAt == null) row.readAt = now(); }
      changed();
    },
    dismiss(id) { if (records.has(id)) { records.set(id, { id, dismissedAt: now() }); changed(); } },
    clearPrivate() { for (const [id, row] of records) if (row.private) records.set(id, { id, dismissedAt: now() }); changed(); },
    clear() { for (const id of records.keys()) records.set(id, { id, dismissedAt: now() }); changed(); },
    sync(incoming) { if (incoming != null) read(incoming); read(); changed(); },
    flush,
    saved: () => saved,
    announcedCount: () => announced,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
export { STORAGE_KEY };
