// ui/relevance-feedback-ui.js — IMPORTANT / NOT IMPORTANT, WITH AN OPTIONAL "WHY?", ON THREE SURFACES.
//
//   feedbackBar(item)            the row of controls inside Corporate Announcements' AI Read popup
//   wireFeedback(root, item)     makes a bar inside `root` live; returns a disposer
//   newsFeedbackBar(item)        News: visible controls below each story, outside its article link
//   installNewsFeedback()        delegates clicks for virtual rows and preserves optional drafts
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

const registry = new Map(); // itemKey -> item, for visible controls rendered inside news markup
const newsStates = new Map(); // only interacted items: drafts and in-flight/status state across paints
let sequence = 0;

const statusText = (result, chosen) => {
  if (!result) return '';
  if (result.state === 'saved') return chosen === 'clear' ? 'Vote withdrawn.' : 'Thanks — the shared ranking learns from this.';
  if (result.state === 'queued') return 'Saved on this device; it will be sent when the server is reachable.';
  return `Not saved: ${result.reason || 'the server refused the vote'}.`;
};

/** The control row. `compact` drops the leading question for tight spaces. */
export function feedbackBar(item, { compact = false, question = 'Is this important?', state = null } = {}) {
  const id = `relevance-feedback-${++sequence}`;
  const current = myVote(item.itemKey);
  const pressed = (value) => (current?.vote === value ? 'true' : 'false');
  return `<div class="relevance-feedback${compact ? ' is-compact' : ''}" data-relevance-feedback="${escapeHtml(item.itemKey)}" id="${id}"${state?.busy ? ' aria-busy="true"' : ''}>
    ${compact ? '' : `<span class="relevance-feedback-question">${escapeHtml(question)}</span>`}
    <div class="relevance-feedback-actions" role="group" aria-label="${escapeHtml(question)}">
      <button type="button" data-vote="important" aria-pressed="${pressed('important')}" class="relevance-vote is-important"><span aria-hidden="true">✓</span> Important</button>
      <button type="button" data-vote="not-important" aria-pressed="${pressed('not-important')}" class="relevance-vote is-not-important"><span aria-hidden="true">×</span> Not important</button>
      <button type="button" data-why aria-expanded="${!!state?.open}" aria-controls="${id}-why" class="relevance-why-toggle">Why?</button>
    </div>
    <div id="${id}-why" data-why-box class="relevance-why"${state?.open ? '' : ' hidden'}>
      <label class="relevance-why-label" for="${id}-text">Why? <span>(optional — helps the desk's shared ranking)</span></label>
      <textarea id="${id}-text" data-why-text maxlength="${WHY_MAX}" rows="2" placeholder="e.g. order is large for this company's size; routine notice">${escapeHtml(state?.why ?? current?.why ?? '')}</textarea>
      <div class="relevance-why-actions">
        <button type="button" data-why-save="important" class="relevance-vote is-important"><span aria-hidden="true">✓</span> Save as important</button>
        <button type="button" data-why-save="not-important" class="relevance-vote is-not-important"><span aria-hidden="true">×</span> Save as not important</button>
      </div>
    </div>
    <p data-feedback-status role="status" class="relevance-feedback-status">${escapeHtml(state?.status || (current?.pending ? statusText({ state: 'queued' }) : ''))}</p>
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
// News: one delegated controller for the mounted rows, so windowing never accumulates listeners.
// ---------------------------------------------------------------------------------------------

export function newsFeedbackBar(item) {
  registry.set(item.itemKey, item);
  return `<div class="news-feedback" data-news-feedback="${escapeHtml(item.itemKey)}" data-stop data-norow>${feedbackBar(item, { state: newsStates.get(item.itemKey) })}</div>`;
}

const newsState = key => {
  if (!newsStates.has(key)) newsStates.set(key, { open: false, why: null, busy: false, status: '' });
  return newsStates.get(key);
};

function syncNewsFeedback(key = null) {
  const selector = key ? `[data-news-feedback="${CSS.escape(key)}"]` : '[data-news-feedback]';
  for (const host of document.querySelectorAll(selector)) {
    const itemKey = host.dataset.newsFeedback, current = myVote(itemKey), state = newsStates.get(itemKey);
    const bar = host.querySelector('[data-relevance-feedback]');
    if (state?.busy) bar.setAttribute('aria-busy', 'true'); else bar.removeAttribute('aria-busy');
    for (const button of bar.querySelectorAll('[data-vote]')) button.setAttribute('aria-pressed', String(current?.vote === button.dataset.vote));
    bar.querySelector('[data-why-box]').hidden = !state?.open;
    bar.querySelector('[data-why]').setAttribute('aria-expanded', String(!!state?.open));
    bar.querySelector('[data-why-text]').value = state?.why ?? current?.why ?? '';
    bar.querySelector('[data-feedback-status]').textContent = state?.status || (current?.pending ? statusText({ state: 'queued' }) : '');
  }
}

async function castNewsFeedback(item, value, { why = null, saveWhy = false } = {}) {
  const state = newsState(item.itemKey);
  if (state.busy) return;
  state.busy = true; state.status = ''; syncNewsFeedback(item.itemKey);
  const current = myVote(item.itemKey);
  const chosen = !saveWhy && current?.vote === value ? 'clear' : value;
  const result = await vote({ ...item, vote: chosen, why: chosen === 'clear' ? null : saveWhy ? why : current?.why ?? null });
  state.busy = false; state.status = statusText(result, chosen);
  if (saveWhy && result.state !== 'refused') { state.why = null; state.open = false; }
  // Saving can re-order/repaint the news. Address the replacement bar, not the removed DOM node.
  syncNewsFeedback(item.itemKey);
  document.querySelector(`[data-news-feedback="${CSS.escape(item.itemKey)}"] [data-vote="${value}"]`)?.focus({ preventScroll: true });
}

let newsInstalled = false;
export function installNewsFeedback() {
  if (newsInstalled || typeof document === 'undefined') return;
  newsInstalled = true;
  document.addEventListener('click', event => {
    const host = event.target.closest?.('[data-news-feedback]'), button = event.target.closest?.('button');
    if (!host || !button || !host.contains(button)) return;
    event.preventDefault(); event.stopPropagation();
    const item = registry.get(host.dataset.newsFeedback);
    if (!item) return;
    if (button.dataset.vote) void castNewsFeedback(item, button.dataset.vote);
    else if (button.hasAttribute('data-why')) {
      const state = newsState(item.itemKey); state.open = !state.open;
      syncNewsFeedback(item.itemKey);
      if (state.open) host.querySelector('[data-why-text]').focus();
    } else if (button.dataset.whySave) void castNewsFeedback(item, button.dataset.whySave, { why: host.querySelector('[data-why-text]').value.trim() || null, saveWhy: true });
  }, true);
  document.addEventListener('input', event => {
    const host = event.target.closest?.('[data-news-feedback]');
    if (host && event.target.matches('[data-why-text]')) newsState(host.dataset.newsFeedback).why = event.target.value;
  });
  document.addEventListener('keydown', event => {
    const host = event.target.closest?.('[data-news-feedback]');
    if (event.key !== 'Escape' || !host || !newsState(host.dataset.newsFeedback).open) return;
    event.preventDefault(); event.stopPropagation();
    newsState(host.dataset.newsFeedback).open = false; syncNewsFeedback(host.dataset.newsFeedback);
    host.querySelector('[data-why]').focus();
  });
  onFeedbackChange(() => syncNewsFeedback());
  void loadMine().then(() => syncNewsFeedback());
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
