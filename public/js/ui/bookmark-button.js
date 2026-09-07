import { escapeHtml } from '../core/dom.js';
import * as notebook from '../core/bookmarks.js';

export const BOOKMARK_ICON = '<svg width="16" height="18" viewBox="0 0 20 22" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 2h10a1 1 0 0 1 1 1v17l-6-4-6 4V3a1 1 0 0 1 1-1Z" stroke-linejoin="round"/></svg>';
export function bookmarkButton(entry, { compact = true } = {}) {
  const saved = notebook.has(entry.id);
  const label = saved ? 'Remove from notebook' : 'Save to notebook';
  return `<button type="button" data-bookmark-key="${escapeHtml(entry.id)}" data-norow
    class="bookmark-button${compact ? ' is-compact' : ''}" aria-label="${label}" title="${label}" aria-pressed="${saved}">
    ${BOOKMARK_ICON}${compact ? '' : `<span data-bookmark-label>${saved ? 'Saved' : 'Save'}</span>`}</button>`;
}

let messageTimer;
export function showBookmarkMessage(text, { error = false, undo = null } = {}) {
  clearTimeout(messageTimer);
  document.querySelector('[data-notebook-toast]')?.remove();
  const toast = document.createElement('div');
  toast.className = 'notebook-toast'; toast.dataset.notebookToast = '';
  toast.setAttribute('role', error ? 'alert' : 'status');
  const copy = document.createElement('span'); copy.textContent = text; toast.append(copy);
  if (undo) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Undo';
    button.onclick = async () => {
      button.disabled = true;
      try { await undo(); showBookmarkMessage('Bookmark restored.'); }
      catch (error) { showBookmarkMessage(error.message, { error: true }); }
    };
    toast.append(button);
  } else if (!error) {
    const link = document.createElement('a'); link.href = '#/research/bookmarks'; link.textContent = 'Open notebook'; toast.append(link);
  }
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss');
  close.onclick = () => toast.remove(); toast.append(close);
  document.body.append(toast);
  if (!error) messageTimer = setTimeout(() => toast.remove(), 9000);
}

/** Resolve from the owning component's row model, never from serialized HTML or a live URL. */
export function wireBookmarks(root, resolve) {
  const sync = () => {
    for (const button of root.querySelectorAll('[data-bookmark-key]')) {
      const saved = notebook.has(button.dataset.bookmarkKey);
      button.setAttribute('aria-pressed', String(saved));
      const label = saved ? 'Remove from notebook' : 'Save to notebook';
      button.setAttribute('aria-label', label); button.title = label;
      const caption = button.querySelector('[data-bookmark-label]');
      if (caption) caption.textContent = saved ? 'Saved' : 'Save';
    }
  };
  const click = async event => {
    const button = event.target.closest('[data-bookmark-key]');
    if (!button || !root.contains(button)) return;
    event.preventDefault(); event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    try {
      await notebook.load();
      const saved = notebook.get(button.dataset.bookmarkKey);
      if (saved) {
        await notebook.remove(saved.id);
        showBookmarkMessage('Removed from notebook.', { undo: () => notebook.save(saved) });
      } else {
        const entry = resolve(button);
        if (!entry) throw new Error('This event has changed. Try saving it again.');
        // A research answer may have been rendered hours before this click. Its source date
        // stays intact; the saved date records the reader's action, not that earlier render.
        await notebook.save({ ...entry, savedAt: new Date().toISOString() });
        showBookmarkMessage('Saved to your notebook.');
      }
    } catch (error) { showBookmarkMessage(error.message, { error: true }); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); sync(); }
  };
  // Capture prevents the enclosing article/table from opening its own detail or source.
  root.addEventListener('click', click, true);
  const off = notebook.onChange(sync);
  void notebook.load().then(sync).catch(() => {});
  sync();
  return () => { off(); root.removeEventListener('click', click, true); };
}
