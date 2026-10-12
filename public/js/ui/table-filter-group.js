import { escapeHtml } from '../core/dom.js';

let nextId = 0;

// Keep independent table predicates behind one toolbar control. The native popover lives in
// the top layer, so the table's clipped corners cannot cut off its selectors.
export function tableFilterGroup({ label, indices, summary }, renderSelect, view) {
  const id = `table-filter-group-${++nextId}`;
  const text = () => summary(view.filters) || label;
  const html = `<div data-filter-group class="table-filter-group">
    <button type="button" data-filter-group-toggle popovertarget="${id}" aria-haspopup="dialog"
      class="table-filter-group-toggle"><span data-filter-group-summary>${escapeHtml(text())}</span><span aria-hidden="true">⌄</span></button>
    <div id="${id}" data-filter-group-panel popover="auto" role="dialog" aria-label="${escapeHtml(label)}" class="table-filter-group-panel">
      <div class="table-filter-group-heading"><strong>${escapeHtml(label)}</strong><button type="button" data-filter-group-clear aria-label="Clear ${escapeHtml(label.toLowerCase())}">Clear</button></div>
      ${indices.map(i => `<label class="table-filter-group-field"><span>${escapeHtml(renderSelect.label(i))}</span>${renderSelect(i)}</label>`).join('')}
      <button type="button" class="table-filter-group-done" popovertarget="${id}" popovertargetaction="hide">Done</button>
    </div>
  </div>`;

  function wire(host, onClear) {
    const group = host.querySelector('[data-filter-group]');
    const button = group.querySelector('[data-filter-group-toggle]');
    const panel = group.querySelector('[data-filter-group-panel]');
    const sync = () => {
      const value = text();
      button.querySelector('[data-filter-group-summary]').textContent = value;
      button.setAttribute('aria-label', value === label ? label : `${label}: ${value}`);
      button.title = button.getAttribute('aria-label');
      button.dataset.active = String(indices.some(i => view.filters[i] !== 'all'));
    };
    // Position against the current viewport on every open. Close when that viewport moves,
    // rather than leaving a floating panel detached from its toolbar in an embedded dashboard.
    const close = () => { if (panel.matches(':popover-open')) panel.hidePopover(); };
    let anchorBox = null;
    const closeOnScroll = event => {
      if (panel.contains(event.target) || !anchorBox) return;
      const box = button.getBoundingClientRect();
      // Filtering resets the table's own scroll position without moving this toolbar.
      if (Math.abs(box.top - anchorBox.top) > 1 || Math.abs(box.left - anchorBox.left) > 1) close();
    };
    const beforeToggle = event => {
      const opening = event.newState === 'open';
      if (opening) {
        const box = button.getBoundingClientRect();
        anchorBox = box;
        const width = Math.min(300, innerWidth - 24);
        panel.style.width = `${width}px`;
        panel.style.left = `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`;
        panel.style.top = `${Math.max(12, Math.min(box.bottom + 6, innerHeight - 280))}px`;
        window.addEventListener('resize', close);
        document.addEventListener('scroll', closeOnScroll, true);
      } else {
        window.removeEventListener('resize', close);
        document.removeEventListener('scroll', closeOnScroll, true);
      }
    };
    panel.addEventListener('beforetoggle', beforeToggle);
    group.querySelector('[data-filter-group-clear]').addEventListener('click', () => onClear(indices));
    sync();
    return { sync, dispose() {
      close();
      panel.removeEventListener('beforetoggle', beforeToggle);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', closeOnScroll, true);
    } };
  }
  return { html, wire };
}
