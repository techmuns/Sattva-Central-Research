// A bounded visual copy of the mounted, visible column. Source cells and data stay in place
// until the existing column-order controller commits the drop.
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const intersects = (box, clip) => box.bottom > clip.top && box.top < clip.bottom && box.right > clip.left && box.left < clip.right;

export function columnViewport(table) {
  const box = table.getBoundingClientRect();
  const clip = { top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom), left: Math.max(0, box.left), right: Math.min(innerWidth, box.right) };
  for (let parent = table.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right);
    }
  }
  return clip;
}

export function columnPositions(table) {
  const clip = columnViewport(table), positions = new Map();
  for (const row of table.rows) {
    const box = row.getBoundingClientRect();
    if (!intersects(box, clip)) continue;
    for (const cell of row.cells) {
      const bounds = cell.getBoundingClientRect();
      if (intersects(bounds, clip)) positions.set(cell, bounds);
    }
  }
  return positions;
}

export function animateColumnPositions(before) {
  if (reducedMotion()) return;
  for (const [cell, old] of before) {
    if (!cell.isConnected || cell.hasAttribute('data-column-lifted')) continue;
    const next = cell.getBoundingClientRect(), dx = old.left - next.left;
    if (Math.abs(dx) < 1) continue;
    cell.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

export function liftColumn(state, node, startX, startY) {
  const clip = columnViewport(state.table), header = node.cell.getBoundingClientRect();
  const top = Math.max(clip.top, header.top), height = Math.max(0, clip.bottom - top);
  const positions = columnPositions(state.table);
  const chosen = new Set(state.nodes.filter(item => item.start >= node.start && item.end <= node.end).map(item => item.cell));
  const selectedIndexes = new Set(state.order.map((original, index) => original >= node.start && original < node.end ? index : -1).filter(index => index >= 0));
  for (const cell of positions.keys()) {
    const row = cell.parentElement;
    if (row.closest('thead') || row.cells.length !== state.order.length || cell.colSpan !== 1 || cell.rowSpan !== 1) continue;
    if (selectedIndexes.has(cell.cellIndex)) chosen.add(cell);
  }
  const lifted = [], ghost = document.createElement('div'), surface = document.createElement('div');
  ghost.className = 'column-lift'; ghost.dataset.columnLift = '';
  ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
  Object.assign(ghost.style, { left: `${header.left}px`, top: `${top}px`, width: `${header.width}px`, height: `${height}px` });
  surface.className = 'column-lift-surface'; ghost.append(surface);
  for (const cell of chosen) {
    const bounds = positions.get(cell);
    if (!bounds) continue;
    const copy = cell.cloneNode(true), style = getComputedStyle(cell);
    for (const element of [copy, ...copy.querySelectorAll('*')]) {
      element.removeAttribute('id');
      // A visual copy must never look like a second application control to delegated handlers,
      // refresh code or selectors. Its styling comes from classes and the measured cell style.
      for (const attribute of [...element.attributes]) if (attribute.name.startsWith('data-')) element.removeAttribute(attribute.name);
    }
    copy.classList.add('column-lift-cell');
    const background = style.backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(cell.parentElement).backgroundColor : style.backgroundColor;
    Object.assign(copy.style, {
      position: 'absolute', display: 'block', boxSizing: 'border-box', margin: '0',
      left: `${bounds.left - header.left}px`, top: `${bounds.top - top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
      padding: style.padding, font: style.font, color: style.color, textAlign: style.textAlign,
      whiteSpace: style.whiteSpace, backgroundColor: background === 'rgba(0, 0, 0, 0)' ? 'rgb(var(--surface-white, 255 255 255))' : background,
      borderBottom: '1px solid rgb(var(--edge-slate-100, 241 245 249))', overflow: 'hidden',
    });
    surface.append(copy); lifted.push(cell); cell.dataset.columnLifted = '';
  }
  const marker = document.createElement('div');
  marker.className = 'column-insertion-line'; marker.dataset.columnInsertion = '';
  marker.setAttribute('aria-hidden', 'true'); marker.hidden = true;
  Object.assign(marker.style, { top: `${top}px`, height: `${height}px` });
  document.body.append(ghost, marker);
  if (!reducedMotion()) surface.animate([{ opacity: .4, transform: 'scale(1)' }, { opacity: 1, transform: 'scale(1.015)' }], { duration: 130, easing: 'ease-out' });
  let transform = '';
  const restore = () => { lifted.forEach(cell => cell.removeAttribute('data-column-lifted')); marker.remove(); };
  const cancel = () => { restore(); ghost.remove(); };
  return {
    move(x, y) {
      transform = `translate3d(${x - startX}px, ${Math.max(-20, Math.min(20, y - startY)) - 8}px, 0)`;
      ghost.style.transform = transform;
    },
    mark(target, after) {
      marker.hidden = !target;
      if (target) { const bounds = target.cell.getBoundingClientRect(); marker.style.left = `${(after ? bounds.right : bounds.left) - 1}px`; }
    },
    cancel,
    settle() {
      restore();
      if (!node.cell.isConnected || reducedMotion()) { ghost.remove(); return; }
      const bounds = node.cell.getBoundingClientRect();
      const animation = ghost.animate([{ transform }, { transform: `translate3d(${bounds.left - header.left}px, 0, 0)` }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
      void animation.finished.catch(() => {}).then(() => ghost.remove());
    },
  };
}
