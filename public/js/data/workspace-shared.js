// Shared presentation definitions only. Source rows, holdings and credentials never enter this store.
export const WORKSPACE_OBJECT = 'research-workspace:v1';
export const WORKSPACE_LIMIT = 50;
export const WORKSPACE_BYTES = 64 * 1024;
export const WORKSPACE_TOTAL_BYTES = 512 * 1024;
export const DEFAULT_TAB_ORDER = ['alerts', 'announcements', 'earnings', 'breakouts', 'insider-trades', 'mutual-funds', 'news-section', 'super-investors'];
export const VIEW_SOURCES = ['corp-announcements', 'corporate-actions', 'ipos', 'earnings-hub', 'breakouts', 'insider-trades', 'mutual-funds', 'concall', 'news', 'public-chatter', 'super-investors', 'daily-alerts', 'nse-filings'];
export const VIEW_ID = /^view-[a-f0-9-]{36}$/;
const scopes = new Set(['portfolio', 'watchlist', 'universe']);
const text = (value, max) => typeof value === 'string' && value.length <= max ? value : '';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export const SHARED_COLUMN_TABLES = ['corp-announcements', 'corporate-actions', 'ipos', 'ipo-directory', 'insider-trades'];
const columnId = value => typeof value === 'string' && value.startsWith('$/') && value.length <= 500;
export function cleanColumnLayout(value) {
  if (!plain(value) || Object.keys(value).length > 20) throw Error('Invalid workspace columns');
  const layout = {};
  for (const [group, order] of Object.entries(value)) {
    if (!(group === '$' || columnId(group)) || !Array.isArray(order) || order.length > 200 || !order.every(columnId)) throw Error('Invalid workspace columns');
    layout[group] = [...new Set(order)];
  }
  return layout;
}
// Relative moves compose against the latest desk layout, retaining temporarily absent columns.
export function moveWorkspaceColumn(layout, intent) {
  if (intent.op === 'columns-reset') return {};
  const next = cleanColumnLayout(layout ?? intent.seedLayout);
  const order = [...new Set([...(next[intent.group] || []), ...intent.siblings])].filter(key => key !== intent.column);
  order.splice(order.indexOf(intent.target) + (intent.after ? 1 : 0), 0, intent.column);
  next[intent.group] = order;
  return cleanColumnLayout(next);
}
export function cleanReading(value = {}) {
  if (!plain(value)) throw Error('Invalid workspace reading');
  if ((value.q !== undefined && (typeof value.q !== 'string' || value.q.length > 500)) || (value.filters !== undefined && (!Array.isArray(value.filters) || value.filters.length > 40)) || (value.extras !== undefined && (!plain(value.extras) || Object.keys(value.extras).length > 40))) throw Error('Invalid workspace reading');
  const out = { q: text(value.q, 500), filters: [], watchOnly: value.watchOnly === true, sort: null };
  if (Array.isArray(value.filters) && value.filters.length <= 40) out.filters = value.filters.map(row => {
    if (!plain(row) || !text(row.label, 120) || typeof row.value !== 'string' || row.value.length > 500) throw Error('Invalid workspace filter');
    return { label: row.label, value: row.value };
  });
  if (plain(value.sort) && text(value.sort.key, 120) && ['asc', 'desc'].includes(value.sort.dir)) out.sort = { key: value.sort.key, dir: value.sort.dir };
  out.tableKey = text(value.tableKey, 200);
  // Reader-specific choices are scalar filter settings. No arbitrary object or row snapshot.
  out.extras = {};
  if (plain(value.extras) && Object.keys(value.extras).length <= 40) for (const [key, item] of Object.entries(value.extras)) {
    if (!/^[a-zA-Z][\w-]{0,60}$/.test(key)) throw Error('Invalid workspace filter');
    if (typeof item === 'string' && item.length <= 500) out.extras[key] = item;
    else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) out.extras[key] = item;
    else if (Array.isArray(item) && item.length <= 100 && item.every(v => typeof v === 'string' && v.length <= 120)) out.extras[key] = [...item];
    else throw Error('Invalid workspace filter');
  }
  return out;
}
export function cleanSavedTab(value) {
  if (!plain(value) || !VIEW_ID.test(value.id)) throw Error('Invalid workspace tab');
  const title = text(value.title, 80).replace(/\s+/g, ' ').trim();
  if (!title || (value.source !== null && !VIEW_SOURCES.includes(value.source)) || !scopes.has(value.scope)) throw Error('Invalid workspace tab');
  const params = {};
  // Save reader filters, never transport/authentication settings or open/paid overlays.
  const allowed = new Set(['company', 'view', 'period', 'date', 'range', 'topic', 'type', 'category', 'q', 'sector', 'mcap', 'vol', 'near', 'dma', 'rsi', 'ma', 'country', 'bo', 'side', 'mag', 'mgate', 'mrd1', 'mrw', 'mrm', 'mrd2', 'mvm', 'pattern', 'trend', 'strength', 'quality', 'signals']);
  for (const [key, val] of Object.entries(plain(value.params) ? value.params : {})) if (allowed.has(key) && typeof val === 'string' && val.length <= 500) params[key] = val;
  return { id: value.id, title, source: value.source, scope: value.scope, subview: text(value.subview, 80) || null, params, reading: cleanReading(value.reading || {}) };
}
export function workspaceIntent(value) {
  if (!plain(value) || !/^[\w-]{8,80}$/.test(value.id || '')) throw Error('Invalid workspace intent');
  const afterIntent = /^[\w-]{8,80}$/.test(value.afterIntent || '') ? value.afterIntent : null;
  if (value.op === 'put') return { id: value.id, op: 'put', tab: cleanSavedTab(value.tab), expected: Number.isSafeInteger(value.expected) ? value.expected : null, afterIntent };
  if (value.op === 'remove' && VIEW_ID.test(value.tabId)) return { id: value.id, op: 'remove', tabId: value.tabId, expected: Number.isSafeInteger(value.expected) ? value.expected : null, afterIntent };
  if (value.op === 'reset') return { id: value.id, op: 'reset' };
  if (SHARED_COLUMN_TABLES.includes(value.table)) {
    if (value.op === 'columns-reset') return { id: value.id, op: value.op, table: value.table };
    if (value.op === 'columns-move' && (value.group === '$' || columnId(value.group)) && columnId(value.column) && columnId(value.target) && value.column !== value.target) {
      const seedLayout = cleanColumnLayout(value.seedLayout || {});
      const siblings = cleanColumnLayout({ [value.group]: value.siblings })[value.group];
      if (!siblings.includes(value.column) || !siblings.includes(value.target) || !siblings.every(key => key.startsWith(`${value.group}/`) && !key.slice(value.group.length + 1).includes('/'))) throw Error('Invalid workspace columns');
      return { id: value.id, op: value.op, table: value.table, group: value.group, column: value.column, target: value.target, after: value.after === true, siblings, seedLayout };
    }
  }
  const validId = id => DEFAULT_TAB_ORDER.includes(id) || VIEW_ID.test(id);
  if (value.op === 'move' && validId(value.tabId) && validId(value.targetId) && value.tabId !== value.targetId) return {
    id: value.id, op: 'move', tabId: value.tabId, targetId: value.targetId, after: value.after === true,
    seedOrder: Array.isArray(value.seedOrder) && value.seedOrder.length <= 100 ? [...new Set(value.seedOrder.filter(validId))] : [],
  };
  throw Error('Invalid workspace intent');
}
export function workspaceSnapshot(value) {
  if (!plain(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.tabs) || value.tabs.length > WORKSPACE_LIMIT || !Array.isArray(value.order)) throw Error('Invalid workspace snapshot');
  const tabs = value.tabs.map(tab => ({ ...cleanSavedTab(tab), revision: Number.isSafeInteger(tab.revision) ? tab.revision : 0 }));
  if (new Set(tabs.map(tab => tab.id)).size !== tabs.length) throw Error('Invalid workspace snapshot');
  const ids = new Set([...DEFAULT_TAB_ORDER, ...tabs.map(tab => tab.id)]);
  const order = [...new Set(value.order.filter(id => ids.has(id)))];
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const columnLayouts = {};
  if (value.columnLayouts !== undefined) {
    if (!plain(value.columnLayouts) || Object.keys(value.columnLayouts).some(key => !SHARED_COLUMN_TABLES.includes(key))) throw Error('Invalid workspace columns');
    for (const [key, layout] of Object.entries(value.columnLayouts)) columnLayouts[key] = cleanColumnLayout(layout);
  }
  const navigationRevision = Number.isSafeInteger(value.navigationRevision) && value.navigationRevision >= 0 && value.navigationRevision <= value.revision ? value.navigationRevision : value.revision;
  return { version: 1, revision: value.revision, navigationRevision, updatedAt: text(value.updatedAt, 40) || null, order, tabs, columnLayouts };
}
