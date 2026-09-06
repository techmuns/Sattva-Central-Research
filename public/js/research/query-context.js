// Query-time retrieval preferences, never source retention or investment scores.
const DAY = 86_400_000;
const IST = 19_800_000;
const TOPICS = [
  ['chief-executive', /\b(ceo|chief executive)\b/i, /\b(ceo|chief executive)\b/i],
  ['chief-financial', /\b(cfo|chief financial)\b/i, /\b(cfo|chief financial)\b/i],
  ['leadership', /\b(ceo|cfo|coo|md|chief executive|chief financial|managing director|management|leadership|succession|resign\w*|appoint\w*)\b/i,
    /\b(ceo|cfo|coo|chief executive|chief financial|managing director|leadership|succession|resign\w*|appoint\w*|take over)\b/i],
  ['earnings', /\b(earnings|results|profit|margin|guidance|revenue|sales)\b/i,
    /\b(earnings|results|profit|margin|guidance|revenue|sales|ebitda|pat|quarter)\b/i],
  ['orders', /\b(orders?|contracts?|tenders?|wins?|deals?)\b/i,
    /\b(orders?|contracts?|tenders?|wins?|awarded|orderbook|order book|deal)\b/i],
  ['capital', /\b(debt|fundrais\w*|raising capital|raise capital|dilution|qip|pledge|cash flow|credit|rating)\b/i,
    /\b(debt|fundrais\w*|dilution|qip|pledge|cash flow|credit|rating|borrowing|default|repayment)\b/i],
  ['ownership', /\b(promoter|insider|bulk|block|stake|acquisition|merger|demerger|buyback)\b/i,
    /\b(promoter|insider|bulk|block|stake|acquisition|merger|demerger|buyback|sast)\b/i],
  ['regulatory', /\b(regulat\w*|sebi|rbi|tax|litigation|court|penalty|fraud|audit)\b/i,
    /\b(regulat\w*|sebi|rbi|tax|litigation|court|penalty|fraud|audit|notice|approval|probe)\b/i],
];
const CATALYST = /\b(ceo|chief executive|resign\w*|appoint\w*|guidance|earnings|profit|order|contract|awarded|acquisition|merger|demerger|qip|default|downgrade|upgrade|penalty|approval|buyback|dividend|capex|commission\w*|capacity)\b/i;
const dayString = ms => new Date(ms).toISOString().slice(0, 10);

export function questionWindow(question, now = Date.now()) {
  const time = typeof now === 'number' ? now : Date.parse(now);
  const today = dayString((Number.isFinite(time) ? time : Date.now()) + IST);
  const endMs = Date.parse(`${today}T00:00:00Z`);
  const q = String(question || '');
  const range = q.match(/\b(?:last|past|previous)\s+(?:(\d+|one|two|three|a|an)\s+)?(days?|weeks?|months?|years?)\b/i);
  const number = range ? ({ one: 1, two: 2, three: 3, a: 1, an: 1 }[range[1]?.toLowerCase()] || Number(range[1]) || 1) : null;
  const dates = q.match(/\b20\d{2}-\d{2}-\d{2}\b/g)?.filter(date => {
    const ms = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(ms) && dayString(ms) === date;
  }) || [];
  const year = q.match(/\b(?:in|during|for)\s+(20\d{2})\b/);
  let days = range ? Math.min(3650, number * (/year/i.test(range[2]) ? 365 : /month/i.test(range[2]) ? 30 : /week/i.test(range[2]) ? 7 : 1)) : /\btoday\b/i.test(q) ? 1 : 60;
  let end = today, start = dayString(endMs - (days - 1) * DAY);
  if (year) { start = `${year[1]}-01-01`; end = `${year[1]}-12-31`; }
  if (dates.length) { start = dates[0]; end = dates[1] || (/\b(?:since|from|after)\b/i.test(q) ? today : dates[0]); }
  const explicit = !!(range || year || dates.length || /\btoday\b/i.test(q));
  return { days: Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1, start, end, explicit,
    mode: /\bundated\b/i.test(q) ? 'undated' : explicit ? 'requested-period' : 'recent-priority' };
}

export function questionTopics(question) {
  return TOPICS.filter(([, query]) => query.test(question)).map(([topic]) => topic);
}

// Publication/event dates only: a successful check does not make old information recent.
export function eventDay(row) {
  for (const value of [row.publishedAt, row.publishedDate, row.date, row.resultDate, row.eventDate, row.when, row.latestEvent?.date]) {
    if (!value) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return dayString(ms + IST);
  }
  return null;
}

export function rowContext(row, plan) {
  const text = [row.title, row.headline, row.summary, row.text, row.detail, row.category, row.subCategory,
    row.insight, row.latestEvent?.headline, ...(row.attachments || []).map(a => a.name)].filter(Boolean).join(' ');
  const topic = (plan.topics || []).filter(name => TOPICS.find(([id]) => id === name)?.[2].test(text)).length;
  const date = eventDay(row);
  const window = plan.window;
  const temporal = !date ? 'undated' : !window ? 'dated' : date < window.start ? 'older' : date > window.end ? 'later' : 'in-window';
  const temporalRank = !window ? 0 : window.mode === 'undated' ? (temporal === 'undated' ? 0 : 2)
    : temporal === 'in-window' ? 0 : temporal === 'undated' ? 1 : 2;
  return { topic, date, temporal, temporalRank, catalyst: CATALYST.test(text) ? 1 : 0 };
}
