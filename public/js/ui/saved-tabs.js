import { escapeHtml } from '../core/dom.js';
import { captureTableReading } from '../core/view-reading.js';
import * as workspace from '../core/workspace.js';
import { VIEW_SOURCES, cleanSavedTab } from '../data/workspace-shared.js';
import { TAB_META } from '../tabs/catalog.js';
import { openModal, closeModal } from './screener.js';

const sources = VIEW_SOURCES.map(id => ({ id, title: TAB_META[id]?.navigationTitle || TAB_META[id]?.title || id }));
const field = (label, content) => `<label class="saved-tab-field"><span>${label}</span>${content}</label>`;
export function openTabEditor({ tab = null, seed = null, onSaved, captureCurrent = null }) {
  const value = tab || seed || { title: '', source: null, subview: null, scope: 'universe' };
  openModal(`<form data-saved-tab-form class="saved-tab-editor">
    <h2>${tab ? 'Edit shared tab' : 'Add a shared tab'}</h2>
    <p>Name a screen, then choose its table and save the filters you want to return to.</p>
    ${field('Page heading', `<input data-saved-title maxlength="80" required placeholder="Capital Raises" value="${escapeHtml(value.title)}">`)}
    ${captureCurrent ? '<div class="saved-tab-actions"><button type="button" data-saved-current>Use current view</button></div>' : ''}
    ${field('Table', `<select data-saved-source><option value="">Blank page — choose a table later</option>${sources.map(source => `<option value="${source.id}"${source.id === value.source ? ' selected' : ''}>${escapeHtml(source.title)}</option>`).join('')}</select>`)}
    ${field('View', '<select data-saved-subview></select>')}
    ${field('Companies', `<select data-saved-scope>${['portfolio', 'watchlist', 'universe'].map(scope => `<option value="${scope}"${scope === value.scope ? ' selected' : ''}>${scope[0].toUpperCase() + scope.slice(1)}</option>`).join('')}</select>`)}
    <p class="saved-tab-error" data-saved-error role="status"></p>
    <div class="saved-tab-actions"><button type="button" data-saved-cancel>Cancel</button><button type="submit" data-saved-submit>${tab ? 'Save tab' : 'Add tab'}</button></div>
  </form>`, { size: 'default' });
  const form = document.querySelector('[data-saved-tab-form]');
  const source = form.querySelector('[data-saved-source]'), subview = form.querySelector('[data-saved-subview]');
  const refreshViews = () => {
    const views = TAB_META[source.value]?.subviews || [];
    subview.innerHTML = views.length ? views.map(view => `<option value="${view.id}">${escapeHtml(view.label)}</option>`).join('') : '<option value="">Default table</option>';
    if (views.some(view => view.id === value.subview)) subview.value = value.subview;
    subview.closest('label').hidden = !views.length;
  };
  source.addEventListener('change', refreshViews); refreshViews();
  form.querySelector('[data-saved-current]')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const captured = await captureCurrent();
      if (!form.isConnected) return;
      Object.assign(value, captured);
      source.value = value.source;
      form.querySelector('[data-saved-scope]').value = value.scope;
      refreshViews(); button.textContent = 'Current view selected';
    } catch { form.querySelector('[data-saved-error]').textContent = 'This view could not be captured. Wait for its table to finish loading, then try again.'; }
    finally { button.disabled = false; }
  });
  form.querySelector('[data-saved-cancel]').addEventListener('click', closeModal);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const title = form.querySelector('[data-saved-title]').value.trim();
    if (!title) return;
    const sameSource = source.value === value.source && (subview.value || null) === (value.subview || null);
    const saved = cleanSavedTab({ id: tab?.id || `view-${crypto.randomUUID()}`, title, source: source.value || null, subview: subview.value || null,
      scope: form.querySelector('[data-saved-scope]').value, params: sameSource ? value.params || {} : {}, reading: sameSource ? value.reading || {} : {} });
    const button = form.querySelector('[data-saved-submit]'); button.disabled = true;
    const result = await workspace.edit({ op: 'put', tab: saved, expected: tab?.revision ?? null });
    button.disabled = false;
    if (result.confirmed || result.pending) { closeModal(); onSaved(saved); }
    else form.querySelector('[data-saved-error]').textContent = result.error || 'The tab could not be saved.';
  });
}
export async function captureSavedTab({ root, source, scope, subview, params, module }) {
  const reading = captureTableReading(root);
  reading.extras = module?.getSavedView?.() || {};
  return { source, scope, subview, params, reading };
}
export function blankTabHtml(tab) {
  return `<section class="saved-tab-blank"><h3>Build your screen</h3><p>Choose a table, apply its filters, then save the view for everyone.</p><button type="button" data-saved-choose>Choose a table</button></section>`;
}
