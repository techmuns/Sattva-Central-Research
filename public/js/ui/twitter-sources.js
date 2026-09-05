// ui/twitter-sources.js — "Edit Twitter Sources", opened from the source beacon.
//
//   openTwitterSources()   the modal: add a handle, see what is monitored, remove one
//
// ONE SCREEN, THREE CONTROLS, AND NOTHING ELSE. There is no per-account configuration, no schedule
// picker and no filter: the whole feature is a list of accounts whose posts join the News feed, so
// the screen is a list of accounts.
//
// WHAT IT MAY SAY, AND WHAT IT MAY NOT.
//   • `Adding…` while a run is being asked for, `Active` once the ingestion job's own capture names
//     the handle, `Account not found` when that job reported it could not read the account. Those
//     are three different facts and the middle one is the only one this browser can establish on
//     its own — see core/twitter-handles.js.
//   • A handle this browser has added but the job has not picked up yet is `Adding…`, not `Active`.
//     Saying "active" over an account nothing is reading yet is the same class of claim as a green
//     Live pill over data nobody confirmed.
//   • NO SCRAPER VOCABULARY REACHES THE READER. Cookies, sessions, rate limits, API terms and
//     status codes stay in the log. What is shown is what it means for their list.
//
// The chrome is the dashboard's own: `openModal` from the screener kit, the same rounded-2xl
// surfaces, the same indigo actions and rose removes as the scope editor next door.

import { openModal, closeModal } from './screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import * as handles from '../core/twitter-handles.js';
import * as twitterNews from '../data/twitter-news.js';

const STATUS = {
  active: { label: 'Active', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  adding: { label: 'Adding…', cls: 'bg-amber-50 text-amber-700 ring-amber-200' },
  disconnected: { label: 'Not connected', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
  'not-found': { label: 'Account not found', cls: 'bg-rose-50 text-rose-700 ring-rose-200' },
};

// The result of the last add or remove, held across the repaint it causes. Module state rather
// than node state: the list rebuilds on every change and a value on a node would not survive it.
let notice = null;

function rowHtml(entry, counts) {
  const s = STATUS[entry.status] || STATUS.adding;
  const posts = counts.get(entry.key) || 0;
  return `
    <li class="flex items-center gap-3 border-t border-slate-100 px-4 py-2.5 first:border-t-0">
      <span class="min-w-0 flex-1">
        <span class="font-semibold text-slate-800">@${escapeHtml(entry.handle)}</span>
        ${
          posts
            ? `<span class="ml-2 text-xs text-slate-400">${escapeHtml(formatNumber(posts))} post${posts === 1 ? '' : 's'} in the feed</span>`
            : entry.status === 'active'
              ? '<span class="ml-2 text-xs text-slate-400">no posts captured yet</span>'
              : ''
        }
        ${entry.reason ? `<span class="ml-2 text-xs text-rose-500">${escapeHtml(entry.reason)}</span>` : ''}
      </span>
      <span class="inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${s.cls}">${escapeHtml(s.label)}</span>
      <button type="button" data-tw-remove="${escapeHtml(entry.handle)}"
        class="flex-shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50">Remove</button>
    </li>`;
}

function bodyHtml() {
  const failed = twitterNews.failedByKey();
  const m = twitterNews.meta();
  // `collected` is whether ANY capture exists, not whether this handle is in the committed list —
  // see the note on handles.all(). A run that added a handle and then could not sign in must not
  // leave it reading Active.
  const list = handles.all({ failed, collected: !!m.capturedAt }).map(entry =>
    m.reason || m.lastReadFailed || !m.capturedAt ? { ...entry, status: 'disconnected', reason: null } : entry);
  const counts = twitterNews.countsByHandle();

  return `
    <div data-twitter-sources class="px-7 py-6">
      <div class="mb-1 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-xl font-bold text-slate-900">Twitter / X Sources</h2>
          <p class="mt-1 text-sm text-slate-500">Add accounts whose posts should appear in your News feed, alongside the publisher stories.</p>
        </div>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">&times;</button>
      </div>

      <form data-tw-add class="mt-4 flex flex-wrap items-center gap-2">
        <input type="text" data-tw-input placeholder="@Reuters" autocomplete="off" spellcheck="false"
          aria-label="Twitter handle"
          class="min-w-[200px] flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        <button type="submit"
          class="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">
          <span aria-hidden="true">+</span><span>Add Handle</span>
        </button>
      </form>
      <p class="mt-1.5 text-xs ${notice?.error ? 'text-rose-600' : 'text-slate-400'}" data-tw-notice>${
        notice ? escapeHtml(notice.error || notice.text) : 'Paste @Reuters, Reuters or an x.com profile link — all three become the same handle.'
      }</p>

      <h3 class="font-display mt-5 text-sm font-bold text-slate-900">
        Currently monitored${list.length ? ` <span class="font-medium text-slate-400">· ${escapeHtml(formatNumber(list.length))}</span>` : ''}
      </h3>
      ${
        list.length
          ? `<ul class="mt-2 overflow-hidden rounded-xl bg-slate-50 ring-1 ring-slate-200/70">${list.map((e) => rowHtml(e, counts)).join('')}</ul>`
          : `<p class="mt-2 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500 ring-1 ring-slate-200/70">
               No accounts yet. Add one above and its posts will join the News feed.
             </p>`
      }

      <p class="mt-4 text-xs leading-relaxed text-slate-400">
        ${
          m.capturedAt
            ? `Posts were last collected <strong class="text-slate-500">${escapeHtml(formatRelativeTime(Date.parse(m.capturedAt)))}</strong>, and ${escapeHtml(formatNumber(m.count))} are in the feed now.`
            : 'No posts have been collected yet.'
        }
        An account you add here is monitored by this browser straight away; it reads <em>Active</em> once a collection run
        has actually read it. Posts are reproduced as published — nothing here is scored, ranked or summarised.
      </p>
    </div>`;
}

function repaint() {
  const host = document.getElementById('modal-content');
  if (!host || !host.querySelector('[data-twitter-sources]')) return;
  const input = host.querySelector('[data-tw-input]');
  const kept = input?.value || '';
  const hadFocus = document.activeElement === input;
  host.innerHTML = bodyHtml();
  wire();
  const next = host.querySelector('[data-tw-input]');
  if (next) {
    next.value = kept;
    if (hadFocus) next.focus();
  }
}

function wire() {
  const host = document.getElementById('modal-content');
  if (!host) return;
  host.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', () => closeModal()));

  const form = host.querySelector('[data-tw-add]');
  const input = host.querySelector('[data-tw-input]');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = input?.value || '';
    const out = handles.add(raw);
    if (out.error) {
      notice = { error: out.error };
      repaint();
      // The refused value stays in the box: retyping a long URL to fix one character is a punishment.
      const again = document.getElementById('modal-content')?.querySelector('[data-tw-input]');
      if (again) {
        again.value = raw;
        again.focus();
      }
      return;
    }
    notice = { text: `@${out.handle} added. Its posts will appear in News once a collection run has read it.` };
    if (input) input.value = '';
    repaint();
    // handles.add() already emitted, so the News list has re-rendered. Asking the collector to run
    // is a separate, explicit act and is the only thing here that costs anybody anything.
    requestCollection(out.handle);
  });

  host.querySelectorAll('[data-tw-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const out = handles.remove(btn.getAttribute('data-tw-remove'));
      notice = out.handle ? { text: `@${out.handle} removed. Its posts are no longer in the feed.` } : null;
      repaint();
    });
  });
}

/**
 * Ask the collector to read the new account now, rather than waiting for the next scheduled run.
 *
 * THE ONE CALL HERE THAT STARTS WORK SOMEWHERE ELSE, and it obeys the same rules as the News tab's
 * Fetch button (see js/data/market-news.js): POST-only so nothing can trip it by prefetching, never
 * fired on a render or a poll, and declined at the edge when a run is already going.
 *
 * ITS FAILURES ARE NOT SHOWN AS THE HANDLE'S FAILURES. A deployment with no Worker, or without the
 * dispatch credential, cannot start a run — and that is a fact about this deployment, not about the
 * account. The handle stays on the list and reads `Adding…` until a scheduled run picks it up, which
 * is exactly what is true. Turning an operator's missing token into "account not found" would send
 * the reader to check a handle that was perfectly good.
 */
async function requestCollection(handle) {
  try {
    const res = await fetch(`api/twitter/refresh?source=button&handle=${encodeURIComponent(handle)}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    // A static origin answers 501 (python's http.server) or 404/405. None of those is a failure of
    // the handle, and none is worth a sentence on this screen.
    if (!res.ok) return;
    await res.json().catch(() => null);
  } catch {
    // Same: the list is already correct without this having worked.
  }
}

export function openTwitterSources() {
  notice = null;
  // The handle list and the posts are both needed to draw a row's status; both are cheap and
  // idempotent, and the modal repaints when either lands.
  Promise.all([handles.load(), twitterNews.isLoaded() ? null : twitterNews.load()]).then(repaint);
  openModal(bodyHtml(), { size: 'default' });
  wire();
}
