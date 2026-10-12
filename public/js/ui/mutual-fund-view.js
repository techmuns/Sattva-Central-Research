import { TAB_META } from '../tabs/catalog.js';
import { escapeHtml } from '../core/dom.js';
import { navigate } from '../core/router.js';

/** The same saved subviews, in a compact control owned by the table toolbar. */
export function mutualFundView(ctx) {
  const active = ctx.subview || 'company-holdings';
  return {
    html: `<select data-mf-view class="mf-table-control" aria-label="Mutual fund view">${TAB_META['mutual-funds'].subviews.map(view =>
      `<option value="${view.id}"${view.id === active ? ' selected' : ''}>${escapeHtml(view.label)}</option>`).join('')}</select>`,
    wire(root) {
      const select = root.querySelector('[data-mf-view]');
      if (!select) return () => {};
      const changed = () => navigate({ workspace: ctx.workspace || 'research', tab: 'mutual-funds',
        subview: select.value, scope: ctx.scope });
      select.addEventListener('change', changed);
      return () => select.removeEventListener('change', changed);
    },
  };
}
