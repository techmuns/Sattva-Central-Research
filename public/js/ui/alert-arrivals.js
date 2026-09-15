const HIGHLIGHT_MS = 20_000;
const STEP_MS = 110;
const clock = (at) => new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

// Accessible receipts live with the table; no separate status banner takes reading space.
export const arrivalsHtml = `<span class="sr-only" data-arrivals-announcement role="status" aria-live="polite" aria-atomic="true"></span>`;

export function createArrivalsUI(tracker, redraw = () => {}) {
  let root = null, observer = null, timer = null, stepTimer = null, motion = null;
  let recent = [], announced = new Set(), announcementIds = [];
  const handled = new Set(), entering = new Map();
  let pending = [];
  const text = (value) => {
    const node = root?.querySelector('[data-arrivals-announcement]');
    if (node && node.textContent !== value) node.textContent = value;
  };
  function clearQueue() { clearTimeout(stepTimer); stepTimer = null; pending = []; }
  function releaseNext() {
    stepTimer = null;
    const id = pending.shift();
    if (id) entering.set(id, Date.now());
    scheduleNext();
    redraw();
  }
  function scheduleNext() {
    if (pending.length && !stepTimer) stepTimer = setTimeout(releaseNext, STEP_MS);
  }
  function finishMotion() {
    if (!document.hidden && !motion?.matches) return;
    clearQueue(); entering.clear(); redraw(); decorate();
  }
  // Only the rendered presentation is paced. Search, counts, sorting and export retain the
  // complete filtered model. Rows beyond the first screen never wait in an animation backlog.
  function presentRows(next, { resetScroll = false } = {}) {
    const now = Date.now();
    const receipts = next.filter(row => tracker.time(row.id));
    const ids = new Set(receipts.map(row => row.id));
    pending = pending.filter(id => ids.has(id));
    const fresh = receipts.filter(row => !handled.has(row.id) && now - tracker.time(row.id) < HIGHLIGHT_MS);
    receipts.forEach(row => handled.add(row.id));
    if (!root || resetScroll || document.hidden || motion?.matches) {
      clearQueue();
      return next;
    }
    const firstScreen = new Set(next.slice(0, 12).map(row => row.id));
    // Older members enter first, so each newer row pushes the previous one down and the final
    // table keeps its chosen source-date order. Never re-date a delayed source record.
    pending.push(...fresh.filter(row => firstScreen.has(row.id)).reverse().map(row => row.id));
    pending = pending.slice(-12);
    if (pending.length && !stepTimer) {
      entering.set(pending.shift(), now);
      scheduleNext();
    }
    if (!pending.length) return next;
    const waiting = new Set(pending);
    return next.filter(row => !waiting.has(row.id));
  }
  // Decorate mounted rows only: scrolling back never restarts a receipt or its entrance.
  function decorate() {
    if (!root?.querySelector('[data-arrivals-announcement]')) return;
    for (const row of root.querySelectorAll('tr[data-row-key]')) {
      const at = tracker.time(row.dataset.rowKey), age = Date.now() - at;
      const fresh = at > 0 && age < HIGHLIGHT_MS;
      row.classList.toggle('alert-just-arrived', fresh);
      const entrance = entering.get(row.dataset.rowKey);
      const entranceAge = entrance ? Date.now() - entrance : 1000;
      row.classList.toggle('alert-stream-enter', entranceAge < 220 && !motion?.matches);
      if (entranceAge < 220) row.style.setProperty('--stream-age', `-${Math.max(0, entranceAge)}ms`);
      if (fresh) {
        if (!row.querySelector('[data-arrival-badge]')) {
          row.style.setProperty('--arrival-age', `-${Math.max(0, age)}ms`);
          const badge = document.createElement('span');
          badge.dataset.arrivalBadge = '';
          badge.className = 'alert-arrival-badge';
          badge.textContent = 'NEW';
          badge.title = `Received in this view at ${clock(at)} IST. The date above is the source date.`;
          row.querySelector('[data-event-day]')?.append(badge);
        }
      } else {
        row.querySelector('[data-arrival-badge]')?.remove();
        row.style.removeProperty('--arrival-age');
      }
    }
    for (const [id, at] of entering) if (Date.now() - at >= 220) entering.delete(id);
  }
  function paint() {
    if (!root?.querySelector('[data-arrivals-announcement]')) return;
    const currentIds = new Set(recent.map(row => row.id));
    if (announcementIds.some(id => !currentIds.has(id) || !tracker.time(id))) {
      text(''); announcementIds = [];
    }
    const fresh = recent.filter(row => !announced.has(row.id) && Date.now() - tracker.time(row.id) < HIGHLIGHT_MS);
    if (fresh.length && !document.hidden) {
      text(`${fresh.length} newly received alert${fresh.length === 1 ? '' : 's'} in Till Today. ${fresh[0].company || ''}: ${fresh[0].headline}`);
      fresh.forEach(row => announced.add(row.id));
      announcementIds = fresh.map(row => row.id);
    }
    decorate();
  }
  function detach() {
    observer?.disconnect(); observer = null;
    clearInterval(timer); timer = null;
    clearQueue(); entering.clear();
    motion?.removeEventListener('change', finishMotion); motion = null;
    document.removeEventListener('visibilitychange', finishMotion);
    root = null;
  }
  return {
    presentRows,
    setRows(next) { recent = next.filter(row => tracker.time(row.id)); paint(); },
    reset() { clearQueue(); entering.clear(); handled.clear(); recent = []; announced.clear(); text(''); announcementIds = []; },
    attach(nextRoot) {
      detach(); root = nextRoot;
      if (!root.querySelector('[data-arrivals-announcement]')) return;
      motion = matchMedia('(prefers-reduced-motion: reduce)');
      motion.addEventListener('change', finishMotion);
      document.addEventListener('visibilitychange', finishMotion);
      observer = new MutationObserver(changes => {
        if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === 1 && (node.matches('tr[data-row-key], td') || node.querySelector('tr[data-row-key]'))))) decorate();
      });
      observer.observe(root.querySelector('[data-table-body]'), { childList: true, subtree: true });
      timer = setInterval(paint, 1000);
      paint();
    },
    detach,
  };
}
