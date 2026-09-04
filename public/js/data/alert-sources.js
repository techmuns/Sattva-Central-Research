// Additional source-tab adapters. No ranking, company walks or upstream job dispatches.
import * as nse from './nse-filings.js';
import * as twitter from './twitter-news.js';
import * as institutions from './institution-holdings.js';
import * as investors from './super-investors.js';
import * as concalls from './concall-scans.js';
import * as chatter from './chatter-live.js';
import * as calendar from './earnings-calendar.js';
import * as ipoFilings from './ipo-filings.js';
import { screenerUpcomingKey } from './screener-upcoming-shared.js';
import { revalidatedJson } from '../core/store.js';
import { documentRecords, record, istDay } from './alert-records.js';

let calendarCapture = null;
let calendarTickers = {};
const confirmed = (asOf, day, incomplete = false, note = null) => ({
  status: incomplete ? 'failed' : 'ok', asOf,
  reachesToday: !incomplete && !!istDay(asOf) && istDay(asOf) >= day, note,
});
const slugTicker = (value) => value && !String(value).toUpperCase().startsWith('SCRIP-') ? String(value).toUpperCase() : null;

export function nseRecords(rows) {
  return rows.map((r) => record({ id: `nse:${nse.rowKey(r)}`, row: r, at: r.publishedAt,
    ticker: r.ticker, company: r.company, headline: r.subject || 'NSE filing', detail: r.description,
    url: r.url, kind: 'filing' }));
}

export function ipoRecords(snapshots) {
  const records = new Map();
  // Newer captures correct the same filing; each market observation keeps its capture date.
  for (const snapshot of [...snapshots].sort((a, b) => a.meta.snapshot_id.localeCompare(b.meta.snapshot_id))) {
    for (const r of snapshot.filings || []) {
      const id = `ipo:filing:${r.id || JSON.stringify([r.company_name, r.filing_type, r.filing_date, r.sources])}`;
      records.set(id, record({ id, row: r, at: r.filing_date, company: r.company_name,
        headline: `${r.filing_type || 'IPO'} filing`, detail: r.business_summary,
        url: r.sources?.drhp_pdf_url || r.sources?.sebi_url, kind: 'filing',
        observedAt: snapshot.meta.data_as_of, sourceSnapshot: snapshot.meta.snapshot_id }));
    }
    for (const group of ['open_upcoming', 'recent_listings']) for (const r of snapshot.ipo_market?.[group] || []) {
      const id = `ipo:market:${r.company_name}:${snapshot.meta.snapshot_id}:${group}`;
      records.set(id, record({ id, row: r, at: snapshot.meta.data_as_of, ticker: r.symbol,
        company: r.company_name, headline: `IPO market snapshot: ${r.stage || r.status || 'status not supplied'}`,
        detail: `Observed ${snapshot.meta.data_as_of}; not a current-status confirmation. Open: ${r.issue_open || 'not supplied'}; close: ${r.issue_close || 'not supplied'}; listing: ${r.listing_date || 'not supplied'}.`,
        url: r.groww?.provenance?.source_url, kind: 'snapshot', sourceSnapshot: snapshot.meta.snapshot_id }));
    }
  }
  return [...records.values()];
}

function calendarRecords() {
  const dates = new Map(Object.entries(calendarCapture?.byDate || {}));
  for (const d of calendar.strip()) {
    const loaded = calendar.forDate(d.date);
    if (loaded) dates.set(d.date, loaded);
  }
  return [...dates].flatMap(([date, payload]) => (payload.rows || []).map((r) => record({
    id: `calendar:${date}:${r.scId || r.ticker || r.name || r.company}`, row: r,
    at: date, ticker: r.ticker || calendarTickers[r.scId]?.ticker, company: r.company || r.name || r.companyName,
    headline: 'Scheduled earnings result', detail: `Scheduled for ${date}; not confirmation that results were filed.`,
    url: r.mcUrl || r.url, kind: 'scheduled', scheduledFor: date,
  })));
}

function privateDocuments(kind, day) {
  const { rows, reads } = documentRecords(kind);
  return {
    events: rows.map((r) => record({ id: `${kind}:${r.key || r.id || JSON.stringify([r.symbol, r.company, r.form, r.date, r.documents])}`,
      row: r, at: r.date, ticker: r.ticker || null, company: r.company || r.symbol,
      headline: r.title || `${r.form || 'Prospectus'} document`, detail: r.summary || (r.sources || [r.source]).filter(Boolean).join(' · '),
      url: r.url || r.documents?.[0]?.url, kind: 'document', private: true })),
    ...confirmed(null, day, reads.some((r) => r.incomplete)),
    status: reads.some((r) => r.incomplete) ? 'failed' : 'on-demand',
    note: `${reads.length} lookup(s) read in this session. Only requested companies are covered; no automatic universe-wide lookup. Results clear on account change/logout.${reads.some((r) => r.incomplete) ? ' Some returned records could not be mapped or the service limit was reached.' : ''}`,
  };
}

export const ADDITIONAL_SOURCES = [
  { id: 'nse-filings', label: 'NSE filings', tab: 'nse-filings', what: 'Every filing in the available retained NSE window, including unresolved and undated filings.',
    load: async (refresh) => { await nse.load(); if (refresh) await nse.refresh(); await nse.loadHistory(90, { updateWindow: false }); },
    read: ({ day }) => { const m = nse.meta(); return { events: nseRecords(nse.retainedRows()),
      ...confirmed(m.capturedAt, day, !!(m.degraded || m.historyUnavailable || m.allMissingDays?.length),
        `Available NSE archive: up to 90 days.${m.degraded ? ` ${m.degraded}` : ''}${m.historyUnavailable ? ' Archive index unavailable.' : ''}${m.allMissingDays?.length ? ` Unread archive days: ${m.allMissingDays.join(', ')}.` : ''}`) }; } },
  { id: 'twitter', label: 'X / Twitter posts', tab: 'news', what: 'Every captured post from currently monitored accounts. No inferred company mapping.',
    load: async (refresh) => { await twitter.load(); if (refresh) await twitter.refresh(); },
    read: ({ day }) => { const m = twitter.meta(); return { events: twitter.rows().map((r) => record({ id: r.id, row: r, at: r.publishedAt,
      company: `@${r.handle}`, headline: r.title, detail: r.displayName, url: r.url, kind: 'post' })),
      ...confirmed(m.capturedAt, day, !!(m.lastReadFailed || m.reason || m.failed), m.lastReadFailed ? 'X capture could not be revalidated; retained posts remain visible.' : m.message || 'Captured monitored accounts only; unresolved posts are visible in Universe.') }; } },
  { id: 'ipos', label: 'IPO filings', tab: 'ipos', what: 'The same official-source documents and retained history as the IPOs tab. Filing does not confirm an open/approved IPO.',
    load: (refresh) => refresh ? ipoFilings.refresh() : ipoFilings.load(),
    read: ({ day }) => { const m = ipoFilings.meta(); return { events: ipoFilings.rows().map((r) => record({
      id: `ipo:${r.id}`, row: r, at: r.filingDate, company: r.company, ticker: r.ticker,
      headline: `${r.filingType} filing${r.origin === 'supplement' ? ' · tracked-issuer supplement' : ''}`,
      detail: `${r.title}. ${r.source}${r.note ? `. ${r.note}` : ''}`, url: r.url, kind: 'filing', observedAt: r.observedAt,
    })), ...confirmed(m.checkedAt, day, !!m.degraded,
      `Official source check, not a filing timestamp. SEBI recent pages + NSE mainboard/SME + BSE SME + retained captures; not a complete archive. ${m.sources.map((s) => `${s.label}: ${s.status}. ${s.note}`).join(' ')}${m.liveFailed ? ' Live revalidation failed.' : ''}`) }; } },
  { id: 'earnings-calendar', label: 'Earnings calendar', tab: 'earnings-hub', what: 'Every company/date in the captured calendar plus dates explicitly loaded in Earnings Hub. Scheduled, not filed.',
    load: async () => { const [payload, map] = await Promise.all([revalidatedJson('data/earnings-calendar.json'), revalidatedJson('data/mc-ticker-map.json', { optional: true })]);
      if (!payload?.byDate) throw Error('Earnings calendar capture unavailable'); calendarCapture = payload; calendarTickers = map?.map || {}; },
    read: ({ day }) => ({ events: calendarRecords(), ...confirmed(calendarCapture?.capturedAt, day,
      Object.values(calendarCapture?.byDate || {}).some((p) => p.complete === false),
      `Captured calendar window: ${calendarCapture?.from || 'unknown'} to ${calendarCapture?.to || 'unknown'}. Scheduled dates do not establish a filing.`) }) },
  { id: 'scheduled-concalls', label: 'Scheduled con-calls', tab: 'concall', what: 'All upcoming calls returned by the con-call source; not yet held.',
    load: () => concalls.load(),
    read: ({ day }) => ({ events: concalls.upcoming().map((r) => record({ id: `scheduled-call:${concalls.rowUid(r)}`, row: r,
      at: r.when || r.date, ticker: r.ticker, company: r.name, headline: 'Scheduled con-call',
      detail: `Scheduled for ${r.date || r.when || 'an unspecified date'}; not a completed call or published analysis.`, url: r.transcriptUrl,
      kind: 'scheduled', scheduledFor: r.date || istDay(r.when) })),
      ...confirmed(concalls.meta()?.fetchedAt, day, !!concalls.meta()?.degraded) }) },
  { id: 'screener-portfolio-upcoming', label: 'Portfolio calendar', tab: 'daily-alerts', portfolioOnly: true,
    what: 'Upcoming AGMs, postal ballots, results, calls and other scheduled events shown for the exact S Screen portfolio watchlist. Scheduled, not completed.',
    load: () => concalls.load(),
    read: ({ day }) => {
      const source = concalls.meta()?.screener;
      return {
        events: concalls.portfolioUpcoming().map((r) => record({
          id: `screener-upcoming:${screenerUpcomingKey(r)}`,
          row: r,
          at: r.date,
          time: r.time || null,
          ticker: r.ticker,
          company: r.name,
          headline: `${r.eventType} scheduled`,
          detail: `${r.eventType} is listed for ${r.date}${r.time ? ` at ${r.time} IST` : ''} on the portfolio calendar; this is not confirmation that it occurred.`,
          url: r.sourceUrl || r.companyUrl,
          kind: 'scheduled',
          scheduledFor: r.date,
          portfolioOnly: true,
          companyUrl: r.companyUrl,
        })),
        ...confirmed(
          source?.checkedAt,
          day,
          source?.status !== 'ok' || source?.collectorLatestFailed === true || source?.portfolioUpcomingAvailable === false,
          'Authenticated S Screen dashboard calendar for the synchronized portfolio watchlist.',
        ),
      };
    } },
  { id: 'investor-positions', label: 'Investor holdings', tab: 'super-investors', what: 'All retained investor/company disclosures, including unchanged holdings and filing-due states. Snapshots, not trades.',
    load: () => investors.load(),
    read: ({ day }) => ({ events: investors.books().flatMap((b) => (b.holdings || []).map((r) => record({
      id: `investor-position:${b.slug}:${r.companySlug || r.company}:${b.quarters?.[0] || ''}`, row: { ...r, quarters: b.quarters, investor: b.name },
      at: investors.confirmedAtFor(b.slug) || investors.meta()?.capturedAt || null, ticker: slugTicker(r.companySlug), company: r.company,
      headline: `${b.name || b.slug}: holding disclosure snapshot`,
      detail: `${b.quarters?.[0] || 'Period not supplied'}: ${r.quarterlyHoldings?.[b.quarters?.[0]] == null ? 'Filing due / percentage not disclosed; not an exit or sale.' : `${r.quarterlyHoldings[b.quarters[0]]}% disclosed. Not a trade timestamp.`}`,
      url: r.companySlug ? `https://ticker.finology.in/company/${encodeURIComponent(r.companySlug)}` : null, kind: 'snapshot',
    }))), ...confirmed(investors.meta()?.checkedAt || investors.meta()?.capturedAt, day,
      investors.meta()?.ok === false || !!(investors.meta()?.failedBooks || investors.meta()?.stale || investors.meta()?.pending),
      'Quarterly disclosures dated to source observation, not trades. Every reported period is retained in the source record.') }) },
  { id: 'institutions', label: 'Institutional disclosures', tab: 'super-investors', what: 'All captured institutional holdings and former holdings. Company ownership and fund NAV remain distinct.',
    load: async (refresh) => { await (refresh ? institutions.refresh() : institutions.load()); if (!institutions.isLoaded()) throw Error('Institutional capture unavailable'); },
    read: ({ day }) => ({ events: institutions.all().flatMap((fund) => [...fund.holdings, ...fund.former].map((r) => record({
      id: `institution:${fund.investorId}:${r.ticker || r.name}:${fund.latestPeriod}`, row: { ...r, disclosure: fund.disclosure, periods: fund.periods },
      at: institutions.meta()?.generatedAt, ticker: r.ticker, company: r.name,
      headline: `${fund.name}: ${fund.disclosure === 'portfolio' ? 'fund portfolio' : 'company shareholding'} disclosure`,
      detail: `${fund.latestPeriodLabel || fund.latestPeriod || 'Period not supplied'}: ${r.pct == null ? 'Percentage not disclosed; not zero' : `${r.pct}% ${fund.disclosure === 'portfolio' ? 'of fund NAV' : 'of company'}`}. Source snapshot, not a trade date.`,
      url: r.url || fund.sourceUrl, kind: 'snapshot',
    }))), ...confirmed(institutions.meta()?.generatedAt, day) }) },
  { id: 'chatter-posts', label: 'Chatter posts', tab: 'public-chatter', what: 'Individual posts already requested in Public Chatter; untouched source text.',
    load: () => chatter.load(),
    read: ({ day }) => ({ events: chatter.loadedPosts().flatMap((group) => {
      const company = chatter.all().find((r) => r.slug === group.slug);
      return group.posts.map((r) => record({ id: `chatter-post:${r.source}:${r.id}:${group.slug}`, row: r, at: r.at,
        ticker: company?.ticker, company: company?.name || group.name || group.slug,
        headline: r.text, detail: [r.sourceLabel, r.author || r.handle].filter(Boolean).join(' · '), url: r.url, kind: 'post' }));
    }), ...confirmed(chatter.meta()?.generatedAt, day), status: 'on-demand',
      note: 'Only detail pages already requested in Public Chatter are loaded. Company summaries are bulk-loaded separately; individual-post coverage is not complete.' }) },
  { id: 'company-documents', label: 'Company documents', tab: 'corp-announcements', what: 'All successful combined-filings lookup results from this session, before tab-specific filters.',
    load: null, read: ({ day }) => privateDocuments('company-documents', day) },
  { id: 'drhp-documents', label: 'Private DRHP lookup', tab: 'ipos', what: 'All successful DRHP lookup results from this session. This is not an IPO-discovery feed.',
    load: null, read: ({ day }) => privateDocuments('drhp-documents', day) },
];

export const additionalSubscriptions = [nse, twitter, institutions, calendar, ipoFilings];
