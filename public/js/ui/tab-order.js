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
    if (!target || target === button) return;
    const before = buttons();
    list.insertBefore(button, after ? target.nextElementSibling : target);
    if (buttons().some((item, index) => item !== before[index])) save(button, { op: 'move', tabId: button.dataset.tabId, targetId: target.dataset.tabId, after, seedOrder: before.map(item => item.dataset.tabId) });
  }
  function mark(target, after) {
    gesture.target?.removeAttribute('data-tab-drop');
    gesture.target = target;
    gesture.after = after;
    if (target) target.dataset.tabDrop = after ? 'after' : 'before';
  }
  function track() {
    frame = 0;
    if (!gesture?.active) return;
    const { x, y, button } = gesture;
    const bounds = list.getBoundingClientRect();
    if (y < bounds.top - 12 || y > bounds.bottom + 12 || x < bounds.left - 12 || x > bounds.right + 12) {
      mark(null, false); return;
    }
    const hit = buttons().find(item => {
      const box = item.getBoundingClientRect();
      return x >= box.left && x <= box.right;
    });
    if (hit && hit !== button) {
      const box = hit.getBoundingClientRect();
      mark(hit, x > box.left + box.width / 2);
    } else mark(null, false);
    // Reveal offscreen destinations while dragging at either edge of a narrow strip.
    const delta = x > bounds.right - 28 ? 10 : x < bounds.left + 28 ? -10 : 0;
    if (delta) {
      const before = list.scrollLeft;
      list.scrollLeft += delta;
      if (before !== list.scrollLeft) frame = requestAnimationFrame(track);
    }
  }
  function finish() {
    if (!gesture) return null;
    const old = gesture;
    gesture = null;
    cancelAnimationFrame(frame); frame = 0;
    old.button.removeAttribute('data-tab-dragging');
    old.target?.removeAttribute('data-tab-drop');
    if (old.button.hasPointerCapture(old.id)) old.button.releasePointerCapture(old.id);
    if (old.active) suppressClickUntil = performance.now() + 500;
    return old;
  }
  listen(list, 'pointerdown', event => {
    suppressClickUntil = 0;
    if (event.button !== 0 || !event.isPrimary || event.altKey || event.ctrlKey || event.metaKey) return;
    const button = event.target.closest('[data-tab-id]');
    if (!button || !list.contains(button)) return;
    // The grip owns touch dragging; the rest of each tab keeps native swipe scrolling.
    if (event.pointerType !== 'mouse' && !event.target.closest('[data-tab-drag-handle]')) return;
    finish();
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
      gesture.button.setPointerCapture(gesture.id);
      gesture.button.dataset.tabDragging = '';
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
    const old = finish();
    if (old?.active) move(old.button, old.target, old.after);
  });
  listen(window, 'pointercancel', event => { if (gesture?.id === event.pointerId) finish(); });
  // Touch starts with implicit capture on the grip; transferring it to the tab emits a
  // lost-capture event for that grip. Only losing the tab's own capture cancels our drag.
  listen(list, 'lostpointercapture', event => {
    if (gesture?.id === event.pointerId && event.target === gesture.button) finish();
  });
  listen(window, 'blur', finish);
  listen(document, 'visibilitychange', () => { if (document.hidden) finish(); });
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
    finish();
    if (event.key === 'Home') {
      if (order.some((item, i) => item !== defaults[i])) { defaults.forEach(item => list.append(item)); save(button, { op: 'reset' }); }
    } else move(button, order[index + (event.key === 'ArrowRight' ? 1 : -1)], event.key === 'ArrowRight');
  });
  const dispose = () => { finish(); abort.abort(); status.remove(); };
  // The searchable navigator uses the same move/save path as dragging and keyboard moves.
  dispose.moveById = (id, direction) => {
    finish();
    const order = buttons(), button = order.find(item => item.dataset.tabId === id);
    if (button) move(button, order[order.indexOf(button) + direction], direction > 0);
  };
  return dispose;
}
