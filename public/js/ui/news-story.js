// One article layout for Universe, Portfolio and Watchlist. Source fields stay unchanged;
// controls sit outside the article link, and missing images keep the same reading geometry.
import { escapeHtml } from '../core/dom.js';

export const newsLinkable = url => /^https?:\/\//i.test(String(url || ''));

export function newsThumbnail(image) {
  return `<div class="news-story-thumbnail" aria-hidden="true">
    <svg class="news-story-placeholder" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h4M7 16h10M14 12h3"/></svg>
    ${newsLinkable(image) ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">` : ''}
  </div>`;
}

export function newsStoryHtml(row, { key = row.id || row.url || '', meta = '', company = '', feedback = '', bookmark = '', watch = '', body = null } = {}) {
  const canLink = newsLinkable(row.url);
  const storyBody = body ?? `${newsThumbnail(row.image || row.publisherSourceRecord?.image)}
    <div class="news-story-copy">
      <h3 class="news-story-title">${escapeHtml(row.title || '(untitled)')}</h3>
      ${row.summary ? `<p class="news-story-summary">${escapeHtml(row.summary)}</p>` : ''}
      ${company ? `<p class="news-story-company">${escapeHtml(company)}</p>` : ''}
      <div class="news-story-meta">${meta}</div>
    </div>`;
  const content = canLink
    ? `<a class="news-story-link" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${storyBody}</a>`
    : `<div class="news-story-link" data-news-unlinkable>${storyBody}</div>`;
  return `<article data-news-key="${escapeHtml(String(key))}"${canLink ? '' : ' data-news-unlinkable'} class="news-story">
    <div class="news-story-content">${content}<span class="news-story-bookmark">${watch}${bookmark}</span></div>
    ${canLink ? '' : '<span class="news-story-no-link">No link available</span>'}
    <div class="news-story-feedback">${feedback}</div>
  </article>`;
}
