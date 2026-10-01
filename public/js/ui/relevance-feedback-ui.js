// ui/relevance-feedback-ui.js — IMPORTANT / NOT IMPORTANT, WITH AN OPTIONAL "WHY?", ON THREE SURFACES.
//
//   feedbackBar(item)            the row of controls inside Corporate Announcements' AI Read popup
//   wireFeedback(root, item)     makes a bar inside `root` live; returns a disposer
//   feedbackMenuButton(item)     News: a small ⋯ beside the row — the row's own click still opens the
//                                article, exactly as before; this is a second, separate control
//   promptAfterOpen(item)        All Alerts: after the reader opens an item, a small prompt asks
//
// Every one of them casts the same vote into the same shared preference (data/relevance-feedback.js):
// one model for the whole desk, which re-orders all three surfaces. A vote moves an item within its
// day and never hides it, and the controls say so.
//
// `item` = { surface, itemKey, eventKey?, features, label, company?, categories? } — `features` are
// the relevance keys (relevance.js) the vote teaches.
import { escapeHtml } from '../core/dom.js';
import { vote, myVote, loadMine, onChange as onFeedbackChange } from '../data/relevance-feedback.js';
import { WHY_MAX } from '../data/relevance-feedback-shared.js';

const registry = new Map(); // itemKey -> item, for menu buttons rendered inside table markup
let sequence = 0;

const statusText = (result, chosen) => {
  if (!result) return '';
  if (result.state === 'saved') return chosen === 'clear' ? 'Vote withdrawn.' : 'Thanks — the shared ranking learns from this.';
  if (result.state === 'queued') return 'Saved on this device; it will be sent when the server is reachable.';
  return `Not saved: ${result.reason || 'the server refused the vote'}.`;
};

/** The control row. `compact` drops the leading question for tight spaces. */
export function feedbackBar(item, { compact = false, question = 'Is this important?' } = {}) {
  const id = `relevance-feedback-${++sequence}`;
  const current = myVote(item.itemKey);
  const pressed = (value) => (current?.vote === value ? 'true' : 'false');
  return `<div class="relevance-feedback${compact ? ' is-compact' : ''}" data-relevance-feedback="${escapeHtml(item.itemKey)}" id="${id}">
    ${compact ? '' : `<span class="relevance-feedback-question">${escapeHtml(question)}</span>`}
    <div class="relevance-feedback-actions" role="group" aria-label="${escapeHtml(question)}">
      <button type="button" data-vote="important" aria-pressed="${pressed('important')}" class="relevance-vote">Important</button>
      <button type="button" data-vote="not-important" aria-pressed="${pressed('not-important')}" class="relevance-vote">Not important</button>
      <button type="button" data-why aria-expanded="false" aria-controls="${id}-why" class="relevance-why-toggle">Why?</button>
    </div>
    <div id="${id}-why" data-why-box class="relevance-why" hidden>
      <label class="relevance-why-label" for="${id}-text">Why? <span>(optional — helps the desk's shared ranking)</span></label>
      <textarea id="${id}-text" data-why-text maxlength="${WHY_MAX}" rows="2" placeholder="e.g. order is large for this company's size; routine notice">${escapeHtml(current?.why || '')}</textarea>
      <div class="relevance-why-actions">
        <button type="button" data-why-save="important" class="relevance-vote">Save as important</button>
        <button type="button" data-why-save="not-important" class="relevance-vote">Save as not important</button>
      </div>
    </div>
    <p data-feedback-status role="status" class="relevance-feedback-status">${current?.pending ? escapeHtml(statusText({ state: 'queued' })) : ''}</p>
  </div>`;
}

/** Make the bar inside `root` live. Returns a disposer. */
export function wireFeedback(root, item) {
  const bar = root.querySelector(`[data-relevance-feedback="${CSS.escape(item.itemKey)}"]`);
  if (!bar) return () => {};
  const status = bar.querySelector('[data-feedback-status]');
  const box = bar.querySelector('[data-why-box]');
  const toggle = bar.querySelector('[data-why]');
  const text = bar.querySelector('[data-why-text]');
  const sync = () => {
    const current = myVote(item.itemKey);
    for (const button of bar.querySelectorAll('[data-vote]')) button.setAttribute('aria-pressed', String(current?.vote === button.dataset.vote));
  };
  let busy = false;
  const cast = async (value, why = null) => {
    if (busy) return;
    busy = true;
    bar.setAttribute('aria-busy', 'true');
    const current = myVote(item.itemKey);
    // Pressing the selected answer again withdraws it — the one way to undo a mis-click.
    const chosen = !why && current?.vote === value ? 'clear' : value;
    const result = await vote({ ...item, vote: chosen, why: chosen === 'clear' ? null : (why ?? current?.why ?? null) });
    busy = false;
    bar.removeAttribute('aria-busy');
    status.textContent = statusText(result, chosen);
    sync();
    if (why !== null && result.state !== 'refused') { box.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
  };
  const onClick = (event) => {
    const button = event.target.closest('button');
    if (!button || !bar.contains(button)) return;
    event.stopPropagation();
    if (button.dataset.vote) void cast(button.dataset.vote);
    else if (button.hasAttribute('data-why')) {
      box.hidden = !box.hidden;
      toggle.setAttribute('aria-expanded', String(!box.hidden));
      if (!box.hidden) text.focus();
    } else if (button.dataset.whySave) void cast(button.dataset.whySave, text.value.trim() || null);
  };
  bar.addEventListener('click', onClick);
  void loadMine().then(sync);
  const off = onFeedbackChange(sync);
  return () => { bar.removeEventListener('click', onClick); off(); };
}

// ---------------------------------------------------------------------------------------------
// News: a small secondary control beside the row. The row itself keeps opening the article.
// ---------------------------------------------------------------------------------------------

export function registerFeedbackItem(item) { registry.set(item.itemKey, item); }

export function feedbackMenuButton(item) {
  registerFeedbackItem(item);
  const current = myVote(item.itemKey);
  const mark = current?.vote === 'important' ? ' is-important' : current?.vote === 'not-important' ? ' is-not-important' : '';
  return `<button type="button" class="relevance-menu-button${mark}" data-stop data-norow data-feedback-menu="${escapeHtml(item.itemKey)}"
    aria-haspopup="dialog" aria-label="Rate this item: important or not important" title="Important / Not important">⋯</button>`;
}

let menu = null;
let menuDispose = null;
function closeMenu() {
  menuDispose?.(); menuDispose = null;
  if (menu) { menu.remove(); menu = null; }
}

function openMenu(button, item) {
  closeMenu();
  menu = document.createElement('div');
  menu.className = 'relevance-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Rate this item');
  menu.innerHTML = `${feedbackBar(item, { question: 'Is this important?' })}<p class="relevance-menu-note">Votes train one shared ranking for the desk. Nothing is hidden.</p>`;
  document.body.append(menu);
  const r = button.getBoundingClientRect();
  const width = Math.min(320, innerWidth - 16);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - width, innerWidth - width - 8))}px`;
  const below = innerHeight - r.bottom;
  menu.style.top = `${below > 220 ? r.bottom + 6 : Math.max(8, r.top - menu.offsetHeight - 6)}px`;
  const release = wireFeedback(menu, item);
  menu.querySelector('[data-vote]')?.focus();
  // The list under the menu can repaint while it is open (new stories, the order settling), which
  // replaces the ⋯ it was opened from with an identical one. So the anchor is found by its item, and
  // the menu closes when that row moves or leaves — the reader scrolling — not on every scroll event
  // a repaint restoring its position fires.
  const anchor = () => (button.isConnected ? button : document.querySelector(`[data-feedback-menu="${CSS.escape(item.itemKey)}"]`));
  const at = button.getBoundingClientRect().top;
  const onKey = (event) => { if (event.key === 'Escape') { closeMenu(); anchor()?.focus(); } };
  const onDown = (event) => { if (menu && !menu.contains(event.target) && !event.target.closest?.(`[data-feedback-menu="${CSS.escape(item.itemKey)}"]`)) closeMenu(); };
  const onScroll = (event) => {
    if (!menu || menu.contains(event.target)) return;
    const current = anchor();
    if (!current || Math.abs(current.getBoundingClientRect().top - at) > 4) closeMenu();
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('scroll', onScroll, true);
  menuDispose = () => {
    release();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('scroll', onScroll, true);
    // A vote changes the button's own mark; the list does not have to repaint for it.
    const current = myVote(item.itemKey);
    const target = anchor();
    target?.classList.toggle('is-important', current?.vote === 'important');
    target?.classList.toggle('is-not-important', current?.vote === 'not-important');
  };
}

// One capture-phase listener for every ⋯ on the page: it runs before a row's own click handler and
// stops that click there, so opening the menu never also opens the article.
let installed = false;
export function installFeedbackMenus() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-feedback-menu]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const item = registry.get(button.dataset.feedbackMenu);
    if (!item) return;
    if (menu && menu.dataset.for === item.itemKey) { closeMenu(); return; }
    openMenu(button, item);
    if (menu) menu.dataset.for = item.itemKey;
  }, true);
}

// ---------------------------------------------------------------------------------------------
// All Alerts: ask after the item was opened.
// ---------------------------------------------------------------------------------------------

let prompt = null;
let promptTimer = null;
let promptDispose = null;
function closePrompt() {
  clearTimeout(promptTimer);
  promptDispose?.(); promptDispose = null;
  prompt?.remove(); prompt = null;
}

/** A small prompt in the lower right, after the reader opened `item`. One at a time; it leaves on its own. */
export function promptAfterOpen(item, { title = item.label } = {}) {
  closePrompt();
  prompt = document.createElement('section');
  prompt.className = 'relevance-prompt';
  prompt.setAttribute('role', 'region');
  prompt.setAttribute('aria-label', 'Rate the item you opened');
  prompt.innerHTML = `<div class="relevance-prompt-head"><p class="relevance-prompt-title">You opened: <span>${escapeHtml(String(title || '').slice(0, 140))}</span></p>
    <button type="button" data-prompt-close aria-label="Dismiss" class="relevance-prompt-close">×</button></div>
    ${feedbackBar(item, { question: 'Was it important?' })}`;
  document.body.append(prompt);
  const release = wireFeedback(prompt, item);
  const onClose = (event) => { if (event.target.closest('[data-prompt-close]')) closePrompt(); };
  prompt.addEventListener('click', onClose);
  // Leaves after a while unless the reader is using it.
  const arm = () => { clearTimeout(promptTimer); promptTimer = setTimeout(() => { if (!prompt?.matches(':focus-within, :hover')) closePrompt(); else arm(); }, 25_000); };
  arm();
  promptDispose = () => { release(); prompt?.removeEventListener('click', onClose); };
}
export const dismissPrompt = closePrompt;
