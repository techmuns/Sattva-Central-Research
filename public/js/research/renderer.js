// research/renderer.js — a small safe renderer for model prose.
// Model text never reaches innerHTML. The supported markdown subset is deliberately restrained:
// headings, paragraphs, callouts, bullets, numbering, bold, emphasis, code and valid pipe tables.

import { el, empty } from '../core/dom.js';

// A CITATION IS A LINK INTO THE DASHBOARD. The model cites `[Dashboard: Page name]`; `cite(name)`
// (supplied by the tab, which knows the source registry and the companies the answer is about)
// returns `{ href, title, label }` for a page it recognises, and the citation renders as an anchor
// into that tab — deep-linked to the company where the tab can seed its search. An unrecognised
// name stays as the model wrote it: a link that went nowhere would be worse than none.
const CITATION = /^\[Dashboard:\s*([^\]\n]+?)\s*\]$/;

function appendInline(parent, text, cite = null) {
  const source = String(text || '');
  const pattern = /(\[Dashboard:\s*[^\]\n]+\]|\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    const citation = token.match(CITATION);
    const target = citation ? cite?.(citation[1]) || null : null;
    let citationParent = parent;
    if (match.index > cursor) {
      const between = source.slice(cursor, match.index);
      const tail = target?.number ? between.match(/([^\s]{1,32})[ \t]+$/) : null;
      if (tail && (tail.index === 0 || /\s/.test(between[tail.index - 1]))) {
        parent.appendChild(document.createTextNode(between.slice(0, tail.index)));
        citationParent = el('span', { class: 'research-citation-anchor' }, `${tail[1]}\u00a0`);
        parent.appendChild(citationParent);
      } else parent.appendChild(document.createTextNode(between));
    }
    if (citation) {
      if (target?.href) {
        citationParent.appendChild(el('a', {
          class: `research-cite${target.number ? ' research-cite-number' : ''}`,
          href: target.href, title: target.title || `Open ${citation[1]}`,
          target: /^https?:\/\//.test(target.href) ? '_blank' : null,
          rel: /^https?:\/\//.test(target.href) ? 'noopener noreferrer' : null,
          'aria-label': target.number ? `Source ${target.number}: ${target.label || citation[1]}` : null,
        }, target.number ? String(target.number) : target.label || citation[1]));
      } else {
        parent.appendChild(el('span', { class: 'research-cite research-cite-unresolved' }, citation[1]));
      }
    } else if (token.startsWith('**')) {
      const strong = el('strong', { class: 'font-bold text-slate-900' });
      appendInline(strong, token.slice(2, -2), cite);
      parent.appendChild(strong);
    } else if (token.startsWith('`')) {
      parent.appendChild(el('code', { class: 'rounded bg-slate-100 px-1 py-0.5 text-[0.92em] text-slate-700' }, token.slice(1, -1)));
    } else {
      parent.appendChild(el('em', { class: 'italic' }, token.slice(1, -1)));
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) parent.appendChild(document.createTextNode(source.slice(cursor)));
}

function splitPipe(line) {
  const body = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((cell) => cell.trim());
}

function isDivider(line) {
  const cells = splitPipe(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderTable(lines, start, cite) {
  if (!lines[start]?.includes('|') || !isDivider(lines[start + 1] || '')) return null;
  const headers = splitPipe(lines[start]);
  const rows = [];
  let cursor = start + 2;
  while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
    const cells = splitPipe(lines[cursor]);
    if (cells.length !== headers.length) return null;
    rows.push(cells);
    cursor += 1;
  }
  if (!rows.length) return null;

  const table = el('table', { class: 'min-w-full border-separate border-spacing-0 text-left text-xs' });
  const headRow = el('tr');
  for (const header of headers) {
    const th = el('th', { scope: 'col', class: 'border-b border-slate-200 bg-slate-50 px-3 py-2 font-bold text-slate-600' });
    appendInline(th, header, cite);
    headRow.appendChild(th);
  }
  table.appendChild(el('thead', {}, headRow));
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td', { class: 'border-b border-slate-100 px-3 py-2 align-top text-slate-700' });
      appendInline(td, cell, cite);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return {
    node: el('div', { class: 'table-scroll-surface scrollbar-thin my-4 overflow-x-auto rounded-xl border border-slate-200', tabindex: '0', role: 'region', 'aria-label': 'Answer data table' }, table),
    next: cursor,
  };
}

export function renderResearchAnswer(container, text, { cite = null, compactCitations = false, streaming = false } = {}) {
  const output = document.createDocumentFragment();
  const references = new Map();
  const resolve = compactCitations ? (name) => {
    const target = cite?.(name);
    if (!target?.href) return null;
    if (!references.has(target.href)) references.set(target.href, { ...target, number: references.size + 1, label: target.label || name });
    return references.get(target.href);
  } : cite;
  const prose = String(text || '').replaceAll('\r\n', '\n');
  const lines = (streaming ? prose.replace(/\[Dashboard:[^\]\n]*$/, '') : prose).split('\n');
  let cursor = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    let copy = paragraph.join(' ');
    // Promote only an explicit bold label at the beginning of a paragraph.
    // Preserve its words and all following prose; never infer new conclusions.
    const label = copy.match(/^\*\*([^*\n]{1,160})\*\*(\s*:)?\s*/);
    if (label && (/:\s*$/.test(label[1]) || label[2] || copy.length === label[0].length)) {
      const heading = el('h3', { class: 'research-answer-heading' });
      appendInline(heading, label[1].trim() + (label[2]?.trim() || ''), resolve);
      output.appendChild(heading);
      copy = copy.slice(label[0].length);
    }
    const p = el('p', { class: 'research-answer-paragraph' });
    appendInline(p, copy, resolve);
    if (copy) output.appendChild(p);
    paragraph = [];
  };

  while (cursor < lines.length) {
    const line = lines[cursor];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      cursor += 1;
      continue;
    }

    // Resolve citations in document order, including the paragraph before a table.
    const tableCandidate = lines[cursor]?.includes('|') && isDivider(lines[cursor + 1] || '');
    if (tableCandidate) flushParagraph();
    const table = tableCandidate ? renderTable(lines, cursor, resolve) : null;
    if (table) {
      flushParagraph();
      output.appendChild(table.node);
      cursor = table.next;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const h = el('h3', { class: 'research-answer-heading' });
      appendInline(h, heading[2], resolve);
      output.appendChild(h);
      cursor += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      const quote = el('blockquote', { class: 'research-answer-callout' });
      appendInline(quote, trimmed.replace(/^>\s?/, ''), resolve);
      output.appendChild(quote);
      cursor += 1;
      continue;
    }

    const bullet = trimmed.match(/^[-•*]\s+(.+)$/);
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      const list = el(ordered ? 'ol' : 'ul', { class: ordered ? 'research-answer-list list-decimal' : 'research-answer-list list-disc' });
      if (ordered) list.start = Number(numbered[1]);
      while (cursor < lines.length) {
        const candidate = lines[cursor].trim();
        const match = ordered ? candidate.match(/^(\d+)[.)]\s+(.+)$/) : candidate.match(/^[-•*]\s+(.+)$/);
        if (!match) break;
        const li = el('li');
        appendInline(li, ordered ? match[2] : match[1], resolve);
        if (ordered) li.value = Number(match[1]);
        list.appendChild(li);
        cursor += 1;
      }
      output.appendChild(list);
      continue;
    }

    paragraph.push(trimmed);
    cursor += 1;
  }
  flushParagraph();
  if (references.size) {
    const sources = el('nav', { class: 'research-answer-references', 'aria-label': 'Sources cited in this answer' });
    sources.appendChild(el('span', {}, 'Cited sources'));
    for (const reference of references.values()) sources.appendChild(el('a', {
      href: reference.href, title: reference.title,
      target: /^https?:\/\//.test(reference.href) ? '_blank' : null,
      rel: /^https?:\/\//.test(reference.href) ? 'noopener noreferrer' : null,
    }, `${reference.number}. ${reference.label}`));
    output.appendChild(sources);
  }
  // Keep completed paragraphs and their citation links mounted as later tokens
  // arrive. Selecting text or focusing a citation should survive the next chunk.
  const children = [...output.childNodes];
  children.forEach((node, index) => {
    const existing = container.childNodes[index];
    if (existing?.isEqualNode(node)) return;
    if (existing) existing.replaceWith(node);
    else container.appendChild(node);
  });
  while (container.childNodes.length > children.length) container.lastChild.remove();
}

export function renderResearchSources(container, { dashboard = [], web = [] } = {}) {
  empty(container);
  if (!dashboard.length && !web.length) return;

  const label = el('span', { class: 'mr-1 text-[10px] font-bold uppercase tracking-wider text-slate-400' }, 'Sources');
  container.appendChild(label);
  for (const item of dashboard) {
    const chip = el('a', {
      class: 'research-source-chip',
      href: item.route || '#',
      title: `Open ${item.tab || item.id}`,
    }, item.tab || item.id);
    container.appendChild(chip);
  }
  for (const item of web) {
    let url;
    try {
      url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
    } catch {
      continue;
    }
    const link = el('a', {
      class: 'research-source-chip research-source-chip-web',
      href: url.href,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: item.title || url.hostname,
    }, item.title || url.hostname);
    container.appendChild(link);
  }
}
