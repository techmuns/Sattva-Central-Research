// ui/visual.js — the visual vocabulary shared by every screener surface.
//
// These are pure, dependency-free functions: same input, same markup, no DOM access. They are
// the single source of truth for what a company avatar looks like, how a score maps to a
// colour, and what a rule outcome chip says. Tabs, the top-card grid, the table and the drill
// panel all call these so the language stays identical everywhere.
//
// Colour discipline: emerald / amber / rose here are SEMANTIC (pass / partial / fail) — they
// describe a rule outcome, never the brand. Brand colour is indigo→purple→pink and lives in
// the chrome, gradients and hero cards.

import { escapeHtml } from '../core/dom.js';

// Twelve gradient pairs. A company's avatar colour is a stable hash of its name, so the same
// company keeps the same colour across tabs and reloads without storing anything.
const PALETTE = [
  'from-purple-500 to-indigo-500',
  'from-pink-500 to-rose-500',
  'from-amber-500 to-orange-500',
  'from-emerald-500 to-teal-500',
  'from-blue-500 to-cyan-500',
  'from-fuchsia-500 to-pink-500',
  'from-violet-500 to-purple-500',
  'from-lime-500 to-emerald-500',
  'from-sky-500 to-indigo-500',
  'from-red-500 to-pink-500',
  'from-yellow-500 to-amber-500',
  'from-teal-500 to-cyan-500',
];

// Deterministic avatar for a company name → { color (Tailwind gradient pair), initials }.
export function avatarFor(name) {
  const safe = String(name ?? '');
  let h = 0;
  for (let i = 0; i < safe.length; i++) h = (h * 31 + safe.charCodeAt(i)) >>> 0;
  const color = PALETTE[h % PALETTE.length];
  const initials =
    safe
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || '')
      .join('')
      .toUpperCase()
      .slice(0, 2) || '?';
  return { color, initials };
}

// Percentage score (0–100) → tier key. The one place the band cut-offs are defined.
export function scoreTier(pct) {
  if (pct >= 80) return 'excellent';
  if (pct >= 60) return 'good';
  if (pct >= 40) return 'average';
  return 'weak';
}

// Percentage score → Tailwind classes for the table's score pill.
export function scoreBadgeClass(pct) {
  if (pct >= 80) return 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200';
  if (pct >= 60) return 'bg-blue-100 text-blue-700 ring-1 ring-blue-200';
  if (pct >= 40) return 'bg-amber-100 text-amber-700 ring-1 ring-amber-200';
  return 'bg-rose-100 text-rose-700 ring-1 ring-rose-200';
}

// Tier key → human label.
export function tierLabel(tier) {
  return { excellent: 'Excellent', good: 'Good', average: 'Average', weak: 'Weak', hardfail: 'Hard Fail' }[tier] || '';
}

// Tier key → text colour class for the big number on top cards and the drill header.
export function tierColor(tier) {
  return (
    {
      excellent: 'text-emerald-600',
      good: 'text-blue-600',
      average: 'text-amber-600',
      weak: 'text-rose-600',
      hardfail: 'text-rose-700',
    }[tier] || 'text-slate-600'
  );
}

// Rule-outcome chip. `status` is one of: pass | partial | fail | hard_fail | na.
export function statusPill(status) {
  switch (status) {
    case 'pass':
      return `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">✓ Pass</span>`;
    case 'partial':
      return `<span class="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">Mixed</span>`;
    case 'fail':
      return `<span class="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">✕ Fail</span>`;
    case 'hard_fail':
      return `<span class="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800 ring-1 ring-rose-300">⚠ Hard Fail</span>`;
    case 'na':
      return `<span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">— N/A</span>`;
    default:
      return '';
  }
}

// Dot colour per status — used by the table's Signals column and the legend so the two
// always agree.
export const STATUS_DOT = {
  pass: 'bg-emerald-500',
  partial: 'bg-amber-400',
  fail: 'bg-rose-400',
  hard_fail: 'bg-rose-600',
  na: 'bg-slate-300',
};

// A compact run of up to `max` status dots. `signals` is `[{ label, status }]`.
export function signalDots(signals = [], max = 8) {
  const face = (status) => (status === 'partial' ? 'mixed' : status);
  return signals
    .slice(0, max)
    .map(
      (s) =>
        `<span class="h-1.5 w-1.5 rounded-full ${STATUS_DOT[s.status] || STATUS_DOT.na}" title="${escapeHtml(s.label)}: ${escapeHtml(face(s.status))}"></span>`
    )
    .join('');
}

// The legend strip that sits at the bottom of every tab rendering signal dots. Keeping it here
// (next to STATUS_DOT) is what stops the legend drifting from the dots it explains.
export function legendStrip({ note = '' } = {}) {
  const item = (dotClass, label) =>
    `<div class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full ${dotClass}"></span> ${escapeHtml(label)}</div>`;
  return `
    <section class="mt-6 rounded-2xl bg-white/60 p-4 ring-1 ring-slate-100">
      <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Legend</div>
      <div class="flex flex-wrap gap-4 text-xs text-slate-600">
        ${item(STATUS_DOT.pass, 'Pass')}
        ${item(STATUS_DOT.partial, 'Mixed')}
        ${item(STATUS_DOT.fail, 'Fail')}
        ${item(STATUS_DOT.hard_fail, 'Hard Fail (red flag)')}
        ${item(STATUS_DOT.na, 'N/A — see drill-down for reason')}
      </div>
      ${note ? `<div class="mt-2 text-[11px] leading-relaxed text-slate-400">${escapeHtml(note)}</div>` : ''}
    </section>`;
}

// Small monoline icons reused across the kit.
export const ICON_LINK = `<svg class="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>`;
export const ICON_SEARCH = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`;
export const ICON_BOOK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>`;
