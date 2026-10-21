import { TAB_META } from './catalog.js';
import { lazyTab } from '../core/lazy-tab.js';

// Literal imports keep every tab discoverable by the service worker's atomic
// offline warm-up, without executing every renderer before the first screen.
export const bookmarks = lazyTab(TAB_META.bookmarks, () => import('./bookmarks.js'));
export const researchTabs = [
  lazyTab(TAB_META['ai-alerts'], () => import('./ai-alerts.js')),
  lazyTab(TAB_META['ai-recommendations'], () => import('./ai-recommendations.js')),
  lazyTab(TAB_META['daily-alerts'], () => import('./daily-alerts.js')),
  lazyTab(TAB_META['corp-announcements'], () => import('./corp-announcements.js')),
  lazyTab(TAB_META['corporate-actions'], () => import('./corporate-actions.js')),
  lazyTab(TAB_META.ipos, () => import('./ipos.js')),
  lazyTab(TAB_META['earnings-hub'], () => import('./earnings-hub.js')),
  lazyTab(TAB_META.breakouts, () => import('./breakouts.js')),
  lazyTab(TAB_META['insider-trades'], () => import('./insider-trades.js')),
  lazyTab(TAB_META['mutual-funds'], () => import('./mutual-funds.js')),
  lazyTab(TAB_META.concall, () => import('./concall.js')),
  lazyTab(TAB_META.news, () => import('./news.js')),
  lazyTab(TAB_META['private-market-news'], () => import('./private-market-news.js')),
  lazyTab(TAB_META['public-chatter'], () => import('./public-chatter.js')),
  lazyTab(TAB_META['super-investors'], () => import('./super-investors.js')),
  bookmarks,
  lazyTab(TAB_META['ask-research'], () => import('./ask-research.js')),
  lazyTab(TAB_META['nse-filings'], () => import('./nse-filings.js')),
];
