// Display helpers keep calendar ages independent of a cached report's collection date.
const DAY_MS = 86_400_000;
const DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const currentDay = (now = Date.now()) => new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);

function dayMillis(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return NaN;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms : NaN;
}

export function relativeAge(eventDay, throughDay = currentDay()) {
  const days = (dayMillis(throughDay) - dayMillis(eventDay)) / DAY_MS;
  if (!Number.isFinite(days)) return '—';
  if (days < 0) return `in ${Math.abs(days)}d`;
  return days === 0 ? 'today' : `${days}d`;
}

export function formatDay(day) {
  const ms = dayMillis(day);
  if (!Number.isFinite(ms)) return 'Date unavailable';
  return DATE_FORMATTER.format(ms);
}

/** The newest underlying signal, not the strongest event or an invented AI creation time. */
export function latestSignal(events = []) {
  const day = events.reduce((latest, event) => Number.isFinite(dayMillis(event.day)) && event.day > latest ? event.day : latest, '');
  if (!day) return null;
  const sameDay = events.filter((event) => event.day === day);
  // An undated clock could be later than any known clock on that day. Keep day precision then.
  const timed = sameDay.every((event) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(event.time)));
  const time = timed ? sameDay.map((event) => event.time).sort().at(-1) : null;
  return { day, time, datetime: time ? `${day}T${time}:00+05:30` : day };
}

function normalize(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Search every event, including evidence below the card's three-row preview. */
export function matchesSearch(card, query) {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const text = normalize([
    card.company, card.ticker, card.sector, card.insight, card.badge?.label,
    ...(card.feedLabels || []),
    ...(card.confluence || []).flatMap((pattern) => [pattern.label, pattern.short, pattern.detail]),
    ...(card.events || []).flatMap((event) => [event.company, event.ticker, event.headline, event.feedLabel, event.feed, event.day, formatDay(event.day), event.time]),
  ].join(' '));
  return words.every((word) => text.includes(word));
}
