import { escapeHtml } from '../core/dom.js';

export function filingHistoryControls(feed) {
  return {
    html(_ctx, meta) {
      const history = meta.archive || {};
      return `<div class="my-3 text-xs text-slate-600"><button data-load-filing-history class="rounded-lg bg-white px-3 py-2 font-semibold text-indigo-700 ring-1 ring-slate-200" ${history.pending ? 'disabled' : ''}>${history.pending ? 'Loading captured history…' : 'Load all captured history'}</button>
        <span role="status" class="ml-2">${escapeHtml(history.error || (history.loaded ? 'Captured archive loaded into this table.' : 'The initial table shows recent records. Older captured records remain in the shared archive.'))}</span></div>`;
    },
    wire(root) {
      const button = root.querySelector('[data-load-filing-history]');
      const load = () => void feed.loadArchive();
      button?.addEventListener('click', load);
      return () => button?.removeEventListener('click', load);
    },
  };
}
