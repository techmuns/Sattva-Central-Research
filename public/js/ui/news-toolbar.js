import { fitTableViewport } from './table-viewport.js';

// Keep existing bound controls: search/date/actions first, the remaining filters beneath them.
export function arrangeNewsToolbar(host) {
  const toolbar = host.querySelector('[data-news-toolbar], [data-table-toolbar]');
  if (!toolbar || toolbar.dataset.newsArranged) return;
  const input = toolbar.querySelector('[data-news-search], [data-table-search]');
  const search = input?.parentElement;
  const period = toolbar.querySelector('[data-news-period], select[aria-label="News period"]');
  const actions = toolbar.querySelector('[data-news-actions], [data-table-actions]');
  if (!search || !period || !actions) return;
  const remaining = [...search.parentElement.children].filter(node => node !== search && node !== period);
  const primary = document.createElement('div'), filters = document.createElement('div');
  toolbar.classList.add('news-toolbar'); toolbar.dataset.newsArranged = 'true';
  primary.className = 'news-toolbar-primary'; filters.className = 'news-toolbar-filters';
  search.classList.add('news-toolbar-search'); actions.classList.add('news-toolbar-actions');
  primary.append(search, period, actions); filters.append(...remaining);
  toolbar.replaceChildren(primary, filters);
  // Company tables share the measured viewport; the market list owns its own lifecycle.
  if (host.querySelector('.news-card-table')) return fitTableViewport(host, { bottomGap: 8 });
}
