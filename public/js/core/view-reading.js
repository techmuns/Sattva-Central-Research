// Only user-selected reading controls are captured. Keep row data and private holdings out.
import { cleanReading } from '../data/workspace-shared.js';
let context = null;
const tableReadings = new WeakMap();
export function enterView(value) { context = value; }
export const activeView = () => context;
const keyFor = config => (config.columnLayoutKey || config.exportName || config.nameLabel || 'table').replace(/-\d{4}-\d{2}-\d{2}$/, '');
export function seedTableReading(config, filters) {
  const reading = context?.preset?.reading;
  const saved = reading?.tables?.find(table => table.tableKey === keyFor(config)) || reading;
  if (!saved || (saved.tableKey && saved.tableKey !== keyFor(config)) || config.initialView?.savedViewKey === context.key) return config.initialView;
  return { q: saved.q, watchOnly: saved.watchOnly, sort: saved.sort,
    // A clearer display label must not silently reset an older saved screen.
    filters: filters.map(filter => (saved.filters.find(item => item.label === filter.label) ??
      saved.filters.find(item => filter.readingAliases?.includes(item.label)))?.value ?? filter.value ?? 'all'), savedViewKey: context.key };
}
function registerOwnedTable(root, host, config, view, filters) {
  let tables = tableReadings.get(root);
  if (!tables) tableReadings.set(root, tables = new Map());
  for (const [key, table] of tables) if (!table.host.isConnected || !root.contains(table.host)) tables.delete(key);
  tables.set(keyFor(config), { host, read: () => cleanReading({ tableKey: keyFor(config), q: view.q, watchOnly: view.watchOnly, sort: view.sort,
    filters: filters.map((filter, index) => ({ label: filter.label || `Filter ${index + 1}`, value: String(view.filters[index] ?? 'all') })) }) });
}
export function registerTableReading(root, host, config, view, filters) {
  registerOwnedTable(root, host, config, view, filters);
  if (context?.root !== root && context?.root?.contains(host)) registerOwnedTable(context.root, host, config, view, filters);
}
const mountedReadings = root => [...(tableReadings.get(root)?.values() || [])].filter(table => table.host.isConnected && root.contains(table.host));
export const hasTableReading = root => mountedReadings(root).length > 0;
export function captureTableReading(root) {
  const tables = mountedReadings(root).map(table => { const reading = table.read(); delete reading.extras; return reading; });
  return tables.length ? cleanReading({ ...tables.at(-1), ...(tables.length > 1 ? { tables } : {}) }) : cleanReading({});
}
