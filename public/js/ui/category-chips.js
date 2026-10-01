// ui/category-chips.js — the category tags, drawn the same way on Corporate Announcements, News and
// All Alerts. A tag is a TOPIC, never a verdict (announcement-categories.js rule 1), so the chips use
// one neutral brand tint and no semantic colour; a weak tag (read from a generic word) is muted.
import { escapeHtml } from '../core/dom.js';
import { categoryById, OTHER_CATEGORY } from '../data/announcement-categories.js';

const chip = (id, weak) => {
  const category = categoryById(id);
  if (!category) return '';
  const title = `${category.label}${category.hint ? ` — ${category.hint}` : ''}${weak ? ' (read from a generic word in the subject)' : ''}`;
  return `<span class="category-chip${weak ? ' is-weak' : ''}${category.routine ? ' is-routine' : ''}" data-category="${escapeHtml(id)}" title="${escapeHtml(title)}">${escapeHtml(category.label)}</span>`;
};

/**
 * Up to `max` chips and a "+N" naming the rest in its tooltip. `other` is only drawn when it is the
 * only tag, so an unclassified item still says so instead of drawing nothing.
 */
export function categoryChips(ids = [], { weak = [], max = 3, empty = '' } = {}) {
  const list = ids.filter((id) => id !== OTHER_CATEGORY || ids.length === 1);
  if (!list.length) return empty;
  const shown = list.slice(0, max);
  const rest = list.slice(max);
  const more = rest.length
    ? `<span class="category-chip-more" title="${escapeHtml(`Also: ${rest.map((id) => categoryById(id)?.label || id).join(', ')}`)}">+${rest.length}</span>`
    : '';
  return `<span class="category-chips">${shown.map((id) => chip(id, weak.includes(id))).join('')}${more}</span>`;
}
