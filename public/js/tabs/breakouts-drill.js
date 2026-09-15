import * as live from '../data/breakout-live.js';
// tabs/breakouts-drill.js — the technicals drill panel.
//
// Split out of breakouts.js because the header's global search opens it from ANY tab: pick a
// company anywhere in the dashboard and you get its 16-rule technical breakdown without
// navigating. Keeping it here avoids a circular import between shell.js and the tab.
//
// The panel renders the scored breakdown grouped into the model's five categories, each rule
// carrying its status pill, measured value, note, points/max badge, and three provenance
// chips (Source · Calculation · Implementation) driven by scoring/rule-meta.js.

import { openDrill } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { RULE_META } from '../scoring/rule-meta.js';
import * as technicals from '../data/technicals.js';

// The model's categories, in the order the client's sheet lists them.
const CATEGORY_ORDER = ['Trend Strength', 'Momentum', 'Volume', 'Breakout', 'Risk'];

const ICON_LINK = `<svg class="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>`;
const ICON_CALC = `<svg class="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 7h6m-6 4h6m-3 4h3M7 21h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2z"/></svg>`;
const ICON_LOGIC = `<svg class="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z"/></svg>`;

// The three provenance chips under each rule card. `Implementation` turns amber when our
// computation deviates from the client's stated logic (rule-meta `ourLogic` is non-null).
function metaChips(ruleKey, company) {
  const meta = RULE_META[ruleKey];
  if (!meta) return '';
  const src = typeof meta.source === 'function' ? meta.source(company || {}) : meta.source;
  const deviates = !!meta.ourLogic;

  const chip = (inner, cls) =>
    `<span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${cls}">${inner}</span>`;

  const sourceChip = src?.url
    ? `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener" data-stop title="${escapeHtml(src.section || '')}"
         class="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 transition-colors hover:bg-indigo-50 hover:text-indigo-700">
         ${ICON_LINK}<span>${escapeHtml(src.label || 'Source')}</span></a>`
    : '';

  return `
    <div class="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
      ${sourceChip}
      ${
        meta.calculation
          ? `<details class="meta-details group inline-block">
               <summary class="cursor-pointer list-none">${chip(`${ICON_CALC}<span>Calculation</span>`, 'bg-slate-100 text-slate-600 hover:bg-slate-200')}</summary>
               <div class="mt-1.5 rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600 ring-1 ring-slate-100">${escapeHtml(meta.calculation)}</div>
             </details>`
          : ''
      }
      <details class="meta-details group inline-block">
        <summary class="cursor-pointer list-none">${chip(
          `${ICON_LOGIC}<span>Implementation</span>`,
          deviates ? 'bg-amber-100 text-amber-800 hover:bg-amber-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
        )}</summary>
        <div class="mt-1.5 space-y-1.5 rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed ring-1 ring-slate-100">
          <div><span class="font-bold text-slate-700">Client logic:</span> <span class="text-slate-600">${escapeHtml(meta.clientLogic)}</span></div>
          ${
            deviates
              ? `<div><span class="font-bold text-amber-800">Our implementation differs:</span> <span class="text-amber-800">${escapeHtml(meta.ourLogic)}</span></div>`
              : `<div class="text-slate-500">Implemented exactly as specified.</div>`
          }
        </div>
      </details>
    </div>`;
}

/**
 * Open the technicals drill for a scored row (as returned by data/technicals.js).
 * Falls back to an honest "no data" panel when the scrape failed for that ticker.
 */
export function openTechnicalsDrill(scored) {
  if (!scored) return;
  const c = scored.company?.dailyCompany || scored.company || {};
  let stopWatching = null, stopDaily = null, closed = false;
  const onClose = () => { closed = true; stopWatching?.(); stopDaily?.(); stopWatching = stopDaily = null; };
  const watchPrice = () => {
    stopDaily = technicals.onChange(() => {
      // Defer replacement until notification finishes, so its new subscription is not
      // visited again by the same Set iteration. Closing in the meantime cancels it.
      queueMicrotask(() => {
        const latest = technicals.byTicker(c.ticker);
        if (closed || !latest || latest === scored) return;
        const panel = document.getElementById('drill-panel'), scroll = panel?.scrollTop;
        openTechnicalsDrill(latest);
        if (panel) panel.scrollTop = scroll;
      });
    });
    stopWatching = live.watch(() => {
      const element = document.querySelector('[data-stat="breakout-price"]');
      if (!element) return;
      const info = live.priceInfo(c);
      element.children[1].textContent = info.price == null ? '—' : `₹${Number(info.price).toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2})}`;
      element.children[2].textContent = live.priceCaption(info);
      element.children[2].className = `text-xs ${info.stale ? 'text-amber-700' : 'text-slate-500'}`;
    });
  };
  const info = live.priceInfo(c);
  const priceStat = {id:'breakout-price',label:'CMP',value:info.price == null ? '—' : `₹${Number(info.price).toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2})}`,caption:live.priceCaption(info),captionWrap:true,tone:'neutral'};
  const tier = scored.hardFails.length ? 'hardfail' : null;

  if (scored.tickerError) {
    openDrill({
      name: c.name || c.ticker || 'Unknown',
      sub: c.ticker || '',
      link: c.screenerUrl || null,
      linkLabel: 'View on Screener.in ↗',
      headerStats: [
        { label: 'Technicals Score', value: 'No data', tone: 'neutral' },
        priceStat,
      ],
      banner: {
        tone: 'slate',
        title: 'No price history for this ticker',
        body: `${scored.tickerError}. Nothing is estimated in its place — the row scores zero of zero and is ranked last.`,
      },
      groups: [], onClose,
    });
    watchPrice();
    return;
  }

  // Group the scored breakdown into the model's five categories.
  const byCategory = new Map();
  for (const b of scored.breakdown) {
    if (!byCategory.has(b.category)) byCategory.set(b.category, []);
    byCategory.get(b.category).push(b);
  }
  const ordered = [...CATEGORY_ORDER.filter((cat) => byCategory.has(cat)), ...[...byCategory.keys()].filter((cat) => !CATEGORY_ORDER.includes(cat))];

  const groups = ordered.map((category) => {
    const items = byCategory.get(category);
    const catPoints = items.reduce((s, b) => s + b.points, 0);
    const catMax = items.reduce((s, b) => s + b.max, 0);
    return {
      category: `${category} · ${fmtPoints(catPoints)}/${catMax}`,
      items: items.map((b) => ({
        label: b.label,
        criteria: b.criteria,
        status: b.status,
        value: b.value || '',
        note: b.note,
        points: fmtPoints(b.points),
        max: b.max,
        extraHtml: metaChips(b.key, c),
      })),
    };
  });

  openDrill({
    name: c.name || c.ticker,
    sub: [c.ticker, c.sector, c.industry].filter(Boolean).join(' · '),
    link: c.screenerUrl || null,
    linkLabel: 'View on Screener.in ↗',
    headerStats: [
      {
        label: 'Daily Technicals Score',
        value: `${fmtPoints(scored.totalPoints)}/${scored.totalMax}`,
        caption: `${scored.scorePct}% · close ${c.price_date || technicals.meta()?.price_date || 'date unavailable'}`,
        tone: tier === 'hardfail' ? 'negative' : scored.scorePct >= 60 ? 'positive' : scored.scorePct >= 40 ? 'caution' : 'negative',
      },
      priceStat,
    ],
    banner: scored.hardFails.length
      ? {
          tone: 'rose',
          title: `Red flag: ${scored.hardFails.join(', ')}`,
          body: "Client framework: 'Price < 200 DMA = immediate fail — stock exits pipeline.' All data is present; this is deliberately surfaced as cautionary.",
        }
      : null,
    groups, onClose,
  });
  watchPrice();
}

/** Open the drill by ticker — used by the header's global search from any tab. */
export function openTechnicalsDrillByTicker(ticker) {
  const scored = technicals.byTicker(ticker);
  if (!scored) return false;
  openTechnicalsDrill(scored);
  return true;
}

// Points can be fractional (ADX 0.5, ATR 0.5) — show a decimal only when there is one.
export function fmtPoints(n) {
  if (n == null) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
