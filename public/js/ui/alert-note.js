// ui/alert-note.js — how the "So what?" line reads, on a card and on a row.
//
// One drawing for one reading, so AI Alerts and All Alerts cannot disagree about which state is a
// note: only `ready` prints model text; a question on its way pulses; an absent note prints its
// reason, muted. See data/alert-notes.js for the states and data/alert-notes-shared.js for what the
// model is allowed to say.
import { escapeHtml } from '../core/dom.js';
import { noteState, reasonText } from '../data/alert-notes.js';

/** The disclosure every surface carries beside an AI note — in a title, a banner or an export. */
export const NOTE_DISCLOSURE = 'Written by an AI model from the source statement shown, and nothing else. It is a possibility, not a forecast, a price call or a recommendation, and it may be wrong — the source is one click away.';

/** The note's body for a card. `request` is `noteRequestFor(...)`; null draws nothing. */
export function noteBodyHtml(request) {
  if (!request) return '';
  const state = noteState(request);
  if (state?.state === 'ready') {
    return `<span data-note-state="ready">${escapeHtml(state.note)}</span>`;
  }
  if (state?.state === 'missing') {
    return `<span data-note-state="missing" class="text-xs font-medium text-slate-400">${escapeHtml(reasonText(state.reason))}</span>`;
  }
  return `<span data-note-state="pending" class="inline-block h-3.5 w-3/4 animate-pulse rounded bg-slate-100 align-middle" aria-label="Reading what this could change"></span>`;
}

/** The note as one line under a table row — drawn only once there is a note to draw. */
export function noteRowHtml(request) {
  const state = request ? noteState(request) : null;
  if (state?.state !== 'ready') return '';
  return `<div data-alert-note="${escapeHtml(request.handle)}" class="mt-0.5 truncate text-xs text-indigo-900" title="${escapeHtml(`So what? (AI) — ${state.note}\n\n${NOTE_DISCLOSURE}`)}"><span class="font-bold text-indigo-700">So what? · AI</span> ${escapeHtml(state.note)}</div>`;
}

/** The note's text for an export cell, or its reason in brackets, or empty when nobody asked. */
export function noteExportText(request) {
  const state = request ? noteState(request) : null;
  if (state?.state === 'ready') return state.note;
  if (state?.state === 'missing') return `[${reasonText(state.reason)}]`;
  return '';
}
