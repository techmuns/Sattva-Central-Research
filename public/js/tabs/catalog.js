// Navigation metadata stays available before any tab's renderer is loaded.
// Renderers use these same objects so labels, scopes and subviews cannot drift.
import { AI_ALERT_WINDOW_DAYS } from '../core/alert-window.js';

export const TAB_META = Object.freeze({
  'ai-alerts': {
    id: 'ai-alerts',
    title: 'AI Alerts',
    subtitle: `Important portfolio events from the last ${AI_ALERT_WINDOW_DAYS} days.`,
    subviews: [],
  },
  'ask-research': {
    id: 'ask-research',
    title: 'Ask Research',
    // Removed from the tab strip; saved research and newsletter links still resolve.
    hideFromNavigation: true,
    subtitle: 'Ask across every dashboard tab.',
    subviews: [],
    allowEmptyScope: true,
  },
  'daily-alerts': {
    id: 'daily-alerts',
    title: 'All Alerts',
    layout: 'table',
    subtitle: 'Opens on Today (IST); older retained alerts and upcoming schedules remain available.',
    // No rail. This is one stream and splitting it by feed would rebuild the tabs it exists to
    // collapse — the feed filter in the toolbar does that job without costing a navigation.
    subviews: [],
  },
  'bookmarks': { id: 'bookmarks', title: 'Bookmarks', subtitle: 'Your saved research, kept together.', subviews: [], allowEmptyScope: true, scopeIndependent: true },
  'earnings-hub': {
    id: 'earnings-hub',
    title: 'Earnings Hub',
    subtitle: 'Live quarterly results across the listed universe, updated as companies report.',
    // No sub-views: this tab is one table. The shell hides the rail entirely when this is empty.
    subviews: [],
  },
  'concall': {
    id: 'concall',
    title: 'Con-call',
    subtitle: 'The complete Screener concall document index, enriched with current-quarter third-party analysis.',
    // No sub-views: the shell hides the rail entirely when this is empty and the table spans the
    // full width. The schedule is an overlay, not a second page.
    subviews: [],
  },
  'public-chatter': {
    id: 'public-chatter',
    title: 'Public Chatter',
    subtitle: 'What retail is actually discussing, across ValuePickr, TradingQnA and Google News.',
    // No shell sub-view picker: Coverage, Not in coverage and Telegram are simple tabs inside this
    // page.
    subviews: [],
    // TWO OF THIS TAB'S THREE SECTIONS CARRY NO COMPANY AT ALL, so an empty watchlist is not an
    // empty page. Without this the shell replaces the whole tab with its zero-watchlist panel and
    // states, in those words, that "Public Chatter has nothing to show in this scope" — while the
    // Telegram section holds a hundred-odd posts and the uncovered section holds every entry that
    // resolved to no symbol, neither of which the scope can narrow. That is a false claim made by
    // the chrome about content it is hiding, and it is the same reason Ask Research and IPOs declare
    // this. The Coverage section keeps its own scope-aware empty state, which names the watchlist
    // explicitly rather than blaming a filter the reader never set.
    allowEmptyScope: true,
  },
  'breakouts': {
    id: 'breakouts',
    title: 'Breakouts / Technical',
    subtitle: 'Daily technical scoring and captured prices across the NSE 500 and every listed holding — 16 rules, 24 points.',
    subviewNavigation: 'tabs',
    subviews: [
      { id: 'momentum-scanner', label: 'Momentum Scanner' },
      { id: 'strong-breakouts', label: 'Strong Breakouts' },
      { id: 'technical-scanner', label: 'Technical Scanner' },
      { id: 'fii-accumulation', label: 'FII Accumulation' },
    ],
  },
  'super-investors': {
    id: 'super-investors',
    title: 'Super Investors',
    subtitle: 'Superstar-investor and institutional holdings, quarter on quarter and month on month.',
    subviews: [
      { id: 'superstar-investors', label: 'Superstar Investors' },
      { id: 'institutions', label: 'Institutions' },
    ],
  },
  'news': {
    id: 'news',
    title: 'News',
    subtitle:
      'Company news, updated automatically. Opens on Today (IST); choose another period up to 30 days or This month. ' +
      'Undated stories have their own filter; older news stays saved in All Alerts.',
    subviews: [],
  },
  'ipos': { id: 'ipos', title: 'IPOs', subtitle: 'Official public-issue filings, including unlisted issuers. Newest filings first.', allowEmptyScope: true, subviews: [] },
  'corp-announcements': {
    id: 'corp-announcements',
    title: 'Corp Announcements',
    subtitle:
      'Company announcements from BSE, NSE and captured filings — newest day first, the most relevant first within each day.',
    subviews: [],
  },
  'corporate-actions': {
    id: 'corporate-actions',
    title: 'Corporate Actions',
    subtitle: 'One deduplicated feed of NSE actions, enriched with Screener ratios, terms, prices and additional records.',
    subviews: [],
  },
  'nse-filings': {
    id: 'nse-filings',
    title: 'NSE Filings',
    subtitle: 'Search captured NSE filing history by company or ticker, with live updates.',
    subviews: [],
  },
  'insider-trades': {
    id: 'insider-trades',
    title: 'Bulk/Block Deal',
    subtitle: '',
    subviews: [],
  },
  'mutual-funds': {id:'mutual-funds',title:'Mutual Funds',subtitle:'Fund returns, category comparisons and company ownership.',subviews:[
    {id:'company-holdings',label:'Company Holdings'}, {id:'all-schemes',label:'All Schemes'}, {id:'category-performance',label:'Category Performance'}
  ]}
});
