// Device-local table layouts. No dependencies, polling, data reads, or per-cell listeners.
// Only mounted cells move, once on drop. A single child-list observer restores new/replaced
// rows before paint; it is disconnected during our writes, so it cannot observe itself.
const PREFIX = 'dashboard:column-layout:v1:';
const installations = new WeakMap();
const memory = new Map();
const labelOf = cell => (cell.dataset.columnKey || cell.dataset.colKey || cell.dataset.sort ||
  cell.textContent.replace(/[▴▾▲▼↕]/g, '').trim()).replace(/\s+/g, ' ') || 'Column';

function readLayout(key) {
  if (memory.has(key)) return memory.get(key);
  let value = {};
  try {
    const raw = localStorage.getItem(PREFIX + key);
    const parsed = raw && raw.length < 32768 ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [group, order] of Object.entries(parsed)) {
        if (Array.isArray(order) && order.length <= 200 && order.every(id => typeof id === 'string'))
          Object.defineProperty(value, group, { value: [...new Set(order)], enumerable: true, writable: true, configurable: true });
      }
    }
  } catch { /* Disabled/corrupt storage must never prevent reading a table. */ }
  memory.set(key, value);
  return value;
}

export function installColumnOrder(root = document) {
  if (installations.has(root)) return installations.get(root);
  const tables = new WeakMap(), rowCells = new WeakMap();
  let gesture = null, suppressClick = null, frame = 0;
  const abort = new AbortController();
  const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: abort.signal });
  const observe = () => observer.observe(root, { childList: true, subtree: true });
  const quiet = fn => {
    // Deliver pending application changes before temporarily disconnecting for our own writes.
    const pending = observer.takeRecords();
    if (pending.length) changed(pending);
    observer.disconnect();
    try { return fn(); } finally { observe(); }
  };
  function originals(row) {
    const cells = [...row.cells], old = rowCells.get(row);
    if (old && old.length === cells.length && old.every(cell => cell.parentElement === row)) return old;
    rowCells.set(row, cells);
    return cells;
  }
  function moveCells(row, desired) {
    let cursor = row.firstElementChild;
    for (const cell of desired) {
      if (cell === cursor) cursor = cursor.nextElementSibling;
      else row.insertBefore(cell, cursor);
    }
  }
  function plan(state) {
    const order = [];
    const walk = node => {
      const saved = state.saved[node.key] || [];
      const rank = new Map(saved.map((key, index) => [key, index]));
      node.ordered = [...node.children].sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity));
      for (const child of node.ordered) {
        if (child.children.length) walk(child);
        else for (let i = child.start; i < child.end; i++) order.push(i);
      }
    };
    walk(state.tree);
    state.order = order;
    state.positions = new Map(order.map((index, position) => [index, position]));
    state.custom = order.some((index, position) => index !== position);
    state.table.toggleAttribute('data-column-custom', state.custom);
  }
  function bodyRow(state, row) {
    const cells = originals(row);
    // Empty states, loading rows and virtual spacers span the complete table.
    if (cells.length !== state.order.length || cells.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) return;
    if (state.custom || cells.some((cell, index) => cell !== row.cells[index]))
      moveCells(row, state.order.map(index => cells[index]));
  }
  function apply(state) {
    plan(state);
    for (const row of state.table.tHead.rows) {
      const nodes = state.nodes.filter(node => node.cell.parentElement === row);
      moveCells(row, nodes.sort((a, b) => state.positions.get(a.start) - state.positions.get(b.start)).map(node => node.cell));
    }
    for (const section of [...state.table.tBodies, ...(state.table.tFoot ? [state.table.tFoot] : [])])
      for (const row of section.rows) bodyRow(state, row);
  }
  function setup(table) {
    let head = table.tHead;
    if (!head && table.rows.length) {
      // Source-document tables have no header semantics. Add neutral controls, never promote
      // a source data row into a heading or remove it from the retained document.
      const count = [...table.rows[0].cells].reduce((n, cell) => n + cell.colSpan, 0);
      if (count < 2) return null;
      head = table.createTHead();
      const row = head.insertRow();
      for (let i = 0; i < count; i++) {
        const cell = document.createElement('th'); cell.textContent = `Column ${i + 1}`; row.append(cell);
      }
    }
    if (!head?.rows.length) return null;
    let state = tables.get(table);
    if (state && state.nodes.every(node => head.contains(node.cell)) &&
      state.nodes.length === [...head.rows].reduce((n, row) => n + row.cells.length, 0)) return state;
    if (gesture?.state === state) finish();
    const tree = { key: '$', children: [] }, nodes = [], occupied = [];
    for (const [r, row] of [...head.rows].entries()) {
      let col = 0;
      for (const cell of originals(row)) {
        while (occupied[r]?.[col]) col++;
        const end = col + cell.colSpan;
        const parent = [...nodes].reverse().find(node => node.row < r && node.start <= col && node.end >= end) || tree;
        const label = labelOf(cell);
        const duplicate = parent.children.filter(node => node.label === label).length;
        const node = { cell, label, row: r, start: col, end, children: [], parent,
          key: `${parent.key}/${encodeURIComponent(label)}:${duplicate}` };
        nodes.push(node); parent.children.push(node);
        for (let y = r; y < r + cell.rowSpan; y++) {
          occupied[y] ||= [];
          for (let x = col; x < end; x++) occupied[y][x] = true;
        }
        col = end;
      }
    }
    if (nodes.length < 2) return null;
    const route = location.hash.split('?')[0];
    const identity = table.dataset.columnLayout || nodes.map(node => node.key).sort().join('|');
    const key = `${route}|${identity}`;
    state = { table, nodes, tree, key, saved: readLayout(key) };
    tables.set(table, state);
    for (const node of nodes) {
      const cell = node.cell;
      cell.dataset.columnReorder = '';
      if (!cell.hasAttribute('tabindex')) cell.tabIndex = 0;
      if (!cell.hasAttribute('scope')) cell.scope = cell.colSpan > 1 ? 'colgroup' : 'col';
      const tip = 'Drag to move column. Alt + Left/Right also moves it; Alt + Home resets this table.';
      if (!cell.title.includes(tip)) cell.title = [cell.title, tip].filter(Boolean).join('\n');
      cell.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+Home');
    }
    apply(state);
    return state;
  }
  function changed(records) {
    const fresh = new Set(), rows = new Set();
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const table = target?.closest('table');
      if (table) {
        if (target.closest('thead') || target === table) fresh.add(table);
        else if (target.tagName === 'TR') rows.add(target);
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'TABLE') fresh.add(node);
        else if (node.tagName === 'TR') rows.add(node);
        else if (node.tagName === 'TD' || node.tagName === 'TH') rows.add(node.parentElement);
        else {
          node.querySelectorAll('table').forEach(item => fresh.add(item));
          if (node.tagName === 'TBODY' || node.tagName === 'TFOOT')
            [...node.rows].forEach(row => rows.add(row));
        }
      }
    }
    observer.disconnect();
    try {
      for (const table of fresh) if (table.isConnected) setup(table);
      for (const row of rows) {
        if (!row?.isConnected || row.closest('thead')) continue;
        const table = row.closest('table');
        if (!table) continue;
        const state = tables.get(table) || setup(table);
        if (state) bodyRow(state, row);
      }
      if (gesture && !gesture.cell.isConnected) finish();
    } finally { observe(); }
  }
  const observer = new MutationObserver(changed);
  quiet(() => root.querySelectorAll('table').forEach(setup));
  function targetNode(cell) {
    const state = tables.get(cell?.closest('table'));
    return state && { state, node: state.nodes.find(node => node.cell === cell) };
  }
  function save(state) {
    memory.set(state.key, state.saved);
    let persisted = true;
    try { localStorage.setItem(PREFIX + state.key, JSON.stringify(state.saved)); } catch { persisted = false; }
    announce(persisted ? 'Column order saved for this browser.' : 'Column order changed. Browser storage is unavailable; this layout lasts for this visit.', !persisted);
  }
  let status;
  function announce(text, unavailable = false) {
    if (!status) {
      status = document.createElement('div'); status.className = 'column-layout-status';
      status.setAttribute('role', 'status'); document.body.append(status);
    }
    status.toggleAttribute('data-unavailable', unavailable);
    status.textContent = text;
  }
  function commit(state, node, target, after) {
    if (!target || node === target || node.parent !== target.parent || !node.cell.isConnected) return;
    const siblings = node.parent.ordered.filter(item => item !== node);
    siblings.splice(siblings.indexOf(target) + (after ? 1 : 0), 0, node);
    const keys = siblings.map(item => item.key), present = new Set(keys), remaining = [...keys];
    // Keep temporarily absent columns in the preference, so a scope/schema round trip retains them.
    state.saved[node.parent.key] = (state.saved[node.parent.key] || []).map(key => present.has(key) ? remaining.shift() : key).concat(remaining);
    quiet(() => apply(state)); save(state);
    node.cell.focus({ preventScroll: true });
  }
  function mark(target, after) {
    gesture.target?.cell.removeAttribute('data-column-drop');
    gesture.target = target; gesture.after = after;
    if (target) target.cell.dataset.columnDrop = after ? 'after' : 'before';
  }
  function track() {
    frame = 0;
    if (!gesture?.active) return;
    const { state, node, x, y } = gesture;
    if (!gesture.cell.isConnected) { finish(); return; }
    // Hit-test only the header; moving the pointer never walks or rebuilds data rows.
    const hit = document.elementFromPoint(x, y)?.closest('[data-column-reorder]');
    const target = state.nodes.find(item => item.cell === hit && item.parent === node.parent && item !== node);
    if (target) { const box = hit.getBoundingClientRect(); mark(target, x > box.left + box.width / 2); }
    else mark(null, false);
    // Auto-scroll wide tables only while the pointer is held near their visible edge.
    let scroller = state.table.parentElement;
    while (scroller && scroller.scrollWidth <= scroller.clientWidth) scroller = scroller.parentElement;
    if (scroller && scroller !== document.body && scroller !== document.documentElement) {
      const box = scroller.getBoundingClientRect();
      const delta = y >= box.top && y <= box.bottom ? x > box.right - 28 ? 12 : x < box.left + 28 ? -12 : 0 : 0;
      if (delta) {
        const before = scroller.scrollLeft; scroller.scrollLeft += delta;
        if (before !== scroller.scrollLeft) frame = requestAnimationFrame(track);
      }
    }
  }
  function finish() {
    if (!gesture) return;
    if (frame) cancelAnimationFrame(frame); frame = 0;
    const old = gesture; gesture = null;
    old.target?.cell.removeAttribute('data-column-drop');
    old.cell.removeAttribute('data-column-dragging');
    if (old.cell.hasPointerCapture?.(old.id)) old.cell.releasePointerCapture(old.id);
    if (old.active) suppressClick = { until: performance.now() + 500, table: old.state.table };
    return old;
  }
  listen(root, 'pointerdown', event => {
    suppressClick = null; // A new deliberate click must never be swallowed after a drag.
    if (event.button !== 0 || !event.isPrimary || event.target.closest('a,button:not([data-column-drag-handle]),input,select,textarea')) return;
    const cell = event.target.closest('[data-column-reorder]');
    const match = targetNode(cell);
    if (!match?.node) return;
    finish();
    gesture = { ...match, cell, id: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, active: false };
  }, { capture: true });
  listen(root, 'pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    if (!gesture.active) {
      if (Math.abs(gesture.x - gesture.startX) < 6 || Math.abs(gesture.x - gesture.startX) < Math.abs(gesture.y - gesture.startY)) return;
      gesture.active = true; gesture.cell.setPointerCapture(event.pointerId);
      gesture.cell.dataset.columnDragging = '';
    }
    event.preventDefault();
    if (!frame) frame = requestAnimationFrame(track);
  }, { capture: true, passive: false });
  listen(root, 'pointerup', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (gesture.active) { if (frame) cancelAnimationFrame(frame); track(); }
    const old = finish();
    if (old?.active) { event.preventDefault(); commit(old.state, old.node, old.target, old.after); }
  }, { capture: true });
  listen(root, 'pointercancel', finish, { capture: true });
  listen(window, 'blur', finish);
  listen(document, 'visibilitychange', () => { if (document.hidden) finish(); });
  listen(root, 'dragstart', event => { if (gesture) event.preventDefault(); }, { capture: true });
  listen(root, 'click', event => {
    if (suppressClick && performance.now() < suppressClick.until && suppressClick.table.contains(event.target)) {
      event.preventDefault(); event.stopImmediatePropagation(); suppressClick = null;
    }
  }, { capture: true });
  listen(root, 'keydown', event => {
    if (event.key === 'Escape' && gesture) { event.preventDefault(); finish(); return; }
    if (!event.altKey || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    const match = targetNode(event.target.closest('[data-column-reorder]'));
    if (!match?.node) return;
    event.preventDefault(); event.stopPropagation();
    const { state, node } = match;
    if (event.key === 'Home') {
      state.saved = {}; quiet(() => apply(state)); save(state); node.cell.focus({ preventScroll: true }); return;
    }
    const siblings = node.parent.ordered, index = siblings.indexOf(node);
    const after = event.key === 'ArrowRight';
    commit(state, node, siblings[index + (after ? 1 : -1)], after);
  }, { capture: true });
  const dispose = () => { finish(); observer.disconnect(); abort.abort(); status?.remove(); installations.delete(root); };
  installations.set(root, dispose);
  return dispose;
}
