// One quiet inbox in the header. Arrivals update the bell; only the reader opens the list.
import { escapeHtml } from '../core/dom.js';
import { formatRelativeTime } from '../core/format.js';
import { createInbox, STORAGE_KEY } from '../core/notification-inbox.js';
import { onHostContext } from '../core/host-context.js';

const inbox = createInbox();
const LABELS = { earnings: 'Result filed', concall: 'Con-call', chatter: 'Chatter', news: 'Market news', research: 'Ask Research', system: 'Update' };
const icon = path => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const CLOSE = icon('<path d="m6 6 12 12M6 18 18 6"/>');
const CHECK = icon('<path d="m5 12 4 4L19 6"/>');
export const bellHtml = `<button type="button" class="notification-bell" data-notification-bell aria-label="Notifications" title="Notifications" aria-haspopup="dialog" aria-controls="notification-root" aria-expanded="false">
  ${icon('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>')}
  <span class="notification-bell-dot" data-notification-dot hidden aria-hidden="true"></span>
</button>`;
let root = null, bell = null, limit = 30;
const nodes = new Map();
export const items = () => inbox.items();
export const unreadCount = () => items().filter(row => row.readAt == null).length;
export const visibleCount = () => root && !root.hidden ? root.querySelectorAll('[data-notification]').length : 0;
export const announcedCount = () => inbox.announcedCount();
export const push = value => inbox.push(value);
export const suppress = keys => inbox.suppress(keys);
export const clear = () => inbox.clear();

export function mount() {
  if (root?.isConnected) return root;
  root = document.createElement('section');
  root.id = 'notification-root'; root.className = 'notification-panel'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Notifications');
  root.innerHTML = `<div class="notification-heading"><h2>Notifications</h2><button type="button" data-notification-all>Mark all as read</button><button type="button" class="notification-icon-button" data-notification-panel-close aria-label="Close notifications">${CLOSE}</button></div>
    <div class="notification-list" data-notification-list><div data-notification-items></div><p class="notification-empty" data-notification-empty>You’re all caught up.<span>New updates will appear here.</span></p><button type="button" class="notification-more" data-notification-more hidden>Show older updates</button></div>
    <p class="notification-storage" data-notification-storage>Read status saved on this device</p>`;
  document.body.appendChild(root);
  root.querySelector('[data-notification-all]').onclick = () => inbox.read(items().map(row => row.id));
  root.querySelector('[data-notification-panel-close]').onclick = () => close(true);
  root.querySelector('[data-notification-more]').onclick = () => { limit += 30; paint(); };
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-notification-action]');
    if (action?.getAttribute('aria-disabled') === 'true') return;
    const row = action?.closest('[data-notification-id]');
    if (!row) return;
    const id = row.dataset.notificationId;
    if (action.dataset.notificationAction === 'dismiss') {
      const focus = row.nextElementSibling?.querySelector('[data-notification-action]') || row.previousElementSibling?.querySelector('[data-notification-action]');
      inbox.dismiss(id); (focus || root.querySelector('[data-notification-panel-close]')).focus();
    } else {
      inbox.read([id]);
      if (action.dataset.notificationAction === 'open') close(false);
    }
  });
  document.addEventListener('pointerdown', event => { if (!root.hidden && !root.contains(event.target) && !bell?.contains(event.target)) close(false); });
  document.addEventListener('focusin', event => { if (!root.hidden && !root.contains(event.target) && !bell?.contains(event.target)) close(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !root.hidden) { event.preventDefault(); close(true); } });
  window.addEventListener('hashchange', () => close(false));
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position);
  window.addEventListener('storage', event => { if (event.key === STORAGE_KEY) inbox.sync(event.newValue); });
  window.addEventListener('pagehide', () => inbox.flush());
  document.addEventListener('visibilitychange', () => { if (document.hidden) inbox.flush(); });
  inbox.onChange(paint);
  onHostContext((_context, changed) => { if (changed?.session) inbox.clearPrivate(); });
  paint(); return root;
}

export function mountBell(button) {
  mount(); bell = button;
  const toggle = () => root.hidden ? open() : close(true);
  button.addEventListener('click', toggle); paint();
  return () => { button.removeEventListener('click', toggle); close(false); if (bell === button) bell = null; };
}
function open() {
  if (!bell) return;
  root.hidden = false; limit = 30; paint(); position();
  root.querySelector('[data-notification-list]').scrollTop = 0;
  root.querySelector('[data-notification-panel-close]').focus();
}
function close(restoreFocus) {
  if (!root || root.hidden) return;
  root.hidden = true; bell?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) bell?.focus();
}
function position() {
  if (!root || root.hidden || !bell) return;
  const rect = bell.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight) { close(false); return; }
  const width = Math.min(420, innerWidth - 24), top = Math.min(rect.bottom + 10, Math.max(12, innerHeight - 240));
  root.style.width = `${width}px`;
  root.style.left = `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`;
  root.style.top = `${top}px`;
  root.style.maxHeight = `${Math.max(160, Math.min(560, innerHeight - top - 12))}px`;
}
function card(row) {
  const node = document.createElement('article');
  node.className = 'notification-item'; node.dataset.notification = row.kind; node.dataset.notificationId = row.id;
  const title = row.href
    ? `<a data-notification-action="open" data-notification-link href="${escapeHtml(row.href)}" ${row.href.startsWith('https:') ? 'target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(row.title)}</a>`
    : `<button type="button" data-notification-action="read">${escapeHtml(row.title)}</button>`;
  node.innerHTML = `<span class="notification-unread-dot" data-notification-unread aria-label="Unread"></span>
    <div class="notification-copy"><div class="notification-meta"><span>${escapeHtml(LABELS[row.kind] || LABELS.system)}</span><time data-notification-time datetime="${new Date(row.at).toISOString()}">${escapeHtml(formatRelativeTime(row.at))}</time></div>
    <h3>${title}</h3>${row.detail ? `<p>${escapeHtml(row.detail)}</p>` : ''}
    ${row.image ? `<img class="notification-thumbnail" src="${escapeHtml(row.image)}" alt="" loading="lazy" decoding="async">` : ''}</div>
    <div class="notification-actions"><button type="button" class="notification-icon-button" data-notification-action="read" data-notification-read aria-label="Mark as read: ${escapeHtml(row.title)}" title="Mark as read">${CHECK}</button><button type="button" class="notification-icon-button" data-notification-action="dismiss" data-notification-close aria-label="Dismiss: ${escapeHtml(row.title)}" title="Dismiss">${CLOSE}</button></div>`;
  node.querySelector('img')?.addEventListener('error', event => { event.target.hidden = true; });
  return node;
}
function paint() {
  const rows = items(), unread = rows.filter(row => row.readAt == null).length;
  if (bell) {
    bell.querySelector('[data-notification-dot]').hidden = !unread;
    bell.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
    bell.setAttribute('aria-expanded', String(!!root && !root.hidden));
  }
  // A dismissed/private-session item must leave the DOM even when the panel is closed.
  const retained = new Set(rows.map(row => row.id));
  for (const [id, node] of nodes) if (!retained.has(id)) { node.remove(); nodes.delete(id); }
  if (!root || root.hidden) return;
  const list = root.querySelector('[data-notification-list]'), container = root.querySelector('[data-notification-items]');
  const anchor = [...container.children].find(node => node.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const visible = rows.slice(0, limit), wanted = new Set(visible.map(row => row.id));
  for (const [id, node] of nodes) if (!wanted.has(id)) { node.remove(); nodes.delete(id); }
  let cursor = container.firstElementChild;
  for (const row of visible) {
    let node = nodes.get(row.id);
    if (!node) { node = card(row); nodes.set(row.id, node); }
    if (cursor !== node) container.insertBefore(node, cursor); else cursor = cursor.nextElementSibling;
    node.dataset.read = String(row.readAt != null);
    node.querySelector('[data-notification-unread]').hidden = row.readAt != null;
    const read = node.querySelector('[data-notification-read]');
    read.setAttribute('aria-label', `${row.readAt != null ? 'Read' : 'Mark as read'}: ${row.title}`);
    read.title = row.readAt != null ? 'Read' : 'Mark as read';
    read.setAttribute('aria-disabled', String(row.readAt != null));
    node.querySelector('[data-notification-time]').textContent = formatRelativeTime(row.at);
  }
  if (anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  root.querySelector('[data-notification-empty]').hidden = !!rows.length;
  root.querySelector('[data-notification-more]').hidden = rows.length <= limit;
  const all = root.querySelector('[data-notification-all]'); all.disabled = !unread;
  root.querySelector('[data-notification-storage]').textContent = inbox.saved() ? 'Read status saved on this device' : 'New updates are saved for this visit only';
}
