import { CACHE_MS, MAX_COMPANIES, activePosts, portfolioCatalog, recordStatus, issuerName } from '../public/js/data/x-chatter-shared.js';
import { searchRecent } from './x-chatter-api.mjs';

export function collectionConfig(env) {
  const allowPaid = env.X_CHATTER_ALLOW_PAID === 'true';
  const dailyLimit = Math.min(100000, Math.max(0, Math.floor(Number(env.X_CHATTER_DAILY_POST_LIMIT) || 0)));
  const perCompany = Math.min(20, Math.max(10, Math.floor(Number(env.X_CHATTER_POSTS_PER_COMPANY) || 20)));
  const enabled = allowPaid && env.X_CHATTER_ENABLED === 'true' && dailyLimit >= perCompany && Boolean(env.X_BEARER_TOKEN);
  const selected = String(env.X_CHATTER_COMPANIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { allowPaid, enabled: enabled && selected.length > 0, dailyLimit, perCompany, selected,
    intervalMs: Math.max(1, Math.min(24, Number(env.X_CHATTER_INTERVAL_HOURS) || 12)) * 3600000 };
}

// The adapter's reads/writes are synchronous SQL statements inside one Durable Object.
// No state mutation is left until after a network call: reserve slots and advance the queue first.
export class XChatterEngine {
  constructor(store, env, { clock = Date.now, read = searchRecent } = {}) {
    this.store = store; this.env = env; this.clock = clock; this.read = read;
    this.busy = false;
    this.state = store.get('state') || { running: false, revision: 0, catalog: [], queue: [], cursor: 0, usage: {}, tombstones: {} };
  }
  save() { this.state.revision++; this.store.put('state', this.state); }
  purge() {
    const now = this.clock();
    for (const [key, record] of this.store.entries('company:')) {
      if (Date.parse(record.expiresAt) <= now && record.posts?.length) { record.posts = []; this.store.put(key, record); }
    }
    this.state.tombstones = Object.fromEntries(Object.entries(this.state.tombstones).filter(([, until]) => until > now));
  }
  async start(holdings) {
    const cfg = collectionConfig(this.env);
    if (!cfg.allowPaid) return { ok: false, code: 'free-only' };
    if (!cfg.enabled) return { ok: false, code: 'setup-required' };
    if (this.state.running || this.busy) return { ok: false, code: 'already-running' };
    const catalog = portfolioCatalog(holdings);
    if (!catalog.length || catalog.length > MAX_COMPANIES) return { ok: false, code: 'portfolio-size' };
    // A holding removed from the server book must stop being served immediately.
    const valid = new Set(catalog.map((c) => c.key));
    for (const [key] of this.store.entries('company:')) if (!valid.has(key.slice(8))) this.store.delete(key);
    this.state.catalog = catalog;
    this.state.running = true; this.state.problem = null; this.state.nextCycle = null; this.state.notBefore = null;
    this.makeQueue(cfg); this.save();
    await this.store.setAlarm(this.clock() + 1000);
    return { ok: true, companies: catalog.length, searches: this.state.queue.length };
  }
  makeQueue(cfg) {
    const groups = new Map();
    for (const company of this.state.catalog) {
      if (!company.query || !(cfg.selected.includes('all') || cfg.selected.includes(company.key) || cfg.selected.includes(company.ticker))) continue;
      const groupKey = issuerName(company.name).toLowerCase();
      const group = groups.get(groupKey);
      if (group) {
        group.keys.push(company.key);
        if (company.ticker) group.query = company.query;
      } else groups.set(groupKey, { query: company.query, keys: [company.key] });
    }
    this.state.queue = [...groups.values()]; this.state.cursor = 0; this.state.cycleStartedAt = this.clock();
  }
  async pause() {
    this.state.running = false; this.state.problem = 'paused'; this.state.queue = [];
    // Clearing is immediate, including copies currently in an outbound read.
    this.state.generation = (this.state.generation || 0) + 1;
    for (const [key] of this.store.entries('company:')) this.store.delete(key);
    this.save(); await this.store.deleteAlarm();
    return { ok: true };
  }
  remove(ids) {
    this.purge();
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((id) => !/^\d{1,25}$/.test(id))) return { ok: false, code: 'invalid-ids' };
    if (Object.keys(this.state.tombstones).length + ids.length > 5000) return { ok: false, code: 'removal-capacity' };
    for (const id of ids) this.state.tombstones[id] = this.clock() + 8 * 86400000;
    for (const [key, record] of this.store.entries('company:')) {
      record.posts = this.withoutRemoved(record.posts || []); this.store.put(key, record);
    }
    this.save(); return { ok: true };
  }
  withoutRemoved(posts) {
    return posts.filter((p) => ![p.id, ...(p.editIds || [])].some((id) => this.state.tombstones[id]));
  }
  async alarm() {
    if (this.busy) return;
    this.purge();
    const cfg = collectionConfig(this.env); const now = this.clock();
    if (!cfg.enabled || !this.state.running) {
      this.state.running = false; this.save();
      // A disabled deployment still expires a previously captured body.
      await this.scheduleExpiry(); return;
    }
    if (this.state.notBefore > now) { await this.scheduleWork(this.state.notBefore); return; }
    if (this.state.nextCycle && this.state.nextCycle > now) { await this.scheduleWork(this.state.nextCycle); return; }
    if (this.state.nextCycle) { this.makeQueue(cfg); this.state.nextCycle = null; }
    if (this.state.cursor >= this.state.queue.length) {
      this.state.nextCycle = Math.max(now + 60000, (this.state.cycleStartedAt || now) + cfg.intervalMs);
      this.state.problem = null; this.save();
      await this.scheduleWork(this.state.nextCycle); return;
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const used = this.state.usage[day] || 0;
    this.state.usage = { [day]: used };
    if (used + cfg.perCompany > cfg.dailyLimit) {
      this.state.problem = 'daily-limit'; this.save();
      await this.scheduleWork(Date.parse(`${day}T00:00:00Z`) + 86400000 + 1000); return;
    }
    const group = this.state.queue[this.state.cursor++];
    group.keys = group.keys.filter((key) => {
      const c = this.state.catalog.find((item) => item.key === key);
      return c && (cfg.selected.includes('all') || cfg.selected.includes(key) || cfg.selected.includes(c.ticker));
    });
    if (!group.keys.length) { this.save(); await this.scheduleWork(now + 1000); return; }
    const generation = this.state.generation || 0;
    this.state.usage[day] += cfg.perCompany;
    this.state.problem = null; this.state.lastAttemptAt = new Date(now).toISOString();
    // At-most-once reservation across alarm retries/crashes. Never refund uncertain requests.
    for (const key of group.keys) {
      const previous = this.store.get(`company:${key}`) || {};
      this.store.put(`company:${key}`, { ...previous, error: 'checking', attemptedAt: this.state.lastAttemptAt });
    }
    this.save(); this.busy = true;
    let delay = 60000;
    try {
      await this.store.setAlarm(now + 60000); // Recovery if the instance dies during the read.
      const result = await this.read({ token: this.env.X_BEARER_TOKEN, query: group.query, limit: cfg.perCompany, now });
      if ((this.state.generation || 0) !== generation || !this.state.running) return;
      const checkedAt = new Date(this.clock()).toISOString();
      const record = { ...result, posts: this.withoutRemoved(result.posts), checkedAt,
        expiresAt: new Date(this.clock() + CACHE_MS).toISOString(), query: group.query, error: null };
      for (const key of group.keys) this.store.put(`company:${key}`, record);
      this.state.lastSuccessAt = checkedAt;
    } catch (err) {
      if ((this.state.generation || 0) !== generation || !this.state.running) return;
      const code = ['rate-limited', 'access-required', 'request-rejected', 'unavailable', 'invalid-response', 'partial-response'].includes(err.code) ? err.code : 'unavailable';
      for (const key of group.keys) this.store.put(`company:${key}`, { ...(this.store.get(`company:${key}`) || {}), error: code });
      this.state.problem = code;
      if (['access-required', 'request-rejected'].includes(code)) this.state.running = false;
      else if (err.retryAt) delay = Math.max(60000, err.retryAt - this.clock());
      else delay = 15 * 60000;
    } finally {
      this.busy = false; this.save();
      this.state.notBefore = this.clock() + delay; this.save();
      if (this.state.running) await this.scheduleWork(this.state.notBefore);
      else await this.scheduleExpiry();
    }
  }
  async scheduleExpiry() {
    const expiries = this.store.entries('company:').map(([, r]) => Date.parse(r.expiresAt)).filter((n) => n > this.clock());
    if (expiries.length) await this.store.setAlarm(Math.min(...expiries) + 1000);
    else await this.store.deleteAlarm();
  }
  async scheduleWork(at) {
    const expiries = this.store.entries('company:').filter(([, r]) => r.posts?.length)
      .map(([, r]) => Date.parse(r.expiresAt) + 1000).filter((n) => n > this.clock());
    await this.store.setAlarm(Math.min(at, ...expiries));
  }
  snapshot({ company = '', q = '', hours = 24, offset = 0, limit = 50, keys = '' } = {}) {
    this.purge();
    const now = this.clock(), cfg = collectionConfig(this.env);
    const minDate = now - Math.min(168, Math.max(1, Number(hours) || 24)) * 3600000;
    const search = String(q).toLowerCase().slice(0, 200);
    const selectedKeys = keys ? new Set(String(keys).slice(0, 10000).split(',')) : null;
    const companies = []; const posts = new Map();
    for (const c of this.state.catalog) {
      const record = this.store.get(`company:${c.key}`);
      const available = cfg.enabled ? this.withoutRemoved(activePosts(record, now)) : [];
      companies.push({ ...c, status: recordStatus(record, now), checkedAt: record?.checkedAt || null,
        expiresAt: record?.expiresAt || null, count: available.length, partial: Boolean(record?.partial), query: record?.query || c.query });
      if ((company && company !== c.key) || (selectedKeys && !selectedKeys.has(c.key))) continue;
      for (const post of available) {
        if (Date.parse(post.createdAt) < minDate || (search && !`${post.text} ${post.author.name} @${post.author.username} ${c.name} ${c.ticker || ''}`.toLowerCase().includes(search))) continue;
        if (posts.has(post.id)) posts.get(post.id).companies.push({ key: c.key, name: c.name });
        else posts.set(post.id, { ...post, expiresAt: record.expiresAt, capturedAt: record.checkedAt, companies: [{ key: c.key, name: c.name }] });
      }
    }
    const sorted = [...posts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const start = Math.max(0, Math.floor(Number(offset) || 0)), size = Math.max(1, Math.min(50, Math.floor(Number(limit) || 50)));
    return { source: 'X API', status: !cfg.allowPaid ? 'free-only' : !cfg.enabled ? 'setup-required' : this.state.problem || (this.state.running ? 'collecting' : 'not-started'),
      running: cfg.enabled && this.state.running, version: this.state.revision,
      asOf: new Date(now).toISOString(), lastSuccessAt: this.state.lastSuccessAt || null,
      perCompany: cfg.perCompany, intervalHours: cfg.intervalMs / 3600000, dailyLimit: cfg.dailyLimit,
      reservedToday: this.state.usage[new Date(now).toISOString().slice(0, 10)] || 0,
      companies, posts: sorted.slice(start, start + size), total: sorted.length, offset: start, hasMore: start + size < sorted.length };
  }
}
