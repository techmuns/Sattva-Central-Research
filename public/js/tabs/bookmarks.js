import { escapeHtml as esc } from '../core/dom.js';
import * as notebook from '../core/bookmarks.js';
import { companyKey, filterBookmarks } from '../core/bookmark-record.js';
import { sectionHead, openModal } from '../ui/screener.js';
import { BOOKMARK_ICON, bookmarkButton, wireBookmarks, showBookmarkMessage } from '../ui/bookmark-button.js';

export const meta = { id: 'bookmarks', title: 'Bookmarks', subtitle: 'Your saved research, kept together.', subviews: [], allowEmptyScope: true, scopeIndependent: true };
let ctxRef, off, offButtons, limit = 30;
let view = { company: '', query: '', kind: '', sort: 'saved', notesOnly: false };
let companySearch = '';
const date = value => {
  if (!value) return 'Date not supplied';
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return value;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : value;
};
const companyName = entry => entry.company || entry.ticker || 'Market & general';

export function render(ctx) {
  destroy(); ctxRef = ctx;
  ctx.root.innerHTML = `${sectionHead({ title: meta.title, description: 'Keep the events that matter. Saved copies stay here when the dashboard moves on.',
    meta: `<div class="notebook-backups"><button type="button" data-notebook-export class="notebook-action">Export backup</button><button type="button" data-notebook-import class="notebook-action">Import backup</button><input type="file" accept=".json,application/json" data-notebook-file hidden></div>` })}
    <p class="notebook-storage-note">Saved in this browser · All your companies, across every dashboard scope. Export a backup to keep a copy or move browsers.</p>
    <div data-notebook-state role="status" class="notebook-state">Opening your notebook…</div>
    <div class="notebook-layout" data-notebook-layout hidden>
      <aside class="notebook-companies" aria-label="Filter bookmarks by company">
        <h3>Companies</h3><label class="sr-only" for="notebook-company-search">Search companies</label>
        <input id="notebook-company-search" data-notebook-company-search type="search" placeholder="Find a company…" value="${esc(companySearch)}">
        <div data-notebook-companies></div>
      </aside>
      <section class="notebook-main" aria-label="Saved events">
        <div class="notebook-toolbar">
          <label class="notebook-event-search"><span class="sr-only">Search saved events or notes</span><input data-notebook-search type="search" placeholder="Search company, event or notes…" value="${esc(view.query)}"></label>
          <label><span>Event type</span><select data-notebook-kind></select></label>
          <label><span>Sort by</span><select data-notebook-sort><option value="saved">Recently saved</option><option value="event">Event date</option><option value="company">Company A–Z</option></select></label>
          <label class="notebook-mobile-company"><span>Company</span><select data-notebook-company-select></select></label>
        </div>
        <div class="notebook-result-bar"><p data-notebook-count role="status"></p><div><label><input type="checkbox" data-notebook-notes ${view.notesOnly ? 'checked' : ''}> With notes</label><button type="button" data-notebook-clear>Clear filters</button></div></div>
        <div data-notebook-results></div>
      </section>
    </div>`;
  const root = ctx.root;
  root.querySelector('[data-notebook-sort]').value = view.sort;
  root.querySelector('[data-notebook-search]').oninput = event => { view.query = event.target.value; limit = 30; paintResults(); };
  root.querySelector('[data-notebook-company-search]').oninput = event => { companySearch = event.target.value; paintCompanies(); };
  root.querySelector('[data-notebook-kind]').onchange = event => { view.kind = event.target.value; limit = 30; paintResults(); };
  root.querySelector('[data-notebook-sort]').onchange = event => { view.sort = event.target.value; limit = 30; paintResults(); };
  root.querySelector('[data-notebook-notes]').onchange = event => { view.notesOnly = event.target.checked; limit = 30; paintResults(); };
  root.querySelector('[data-notebook-company-select]').onchange = event => selectCompany(event.target.value);
  root.querySelector('[data-notebook-companies]').onclick = event => {
    const button = event.target.closest('[data-notebook-company]'); if (button) selectCompany(button.dataset.notebookCompany);
  };
  root.querySelector('[data-notebook-clear]').onclick = clearFilters;
  root.querySelector('[data-notebook-results]').onclick = event => {
    const button = event.target.closest('[data-notebook-open]');
    if (button) openEntry(button.dataset.notebookOpen);
    if (event.target.closest('[data-notebook-more]')) { limit += 30; paintResults(); }
    if (event.target.closest('[data-notebook-empty-clear]')) clearFilters();
  };
  root.querySelector('[data-notebook-export]').onclick = async () => {
    try {
      const blob = new Blob([await notebook.exportBackup()], { type: 'application/json' });
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = `sattva-notebook-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { showBookmarkMessage(error.message, { error: true }); }
  };
  const file = root.querySelector('[data-notebook-file]');
  root.querySelector('[data-notebook-import]').onclick = () => file.click();
  file.onchange = async () => {
    const picked = file.files[0]; if (!picked) return;
    try {
      const count = await notebook.importBackup(JSON.parse(await picked.text()));
      showBookmarkMessage(`${count} bookmark${count === 1 ? '' : 's'} imported. Existing bookmarks and notes kept.`);
    } catch (error) { showBookmarkMessage(error instanceof SyntaxError ? 'This file is not a valid notebook backup. Nothing was imported.' : error.message, { error: true }); }
    finally { file.value = ''; }
  };
  off = notebook.onChange(paint);
  offButtons = wireBookmarks(root, button => notebook.get(button.dataset.bookmarkKey));
  void notebook.load({ force: true }).then(() => { if (ctxRef === ctx) paint(); }).catch(error => {
    if (ctxRef !== ctx) return;
    const status = root.querySelector('[data-notebook-state]');
    status.hidden = false; status.textContent = error.message;
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'notebook-action'; retry.textContent = 'Try again';
    retry.onclick = () => render(ctx); status.append(' ', retry);
  });
}
export function destroy() { off?.(); offButtons?.(); off = offButtons = null; ctxRef = null; }
function selectCompany(value) { view.company = value; limit = 30; paintCompanies(); paintResults(); }
function clearFilters() {
  view = { company: '', query: '', kind: '', notesOnly: false, sort: view.sort }; companySearch = ''; limit = 30;
  const root = ctxRef.root;
  root.querySelector('[data-notebook-search]').value = '';
  root.querySelector('[data-notebook-company-search]').value = '';
  root.querySelector('[data-notebook-notes]').checked = false;
  paint();
}
function companies() {
  const groups = new Map();
  for (const entry of notebook.all()) {
    const key = companyKey(entry);
    const group = groups.get(key) || { key, name: companyName(entry), ticker: entry.ticker, count: 0 };
    group.count++; groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function paint() {
  if (!ctxRef) return;
  ctxRef.root.querySelector('[data-notebook-state]').hidden = true;
  ctxRef.root.querySelector('[data-notebook-layout]').hidden = false;
  const kinds = [...new Set(notebook.all().map(entry => entry.kind))].sort();
  if (view.kind && !kinds.includes(view.kind)) kinds.push(view.kind);
  const select = ctxRef.root.querySelector('[data-notebook-kind]');
  select.innerHTML = '<option value="">All event types</option>' + kinds.map(kind => `<option value="${esc(kind)}">${esc(kind)}</option>`).join('');
  select.value = view.kind;
  paintCompanies(); paintResults();
}
function paintCompanies() {
  if (!ctxRef) return;
  const groups = companies(), root = ctxRef.root;
  const button = group => `<button type="button" data-notebook-company="${esc(group.key)}" aria-pressed="${view.company === group.key}"><span>${esc(group.name)}${group.ticker && group.name !== group.ticker ? `<small>${esc(group.ticker)}</small>` : ''}</span><b>${group.count}</b></button>`;
  const matches = groups.filter(group => `${group.name} ${group.ticker}`.toLowerCase().includes(companySearch.toLowerCase()));
  root.querySelector('[data-notebook-companies]').innerHTML = button({ key: '', name: 'All companies', count: notebook.all().length }) + matches.map(button).join('')
    + (!matches.length && companySearch ? '<p class="notebook-storage-note">No saved company matches.</p>' : '');
  const select = root.querySelector('[data-notebook-company-select]');
  select.innerHTML = '<option value="">All companies</option>' + groups.map(group => `<option value="${esc(group.key)}">${esc(group.name)} (${group.count})</option>`).join('');
  if (view.company && !groups.some(group => group.key === view.company)) select.insertAdjacentHTML('beforeend', `<option value="${esc(view.company)}">Selected company (0)</option>`);
  select.value = view.company;
}
function paintResults() {
  if (!ctxRef) return;
  const root = ctxRef.root, all = notebook.all(), rows = filterBookmarks(all, view);
  const company = companies().find(group => group.key === view.company)?.name;
  root.querySelector('[data-notebook-count]').textContent = `${rows.length} saved event${rows.length === 1 ? '' : 's'}${company ? ` · ${company}` : ''}`;
  root.querySelector('[data-notebook-clear]').hidden = !(view.query || view.company || view.kind || view.notesOnly);
  root.querySelector('[data-notebook-results]').innerHTML = rows.length ? rows.slice(0, limit).map(entry => `
    <article class="notebook-card" data-notebook-entry="${esc(entry.id)}">
      <div class="notebook-card-top"><span class="notebook-company-name">${esc(companyName(entry))}${entry.ticker && entry.ticker !== entry.company ? `<small>${esc(entry.ticker)}</small>` : ''}</span>${bookmarkButton(entry)}</div>
      <div class="notebook-card-meta"><span>${esc(entry.kind)}</span><span>${esc(date(entry.eventDate))}</span>${entry.source ? `<span>${esc(entry.source)}</span>` : ''}</div>
      <h3><button type="button" data-notebook-open="${esc(entry.id)}">${esc(entry.title)}</button></h3>
      ${entry.body ? `<p class="notebook-excerpt">${esc(entry.body)}</p>` : ''}
      ${entry.note ? `<p class="notebook-note-preview"><strong>Your note</strong> ${esc(entry.note)}</p>` : ''}
      <footer><span>Saved ${esc(date(entry.savedAt))}</span><div><button type="button" data-notebook-open="${esc(entry.id)}">${entry.note ? 'Read & edit note' : 'Read & add note'}</button>${entry.url ? `<a href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">Source ↗</a>` : ''}</div></footer>
    </article>`).join('') + (rows.length > limit ? `<button type="button" data-notebook-more class="notebook-action notebook-more">Show ${Math.min(30, rows.length - limit)} more · ${rows.length - limit} remaining</button>` : '')
    : `<div class="notebook-empty">${BOOKMARK_ICON}<h3>${all.length ? 'No bookmarks match these filters' : 'Your next insight starts here'}</h3><p>${all.length ? 'Try another company or event type, or clear your filters.' : 'Tap the bookmark beside any event in the dashboard. Its saved copy and your notes will be waiting here, even after the event is archived.'}</p>${all.length ? '<button type="button" class="notebook-action" data-notebook-empty-clear>Clear filters</button>' : '<a class="notebook-action" href="#/research/daily-alerts">Explore All Alerts →</a>'}</div>`;
}
function openEntry(id) {
  const entry = notebook.get(id); if (!entry) return;
  openModal(`<div class="notebook-detail">
    <div class="notebook-detail-heading"><span>${esc(companyName(entry))} · ${esc(entry.kind)}</span><button type="button" data-modal-close aria-label="Close bookmark">×</button></div>
    <h2>${esc(entry.title)}</h2><p class="notebook-card-meta">${esc(date(entry.eventDate))}${entry.source ? ` · ${esc(entry.source)}` : ''}</p>
    <p class="notebook-storage-note">Saved ${esc(date(entry.savedAt))}. This is the copy you bookmarked; linked articles and documents remain at their source.</p>
    ${entry.body ? `<div class="notebook-snapshot">${esc(entry.body)}</div>` : ''}
    ${entry.details.length ? `<dl class="notebook-facts">${entry.details.map(item => `<div><dt>${esc(item.label)}</dt><dd>${esc(item.value)}</dd></div>`).join('')}</dl>` : ''}
    ${entry.url ? `<a class="notebook-source" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">Open original source ↗</a>` : ''}
    ${entry.links.map(link => `<a class="notebook-source" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label)} ↗</a>`).join('')}
    <form data-notebook-note-form><label for="notebook-note">Your research note</label><textarea id="notebook-note" placeholder="Why does this matter? What should you follow up on?">${esc(entry.note)}</textarea>
      <div class="notebook-note-actions"><span data-notebook-note-status role="status"></span><button class="notebook-action" type="submit">Save note</button></div>
    </form></div>`, { size: 'wide' });
  const form = document.querySelector('[data-notebook-note-form]');
  form.onsubmit = async event => {
    event.preventDefault(); const button = form.querySelector('button'), status = form.querySelector('[data-notebook-note-status]');
    button.disabled = true;
    try { await notebook.updateNote(id, form.querySelector('textarea').value); status.textContent = 'Note saved'; }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };
  form.querySelector('textarea').oninput = () => { form.querySelector('[data-notebook-note-status]').textContent = 'Unsaved changes'; };
}
