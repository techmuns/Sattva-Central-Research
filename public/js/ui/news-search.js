import { escapeHtml } from '../core/dom.js';
import { createNewsMatcher, prepareNewsSearch } from '../data/news-search.js';

export function newsSearchControl({ q = '', searchable }) {
  return {
    html: `<div class="relative min-w-0 flex-1"><span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span><input type="text" data-table-search aria-label="Search company, ticker or headline" placeholder="Search company, ticker or headline…" value="${escapeHtml(q)}" class="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"></div>`,
    matches: createNewsMatcher(searchable),
    wire(host, { onQuery, onChange }) {
      const input = host.querySelector('[data-table-search]');
      let disposed = false, pending = null;
      const prepare = () => {
        if (input.value.trim().length < 2 || pending) return;
        pending = prepareNewsSearch().then(changed => {
          if (changed && !disposed && host.isConnected) onChange();
        }).finally(() => { pending = null; });
      };
      const changed = () => { onQuery(input.value); prepare(); };
      input.addEventListener('input', changed);
      prepare();
      return () => { disposed = true; input.removeEventListener('input', changed); };
    },
  };
}
