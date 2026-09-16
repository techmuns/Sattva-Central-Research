// Bounded DOM with natural row heights. Data, search and exports stay owned by the caller.
// A prefix-sum tree makes offset lookup/height correction logarithmic, even for a long archive.
import { syncListDOM } from '../core/dom.js';
export function rowGeometry(count, estimate = 72) {
  const heights = new Float64Array(count).fill(estimate);
  const tree = new Float64Array(count + 1);
  for (let i = 1; i <= count; i++) tree[i] = (i & -i) * estimate;
  const offset = (end) => {
    let sum = 0;
    for (let i = Math.min(count, Math.max(0, end)); i > 0; i -= i & -i) sum += tree[i];
    return sum;
  };
  return {
    offset,
    height: i => heights[i] || estimate,
    set(i, height) {
      if (i < 0 || i >= count || !Number.isFinite(height) || height <= 0) return false;
      const delta = height - heights[i];
      if (Math.abs(delta) < 0.25) return false;
      heights[i] = height;
      for (let n = i + 1; n <= count; n += n & -n) tree[n] += delta;
      return true;
    },
    indexAt(y) {
      if (!count) return 0;
      let index = 0, sum = 0;
      for (let bit = 2 ** Math.floor(Math.log2(count)); bit; bit = Math.floor(bit / 2)) {
        const next = index + bit;
        if (next <= count && sum + tree[next] <= y) { index = next; sum += tree[next]; }
      }
      return Math.min(count - 1, index);
    },
  };
}

export function mountWindowedList({ scroller, content, items, key, renderRows, renderParts = null, spacerHtml,
  rowSelector, estimateHeight = 72, initialKey = null, onScrollActivity = null, onWindow = null }) {
  const overscan = 8;
  const rendered = new Map(); // only mounted nodes and their last generated markup
  const measured = new Map(); // at most one small measurement per currently retained record
  let rows = items, geometry, start = -1, end = 0, frame = 0, measureFrame = 0, disposed = false;
  let width = scroller.clientWidth;
  const head = () => content === scroller ? 0 : Math.max(0,
    content.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
  const rowTop = () => Math.max(0, scroller.scrollTop - head());
  const resetGeometry = () => {
    geometry = rowGeometry(rows.length, estimateHeight);
    rows.forEach((row, i) => { const old = measured.get(String(key(row))); if (old?.row === row) geometry.set(i, old.height); });
  };
  const anchor = () => { const top = rowTop(), index = geometry.indexAt(top); return { index, inside: top - geometry.offset(index) }; };
  function spacers() {
    const top = content.querySelector('[data-window-spacer="top"]');
    const bottom = content.querySelector('[data-window-spacer="bottom"]');
    if (top) top.style.height = `${geometry.offset(start)}px`;
    if (bottom) bottom.style.height = `${geometry.offset(rows.length) - geometry.offset(end)}px`;
  }
  function measure() {
    measureFrame = 0;
    if (disposed || !rows.length) return;
    const held = anchor();
    // Read all geometry before writing spacer heights: no per-row read/write layout loop.
    const heights = [...content.querySelectorAll(rowSelector)].map(el => el.getBoundingClientRect().height);
    let changed = false;
    heights.forEach((height, n) => {
      const index = start + n, row = rows[index];
      if (!row || height <= 0) return;
      measured.set(String(key(row)), { row, height });
      changed = geometry.set(index, height) || changed;
    });
    if (changed) {
      spacers();
      if (scroller.scrollTop > 0) scroller.scrollTop = head() + geometry.offset(held.index) + held.inside;
    }
    onWindow?.(start, rows.length);
    // Measuring shorter rows can expose an unpainted part of the viewport without another
    // user scroll. Recheck coverage on the next frame after the spacer/anchor correction.
    if (changed) scheduleViewport();
  }
  const scheduleMeasure = () => { if (!measureFrame && !disposed) measureFrame = requestAnimationFrame(measure); };
  function paint(index, force = false) {
    const count = Math.max(40, Math.min(100, Math.ceil(scroller.clientHeight / 40) + overscan * 2));
    const next = Math.max(0, Math.min(Math.max(0, rows.length - count), index - overscan));
    if (!force && next === start && end === Math.min(rows.length, next + count)) return;
    start = next; end = Math.min(rows.length, start + count);
    const active = content.contains(document.activeElement) ? document.activeElement : null;
    const activeRow = active?.closest(rowSelector);
    const activeIndex = activeRow ? [...content.querySelectorAll(rowSelector)].indexOf(activeRow) : -1;
    const activeKey = activeIndex >= 0 ? activeRow.dataset.rowKey || activeRow.dataset.newsKey : null;
    const focusIndex = activeRow ? [...activeRow.querySelectorAll('a,button,input,[tabindex]')].indexOf(active) : -1;
    const topHtml = spacerHtml(geometry.offset(start), 'top');
    const bottomHtml = spacerHtml(geometry.offset(rows.length) - geometry.offset(end), 'bottom');
    const keys = rows.slice(start, end).map(row => String(key(row)));
    if (renderParts && keys.length && new Set(keys).size === keys.length) {
      const parts = renderParts(rows, start, end);
      const desired = [];
      const parse = html => {
        const box = document.createElement(content.tagName === 'TBODY' ? 'tbody' : 'div');
        box.innerHTML = html;
        return box.firstElementChild;
      };
      for (const [cacheKey, html] of [['spacer:top', topHtml], ...parts.map((html, i) => [`row:${keys[i]}`, html]), ['spacer:bottom', bottomHtml]]) {
        let held = rendered.get(cacheKey);
        if (!held || held.node.parentNode !== content) held = { node: parse(html), html };
        else if (held.html !== html) {
          const next = parse(html);
          // A real content change is applied immediately, including revoked private content.
          for (const attr of [...held.node.attributes]) if (!next.hasAttribute(attr.name)) held.node.removeAttribute(attr.name);
          for (const attr of next.attributes) held.node.setAttribute(attr.name, attr.value);
          held.node.replaceChildren(...next.childNodes);
          held.html = html;
        }
        rendered.set(cacheKey, held);
        if (cacheKey.startsWith('row:')) held.node.setAttribute('aria-rowindex', String(start + desired.length + 1));
        desired.push(held.node);
      }
      let cursor = content.firstElementChild;
      for (const node of desired) {
        if (node === cursor) cursor = cursor.nextElementSibling;
        else content.insertBefore(node, cursor);
      }
      while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
      const keep = new Set(desired);
      for (const [id, held] of rendered) if (!keep.has(held.node)) rendered.delete(id);
    } else {
      // Empty states and non-table consumers retain their existing markup contract.
      syncListDOM(content, topHtml + renderRows(rows, start, end) + bottomHtml, start + 1);
      rendered.clear();
    }
    if (active) {
      const replacement = [...content.querySelectorAll(rowSelector)].find(el => (el.dataset.rowKey || el.dataset.newsKey) === activeKey);
      (replacement?.querySelectorAll('a,button,input,[tabindex]')[focusIndex] || scroller).focus({ preventScroll: true });
    }
    onWindow?.(start, rows.length);
    scheduleMeasure();
  }
  function scheduleViewport() {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const index = geometry.indexAt(rowTop());
      const lastVisible = geometry.indexAt(rowTop() + scroller.clientHeight);
      if (index < start + overscan / 2 || lastVisible >= end - overscan / 2) paint(index);
    });
  }
  function onScroll() { onScrollActivity?.(); scheduleViewport(); }
  resetGeometry();
  scroller.style.overflowAnchor = 'none';
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const initialIndex = initialKey == null ? -1 : rows.findIndex(row => String(key(row)) === initialKey);
  if (initialIndex >= 0) scroller.scrollTop = geometry.offset(initialIndex);
  paint(initialIndex >= 0 ? initialIndex : geometry.indexAt(rowTop()), true);
  if (initialIndex >= 0) scroller.scrollTop = head() + geometry.offset(initialIndex);
  const observer = new ResizeObserver(() => {
    if (width !== scroller.clientWidth) {
      const held = anchor(); width = scroller.clientWidth;
      measured.clear(); resetGeometry();
      scroller.scrollTop = head() + geometry.offset(held.index) + held.inside;
      paint(held.index, true);
    }
    scheduleMeasure();
    scheduleViewport();
  });
  observer.observe(scroller); observer.observe(content);
  return {
    update(next, { resetScroll = false } = {}) {
      const held = !resetScroll && scroller.scrollTop > 0 ? anchor() : null;
      const heldKey = held && rows[held.index] ? String(key(rows[held.index])) : null;
      rows = next;
      const keys = new Set(rows.map(row => String(key(row))));
      for (const k of measured.keys()) if (!keys.has(k)) measured.delete(k);
      resetGeometry();
      if (resetScroll) scroller.scrollTop = 0;
      const nextIndex = heldKey == null ? -1 : rows.findIndex(row => String(key(row)) === heldKey);
      if (nextIndex >= 0) {
        // Source updates can insert rows or replace their objects without changing the record
        // being read. Preserve that record and its within-row offset across new measurements.
        const top = head() + geometry.offset(nextIndex) + held.inside;
        paint(nextIndex, true);
        scroller.scrollTop = top;
      } else paint(geometry.indexAt(rowTop()), true);
    },
    refresh() { paint(geometry.indexAt(rowTop()), true); },
    destroy() {
      disposed = true;
      observer.disconnect(); scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame); cancelAnimationFrame(measureFrame); measured.clear(); rendered.clear();
    },
  };
}
