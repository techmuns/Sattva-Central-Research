// The same market filters and thresholds across all Breakouts / Technical views.
// All imposes no constraint; a selected threshold requires a supplied measurement.
export const TECHNICAL_FILTERS = {
  volume: {
    param: 'vol',
    label: 'Volume confirm',
    description: 'Latest session volume divided by the prior 30-session average, matching Strong Breakouts.',
    multi: false,
    aliases: { any: 'all' },
    options: [
      { id: 'all', label: 'All' },
      { id: '1.5', label: '≥ 1.5×' },
      { id: '1.0', label: '≥ 1.0×' },
    ],
    test: (s, ids) => {
      const id = ids[0];
      if (!id || id === 'all') return true;
      const r = s.company.consolidation_breakout?.today_volume_ratio;
      return r != null && r >= Number(id);
    },
  },
  proximity: {
    param: 'near',
    label: '52W proximity',
    multi: false,
    aliases: { any: 'all' },
    options: [
      { id: 'all', label: 'All' },
      { id: '5', label: 'Within 5%' },
      { id: '10', label: 'Within 10%' },
      { id: '20', label: 'Within 20%' },
    ],
    test: (s, ids) => {
      const id = ids[0];
      if (!id || id === 'all') return true;
      const p = s.company.high_proximity_pct;
      if (p == null) return false;
      return p >= 1 - Number(id) / 100;
    },
  },
  trend: {
    param: 'dma',
    label: 'Trend filter',
    multi: false,
    // 'any' was this group's include-everything id, so it aliases onto 'all' rather than being
    // dropped: a bookmarked `?dma=any` still means what its author meant.
    aliases: { any: 'all' },
    options: [
      { id: 'all', label: 'All' },
      { id: 'above', label: 'Above 200 DMA only' },
    ],
    // Only 'above' constrains. Written this way round so an id this group no longer knows widens
    // the view rather than silently emptying it.
    test: (s, ids) => (ids[0] === 'above' ? s.company.above_200dma === true : true),
  },
};
export const TECHNICAL_DEFAULTS = { vol: 'all', near: 'all', dma: 'all' };

/** Count each option while holding the other chip groups at their selected values. */
export function chipCounts(rows, groups, state) {
  const filters = Object.values(groups);
  return Object.fromEntries(filters.map(group => [group.param, Object.fromEntries(group.options.map(option => {
    const trial = { ...state, [group.param]: [option.id] };
    return [option.id, rows.filter(row => filters.every(filter => filter.test(row, trial[filter.param]))).length];
  }))]));
}
