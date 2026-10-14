import { escapeHtml } from '../core/dom.js';
import { captureTableReading } from '../core/view-reading.js';
import * as workspace from '../core/workspace.js';
import { VIEW_SOURCES, cleanSavedTab } from '../data/workspace-shared.js';
import { TAB_META, TAB_GROUPS } from '../tabs/catalog.js';
import { researchTabs } from '../tabs/registry.js';
import { state } from '../core/state.js';
import { scopeLabel } from '../data/scope.js';
import { openModal, closeModal } from './screener.js';

// The builder follows the live navigation metadata. A new subtab or renamed view
// appears here without maintaining a second hierarchy or a second set of filters.
export const viewChoices = () => researchTabs.map(tab => tab.meta).filter(meta => VIEW_SOURCES.includes(meta.id)).map(meta => {
  const id = meta.id;
  return { id, title: meta.navigationTitle || meta.title, group: meta.navigationGroup || id,
    groupTitle: TAB_GROUPS[meta.navigationGroup]?.title || meta.navigationTitle || meta.title, views: meta.subviews || [] };
});
const field = (label, content) => `<label class="saved-tab-field"><span>${label}</span>${content}</label>`;
export function openTabEditor({ tab = null, seed = null, onSaved, captureCurrent = null, onPreview = null, draftOnly = false }) {
  const value = structuredClone(tab || seed || { title: '', source: null, subview: null, scope: state.scope });
  const sources = viewChoices(), groups = [...new Map(sources.map(source => [source.group, source])).values()];
  openModal(`<form data-saved-tab-form class="saved-tab-editor">
    <h2 class="saved-tab-dialog-title">${tab ? 'Edit tab' : 'Build a Tab'}</h2>
    <p>Choose a live view, select its filters, then save your tab for everyone.</p>
    ${field('Tab heading', `<input data-saved-title maxlength="80" required placeholder="Capital Raises" value="${escapeHtml(value.title)}">`)}
    ${captureCurrent ? '<div class="saved-tab-actions"><button type="button" data-saved-current>Use current view</button></div>' : ''}
    ${field('Tab', `<select data-saved-group required>${groups.map(source => `<option value="${source.group}">${escapeHtml(source.groupTitle)}</option>`).join('')}</select>`)}
    ${field('Subtab', '<select data-saved-source></select>')}
    ${field('View', '<select data-saved-subview></select>')}
    <p data-saved-scope-note>Company scope follows the Scope filter above (currently ${escapeHtml(scopeLabel(state.scope))}).</p>
    <p class="saved-tab-error" data-saved-error role="status"></p>
    <div class="saved-tab-actions"><button type="button" data-saved-cancel>Cancel</button>${onPreview ? '<button type="button" data-saved-preview>Choose filters</button>' : ''}<button type="submit" data-saved-submit></button></div>
    <button type="button" class="saved-tab-close" data-modal-close aria-label="Close tab dialog" title="Close tab dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke-linecap="round" /></svg></button>
  </form>`, { size: 'default' });
  const form = document.querySelector('[data-saved-tab-form]');
  const group = form.querySelector('[data-saved-group]'), source = form.querySelector('[data-saved-source]'), subview = form.querySelector('[data-saved-subview]');
  const sameReading = () => source.value === (value.source || '') && (subview.value || null) === (value.subview || TAB_META[value.source]?.subviews?.[0]?.id || null);
  const refreshAction = () => {
    form.querySelector('[data-saved-submit]').textContent = draftOnly || !tab || (onPreview && !sameReading()) ? 'Select filters →' : 'Save tab';
    const preview = form.querySelector('[data-saved-preview]');
    if (preview) preview.hidden = draftOnly || !tab || !source.value || !sameReading();
  };
  const refreshViews = () => {
    const views = TAB_META[source.value]?.subviews || [];
    subview.innerHTML = views.length ? views.map(view => `<option value="${view.id}">${escapeHtml(view.label)}</option>`).join('') : '<option value="">Default table</option>';
    if (views.some(view => view.id === value.subview)) subview.value = value.subview;
    subview.closest('label').hidden = !views.length;
    refreshAction();
  };
  const refreshSources = (selected = null) => {
    const children = sources.filter(source => source.group === group.value);
    source.innerHTML = children.length ? children.map(child => `<option value="${child.id}">${escapeHtml(child.title)}</option>`).join('') : '<option value=""></option>';
    if (children.some(child => child.id === selected)) source.value = selected;
    source.closest('label').hidden = children.length < 2;
    subview.closest('label').querySelector('span').textContent = children.length > 1 ? 'View' : 'Subtab';
    refreshViews();
  };
  group.value = sources.find(source => source.id === value.source)?.group || groups[0].group;
  group.addEventListener('change', () => refreshSources());
  source.addEventListener('change', refreshViews); subview.addEventListener('change', refreshAction);
  refreshSources(value.source);
  form.querySelector('[data-saved-current]')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const captured = await captureCurrent();
      if (!form.isConnected) return;
      Object.assign(value, captured);
      group.value = sources.find(source => source.id === value.source)?.group || groups[0].group;
      refreshSources(value.source); button.textContent = 'Current view selected';
    } catch { form.querySelector('[data-saved-error]').textContent = 'This view could not be captured. Wait for its table to finish loading, then try again.'; }
    finally { button.disabled = false; }
  });
  form.querySelector('[data-saved-cancel]').addEventListener('click', closeModal);
  const selection = () => cleanSavedTab({ id: tab?.id || `view-${crypto.randomUUID()}`, title: form.querySelector('[data-saved-title]').value.trim() || 'New shared tab',
    source: source.value || null, subview: subview.value || null, scope: state.scope,
    params: sameReading() ? value.params || {} : {}, reading: sameReading() ? value.reading || {} : {} });
  const preview = () => { if (!form.reportValidity()) return; const selected = selection(); closeModal(); onPreview(selected, tab); };
  form.querySelector('[data-saved-preview]')?.addEventListener('click', preview);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const title = form.querySelector('[data-saved-title]').value.trim();
    if (!title) return;
    if (!source.value) return;
    if (onPreview && (draftOnly || !tab || !sameReading())) { preview(); return; }
    const saved = selection();
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
