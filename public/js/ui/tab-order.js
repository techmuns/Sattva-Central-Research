// Personal navigation layout only: routes, reader lifecycles and source data stay independent.
const PREFIX = 'dashboard:tab-order:v1:';
const memory = new Map();

export function restoreTabOrder(tabs, key) {
  let order = memory.get(key);
  if (!order) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      const saved = raw && raw.length < 8192 ? JSON.parse(raw) : null;
      if (Array.isArray(saved) && saved.length <= 100 && saved.every(id => typeof id === 'string'))
        order = [...new Set(saved)];
    } catch { /* Storage may be disabled or damaged; navigation must remain available. */ }
  }
  const rank = new Map((order || []).map((id, index) => [id, index]));
  return [...tabs].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

export function wireTabOrder(list, key, onReorder, shareOrder = null) {
  const defaults = [...list.querySelectorAll('[data-tab-id]')];
  // Markup records the catalog order even when a saved preference has already been applied.
  defaults.sort((a, b) => Number(a.dataset.tabDefaultIndex) - Number(b.dataset.tabDefaultIndex));
  const abort = new AbortController();
  const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: abort.signal });
  let gesture = null, frame = 0, suppressClickUntil = 0;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set();
  let landing = null;
  const status = document.createElement('div');
  status.className = 'tab-order-status';
  status.setAttribute('role', 'status');
  list.parentElement.append(status);
  const buttons = () => [...list.querySelectorAll('[data-tab-id]')];
  function save(button, intent = null) {
    const order = buttons().map(item => item.dataset.tabId);
    memory.set(key, order);
    let saved = true;
    if (shareOrder) {
      // Retain the first migrated layout through an offline reload, before its shared ack.
      try { localStorage.setItem(PREFIX + key, JSON.stringify(order)); } catch { /* The workspace outbox owns sharing and its storage disclosure. */ }
      status.textContent = 'Saving tab order for everyone…';
      Promise.resolve().then(() => shareOrder(intent)).then(result => {
        if (!status.isConnected) return;
        status.toggleAttribute('data-unavailable', !result.confirmed);
        status.textContent = result.confirmed ? 'Tab order saved for everyone.' : result.error || 'Tab order changed here and is waiting to be shared.';
      }).catch(() => { status.toggleAttribute('data-unavailable', true); status.textContent = 'Tab order could not be shared. Please retry.'; });
      button.focus({ preventScroll: true }); onReorder(); return;
    }
    try { localStorage.setItem(PREFIX + key, JSON.stringify(order)); } catch { saved = false; }
    status.toggleAttribute('data-unavailable', !saved);
    status.textContent = saved ? `${button.textContent.trim()} moved. Tab order saved for this browser.`
      : 'Tab order changed. Browser storage is unavailable; this order lasts for this visit.';
    button.focus({ preventScroll: true });
    onReorder();
  }
  function move(button, target, after) {
    if (!target || target === button) return false;
    const before = buttons();
    list.insertBefore(button, after ? target.nextElementSibling : target);
    if (!buttons().some((item, index) => item !== before[index])) return false;
    save(button, { op: 'move', tabId: button.dataset.tabId, targetId: target.dataset.tabId, after, seedOrder: before.map(item => item.dataset.tabId) });
    return true;
  }
  function mark(target, after) {
    if (gesture.target === target && gesture.after === after) return;
    gesture.target?.removeAttribute('data-tab-drop');
    gesture.target = target;
    gesture.after = after;
    if (target) target.dataset.tabDrop = after ? 'after' : 'before';
    const order = [...gesture.order];
    if (target) {
      order.splice(order.indexOf(gesture.button), 1);
      order.splice(order.indexOf(target) + Number(after), 0, gesture.button);
    }
    let left = gesture.boxes.get(gesture.order[0]).left;
    for (const item of order) {
      const box = gesture.boxes.get(item);
      if (item === gesture.button) gesture.slot.style.transform = `translateX(${left}px)`;
      else {
        item.dataset.tabShift = '';
        item.style.setProperty('--tab-reorder-x', `${left - box.left}px`);
      }
      left += box.width + gesture.gap;
    }
  }
  function animate(node, frames, duration) {
    const animation = node.animate(frames, { duration, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
    animations.add(animation);
    const done = () => { animations.delete(animation); animation.cancel(); };
    animation.finished.then(done, done);
    return animation;
  }
  function clearLanding() {
    landing?.ghost.remove();
    landing?.button.removeAttribute('data-tab-settling');
    landing = null;
    for (const animation of animations) animation.cancel();
    animations.clear();
  }
  function lift() {
    clearLanding();
    const bounds = list.getBoundingClientRect();
    gesture.order = buttons();
    gesture.boxes = new Map(gesture.order.map(item => {
      const box = item.getBoundingClientRect();
      return [item, { left: box.left - bounds.left + list.scrollLeft, width: box.width }];
    }));
    gesture.gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    const box = gesture.button.getBoundingClientRect();
    const style = getComputedStyle(gesture.button);
    const surface = gesture.button.cloneNode(true);
    surface.removeAttribute('data-tab-id');
    surface.removeAttribute('id');
    surface.removeAttribute('title');
    surface.tabIndex = -1;
    surface.classList.add('tab-drag-surface');
    // The floating copy retains the compact reading layout's exact typography and size.
    Object.assign(surface.style, { font: style.font, padding: style.padding, minHeight: '0' });
    const ghost = document.createElement('div');
    ghost.className = 'tab-drag-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    ghost.append(surface); document.body.append(ghost);
    const slot = document.createElement('div');
    slot.className = 'tab-drop-slot';
    slot.setAttribute('aria-hidden', 'true');
    Object.assign(slot.style, { top: `${box.top - bounds.top}px`, width: `${box.width}px`, height: `${box.height}px`,
      transform: `translateX(${gesture.boxes.get(gesture.button).left}px)` });
    list.append(slot);
    Object.assign(gesture, { ghost, slot, surface });
    gesture.title = gesture.button.getAttribute('title');
    gesture.button.removeAttribute('title');
    list.dataset.tabSorting = '';
    gesture.button.dataset.tabDragging = '';
    gesture.button.setPointerCapture(gesture.id);
    if (!status.hasAttribute('data-unavailable')) status.textContent = `${gesture.button.textContent.trim()} lifted. Drag left or right; Escape cancels.`;
  }
  function track() {
    frame = 0;
    if (!gesture?.active) return;
    const { x, y, button } = gesture;
    gesture.ghost.style.transform = `translate3d(${x - gesture.startX}px, ${y - gesture.startY}px, 0)`;
    const bounds = list.getBoundingClientRect();
    if (y < bounds.top - 12 || y > bounds.bottom + 12 || x < bounds.left - 12 || x > bounds.right + 12) {
      mark(null, false); return;
    }
    // Hit-test the unchanged layout, never the moving previews: crossing a label
    // halfway gives a stable destination even when neighbouring tabs differ in width.
    const contentX = x - bounds.left + list.scrollLeft;
    const hit = gesture.order.find(item => {
      const box = gesture.boxes.get(item);
      return contentX >= box.left && contentX <= box.left + box.width;
    });
    if (hit && hit !== button) {
      const box = gesture.boxes.get(hit);
      mark(hit, contentX > box.left + box.width / 2);
    } else if (hit === button) mark(null, false);
    // Reveal offscreen destinations while dragging at either edge of a narrow strip.
    const delta = x > bounds.right - 28 ? 10 : x < bounds.left + 28 ? -10 : 0;
    if (delta) {
      const before = list.scrollLeft;
      list.scrollLeft += delta;
      if (before !== list.scrollLeft) frame = requestAnimationFrame(track);
    }
  }
  function finish(commit = false, immediate = false) {
    if (!gesture) return null;
    const old = gesture;
    gesture = null;
    cancelAnimationFrame(frame); frame = 0;
    old.target?.removeAttribute('data-tab-drop');
    if (old.button.hasPointerCapture(old.id)) old.button.releasePointerCapture(old.id);
    if (!old.active) return old;
    if (old.title !== null) old.button.setAttribute('title', old.title);
    suppressClickUntil = performance.now() + 500;
    const positions = old.order.map(item => [item, item.getBoundingClientRect().left]);
    list.removeAttribute('data-tab-sorting');
    for (const item of old.order) {
      item.removeAttribute('data-tab-shift');
      item.style.removeProperty('--tab-reorder-x');
    }
    old.slot.remove();
    old.button.removeAttribute('data-tab-dragging');
    const changed = commit && move(old.button, old.target, old.after);
    if (!changed && !status.hasAttribute('data-unavailable')) status.textContent = 'Tab order unchanged.';
    if (immediate || motion.matches) { old.ghost.remove(); return old; }
    // Continue from the currently painted positions when the pointer is released
    // mid-transition, then lower the lifted tab into its committed (or original) slot.
    for (const [item, left] of positions) {
      if (item === old.button) continue;
      const delta = left - item.getBoundingClientRect().left;
      if (Math.abs(delta) > .5) animate(item, [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }], 180);
    }
    const destination = old.button.getBoundingClientRect();
    old.button.dataset.tabSettling = '';
    landing = { ghost: old.ghost, button: old.button };
    const drop = animate(old.ghost, [{ transform: old.ghost.style.transform },
      { transform: `translate3d(${destination.left - parseFloat(old.ghost.style.left)}px, ${destination.top - parseFloat(old.ghost.style.top)}px, 0)` }], 220);
    animate(old.surface, [{ transform: getComputedStyle(old.surface).transform }, { transform: 'none', boxShadow: 'none' }], 220);
    const reveal = () => {
      old.ghost.remove(); old.button.removeAttribute('data-tab-settling');
      if (landing?.ghost === old.ghost) landing = null;
    };
    drop.finished.then(reveal, reveal);
    return old;
  }
  listen(list, 'pointerdown', event => {
    suppressClickUntil = 0;
    if (event.button !== 0 || !event.isPrimary || event.altKey || event.ctrlKey || event.metaKey) return;
    const button = event.target.closest('[data-tab-id]');
    if (!button || !list.contains(button)) return;
    // The grip owns touch dragging; the rest of each tab keeps native swipe scrolling.
    if (event.pointerType !== 'mouse' && !event.target.closest('[data-tab-drag-handle]')) return;
    finish(false, true); clearLanding();
    gesture = { button, id: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, active: false, target: null };
  });
  listen(window, 'pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    if (!gesture.active) {
      const dx = Math.abs(gesture.x - gesture.startX), dy = Math.abs(gesture.y - gesture.startY);
      if (dy >= 6 && dy > dx) { finish(); return; }
      if (dx < 6) return;
      gesture.active = true;
      lift();
    }
    event.preventDefault();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(track);
  }, { passive: false });
  listen(window, 'pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    // The final pointer sample owns the drop even if its animation frame has not painted yet.
    cancelAnimationFrame(frame); track();
    finish(true);
  });
  listen(window, 'pointercancel', event => { if (gesture?.id === event.pointerId) finish(); });
  // Touch starts with implicit capture on the grip; transferring it to the tab emits a
  // lost-capture event for that grip. Only losing the tab's own capture cancels our drag.
  listen(list, 'lostpointercapture', event => {
    if (gesture?.id === event.pointerId && event.target === gesture.button) finish();
  });
  listen(window, 'blur', () => { finish(false, true); clearLanding(); });
  listen(window, 'resize', () => { finish(false, true); clearLanding(); });
  listen(document, 'visibilitychange', () => { if (document.hidden) { finish(false, true); clearLanding(); } });
  listen(list, 'click', event => {
    if (event.detail > 0 && performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true });
  listen(list, 'dragstart', event => event.preventDefault());
  listen(list, 'keydown', event => {
    if (event.key === 'Escape' && gesture) { event.preventDefault(); finish(); return; }
    const button = event.target.closest('[data-tab-id]');
    if (!button || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const order = buttons(), index = order.indexOf(button);
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    finish(false, true); clearLanding();
    if (event.key === 'Home') {
      if (order.some((item, i) => item !== defaults[i])) { defaults.forEach(item => list.append(item)); save(button, { op: 'reset' }); }
    } else move(button, order[index + (event.key === 'ArrowRight' ? 1 : -1)], event.key === 'ArrowRight');
  });
  const dispose = () => { finish(false, true); clearLanding(); abort.abort(); status.remove(); };
  // The searchable navigator uses the same move/save path as dragging and keyboard moves.
  dispose.moveById = (id, direction) => {
    finish(false, true); clearLanding();
    const order = buttons(), button = order.find(item => item.dataset.tabId === id);
    if (button) move(button, order[order.indexOf(button) + direction], direction > 0);
  };
  return dispose;
}
