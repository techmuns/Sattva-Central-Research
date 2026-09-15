import { escapeHtml } from '../core/dom.js';

/** Empty rows for a result that is still being prepared; never a completed empty state. */
export function loadingGrid({ rows = 6, columns = 4, label = 'Loading results' } = {}) {
  const rowCount = Math.max(1, Math.min(10, Math.round(rows) || 6));
  const columnCount = Math.max(1, Math.min(8, Math.round(columns) || 4));
  return `<div class="loading-grid" role="status" aria-label="${escapeHtml(label)}">
    <div aria-hidden="true">${Array.from({ length: rowCount }, (_, row) =>
      `<div class="loading-grid-row" style="grid-template-columns:repeat(${columnCount},minmax(0,1fr))">${Array.from({ length: columnCount }, (_, column) =>
        `<div class="loading-grid-cell"><span class="loading-grid-line skeleton-shimmer" style="width:${[76, 54, 88, 64][(row + column) % 4]}%"></span>${column === 1 ? '<span class="loading-grid-line loading-grid-subline skeleton-shimmer"></span>' : ''}</div>`).join('')}</div>`).join('')}</div>
  </div>`;
}

/** Cover results without changing their geometry or replacing the reader's controls. */
export function coverTableResults(host, scroller, { columns = 4 } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'table-loading-placeholder';
  overlay.dataset.tableLoading = '';
  overlay.innerHTML = loadingGrid({ columns });
  const previousBusy = scroller.getAttribute('aria-busy');
  const previousInert = scroller.inert;
  scroller.setAttribute('aria-busy', 'true');
  scroller.inert = true;
  scroller.classList.add('table-results-loading');
  host.append(overlay);
  const align = () => {
    overlay.style.top = `${scroller.offsetTop}px`;
    overlay.style.height = `${scroller.offsetHeight}px`;
  };
  align();
  const observer = new ResizeObserver(align);
  observer.observe(host);
  return () => {
    observer.disconnect();
    overlay.remove();
    scroller.classList.remove('table-results-loading');
    scroller.inert = previousInert;
    if (previousBusy === null) scroller.removeAttribute('aria-busy');
    else scroller.setAttribute('aria-busy', previousBusy);
  };
}
