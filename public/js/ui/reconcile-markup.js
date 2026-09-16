// Patch trusted, locally generated markup without replacing unchanged controls or keyed rows.
// Source text must already be escaped by the caller, exactly as for innerHTML.
function identity(node) {
  if (node.nodeType !== 1) return null;
  for (const name of ['data-ai-key', 'data-ai-notebook-event', 'data-bookmark-key', 'data-ai-filter']) {
    if (node.hasAttribute(name)) return `${name}:${node.getAttribute(name)}`;
  }
  const marker = [...node.attributes].find(attribute => attribute.name.startsWith('data-ai-'));
  return marker ? marker.name : null;
}

function compatible(left, right) {
  return left.nodeType === right.nodeType && left.nodeName === right.nodeName && identity(left) === identity(right);
}

function patch(node, next) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  const keep = name => (name === 'open' && node.tagName === 'DETAILS') ||
    (node.hasAttribute('data-bookmark-key') && node.getAttribute('aria-busy') === 'true' && ['aria-busy', 'disabled'].includes(name));
  for (const { name } of [...node.attributes]) if (!next.hasAttribute(name) && !keep(name)) node.removeAttribute(name);
  for (const { name, value } of next.attributes) if (node.getAttribute(name) !== value && !keep(name)) node.setAttribute(name, value);
  children(node, next);
}

function children(parent, next) {
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    let node = cursor;
    while (node && !compatible(node, desired)) node = node.nextSibling;
    if (!node) { parent.insertBefore(desired, cursor); continue; }
    if (node !== cursor) parent.insertBefore(node, cursor);
    patch(node, desired);
    cursor = node.nextSibling;
  }
  while (cursor) { const old = cursor; cursor = cursor.nextSibling; old.remove(); }
}

export function reconcileMarkup(parent, markup) {
  if (parent._markup === markup) return;
  const template = document.createElement('template');
  template.innerHTML = markup;
  const focused = parent.contains(document.activeElement) ? document.activeElement : null;
  children(parent, template.content);
  // Moving an existing keyed element can blur its descendant on older browsers.
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  parent._markup = markup;
}
