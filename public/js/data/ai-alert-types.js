// Display filters only. Source wording decides the labels; AI commentary never does.
import { ANNOUNCEMENT_TYPES, announcementTypeOf } from './announcement-types.js';

const SPECIAL_TYPES = [
  { id: 'scheme', label: 'Schemes & arrangements', hint: 'Schemes of arrangement, mergers, demergers and amalgamations.', re: /scheme of (?:arrangement|amalgamation)|\bdemerg\w*|\bmergers?\b|\bamalgamat\w*/i },
  { id: 'resignation', label: 'Resignations', hint: 'Resignations of directors, key personnel and auditors.', re: /\bresign(?:ation|ations|ed|s|ing)?\b/i },
  { id: 'preferential', label: 'Preferential issues', hint: 'Preferential issues and allotments of securities.', re: /\bpreferential\b/i },
  { id: 'warrants', label: 'Warrants', hint: 'Share warrants, including issues, allotments and conversions.', re: /\bwarrants?\b/i },
];
export const AI_EVENT_TYPES = [
  ...SPECIAL_TYPES.map(({ re, ...type }) => type),
  ...ANNOUNCEMENT_TYPES.filter(type => type.id !== 'routine'),
  { id: 'routine', label: 'Routine notices', hint: 'Lost or duplicate share certificates, demat notices, newspaper copies and routine compliance.' },
  { id: 'news', label: 'News', hint: 'Publisher news reports.' },
  { id: 'indirect', label: 'Indirect exposure', hint: 'Stories about other companies in a market a company is mapped to sell into (reviewed theme map).' },
  { id: 'concalls', label: 'Con-calls', hint: 'Earnings call readings.' },
  { id: 'insider', label: 'Insider trades & deals', hint: 'Insider, SAST, bulk and block disclosures.' },
  { id: 'investors', label: 'Investor holdings', hint: 'Changes in tracked investors’ holdings.' },
  { id: 'broker', label: 'Broker reports', hint: 'Broker research titles, ratings and targets posted on the monitored Telegram channel.' },
  { id: 'technicals', label: 'Price & volume', hint: 'Price, volume and portfolio price-level signals.' },
  { id: 'chatter', label: 'Public chatter', hint: 'Public chatter snapshots.' },
  { id: 'insights', label: 'Operating insights', hint: 'Captured operating insights.' },
];
const ids = new Set(AI_EVENT_TYPES.map(type => type.id));
const feedTypes = { earnings: 'results', news: 'news', 'market-news': 'news', concalls: 'concalls', insider: 'insider', investors: 'investors', 'broker-reports': 'broker', technicals: 'technicals', 'price-levels': 'technicals', chatter: 'chatter', 'screener-insights': 'insights', actions: 'corporate-action' };
const memo = new WeakMap();

export function aiEventTypes(event) {
  if (memo.has(event)) return memo.get(event);
  let types;
  if (['announcements', 'nse-filings'].includes(event.feed)) {
    const row = { title: event.filingSubject || event.headline, subCategory: event.filingSubCategory,
      description: event.filingDescription };
    // An exchange may label a newspaper copy merely "Buyback" or "Results". Read an
    // explicit administrative wrapper in the subject before accepting that broader label.
    const subjectType = announcementTypeOf({ title: row.title, description: row.description });
    const base = subjectType.routine ? 'routine' : announcementTypeOf(row).id;
    // A newspaper copy about results remains routine. Specific material types can refine broad
    // exchange labels (e.g. a board outcome approving a preferential issue of warrants).
    const text = [row.title, row.subCategory, row.description].filter(Boolean).join(' ');
    const specific = base === 'routine' ? [] : SPECIAL_TYPES.filter(type => type.re.test(text) &&
      (type.id !== 'warrants' || !/(?:arrest|search|bailable)\s+warrants?/i.test(text))).map(type => type.id);
    types = [...new Set([...specific, base])];
  } else if (event.themeExposure) types = ['indirect'];
  else types = [feedTypes[event.feed] || 'other'];
  memo.set(event, types);
  return types;
}

export function matchesAIEvent(event, { selected = [], hideRoutine = true } = {}) {
  const types = aiEventTypes(event);
  return (!hideRoutine || !types.includes('routine')) && (!selected.length || selected.some(id => types.includes(id)));
}

export const AI_EVENT_FILTER_KEY = 'sattva:ai-alerts:event-types:v1';
export function normalizeAIEventFilters(value = {}) {
  return { selected: [...new Set((Array.isArray(value?.selected) ? value.selected : []).filter(id => ids.has(id)))],
    hideRoutine: value?.hideRoutine !== false };
}
export function loadAIEventFilters() {
  try { return normalizeAIEventFilters(JSON.parse(localStorage.getItem(AI_EVENT_FILTER_KEY))); }
  catch { return normalizeAIEventFilters(); }
}
export function saveAIEventFilters(value) {
  try { localStorage.setItem(AI_EVENT_FILTER_KEY, JSON.stringify(normalizeAIEventFilters(value))); } catch { /* Session choice survives. */ }
}
