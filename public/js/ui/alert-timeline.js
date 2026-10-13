// One bounded scrolling window per visible AI card; archive preparation never owns the page.
import { mountWindowedList } from './windowed-list.js';
import { reconcileMarkup } from './reconcile-markup.js';
import { prepareTimeline, incompleteHistory } from '../data/alert-timeline.js';

export function mountAlertTimeline({ root, renderEvent, readHistory }) {
  const scroller = root.querySelector('[data-ai-timeline]');
  const content = root.querySelector('[data-ai-timeline-content]');
  const frame = root.querySelector('[data-ai-timeline-frame]');
  const scrollCue = root.querySelector('[data-ai-timeline-scroll-cue]');
  let card, day, filters, history = null, rows = [], generation = 0, disposed = false;
  let preparing = false, loading = false, attempted = false, historyWanted = false, failed = false;
  let inputCard = null, inputDay = null, inputFilters = null, newestId = null, unseen = false;
  function controls() {
    const latest = root.querySelector('[data-ai-timeline-latest]');
    const older = root.querySelector('[data-ai-timeline-older]');
    const status = root.querySelector('[data-ai-timeline-status]');
    const away = scroller.scrollTop > 8;
    if (!away) unseen = false;
    latest.hidden = !away;
    latest.textContent = unseen ? 'New alerts ↑' : 'Latest ↑';
    older.hidden = !!history && !incompleteHistory(history) && !failed;
    older.disabled = loading || preparing;
    older.textContent = loading ? 'Loading older alerts…' : failed || history && incompleteHistory(history) ? 'Retry older alerts' : 'Load older alerts';
    const message = loading ? 'Reading saved history…' : preparing && !rows.length ? 'Loading alerts…'
      : failed || history && incompleteHistory(history) ? 'Some older sources are unavailable. Available alerts are retained.'
        : history ? 'Available saved history' : '';
    if (status.textContent !== message) status.textContent = message;
    status.hidden = !message;
    scroller.setAttribute('aria-busy', String(preparing || loading));
    const canScrollDown = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 2;
    frame?.toggleAttribute('data-can-scroll-up', scroller.scrollTop > 2);
    frame?.toggleAttribute('data-can-scroll-down', canScrollDown);
    if (scrollCue) scrollCue.hidden = !canScrollDown;
  }
  function onScroll() {
    controls();
    // Only a reader's movement toward the end triggers archive IO. Short lists keep the button.
    if (!attempted && !preparing && rows.length && scroller.scrollTop > 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120) void older();
  }
  const view = mountWindowedList({
    scroller, content, items: rows, key: row => row.id, rowSelector: '[data-ai-timeline-row]',
    estimateHeight: 76, minRows: 12, maxRows: 20, overscan: 3,
    spacerHtml: (height, edge) => `<li data-window-spacer="${edge}" aria-hidden="true" role="presentation" style="height:${height}px"></li>`,
    renderRows: () => '',
    renderParts: (items, start, end) => items.slice(start, end).map(row => renderEvent(row.event, day, row.dev)),
    patchRow: (node, next) => reconcileMarkup(node, next.innerHTML),
    onScrollActivity: onScroll,
    onWindow: controls,
  });
  async function prepare() {
    const token = ++generation;
    preparing = true; controls();
    try {
      const next = await prepareTimeline(card, { history, day, filters, isCurrent: () => !disposed && token === generation });
      if (!next || disposed || token !== generation) return;
      if (newestId && next[0]?.id !== newestId && !rows.some(row => row.id === next[0]?.id) && scroller.scrollTop > 8) unseen = true;
      newestId = next[0]?.id;
      rows = next;
      view.update(rows);
    } catch { if (!disposed && token === generation) failed = true; }
    finally { if (!disposed && token === generation) { preparing = false; controls(); } }
  }
  async function older() {
    if (disposed || loading || preparing || history && !incompleteHistory(history) && !failed) return;
    const retry = !!history || failed;
    historyWanted = attempted = true; loading = true; failed = false; controls();
    try {
      const result = await readHistory({ refresh: retry });
      if (disposed || !result) return;
      history = result;
      await prepare();
    } catch { if (!disposed) failed = true; }
    finally { if (!disposed) { loading = false; controls(); } }
  }
  root.querySelector('[data-ai-timeline-older]').onclick = () => { void older(); };
  root.querySelector('[data-ai-timeline-latest]').onclick = () => { scroller.scrollTop = 0; unseen = false; view.refresh(); controls(); };
  return {
    update(nextCard, nextDay, nextFilters) {
      card = nextCard; day = nextDay; filters = nextFilters;
      const filterKey = JSON.stringify(filters);
      if (card !== inputCard || day !== inputDay || filterKey !== inputFilters) {
        inputCard = card; inputDay = day; inputFilters = filterKey;
        void prepare();
      } else controls();
    },
    historyChanged(next) { if (historyWanted && !loading && next && next !== history) { history = next; failed = false; void prepare(); } },
    historyFailed() { if (historyWanted && !disposed) { failed = true; controls(); } },
    event(id) { return rows.find(row => row.id === id)?.event; },
    destroy() { disposed = true; generation++; view.destroy(); content.replaceChildren(); },
  };
}
