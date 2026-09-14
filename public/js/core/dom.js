// core/dom.js — tiny DOM helpers used everywhere instead of jQuery-style bloat.

// Query a single element within `root` (defaults to the whole document).
export function $(selector, root = document) {
  return root.querySelector(selector);
}

// Query all matching elements within `root`, returned as a real array.
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

// Escape user/data-sourced text before interpolating it into innerHTML strings.
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Build a real DOM element without a template engine: el('div', {class:'x'}, [child, 'text'])
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// Remove every child of a node without a full innerHTML re-parse.
export function empty(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// Synchronize a list container with new HTML while preserving existing nodes that share a row key.
export function syncListDOM(container, newHtml, startOffset = -1) {
  const existing = new Map();
  for (const row of container.querySelectorAll('[data-row-key], [data-news-key]')) {
    existing.set(row.dataset.rowKey || row.dataset.newsKey, row);
  }
  // Spacer selectors must target the TR, not the TD inside it
  const topSpacer = container.querySelector('tr[data-window-spacer="top"], [data-window-spacer="top"]')?.closest('tr') || container.querySelector('[data-window-spacer="top"]');
  const bottomSpacer = container.querySelector('tr[data-window-spacer="bottom"], [data-window-spacer="bottom"]')?.closest('tr') || container.querySelector('[data-window-spacer="bottom"]');
  
  const tmp = document.createElement(container.tagName === 'TBODY' ? 'tbody' : 'div');
  tmp.innerHTML = newHtml;
  
  const newNodes = [];
  const newTopSpacer = tmp.querySelector('tr[data-window-spacer="top"], [data-window-spacer="top"]')?.closest('tr') || tmp.querySelector('[data-window-spacer="top"]');
  const newBottomSpacer = tmp.querySelector('tr[data-window-spacer="bottom"], [data-window-spacer="bottom"]')?.closest('tr') || tmp.querySelector('[data-window-spacer="bottom"]');
  
  if (topSpacer && newTopSpacer) {
    const td = topSpacer.querySelector('td');
    const newTd = newTopSpacer.querySelector('td');
    if (td && newTd) td.style.height = newTd.style.height;
    else topSpacer.style.height = newTopSpacer.style.height;
  }
  // Only push spacer if it exists in the new HTML, or if it existed before. Actually windowed-list sends new ones.
  // Wait, `newHtml` contains the spacers. So if `newTopSpacer` exists, we use `topSpacer` if it exists, else `newTopSpacer`.
  if (newTopSpacer) {
      newNodes.push(topSpacer || newTopSpacer);
  } else if (topSpacer) {
      newNodes.push(topSpacer); // keep existing if not in newHtml? Or rely on newHtml? newHtml has them.
  }
  
  let offset = startOffset;
  for (const newRow of Array.from(tmp.children)) {
    // skip spacers from being processed as data rows
    if (newRow === newTopSpacer || newRow === newBottomSpacer) continue;
    if (newRow.dataset.windowSpacer || newRow.querySelector('[data-window-spacer]')) continue;
    
    const rowKey = newRow.dataset.rowKey || newRow.dataset.newsKey;
    if (rowKey && existing.has(rowKey)) {
      const oldRow = existing.get(rowKey);
      
      const oldRev = oldRow.dataset.revision;
      const newRev = newRow.dataset.revision;
      if (oldRev !== newRev || oldRow.innerHTML !== newRow.innerHTML) {
          oldRow.innerHTML = newRow.innerHTML;
          oldRow.className = newRow.className;
          oldRow.style.cssText = newRow.style.cssText;
          if (newRev !== undefined) oldRow.dataset.revision = newRev;
      }
      
      if (offset >= 0) oldRow.setAttribute('aria-rowindex', String(offset + 1));
      newNodes.push(oldRow);
      existing.delete(rowKey);
    } else {
      if (offset >= 0) newRow.setAttribute('aria-rowindex', String(offset + 1));
      newNodes.push(newRow);
    }
    if (!newRow.dataset.windowSpacer && !newRow.querySelector('[data-window-spacer]')) offset++;
  }
  
  if (bottomSpacer && newBottomSpacer) {
    const td = bottomSpacer.querySelector('td');
    const newTd = newBottomSpacer.querySelector('td');
    if (td && newTd) td.style.height = newTd.style.height;
    else bottomSpacer.style.height = newBottomSpacer.style.height;
  }
  if (newBottomSpacer) {
      newNodes.push(bottomSpacer || newBottomSpacer);
  } else if (bottomSpacer) {
      newNodes.push(bottomSpacer);
  }
  
  let current = container.firstElementChild;
  for (const node of newNodes) {
    if (current === node) {
      current = current.nextElementSibling;
    } else {
      container.insertBefore(node, current);
    }
  }
  while (current) {
    const next = current.nextElementSibling;
    container.removeChild(current);
    current = next;
  }
}
