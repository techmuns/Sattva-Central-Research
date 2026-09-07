// Explicit, portable snapshots. Never persist a feed object, session or credential.
export const SECTION_LABELS = {
  'daily-alerts': 'All Alerts', 'ai-alerts': 'AI Alerts', news: 'News',
  'corp-announcements': 'Corporate announcements', 'nse-filings': 'NSE filings',
  'corporate-actions': 'Corporate actions', 'insider-trades': 'Insider trades',
  'earnings-hub': 'Earnings', concall: 'Con-call', 'public-chatter': 'Public chatter',
  breakouts: 'Technicals', 'super-investors': 'Investors', ipos: 'IPOs', 'ask-research': 'Research',
};
const FEED_KINDS = { news: 'News', 'market-news': 'News', announcements: 'Corporate announcements',
  'nse-filings': 'NSE filings', 'corporate-actions': 'Corporate actions', insider: 'Insider trades',
  earnings: 'Earnings', concalls: 'Con-call', chatter: 'Public chatter', telegram: 'Public chatter',
  technicals: 'Technicals', investors: 'Investors', twitter: 'News', ipos: 'IPOs',
  'earnings-calendar': 'Earnings', 'scheduled-concalls': 'Con-call', 'chatter-posts': 'Public chatter',
  'investor-positions': 'Investors', institutions: 'Investors' };
const text = value => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

export function safeBookmarkUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function bookmarkId(entry) {
  const company = text(entry.ticker).toUpperCase() || text(entry.entityId) || text(entry.company).toLowerCase();
  // Keep company attribution separate even when two companies share an article URL.
  // A repeated save never replaces the original snapshot or its notes.
  return JSON.stringify([entry.kind, company, entry.url || JSON.stringify([entry.source, entry.sourceId || entry.title]),
    entry.url && ['News', 'Corporate announcements', 'NSE filings'].includes(entry.kind) ? '' : entry.eventDate,
    entry.kind === 'Investors' ? entry.sourceId : '']);
}

export function normalizeBookmark(value) {
  if (!value || typeof value !== 'object' || !text(value.title)) throw new Error('A bookmark needs an event title.');
  const entry = Object.fromEntries(['title', 'company', 'ticker', 'entityId', 'eventDate', 'body', 'source', 'sourceId', 'kind', 'note']
    .map(key => [key, text(value[key])]));
  entry.kind ||= 'Event';
  entry.url = safeBookmarkUrl(value.url);
  entry.details = Array.isArray(value.details) ? value.details.map(item => ({ label: text(item?.label), value: text(item?.value) }))
    .filter(item => item.label && item.value) : [];
  entry.links = Array.isArray(value.links) ? value.links.map(item => ({ label: text(item?.label) || 'Source', url: safeBookmarkUrl(item?.url) }))
    .filter(item => item.url) : [];
  entry.id = bookmarkId(entry);
  entry.savedAt = Number.isFinite(Date.parse(value.savedAt)) ? new Date(value.savedAt).toISOString() : new Date().toISOString();
  return entry;
}

export function snapshotForRow(row = {}, context = {}) {
  const companyRecord = row.company && typeof row.company === 'object' ? row.company : null;
  const original = row.sourceRecord || companyRecord || row;
  const section = context.section || '';
  const title = text(original.title || row.headline || row.subject || row.purpose || row.text || row.event || context.title)
    || `${SECTION_LABELS[section] || 'Research'} snapshot`;
  return normalizeBookmark({
    title,
    company: row.feed === 'market-news' ? '' : text(original.company) || text(companyRecord?.name) || text(row.company) || text(context.company),
    ticker: original.ticker || row.ticker || context.ticker || '',
    entityId: original.entityId || row.entityId,
    kind: context.kind || FEED_KINDS[row.feed] || row.feedLabel || SECTION_LABELS[section] || 'Event',
    sourceId: original.id || row.id || context.sourceId || context.rowKey || title,
    source: text(original.publisher || original.source || row.sourceLabel || row.feedLabel) || text(context.source) || SECTION_LABELS[section],
    eventDate: original.publishedAt || original.date || row.day || row.at || row.filingDate || row.exDate || row.resultDate || original.bar_date || row.period || context.eventDate,
    body: [original.summary, original.description, original.text, row.detail, row.reason].map(text).filter((v, i, a) => v && v !== title && a.indexOf(v) === i).join('\n\n'),
    url: original.url || row.url || row.documentUrl || row.link || context.url || original.screenerUrl,
    details: context.details || [],
    links: context.links || [],
  });
}

export function filterBookmarks(entries, { company = '', query = '', kind = '', notesOnly = false, sort = 'saved' } = {}) {
  const needle = text(query).toLocaleLowerCase();
  return entries.filter(entry => (!company || companyKey(entry) === company) && (!kind || entry.kind === kind)
    && (!notesOnly || !!entry.note) && (!needle || [entry.company, entry.ticker, entry.title, entry.body, entry.note, entry.source,
      ...entry.details.map(item => `${item.label} ${item.value}`)].join(' ').toLocaleLowerCase().includes(needle)))
    .sort((a, b) => sort === 'company' ? (a.company || a.ticker || '\uffff').localeCompare(b.company || b.ticker || '\uffff') || b.savedAt.localeCompare(a.savedAt)
      : sort === 'event' ? (Date.parse(b.eventDate) || 0) - (Date.parse(a.eventDate) || 0) || b.savedAt.localeCompare(a.savedAt)
        : b.savedAt.localeCompare(a.savedAt));
}
export function companyKey(entry) { return text(entry.ticker).toUpperCase() || text(entry.entityId) || text(entry.company).toLowerCase() || '_market'; }

export function parseBackup(value) {
  if (value?.format !== 'sattva-bookmarked-notebook' || value.version !== 1 || !Array.isArray(value.entries))
    throw new Error('Choose a Sattva notebook backup (.json).');
  // Validate the entire import before opening a write transaction. Never partially import a bad file.
  return value.entries.map(entry => {
    if (!entry?.savedAt || !Number.isFinite(Date.parse(entry.savedAt))) throw new Error('The backup contains an invalid saved date. Nothing was imported.');
    return normalizeBookmark(entry);
  });
}
