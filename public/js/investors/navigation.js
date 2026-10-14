import { tabBar } from '../ui/components.js';
import { escapeHtml as esc } from '../core/dom.js';
import { PERIODS } from '../data/investor-changes.js';

export const AUDIENCES = [{ id: 'my-managers', label: 'My Managers' }, { id: 'investors', label: 'All Investors' }];
export const VIEWS = [{ id: 'overview', label: 'Overview' }, { id: 'changes', label: 'Changes' }, { id: 'holdings', label: 'Holdings' }];
const tableReading = value => ({ q: typeof value?.q === 'string' ? value.q.slice(0, 500) : '',
  filters: Array.isArray(value?.filters) ? value.filters.slice(0, 12).map(v => String(v).slice(0, 500)) : [],
  watchOnly: value?.watchOnly === true,
  sourcesOpen: value?.sourcesOpen === true,
  sort: value?.sort && typeof value.sort.key === 'string' && ['asc', 'desc'].includes(value.sort.dir) ? { key: value.sort.key.slice(0, 120), dir: value.sort.dir } : null });
const query = value => typeof value === 'string' ? value.slice(0, 500) : '';
// Persist reading choices only: no holdings, ledger rows, source payloads or access credentials.
export function navigationPreferences(value = {}) {
  const out = { audience: value.audience === 'investors' ? 'investors' : 'my-managers', group: value.group === 'institutions' ? 'institutions' : 'tracked',
    view: VIEWS.some(v => v.id === value.view) ? value.view : 'changes', contexts: {} };
  for (const key of ['my-managers', 'tracked', 'institutions']) {
    const saved = value.contexts?.[key] || {};
    out.contexts[key] = { overview: { query: query(saved.overview?.query), sourcesOpen: saved.overview?.sourcesOpen === true },
      changes: { period: PERIODS.some(p => p.id === saved.changes?.period) ? saved.changes.period : 'quarter', sourcesOpen: saved.changes?.sourcesOpen === true,
        holdingsOpen: saved.changes?.holdingsOpen === true, activityView: tableReading(saved.changes?.activityView), holdingsView: tableReading(saved.changes?.holdingsView) },
      holdings: tableReading(saved.holdings), fund: query(saved.fund), fundTables: {} };
    for (const [id, reading] of Object.entries(saved.fundTables || {}).slice(0, 30)) out.contexts[key].fundTables[query(id)] = tableReading(reading);
  }
  return out;
}
export const contextKey = state => state.audience === 'my-managers' ? 'my-managers' : state.group;

export function investorNavigation(root, state, { onAudience, onView, onGroup, onPeriod, onReadingChange } = {}) {
  const audience = tabBar({ tabs: AUDIENCES, activeId: state.audience, onSelect: onAudience, label: 'Investor audience' });
  const views = tabBar({ tabs: VIEWS, activeId: state.view, onSelect: onView, label: 'Investor view' });
  root.innerHTML = `<div class="investor-navigation" data-investor-navigation>
    <h1 class="font-display text-xl font-bold text-slate-900">Investors</h1>
    <div class="investor-audience" data-investor-audience>${audience.html}</div>
    <div class="investor-view-row"><div data-investor-view-tabs>${views.html}</div>
      <label class="investor-period" data-investor-period-label>Period <select data-changes-period aria-label="Changes period">${PERIODS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></label>
      <span class="investor-comparison" data-investor-comparison hidden>Compared quarters · latest disclosed pairs</span>
    </div>
    <div data-investor-group-mount><label class="investor-group-control">Investor group <select data-investor-group aria-label="Investor group"><option value="tracked">Tracked investors</option><option value="institutions">Institutional funds</option></select></label></div>
  </div><div data-investors-content></div>`;
  const offAudience = audience.wire(root.querySelector('[data-investor-audience]')), offViews = views.wire(root.querySelector('[data-investor-view-tabs]'));
  const label = root.querySelector('.investor-group-control'), mount = root.querySelector('[data-investor-group-mount]');
  const group = label.querySelector('select'), period = root.querySelector('[data-changes-period]');
  group.addEventListener('change', () => onGroup(group.value));
  period.addEventListener('change', () => onPeriod(period.value));
  const content = root.querySelector('[data-investors-content]');
  for (const event of ['input', 'change', 'click']) content.addEventListener(event, onReadingChange);
  const placeGroup = slot => { (slot || mount).append(label); if (slot) slot.hidden = state.audience !== 'investors'; mount.hidden = state.audience !== 'investors' || label.parentElement !== mount; };
  return {
    content,
    toolbarControls: { html: '<div data-investor-group-slot></div>', wire: host => { placeGroup(host.querySelector('[data-investor-group-slot]')); return () => {}; } },
    reclaimGroup() { placeGroup(null); },
    update() {
      audience.update(state.audience); views.update(state.view); group.value = state.group;
      const institutional = state.audience === 'investors' && state.group === 'institutions';
      root.querySelector('[data-investor-period-label]').hidden = state.view !== 'changes' || institutional;
      root.querySelector('[data-investor-comparison]').hidden = state.view !== 'changes' || !institutional;
      period.value = state.contexts[contextKey(state)].changes.period;
      label.hidden = state.audience !== 'investors';
      if (label.parentElement.matches('[data-investor-group-slot]')) label.parentElement.hidden = label.hidden;
      mount.hidden = label.hidden || label.parentElement !== mount;
    },
    destroy() { offAudience(); offViews(); for (const event of ['input', 'change', 'click']) content.removeEventListener(event, onReadingChange); },
  };
}
