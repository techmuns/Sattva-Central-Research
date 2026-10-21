// One article layout for Universe, Portfolio and Watchlist. Source fields stay unchanged;
// controls sit outside the article link, and missing images keep the same reading geometry.
import { escapeHtml } from '../core/dom.js';

const expandedStories = new Set();
let listening = false;

function rememberDetails() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  // Toggle notifications are queued; resize-driven rendering can run before them.
  // Commit a summary activation before its native default action changes the DOM.
  document.addEventListener('click', event => {
    const summary = event.target.closest?.('[data-news-details] > summary');
    if (!summary || event.defaultPrevented) return;
    const details = summary.parentElement;
    const key = details.closest('[data-news-key]').dataset.newsKey;
    if (details.open) expandedStories.delete(key); else expandedStories.add(key);
  });
  document.addEventListener('toggle', event => {
    const details = event.target;
    if (!details.matches?.('[data-news-details]') || !details.isConnected) return;
    // Ignore the parser's initial notification when an open row is recreated.
    if (details.dataset.newsDetailsOpen === String(details.open)) return;
    details.dataset.newsDetailsOpen = String(details.open);
    const key = details.closest('[data-news-key]').dataset.newsKey;
    if (details.open) expandedStories.add(key); else expandedStories.delete(key);
  }, true);
}

export const newsLinkable = url => /^https?:\/\//i.test(String(url || ''));

export function newsThumbnail(image) {
  return `<div class="news-story-thumbnail" aria-hidden="true">
    <svg class="news-story-placeholder" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h4M7 16h10M14 12h3"/></svg>
    ${newsLinkable(image) ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">` : ''}
  </div>`;
}

export function newsStoryHtml(row, { key = row.id || row.url || '', meta = '', company = '', tags = '', feedback = '', bookmark = '', watch = '', body = null } = {}) {
  rememberDetails();
  const canLink = newsLinkable(row.url);
  const storyBody = body ?? `<div class="news-story-copy">
      <h3 class="news-story-title" title="${escapeHtml(row.title || '(untitled)')}">${escapeHtml(row.title || '(untitled)')}</h3>
      <div class="news-story-meta">${company ? `<span class="news-story-company" title="${escapeHtml(company)}">${escapeHtml(company)}</span><span aria-hidden="true">·</span>` : ''}${meta}${canLink ? '' : '<span class="news-story-no-link">No link available</span>'}</div>
    </div>`;
  const content = canLink
    ? `<a class="news-story-link" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${storyBody}</a>`
    : `<div class="news-story-link" data-news-unlinkable>${storyBody}</div>`;
  return `<article data-news-key="${escapeHtml(String(key))}"${canLink ? '' : ' data-news-unlinkable'} class="news-story">
    <div class="news-story-content">${content}<span class="news-story-bookmark">${watch}${bookmark}</span></div>
    <details class="news-story-details" data-news-details data-norow data-news-details-open="${expandedStories.has(String(key))}"${expandedStories.has(String(key)) ? ' open' : ''}>
      <summary tabindex="0" aria-label="Story details" title="Story details"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
      <div class="news-story-expanded">
        ${newsThumbnail(row.image || row.publisherSourceRecord?.image)}
        <div class="news-story-detail-copy">
          ${row.summary ? `<p class="news-story-summary">${escapeHtml(row.summary)}</p>` : ''}
          ${tags ? `<div class="news-row-extras">${tags}</div>` : ''}
          <div class="news-story-feedback">${feedback}</div>
        </div>
      </div>
    </details>
  </article>`;
}
