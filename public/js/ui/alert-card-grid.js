import { mountWindowedList } from './windowed-list.js';
import { reconcileMarkup } from './reconcile-markup.js';
import { escapeHtml } from '../core/dom.js';

// All eligible companies remain in the model; at most six grid rows own DOM/timelines at once.
export function mountAlertCardGrid({ element, renderCard, onWindow }) {
  const media = matchMedia('(min-width: 1024px)');
  const cardKey = card => String(card.key || card.ticker || card.entityId);
  let cards = [], groups = [], models = new Map(), nodes = new Map(), disposed = false;
  const view = mountWindowedList({
    scroller: document.documentElement, content: element, items: [], pageScroll: true,
    key: group => group.key, rowSelector: '[data-ai-grid-row]',
    estimateHeight: 720, minRows: 4, maxRows: 6, overscan: 1,
    spacerHtml: (height, edge) => `<div data-window-spacer="${edge}" aria-hidden="true" style="height:${height}px"></div>`,
    renderRows: () => '',
    renderParts: (rows, start, end) => rows.slice(start, end).map(group =>
      `<div data-ai-grid-row data-row-key="${escapeHtml(group.key)}" class="grid gap-4 pb-4 lg:grid-cols-2">${group.cards.map(renderCard).join('')}</div>`),
    patchRow: (node, next) => reconcileMarkup(node, next.innerHTML),
    onWindow: () => {
      // Reuse card nodes even if an arrival or a responsive resize changes their grid partner.
      // Timeline scroll positions, expanded evidence and focused controls survive source paints.
      const mounted = [], nextNodes = new Map();
      for (const fresh of element.querySelectorAll('[data-ai-card]')) {
        const key = fresh.dataset.aiKey, held = nodes.get(key);
        let node = fresh;
        if (held && held !== fresh) {
          for (const attr of [...held.attributes]) if (!fresh.hasAttribute(attr.name)) held.removeAttribute(attr.name);
          for (const attr of fresh.attributes) held.setAttribute(attr.name, attr.value);
          reconcileMarkup(held, fresh.innerHTML);
          fresh.replaceWith(held); node = held;
        }
        const model = models.get(key);
        if (!model) continue;
        nextNodes.set(key, node); mounted.push(model.card);
        node.setAttribute('aria-posinset', String(model.index + 1));
        node.setAttribute('aria-setsize', String(cards.length));
      }
      nodes = nextNodes;
      element.dataset.aiTotal = String(cards.length);
      onWindow(mounted);
    },
  });
  function update(next, options = {}) {
    if (disposed) return;
    const focused = element.contains(document.activeElement) ? document.activeElement : null;
    const reading = !options.resetScroll && scrollY > 0 ? [...element.querySelectorAll('[data-ai-card]')]
      .find(node => node.getBoundingClientRect().bottom > 0) : null;
    const readingKey = reading?.dataset.aiKey, readingTop = reading?.getBoundingClientRect().top;
    cards = next;
    models = new Map(cards.map((card, index) => [cardKey(card), { card, index }]));
    const previous = new Map(groups.map(group => [group.key, group]));
    const columns = media.matches ? 2 : 1;
    groups = [];
    for (let index = 0; index < cards.length; index += columns) {
      const members = cards.slice(index, index + columns), key = JSON.stringify(members.map(cardKey));
      const old = previous.get(key);
      groups.push(old && old.cards.every((card, i) => card === members[i]) ? old : { key, cards: members });
    }
    const index = readingKey == null ? null : models.get(readingKey)?.index;
    view.update(groups, index == null ? options : { ...options,
      anchorKey: groups[Math.floor(index / columns)].key, anchorOffset: -readingTop });
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
  const resize = () => update(cards);
  media.addEventListener('change', resize);
  return {
    element,
    update,
    destroy() { disposed = true; media.removeEventListener('change', resize); view.destroy(); nodes.clear(); models.clear(); },
  };
}
