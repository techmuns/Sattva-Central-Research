// Registry only: reads existing feed state, never performs a source read or a capture dispatch.
import { news } from '../data/filings.js';
import * as marketNews from '../data/market-news.js';
import * as screenerInsights from '../data/screener-insights.js';
import { sourceReadState } from './source-connections.js';

export const NEWS_PUBLISHERS = [
  { id: 'moneycontrol', name: 'Moneycontrol', url: 'https://www.moneycontrol.com/news/business/stocks/' },
  { id: 'business-standard', name: 'Business Standard', url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { id: 'mint', name: 'Mint', url: 'https://www.livemint.com/rss/markets' },
  { id: 'economic-times', name: 'Economic Times', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { id: 'investing', name: 'Investing.com', url: 'https://in.investing.com/rss/news_285.rss' },
];

export function newsSourceItems(meta = news.meta(), publishers = marketNews.meta().sources || [], publisherReadFailed = marketNews.meta().lastReadFailed) {
  const tv = meta.tradingViewCoverage, discovery = meta.enrichmentCoverage;
  return [
    { id: 'tradingview-news', name: 'TradingView — portfolio headlines', url: 'https://in.tradingview.com/', status: 'live',
      readState: sourceReadState({ at: tv?.checkedAt, failed: !!meta.tradingViewReadError || !!tv?.blockedUntil && Date.parse(tv.blockedUntil) > Date.now(),
        partial: meta.tradingViewHealth?.ok === false || !!tv?.unresolvedCompanies || !!tv?.possibleGapSymbols }),
      cadence: 'Every 15 minutes, around the clock · open dashboards check published news every 2 minutes',
      details: [tv ? `Last capture: ${tv.checkedAt}. ${tv.mappedCompanies}/${tv.activeCompanies} portfolio companies mapped; ${tv.staleOrFailedSymbols} stale or failed symbol reads.` : 'Automatic capture is configured; the first published capture has not been confirmed here yet.',
        'New portfolio holdings join automatically; exited holdings stop polling and their history stays archived.',
        'Public headline metadata with original publisher links. Restricted headlines are not extracted; bounded public windows may leave gaps.'],
      feeds: 'Additive portfolio news from verified NSE/BSE company pages, with permanent history and original publisher attribution.',
      file: 'data/tradingview-news/latest.json · .github/workflows/tradingview-news-refresh.yml' },
    { id: 'global-company-news', name: 'Muns — global company & related-entity search', url: 'https://fastapi.muns.io', status: 'live',
      readState: sourceReadState({ at: discovery?.capturedAt, partial: !!discovery?.staleOrIncompleteQueries, maxAgeMs: 4 * 3600000 }),
      cadence: 'Every 3 hours · overlapping global searches across reviewed company identities',
      feeds: 'Adds international reporting and reviewed aliases, brands and related entities to the India company search. Related-entity mentions are not treated as proven exposure.',
      details: [discovery ? `Last discovery pass: ${discovery.capturedAt}. ${discovery.completedQueries}/${discovery.plannedQueries} queries completed this run; ${discovery.staleOrIncompleteQueries} stale or incomplete queries remain retryable.` : 'Coverage is populated by the scheduled enrichment capture.',
        'Collection is broad. Topic and materiality filters affect reading, never permanent retention.'],
      file: 'scripts/enrich-company-news.mjs · data/company-news/discovery.json' },
    { id: 'official-company-ir', name: 'Official company investor-relations pages & documents', url: null, status: 'live',
      readState: sourceReadState({ at: discovery?.capturedAt, partial: !!discovery?.pagesFailed || !!discovery?.documentsPending, maxAgeMs: 4 * 3600000 }),
      cadence: 'Every 3 hours · reviewed official pages and bounded document extraction',
      feeds: 'Official presentations, press releases and linked documents from explicitly reviewed company pages. Available metadata is retained before document-reading or relevance filters.',
      details: [discovery ? `${discovery.pagesFailed} page reads need retry; ${discovery.documentsPending} documents await bounded extraction.` : 'The scheduled capture reports which reviewed pages and documents have been read.',
        'This is the reviewed official-page set, not a claim that every portfolio IR website is connected.'],
      file: 'scripts/enrich-company-news.mjs · public/js/data/company-news-reviewed.js' },
    ...NEWS_PUBLISHERS.map(p => {
      const source = publishers.find(s => s.id === p.id);
      return { id: `publisher-${p.id}`, name: p.name, url: p.url, status: 'live',
        readState: sourceReadState({ at: source?.capturedAt, failed: publisherReadFailed || source?.ok === false,
          partial: Number.isFinite(source?.feedsOk) && source.feedsOk < source.feeds, maxAgeMs: 3 * 3600000 }),
        cadence: p.id === 'moneycontrol' ? 'Half-hourly daytime / hourly overnight · retained publisher feed' : 'Hourly RSS capture · retained publisher feeds',
        feeds: 'Original reporting with publisher timestamps and links. Exact portfolio matches enrich company news; the complete retained feed remains available in Universe.',
        details: [source ? `Last source capture: ${source.capturedAt || 'not supplied'}. Latest read: ${source.ok ? 'successful' : 'not completed'}.` : 'Published source metadata has not loaded in this session.',
          'A quiet response is distinct from a failed read. Earlier captured stories remain retained.'],
        file: 'data/market-news.json · data/market-news/' };
    }),
  ];
}

export function screenerInsightsSource(meta = screenerInsights.meta()) {
  return { id: 'screener-insights', name: 'Screener.in — company operating insights', url: 'https://www.screener.in/', status: 'live',
    readState: sourceReadState({ at: meta?.checkedAt, failed: !!meta?.latestReadFailed || !!meta?.collectorLatestFailed,
      partial: !!meta?.failed || !!meta?.missingCompanies || !!meta?.staleCompanies || meta?.fullCoverage === false, maxAgeMs: 36 * 3600000 }),
    feeds: 'Source-backed operating metrics and management context for verified company identities. These enrich research context; they do not independently create a material alert.',
    cadence: 'Daily scheduled capture · verified company pages · last-good values retained',
    details: [meta ? `${meta.companies}/${meta.targets} companies captured; ${meta.failed} failed targets. Source check: ${meta.checkedAt}.` : 'Awaiting a verified published capture. The collector is configured, but coverage has not been confirmed in this session.',
      'Unresolved company identities are recorded separately and do not cause verified company captures to be discarded.'],
    file: '.github/workflows/screener-insights-refresh.yml · api/screener-insights' };
}
