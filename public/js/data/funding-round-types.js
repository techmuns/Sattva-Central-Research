// Display groups only. Original funding rows, amounts and source wording stay intact.
const stages = ['Angel', 'Pre-Seed', 'Seed', ...Array.from({ length:26 }, (_, i) => String.fromCharCode(65 + i)).flatMap(letter => [`Pre-Series ${letter}`, `Series ${letter}`]),
  'Bridge', 'Pre-IPO', 'Equity', 'Debt', 'Equity & Debt', 'Secondary', 'Growth', 'Strategic', 'Unspecified'];
export function fundingRoundType(value) {
  const text = String(value ?? '').normalize('NFKC').trim().replace(/\s*[*†‡]+\s*$/, '').toLowerCase()
    .replace(/[‐‑‒–—−_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const series = text.match(/^(?:extended\s+)?(pre\s+)?series\s+([a-z])(?:\s*\d+)?(?:\s*,\s*(?:series\s+)?\2\s*\d+)?(?:\s+(?:funding\s+)?round|\s+extension)?$/);
  if (series) return `${series[1] ? 'Pre-Series' : 'Series'} ${series[2].toUpperCase()}`;
  if (/^pre\s*seed(?:\s+(?:funding\s+)?round|\s+funding)?$/.test(text)) return 'Pre-Seed';
  if (/^seed(?:\s+(?:funding\s+)?round|\s+funding)?$/.test(text)) return 'Seed';
  if (/^angel(?:\s+(?:funding\s+)?round|\s+funding)?$/.test(text)) return 'Angel';
  if (/^bridge(?:\s+round|\s+funding|\s+financing)?$/.test(text)) return 'Bridge';
  if (/^pre\s*ipo(?:\s+round)?$/.test(text)) return 'Pre-IPO';
  if (/^(?:equity\s*(?:,|and|&)\s*debt|debt\s*(?:,|and|&)\s*equity)(?:\s+round)?$/.test(text)) return 'Equity & Debt';
  if (/^(?:debt|credit)(?:\s+round|\s+funding|\s+financing)?$/.test(text)) return 'Debt';
  if (/^equity(?:\s+round|\s+funding)?$/.test(text)) return 'Equity';
  if (/^secondary(?:\s+round|\s+sale)?$/.test(text)) return 'Secondary';
  if (/^growth(?:\s+round|\s+funding)?$/.test(text)) return 'Growth';
  if (/^strategic(?:\s+round|\s+funding|\s+investment)?$/.test(text)) return 'Strategic';
  // Missing values, misplaced currency amounts and unrecognised text do not
  // establish a round stage. They remain available through this group and All.
  return 'Unspecified';
}
export function fundingRoundFilter(rows) {
  const present = new Set(rows.map(row => fundingRoundType(row.round)));
  return { label:'Round types',
    options:[{ value:'all', label:'All round types' }, ...stages.filter(stage => present.has(stage)).map(value => ({ value, label:value }))],
    normalizeValue:value => !value || value === 'all' ? 'all' : fundingRoundType(value),
    match:(row, value) => !value || value === 'all' || fundingRoundType(row.round) === fundingRoundType(value) };
}
