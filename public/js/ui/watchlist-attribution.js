// ui/watchlist-attribution.js — WHO IS ADDING THIS, ASKED ONCE AND REMEMBERED.
//
//   const by = await askContributor({ ticker, company });   // a name, or null if they backed out
//
// THE WATCHLIST IS SHARED, SO AN ADD IS SOMETHING EVERYONE ELSE WILL SEE.
//   The desk asked for the name of whoever adds a company, so that the rest of them know who put it
//   there. That makes attribution part of the act rather than a setting: the prompt is on the ADD,
//   and `data/watchlist-shared.js` refuses an unattributed add so a second entry point cannot
//   quietly skip it.
//
// AND IT MUST NOT BE A TAX ON EVERY STAR.
//   Typing a name forty times a week is exactly the friction that makes people stop starring
//   things. So the first add types it and every add after it is a SELECTION: the dropdown carries
//   everyone who has ever added to this list, the person who used this browser last is already
//   chosen, and the whole interaction is Enter. The roster is shared (`core/watchlist-people.js`),
//   so a new phone opens with the desk's names already in the list rather than an empty box that
//   invites a second spelling of a name that is already there.
//
// A PRESELECTED NAME IS A DEFAULT, NEVER AN ASSUMPTION.
//   It is always visible and always changeable before the add lands, because two people share a
//   desk and a machine. Silently filing under whoever used the browser last would put one person's
//   name on another person's work — worse than asking, and invisible once it happened.

import { escapeHtml } from '../core/dom.js';
import { openModal, closeModal } from './screener.js';
import * as people from '../core/watchlist-people.js';
import { WATCHLIST_PERSON_MAX, personKey, personName } from '../data/watchlist-shared.js';

const NEW_NAME = '__new__';
const NOBODY = '';

function optionsHtml(roster, selectedKey) {
  return roster
    .map((person) => {
      const key = personKey(person.name);
      // `pending` is a name this browser has used that the shared list has not acknowledged yet —
      // the same distinction the X handle list draws between `adding` and `active`. It is offered
      // either way; it just does not claim to be something everybody can already see.
      const note = person.origin === 'pending' ? ' (not sent yet)' : '';
      return `<option value="${escapeHtml(key)}"${key === selectedKey ? ' selected' : ''}>${escapeHtml(person.name)}${note}</option>`;
    })
    .join('');
}

function dialogHtml({ ticker, company, roster, mine }) {
  // A DEVICE NOBODY HAS IDENTIFIED THEMSELVES ON PRESELECTS NOBODY.
  //
  // Falling back to the top of the roster looks helpful and is the one genuinely damaging default
  // here: the top of the roster is whoever added most recently ANYWHERE on the desk, so a colleague
  // opening the dashboard on a new phone and pressing Enter would file their add under that
  // person's name — one person's name on another person's work, invisible the moment it happened.
  // Once this browser HAS been used, its own last name is a real answer and is preselected, which
  // is what makes the second add onwards a single key.
  const selectedKey = personKey(mine);
  const hasRoster = roster.length > 0;
  const unidentified = hasRoster && !selectedKey;
  const subject = company || ticker;
  return `
    <div data-watch-attribution class="px-6 py-5">
      <div class="text-[11px] font-bold uppercase tracking-wider text-indigo-500">Shared watchlist</div>
      <h2 class="font-display mt-1 text-xl font-extrabold text-slate-900">Who is adding this?</h2>
      <p class="mt-1 text-sm leading-relaxed text-slate-500">
        Everyone on this dashboard sees the same watchlist, so
        <span class="font-semibold text-slate-700">${escapeHtml(subject)}</span>${company && ticker && company !== ticker ? ` <span class="text-slate-400">(${escapeHtml(ticker)})</span>` : ''}
        will be listed with your name beside it.
      </p>

      <div class="mt-5">
        <label for="watch-attribution-who" class="text-xs font-bold uppercase tracking-wider text-slate-400">Added by</label>
        <select id="watch-attribution-who" data-attribution-select
          class="mt-2 w-full rounded-xl bg-white px-3 py-2.5 text-sm font-semibold text-slate-800 ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-indigo-300 ${hasRoster ? '' : 'hidden'}">
          ${unidentified ? `<option value="${NOBODY}" selected>Select your name…</option>` : ''}
          ${optionsHtml(roster, selectedKey)}
          <option value="${NEW_NAME}">+ Add a new name…</option>
        </select>

        <div data-attribution-new class="${hasRoster ? 'hidden ' : ''}mt-2">
          <label for="watch-attribution-name" class="sr-only">Your name</label>
          <input id="watch-attribution-name" data-attribution-input type="text" autocomplete="name"
            maxlength="${WATCHLIST_PERSON_MAX}" placeholder="Type your name"
            class="w-full rounded-xl bg-white px-3 py-2.5 text-sm text-slate-800 ring-1 ring-slate-200 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-300" />
          <p class="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            Saved for next time — you will be able to pick it from the list instead of typing it.
          </p>
        </div>
        <p data-attribution-error role="alert" class="mt-2 hidden text-xs font-semibold text-rose-600"></p>
      </div>

      <div class="mt-6 flex items-center justify-end gap-2">
        <button type="button" data-attribution-cancel
          class="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition hover:bg-slate-100">Cancel</button>
        <button type="button" data-attribution-confirm
          class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700">Add to watchlist</button>
      </div>
    </div>`;
}

/**
 * Ask who is making this addition.
 *
 * Resolves to the name, or to **null** if the reader backed out — and a null must be treated as
 * "do not add", never as an unattributed add. Cancelling a prompt is an answer.
 */
export function askContributor({ ticker = '', company = '' } = {}) {
  const roster = people.roster();
  const mine = people.me();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    openModal(dialogHtml({ ticker, company, roster, mine }), {
      size: 'default',
      // Dismissing by ESC or backdrop is a cancel, so the company is not added. Resolving here
      // rather than only on the buttons is what stops a dismissed dialog leaving a caller awaiting
      // a promise that never settles — an add that neither happens nor reports why.
      onClose: () => finish(null),
    });

    const root = document.querySelector('[data-watch-attribution]');
    if (!root) {
      // `openModal` returns silently when the page carries no overlay roots, so the prompt never
      // rendered. Resolving null is the safe answer — nothing is added, and nothing is added
      // anonymously — but a star that does nothing is the exact shape of bug this codebase treats
      // as worse than a loud one, so it says so rather than just failing closed.
      console.warn('[watchlist] no modal overlay roots on this page, so the contributor prompt could not open; nothing was added.');
      return finish(null);
    }
    const select = root.querySelector('[data-attribution-select]');
    const newBox = root.querySelector('[data-attribution-new]');
    const input = root.querySelector('[data-attribution-input]');
    const error = root.querySelector('[data-attribution-error]');
    const confirm = root.querySelector('[data-attribution-confirm]');

    const typing = () => !roster.length || select.value === NEW_NAME;

    const showTyping = () => {
      newBox.classList.toggle('hidden', !typing());
      if (typing()) input.focus();
    };

    select?.addEventListener('change', () => {
      error.classList.add('hidden');
      showTyping();
    });

    const submit = () => {
      // An unmade choice is not a name. It reports what is missing and adds nothing, rather than
      // resolving to whoever happens to sit at the top of the list.
      if (roster.length && select.value === NOBODY) {
        error.textContent = 'Select who is adding this company, or add a new name.';
        error.classList.remove('hidden');
        select.focus();
        return;
      }
      const chosen = typing() ? input.value : roster.find((p) => personKey(p.name) === select.value)?.name;
      const name = personName(chosen);
      if (!name) {
        error.textContent = 'Please enter the name to record against this company.';
        error.classList.remove('hidden');
        input.focus();
        return;
      }
      finish(name);
      closeModal();
    };

    confirm?.addEventListener('click', submit);
    root.querySelector('[data-attribution-cancel]')?.addEventListener('click', () => {
      finish(null);
      closeModal();
    });
    // Enter anywhere in the dialog confirms, so the common case — the right name already selected —
    // is one key. That is the whole difference between attribution people keep up and attribution
    // they work around.
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submit();
    });

    if (!roster.length) {
      input?.focus();
    } else if (select.value === NOBODY) {
      // Nothing is preselected, so the dropdown takes focus: there is a choice to make and the
      // confirm button would only refuse until it is made.
      select.focus();
    } else {
      showTyping();
      // The confirm button takes focus rather than the dropdown, because the name this browser
      // last used is right most of the time and this makes accepting it a single key.
      confirm?.focus();
    }
  });
}

/**
 * The name to attribute an add to, asking only when there is a choice to make.
 *
 * Exported separately so a caller that is adding SEVERAL companies at once asks once rather than
 * once per company.
 */
export async function contributorFor(subject) {
  return askContributor(subject);
}
