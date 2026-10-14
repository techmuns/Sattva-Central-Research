// Navigation metadata stays available before any tab's renderer is loaded.
// Renderers use these same objects so labels, scopes and subviews cannot drift.
import { AI_ALERT_WINDOW_DAYS } from '../core/alert-window.js';

// Navigation groups share chrome while their readers retain their own routes and lifecycles.
export const TAB_GROUPS = Object.freeze({
  alerts: { id: 'alerts', title: 'Alerts', layout: 'table' },
  announcements: { id: 'announcements', title: 'Announcements' },
  earnings: { id: 'earnings', title: 'Earnings' },
  // Keep the parent distinct from the saved `news` reader route.
  'news-section': { id: 'news-section', title: 'News' },
});

export const TAB_META = Object.freeze({
  'ai-alerts': {
    id: 'ai-alerts',
    title: 'AI Alerts',
    navigationGroup: 'alerts',
    subtitle: `Important portfolio events from the last ${AI_ALERT_WINDOW_DAYS} days.`,
    subviews: [],
  },
  'ask-research': {
    id: 'ask-research',
    title: 'Ask Research',
    // Removed from the tab strip; saved research and newsletter links still resolve.
    hideFromNavigation: true,
    savedViewAvailable: false,
    subtitle: 'Ask across every dashboard tab.',
    subviews: [],
    allowEmptyScope: true,
  },
  'daily-alerts': {
    id: 'daily-alerts',
    title: 'All Alerts',
    navigationGroup: 'alerts',
    layout: 'table',
    subtitle: 'Opens on Today (IST); older retained alerts remain available through All history.',
    // No rail. This is one stream and splitting it by feed would rebuild the tabs it exists to
    // collapse — the feed filter in the toolbar does that job without costing a navigation.
    subviews: [],
  },
  'bookmarks': { id: 'bookmarks', title: 'Bookmarks', subtitle: 'Your saved research, kept together.', subviews: [], allowEmptyScope: true, scopeIndependent: true, savedViewAvailable: false },
  'earnings-hub': {
    id: 'earnings-hub',
    title: 'Earnings Hub',
    navigationTitle: 'Results',
    navigationGroup: 'earnings',
    subtitle: 'Live quarterly results across the listed universe, updated as companies report.',
    // No sub-views: this tab is one table. The shell hides the rail entirely when this is empty.
    subviews: [],
  },
  'concall': {
    id: 'concall',
    title: 'Con-call',
    navigationTitle: 'Concall',
    navigationGroup: 'earnings',
    subtitle: 'The complete Screener concall document index, enriched with current-quarter third-party analysis.',
    // No sub-views: the shell hides the rail entirely when this is empty and the table spans the
    // full width. The schedule is an overlay, not a second page.
    subviews: [],
  },
  'public-chatter': {
    id: 'public-chatter',
    title: 'Public Chatter',
    navigationGroup: 'news-section',
    subtitle: 'What retail is actually discussing, across ValuePickr, TradingQnA and Google News.',
    // Coverage and Telegram are simple tabs inside this page.
    subviews: [],
    // Telegram has no company scope, so an empty watchlist must not hide the page. Coverage keeps
    // its own scope-aware empty state.
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
    subviewNavigation: 'toolbar',
    subviews: [
      { id: 'superstar-investors', label: 'Superstar Investors' },
      { id: 'institutions', label: 'Institutions' },
    ],
  },
  'news': {
    id: 'news',
    title: 'News',
    navigationTitle: 'Market News',
    navigationGroup: 'news-section',
    subtitle:
      'Company news, updated automatically. Opens on Today (IST); choose another period up to 30 days or This month. ' +
      'Undated stories have their own filter; older news stays saved in All Alerts.',
    subviews: [],
  },
  'ipos': { id: 'ipos', title: 'IPOs', navigationGroup: 'announcements', subtitle: 'Official public-issue filings, including unlisted issuers. Newest filings first.', allowEmptyScope: true, subviews: [] },
  'corp-announcements': {
    id: 'corp-announcements',
    title: 'Corp Announcements',
    navigationTitle: 'Corporate Announcements',
    navigationGroup: 'announcements',
    subtitle: '',
    subviews: [],
  },
  'corporate-actions': {
    id: 'corporate-actions',
    title: 'Corporate Actions',
    navigationGroup: 'announcements',
    subtitle: 'One deduplicated feed of NSE actions, enriched with Screener ratios, terms, prices and additional records.',
    subviews: [],
  },
  'nse-filings': {
    id: 'nse-filings',
    title: 'NSE Filings',
    // Retain saved filing routes and source history without a separate tab button.
    hideFromNavigation: true,
    subtitle: 'Search captured NSE filing history by company or ticker, with live updates.',
    subviews: [],
  },
  'insider-trades': {
    id: 'insider-trades',
    title: 'Bulk/Block Deal',
    navigationGroup: 'announcements',
    subtitle: '',
    subviews: [],
  },
  'mutual-funds': {id:'mutual-funds',title:'Mutual Funds',subtitle:'Fund returns, category comparisons and company ownership.',layout:'table',subviewNavigation:'tabs',subviews:[
    {id:'company-holdings',label:'Company Holdings'}, {id:'all-schemes',label:'All Schemes'}, {id:'category-performance',label:'Category Performance'}
  ]}
});
