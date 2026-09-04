// Shared company evidence graph for AI Alerts and Ask Research.
//
// All Alerts remains the lossless top of funnel. This layer never changes an event's reading and
// never lets a context-only row create urgency. It only answers a narrower question once a real
// trigger exists: what else, across every normalized feed, is close enough in company, time and
// topic to help a human understand it?

export const CONTEXT_LOOKBACK_DAYS = 180;
export const UPCOMING_CONTEXT_DAYS = 45;
export const CONTEXT_LIMIT = 3;

const WORDS_TO_IGNORE = new Set([
  'about', 'after', 'against', 'also', 'been', 'before', 'being', 'company', 'could', 'current',
  'dashboard', 'date', 'dated', 'disclosure', 'event', 'from', 'have', 'holding', 'into', 'latest',
  'listed', 'more', 'news', 'period', 'portfolio', 'record', 'result', 'scheduled', 'source', 'stock',
  'that', 'their', 'this', 'through', 'today', 'under', 'with', 'year', 'quarter', 'report', 'snapshot',
]);

const clean = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const headlineKey = (event) => `${event.feed || ''}:${clean(event.headline).slice(0, 180)}`;
const dayMs = (day) => Date.parse(`${day}T12:00:00Z`);
const daysBetween = (a, b) => {
  const left = dayMs(a);
  const right = dayMs(b);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.round((left - right) / 86_400_000) : null;
};
const signed = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}%`;

function wordsOf(event) {
  const words = clean([event.headline, event.detail, ...(event.keywords || []), event.kind].filter(Boolean).join(' ')).split(' ');
  return new Set(words.filter((word) => word.length >= 4 && !WORDS_TO_IGNORE.has(word) && !/^\d+$/.test(word)));
}

function topicsOf(event) {
  return new Set([...(event.keywordIds || []), ...(event.keywords || []).map(clean), ...wordsOf(event)]);
}

function overlapWith(event, triggers) {
  const topics = topicsOf(event);
  let best = [];
  for (const trigger of triggers) {
    const shared = [...topics].filter((topic) => topicsOf(trigger).has(topic));
    if (shared.length > best.length) best = shared;
  }
  return best;
}

function sourceReadable(event, feedById) {
  if (event.feed === 'screener-insights') return event.sourceStatus !== 'failed';
  const feed = feedById.get(event.feed);
  return !!feed && ['ok', 'on-demand'].includes(feed.status);
}

function contextScore(event, triggers, throughDay, feedById) {
  if (!sourceReadable(event, feedById)) return null;
  const distance = daysBetween(event.day, throughDay);
  if (distance == null) return null;
  const upcoming = distance > 0;
  if (upcoming && (event.kind !== 'scheduled' || distance > UPCOMING_CONTEXT_DAYS)) return null;
  if (!upcoming && -distance > CONTEXT_LOOKBACK_DAYS) return null;
  const overlap = overlapWith(event, triggers);
  const nearest = Math.min(...triggers.map((trigger) => Math.abs(daysBetween(event.day, trigger.day) ?? 999)));
  let score = overlap.length * 9;
  if (nearest === 0) score += 8;
  else if (nearest === 1) score += 6;
  else if (nearest <= 3) score += 4;
  else if (nearest <= 14) score += 2;
  if (event.kind === 'filing' || event.kind === 'document') score += 5;
  else if (event.kind === 'fundamental-insight') score += 4;
  else if (event.kind === 'snapshot') score += 2;
  else if (event.kind === 'scheduled') score += 1;
  if (event.feed === 'news' && event.namesCompany === false) return null;
  // A generic snapshot months away from the trigger is merely available data, not related
  // evidence. A large operating move is still not an explanation for unrelated news: Insights
  // needs a shared topic, except beside results/call triggers where a material operating change is
  // itself the subject being discussed. Scheduled rows are useful only as the next milestone.
  const materialInsight = event.kind === 'fundamental-insight' && Number.isFinite(event.changePct) && Math.abs(event.changePct) >= 10;
  const resultsTrigger = triggers.some((trigger) => trigger.feed === 'earnings' || trigger.feed === 'concalls');
  if (event.kind === 'fundamental-insight' && !overlap.length && !(materialInsight && resultsTrigger)) return null;
  if ((event.kind === 'snapshot' || event.kind === 'post') && !overlap.length) return null;
  if (!upcoming && nearest > 14 && !overlap.length && !materialInsight) return null;
  return { score, overlap, nearest, upcoming };
}

/** Turn a metric series into one context record without pretending its period-end is today's news. */
export function insightEvents(companies = [], throughDay) {
  const events = [];
  for (const company of companies) {
    for (const row of company.rows || []) {
      const values = (row.values || []).filter((point) => point.period <= throughDay);
      const latest = values.at(-1);
      if (!latest) continue;
      const prior = values.at(-2) || null;
      const changePct = Number.isFinite(latest.numeric) && Number.isFinite(prior?.numeric) && prior.numeric !== 0
        ? ((latest.numeric - prior.numeric) / Math.abs(prior.numeric)) * 100
        : null;
      events.push({
        id: `insight:${company.companyKey}:${row.periodicity}:${clean(row.metric)}`,
        feed: 'screener-insights',
        feedLabel: 'Screener Insights',
        tab: 'ai-alerts',
        day: latest.period,
        time: null,
        ticker: company.ticker,
        company: company.name,
        headline: `${row.metric}: ${latest.value}${row.unit ? ` ${row.unit}` : ''}`,
        detail: `${latest.label}${Number.isFinite(changePct) ? ` · ${signed(changePct)} vs ${prior.label}` : ''}`,
        direction: 'neutral',
        importance: 'low',
        aiEligible: false,
        contextOnly: true,
        kind: 'fundamental-insight',
        metric: row.metric,
        unit: row.unit || null,
        latest,
        prior,
        periodicity: row.periodicity,
        changePct,
        url: latest.source?.url || company.companyUrl,
        sourceRecord: row,
        sourceStatus: 'ok',
      });
    }
  }
  return events;
}

function contextSentence(event) {
  if (!event) return null;
  if (event.kind === 'fundamental-insight') {
    const comparison = Number.isFinite(event.changePct) && event.prior ? `, ${signed(event.changePct)} vs ${event.prior.label}` : '';
    return `Business context · ${event.metric} was ${event.latest.value}${event.unit ? ` ${event.unit}` : ''} in ${event.latest.label}${comparison}.`;
  }
  if (event.kind === 'scheduled') return `Next known milestone · ${event.headline} on ${event.day}.`;
  return `Related context · ${event.feedLabel || event.feed} also records “${event.headline}”.`;
}

/**
 * Attach context from the complete normalized pool to a card whose trigger events were already
 * selected by AI Alerts. Context can explain and corroborate; it contributes zero priority points.
 */
export function enrichCardFromAllAlerts(card, report, { insightCompanies = [] } = {}) {
  const ticker = String(card?.ticker || '').toUpperCase();
  const triggerIds = new Set((card?.events || []).map((event) => event.id));
  const feedById = new Map((report?.feeds || []).map((feed) => [feed.id, feed]));
  const pool = [
    ...(report?.events || []).filter((event) => String(event.ticker || '').toUpperCase() === ticker && !triggerIds.has(event.id)),
    ...insightEvents(insightCompanies.filter((company) => String(company.ticker || '').toUpperCase() === ticker), report?.day),
  ];
  const seen = new Set();
  const ranked = [];
  for (const event of pool) {
    const key = headlineKey(event);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const relation = contextScore(event, card.events || [], report?.day, feedById);
    if (!relation) continue;
    ranked.push({ event, ...relation });
  }
  ranked.sort((a, b) => b.score - a.score || a.nearest - b.nearest || String(b.event.day).localeCompare(String(a.event.day)));

  // Independent sources first. This makes a raw exchange record useful beside a news trigger and
  // prevents ten unchanged holding snapshots from occupying the entire context budget.
  const selected = [];
  const usedFeeds = new Set();
  for (const item of ranked) {
    if (usedFeeds.has(item.event.feed)) continue;
    selected.push(item);
    usedFeeds.add(item.event.feed);
    if (selected.length === CONTEXT_LIMIT) break;
  }
  for (const item of ranked) {
    if (selected.includes(item)) continue;
    selected.push(item);
    if (selected.length === CONTEXT_LIMIT) break;
  }
  const upcoming = ranked.filter((item) => item.upcoming).map((item) => item.event);
  const contextual = selected.filter((item) => !item.upcoming);
  const lead = contextual[0]?.event || upcoming[0] || null;
  const allFeeds = new Set([...(card.events || []).map((event) => event.feed), ...selected.map((item) => item.event.feed)]);
  return {
    ...card,
    contextEvents: contextual.map((item) => ({ ...item.event, relation: { topicOverlap: item.overlap.slice(0, 5), daysFromTrigger: item.nearest } })),
    upcomingEvents: upcoming.slice(0, 2),
    contextSummary: contextSentence(lead),
    allFeedCount: allFeeds.size,
    allFeeds: [...allFeeds],
  };
}
