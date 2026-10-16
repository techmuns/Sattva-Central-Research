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
  rowSelector, estimateHeight = 72, initialKey = null, onScrollActivity = null, onWindow = null,
  minRows = 40, maxRows = 100, overscan = 8, patchRow = null, viewportInset = () => 0, pageScroll = false }) {
  // Page-sized card grids share the measured window without adding a nested scroll container.
  const scrollTarget = pageScroll ? window : scroller;
  const scrollTop = () => pageScroll ? window.scrollY : scroller.scrollTop;
  const viewportHeight = () => pageScroll ? innerHeight : scroller.clientHeight;
  const viewportBox = () => pageScroll ? { top: 0, left: 0 } : scroller.getBoundingClientRect();
  const setScrollTop = top => {
    if (pageScroll) window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    else scroller.scrollTop = top;
  };
  const previousOverflowAnchor = scroller.style.overflowAnchor;
  const rendered = new Map(); // only mounted nodes and their last generated markup
  const measured = new Map(); // at most one small measurement per currently retained record
  let rows = items, geometry, start = -1, end = 0, frame = 0, measureFrame = 0, disposed = false;
  let width = scroller.clientWidth;
  let draggingScrollbar = false;
  let settleScrollbar = false;
  let pendingRows = null;
  let followingEnd = false;
  const head = () => content === scroller ? 0 : Math.max(0,
    content.getBoundingClientRect().top - viewportBox().top + scrollTop());
  const rowTop = () => Math.max(0, scrollTop() - head());
  const atTableEnd = () => !pageScroll && scrollTop() > 0 &&
    scroller.scrollHeight - scroller.clientHeight - scrollTop() < 2;
  const resetGeometry = () => {
    geometry = rowGeometry(rows.length, estimateHeight);
    rows.forEach((row, i) => { const old = measured.get(String(key(row))); if (old?.row === row) geometry.set(i, old.height); });
  };
  // Preserve the first readable row. A sticky header can hide the geometric top row;
  // holding that hidden row lets arrivals below it push the visible record down.
  const anchor = () => {
    const position = scrollTop() - head() + viewportInset();
    // A page can still be above the grid. Retain that leading space so measuring row zero
    // does not scroll the toolbar out of view when the reader returns to the page top.
    const top = pageScroll ? position : Math.max(0, position), index = geometry.indexAt(Math.max(0, top));
    return { index, inside: top - geometry.offset(index) };
  };
  function spacers() {
    const top = content.querySelector('[data-window-spacer="top"]');
    const bottom = content.querySelector('[data-window-spacer="bottom"]');
    if (top) top.style.height = `${geometry.offset(start)}px`;
    if (bottom) bottom.style.height = `${geometry.offset(rows.length) - geometry.offset(end)}px`;
  }
  function restore(held) {
    const target = head() + geometry.offset(held.index) + held.inside - viewportInset();
    if (Math.abs(target - scrollTop()) >= 0.5) setScrollTop(target);
  }
  function measureBoxes(boxes) {
    let changed = false;
    boxes.forEach(({ height }, n) => {
      const index = start + n, row = rows[index];
      if (!row || height <= 0) return;
      measured.set(String(key(row)), { row, height });
      changed = geometry.set(index, height) || changed;
    });
    if (changed) spacers();
    return changed;
  }
  // Adopt natural heights before another task can read an estimated anchor.
  // During a thumb drag, retain the frozen scroll range until release.
  function settle(index, { force = false, held = null, keepEnd = followingEnd } = {}) {
    if (!paint(index, force)) return;
    if (!draggingScrollbar) {
      const changed = measureBoxes([...content.querySelectorAll(rowSelector)].map(el => el.getBoundingClientRect()));
      // End/large wheel jumps reveal unmeasured rows. Their natural heights can enlarge
      // the range; preserve the requested bottom rather than restoring an estimated top row.
      if (keepEnd) setScrollTop(scroller.scrollHeight - scroller.clientHeight);
      else if (held) restore(held);
      if (changed) scheduleViewport();
    }
  }
  function measure() {
    measureFrame = 0;
    // Native thumb dragging maps pointer movement to the scroll range at grab time. Changing
    // that range and writing scrollTop on each newly measured window makes the thumb lag behind
    // the pointer. Keep painting records during the gesture; settle their heights on release.
    if (disposed || !rows.length || draggingScrollbar) return;
    const keepEnd = !settleScrollbar && (followingEnd || atTableEnd());
    let held = anchor();
    // Read all geometry before writing spacer heights: no per-row read/write layout loop.
    const boxes = [...content.querySelectorAll(rowSelector)].map(el => el.getBoundingClientRect());
    if (settleScrollbar) {
      // The drag displayed natural heights against frozen estimates. Keep the row actually
      // under the reader's eyes when adopting those heights, rather than the estimated row.
      const top = viewportBox().top + viewportInset();
      const visible = boxes.findIndex(box => box.bottom > top);
      if (visible >= 0) held = { index: start + visible, inside: top - boxes[visible].top };
      settleScrollbar = false;
    }
    const changed = measureBoxes(boxes);
    if (changed && keepEnd) setScrollTop(scroller.scrollHeight - scroller.clientHeight);
    else if (changed && scrollTop() > 0) restore(held);
    if (followingEnd && !changed && end === rows.length && atTableEnd()) followingEnd = false;
    onWindow?.(start, pendingRows?.length ?? rows.length);
    // Measuring shorter rows can expose an unpainted part of the viewport without another
    // user scroll. Recheck coverage on the next frame after the spacer/anchor correction.
    if (changed) scheduleViewport();
    if (pendingRows) {
      const next = pendingRows;
      pendingRows = null;
      update(next);
    }
  }
  const scheduleMeasure = () => { if (!measureFrame && !disposed) measureFrame = requestAnimationFrame(measure); };
  function onPointerDown(event) {
    followingEnd = false;
    if (event.button !== 0 || event.target !== scroller || scroller.scrollHeight <= scroller.clientHeight) return;
    const box = viewportBox();
    const left = box.left + scroller.clientLeft;
    const right = left + scroller.clientWidth;
    const top = box.top + scroller.clientTop;
    if (event.clientY < top || event.clientY >= top + scroller.clientHeight) return;
    const style = getComputedStyle(scroller);
    const gutter = scroller.offsetWidth - scroller.clientWidth
      - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0);
    // Native overlay thumbs hit the scroller itself but sit inside its client box. Ordinary
    // row/control presses still target their own elements and were excluded above.
    const overlayEdge = gutter < 1 && (style.direction === 'rtl'
      ? event.clientX <= left + 16 : event.clientX >= right - 16);
    if (event.clientX < left || event.clientX >= right || overlayEdge) draggingScrollbar = true;
  }
  function endScrollbarDrag() {
    if (!draggingScrollbar) return;
    draggingScrollbar = false;
    settleScrollbar = true;
    scheduleMeasure();
  }
  function paint(index, force = false) {
    const visibleHeight = Math.max(0, viewportHeight() - (pageScroll ? Math.max(0, head() - scrollTop()) : 0));
    const lastVisible = geometry.indexAt(rowTop() + visibleHeight);
    const needed = pageScroll ? lastVisible - index + 1 + Math.min(overscan, index)
      + Math.min(overscan, Math.max(0, rows.length - lastVisible - 1))
      : Math.ceil(viewportHeight() / 40) + overscan * 2;
    const count = Math.max(minRows, Math.min(maxRows, needed));
    const next = Math.max(0, Math.min(Math.max(0, rows.length - count), index - overscan));
    if (!force && next === start && end === Math.min(rows.length, next + count)) return false;
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
          if (patchRow) patchRow(held.node, next);
          else held.node.replaceChildren(...next.childNodes);
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
    onWindow?.(start, pendingRows?.length ?? rows.length);
    scheduleMeasure();
    return true;
  }
  function scheduleViewport() {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const index = geometry.indexAt(rowTop());
      const lastVisible = geometry.indexAt(rowTop() + viewportHeight());
      if (index < start + overscan / 2 || lastVisible >= end - overscan / 2) settle(index, {
        held: draggingScrollbar ? null : anchor(), keepEnd: !draggingScrollbar && (followingEnd || atTableEnd()),
      });
    });
  }
  function onScroll() { onScrollActivity?.(); scheduleViewport(); }
  function onWheel(event) {
    if (pageScroll) return;
    followingEnd = event.deltaY > 0 && (atTableEnd() || (event.deltaMode === 0 &&
      event.deltaY >= scroller.scrollHeight - scroller.clientHeight - scrollTop() - 2));
  }
  function onKeyDown(event) {
    followingEnd = false;
    if (pageScroll || event.shiftKey || event.altKey || event.target.closest?.('input,textarea,[contenteditable]')) return;
    if (event.key !== 'End' && !(event.metaKey && event.key === 'ArrowDown')) return;
    // Native smooth End animations target the old estimated range. Own this explicit table
    // navigation so later measurements can complete the same request on every platform.
    followingEnd = true;
    event.preventDefault();
    setScrollTop(scroller.scrollHeight - scroller.clientHeight);
    scheduleViewport();
  }
  const stopFollowingEnd = () => { followingEnd = false; };
  function update(next, { resetScroll = false, anchorKey = null, anchorOffset = 0 } = {}) {
    followingEnd = false; // Source arrivals retain the reader's record, rather than following new data.
    if (draggingScrollbar && !resetScroll) {
      const nextByKey = new Map(next.map(row => [String(key(row)), row]));
      if (rows.every(row => nextByKey.has(String(key(row))))) {
        // The caller has already adopted the complete source model for counts/search/export.
        // Delay only additions/reordering in this rendered view. Patch existing identities now
        // so corrections (including changes to private content) are never held until release.
        pendingRows = next;
        rows = rows.map(row => nextByKey.get(String(key(row))));
        paint(geometry.indexAt(rowTop()), true);
        return;
      }
    }
    // Explicit filters and removals take precedence over the gesture: revoked records must
    // disappear immediately, and an older queued presentation must never restore them.
    pendingRows = null;
    draggingScrollbar = false;
    const held = anchorKey != null ? { index: 0, inside: anchorOffset }
      : !resetScroll && scrollTop() > 0 ? anchor() : null;
    const heldKey = anchorKey != null ? String(anchorKey) : held && rows[held.index] ? String(key(rows[held.index])) : null;
    rows = next;
    const keys = new Set(rows.map(row => String(key(row))));
    for (const k of measured.keys()) if (!keys.has(k)) measured.delete(k);
    resetGeometry();
    if (resetScroll) setScrollTop(0);
    const nextIndex = heldKey == null ? -1 : rows.findIndex(row => String(key(row)) === heldKey);
    if (nextIndex >= 0) {
      // Source updates can insert rows or replace their objects without changing the record
      // being read. Preserve that record and its within-row offset across new measurements.
      settle(nextIndex, { force: true, held: { index: nextIndex, inside: held.inside } });
    } else settle(geometry.indexAt(rowTop()), { force: true });
  }
  resetGeometry();
  scroller.style.overflowAnchor = 'none';
  scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('pointerdown', onPointerDown, { passive: true });
  scroller.addEventListener('wheel', onWheel, { passive: true });
  scroller.addEventListener('keydown', onKeyDown);
  scroller.addEventListener('touchstart', stopFollowingEnd, { passive: true });
  document.addEventListener('pointerup', endScrollbarDrag, true);
  document.addEventListener('pointercancel', endScrollbarDrag, true);
  window.addEventListener('blur', endScrollbarDrag);
  const initialIndex = initialKey == null ? -1 : rows.findIndex(row => String(key(row)) === initialKey);
  if (initialIndex >= 0) setScrollTop(geometry.offset(initialIndex));
  settle(initialIndex >= 0 ? initialIndex : geometry.indexAt(rowTop()), { force: true });
  if (initialIndex >= 0) setScrollTop(head() + geometry.offset(initialIndex));
  const observer = new ResizeObserver(() => {
    if (width !== scroller.clientWidth) {
      const held = anchor(); width = scroller.clientWidth;
      measured.clear(); resetGeometry();
      settle(held.index, { force: true, held });
    }
    scheduleMeasure();
    scheduleViewport();
  });
  observer.observe(scroller); observer.observe(content);
  return {
    update,
    refresh() { settle(geometry.indexAt(rowTop()), { force: true, held: scrollTop() > 0 ? anchor() : null }); },
    destroy() {
      disposed = true;
      pendingRows = null;
      if (pageScroll) scroller.style.overflowAnchor = previousOverflowAnchor;
      observer.disconnect(); scrollTarget.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('pointerdown', onPointerDown);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('keydown', onKeyDown);
      scroller.removeEventListener('touchstart', stopFollowingEnd);
      document.removeEventListener('pointerup', endScrollbarDrag, true);
      document.removeEventListener('pointercancel', endScrollbarDrag, true);
      window.removeEventListener('blur', endScrollbarDrag);
      cancelAnimationFrame(frame); cancelAnimationFrame(measureFrame); measured.clear(); rendered.clear();
    },
  };
}
