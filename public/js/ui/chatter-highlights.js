import { escapeHtml } from '../core/dom.js';
import { formatDate, formatTime } from '../core/format.js';
import { newestMentions } from '../data/chatter-mentions.js';
import * as chatter from '../data/chatter-live.js';

// Only visible companies read detail pages; never put a universe-wide detail walk on startup.
// Shared slots also bound requests across a scope change while old reads finish.
const saved = new Map(), pumps = new Set(), markup = new WeakMap();
let active = 0;
const revision = entry => `${chatter.meta()?.generatedAt || ''}:${entry.mentions}`;
const retryMs = 5 * 60000;
export const latestChatterHighlights = entry => newestMentions(saved.get(entry.slug)?.payload?.posts || []).slice(0, 2);

function sourceUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
function contents(entry) {
  const state = saved.get(entry.slug), posts = latestChatterHighlights(entry);
  if (!posts.length) return `<span class="chatter-highlight-status">${state?.error ? 'Excerpts unavailable · click company to retry' : state?.payload?.complete ? 'No mentions returned by the source' : 'Reading latest mentions…'}</span>`;
  const bullets = posts.map(post => {
    const words = String(post.text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const text = words.length ? `${words.slice(0, 24).join(' ')}${words.length > 24 ? '…' : ''}` : 'No excerpt published';
    const href = sourceUrl(post.url), tag = ['bullish', 'bearish'].includes(post.sentiment) ? post.sentiment : 'neutral';
    const when = Number.isFinite(Date.parse(post.at)) ? `${formatDate(post.at)} · ${formatTime(post.at)}` : 'Time not published';
    const title = `${post.sourceLabel || post.community || 'Source'} · ${when} · Source: ${post.sentiment || 'unclassified'}${href ? '' : ' · Original link unavailable; open captured mention'}`;
    const attrs = `class="chatter-highlight" data-chatter-highlight data-highlight-id="${escapeHtml(post.id)}" data-source-tag="${tag}" title="${escapeHtml(title)}"`;
    const body = `<span class="chatter-highlight-dot" aria-hidden="true"></span><span>${escapeHtml(text)}</span>`;
    return `<li>${href ? `<a ${attrs} href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${body}</a>` : `<button type="button" ${attrs} data-norow data-chatter-highlight-open>${body}</button>`}</li>`;
  }).join('');
  const older = Date.parse(state.payload.generatedAt) < Date.parse(chatter.meta()?.generatedAt);
  const status = state.error ? 'Update unavailable · saved excerpts' : state.pending || state.revision !== revision(entry) ? 'Updating saved excerpts…' : older ? 'Saved excerpts · earlier source snapshot' : '';
  return `<ul class="chatter-highlight-list" aria-label="Latest source excerpts; colours are source tags">${bullets}</ul>${status ? `<span class="chatter-highlight-status">${status}</span>` : ''}`;
}
export const chatterHighlightsCell = entry => `<div data-chatter-highlights="${escapeHtml(entry.slug)}" class="chatter-highlights">${contents(entry)}</div>`;

function renderCell(cell, entry) {
  const html = contents(entry);
  if (markup.get(cell) === html) return;
  const focusedId = cell.contains(document.activeElement) ? document.activeElement.dataset.highlightId : null;
  cell.innerHTML = html; markup.set(cell, html);
  if (focusedId) [...cell.querySelectorAll('[data-chatter-highlight]')].find(node => node.dataset.highlightId === focusedId)?.focus({ preventScroll: true });
}

export function wireChatterHighlights(root, rows, openMention) {
  const entries = new Map(rows.map(row => [row.slug, row])), visible = new Set(), observed = new WeakSet();
  let disposed = false;
  const draw = slug => {
    for (const cell of visible) if (cell.isConnected && cell.dataset.chatterHighlights === slug) renderCell(cell, entries.get(slug));
  };
  const pumpAll = () => { for (const pump of pumps) pump(); };
  const pump = () => {
    if (disposed || document.hidden) return;
    for (const cell of visible) {
      if (!cell.isConnected) { visible.delete(cell); continue; }
      const entry = entries.get(cell.dataset.chatterHighlights);
      if (!entry) continue;
      const old = saved.get(entry.slug), nextRevision = revision(entry);
      if (old?.pending || (old?.revision === nextRevision && Date.now() - old.attemptAt < retryMs)) continue;
      if (active >= 2) break;
      const state = { ...old, revision: nextRevision, pending: true, error: null, attemptAt: Date.now() };
      saved.set(entry.slug, state); active++; draw(entry.slug);
      const update = payload => {
        // An incomplete page cannot establish the newest mentions: upstream pages may be unsorted.
        if (payload.complete) state.payload = payload;
        state.error = payload.error || null;
        draw(entry.slug);
      };
      void chatter.postsFor(entry.slug, { requireFresh: true, maxAgeMs: retryMs, generation: chatter.meta()?.generatedAt,
        force: !!old && old.revision !== nextRevision, onSaved: update, onUpdate: update })
        .then(update).catch(error => { state.error = error.message; })
        .finally(() => { state.pending = false; active--; draw(entry.slug); pumpAll(); });
    }
  };
  pumps.add(pump);
  const observer = new IntersectionObserver(changes => {
    for (const { target, isIntersecting } of changes) {
      if (isIntersecting) { visible.add(target); renderCell(target, entries.get(target.dataset.chatterHighlights)); }
      else visible.delete(target);
    }
    pump();
  }, { root: root.querySelector('[data-table-scroll]'), rootMargin: '80px 0px' });
  const scan = () => {
    for (const cell of root.querySelectorAll('[data-chatter-highlights]')) if (!observed.has(cell)) {
      observed.add(cell); observer.observe(cell);
    }
  };
  // The table mounts a bounded window and replaces that window on search, sort and scroll.
  const mutations = new MutationObserver(scan);
  mutations.observe(root.querySelector('tbody'), { childList: true });
  const changed = () => {
    for (const cell of visible) if (cell.isConnected) renderCell(cell, entries.get(cell.dataset.chatterHighlights));
    pump();
  };
  const off = chatter.onChange(changed);
  document.addEventListener('visibilitychange', changed);
  const click = event => {
    const button = event.target.closest('[data-chatter-highlight-open]');
    if (button) openMention(entries.get(button.closest('[data-chatter-highlights]').dataset.chatterHighlights), button.dataset.highlightId);
  };
  root.addEventListener('click', click);
  scan();
  return () => {
    disposed = true; pumps.delete(pump); observer.disconnect(); mutations.disconnect(); off();
    document.removeEventListener('visibilitychange', changed); root.removeEventListener('click', click);
  };
}
