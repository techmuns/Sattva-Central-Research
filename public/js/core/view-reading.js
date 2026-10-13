// Only user-selected reading controls are captured. Keep row data and private holdings out.
import { cleanReading } from '../data/workspace-shared.js';
let context = null;
const tableReadings = new WeakMap();
export function enterView(value) { context = value; }
export const activeView = () => context;
const keyFor = config => (config.columnLayoutKey || config.exportName || config.nameLabel || 'table').replace(/-\d{4}-\d{2}-\d{2}$/, '');
export function seedTableReading(config, filters) {
  const saved = context?.preset?.reading;
  if (!saved || (saved.tableKey && saved.tableKey !== keyFor(config)) || config.initialView?.savedViewKey === context.key) return config.initialView;
  return { q: saved.q, watchOnly: saved.watchOnly, sort: saved.sort,
    // A clearer display label must not silently reset an older saved screen.
    filters: filters.map(filter => (saved.filters.find(item => item.label === filter.label) ??
      saved.filters.find(item => filter.readingAliases?.includes(item.label)))?.value ?? filter.value ?? 'all'), savedViewKey: context.key };
}
export function registerTableReading(root, host, config, view, filters) {
  tableReadings.set(root, { host, read: () => cleanReading({ tableKey: keyFor(config), q: view.q, watchOnly: view.watchOnly, sort: view.sort,
    filters: filters.map((filter, index) => ({ label: filter.label || `Filter ${index + 1}`, value: String(view.filters[index] ?? 'all') })) }) });
}
export function captureTableReading(root) {
  const table = tableReadings.get(root);
  return table?.host.isConnected && root.contains(table.host) ? table.read() : cleanReading({});
}
