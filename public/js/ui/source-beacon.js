// ui/source-beacon.js — Research connections, the bottom-left source beacon.
//
// A small always-present launcher in the lower-left corner that opens a popover showing EVERY
// source this dashboard reads, as one long vertical list, with the flow drawn converging into a
// single Sattva Research square. It is a shop window for a fact that is otherwise invisible: this
// screen is fed by dozens of separate upstreams, on their own cadences, from four different
// mechanisms (live routes, committed captures, on-demand walks, and one credentialled proxy).
//
// WHY IT IS NOT IN THE HEADER, AND WHY THAT MATTERS
//   The header used to carry a Sources button and it was deliberately removed: the chrome is one
//   passive status pill and a Refresh, and provenance for a NUMBER belongs beside that number —
//   in the owning tab's Live label, its drill panel and its export banner. None of that changes.
//   This is the whole ESTATE rather than one figure's provenance, it sits out of the reading
//   column entirely, and it is opened only by someone who went looking for it. The header rule
//   stands; this is a different question asked in a different place.
//
// FOUR RULES, and the first two are the ones that keep it honest:
//
//   1. NO FIGURE HERE IS TYPED. Every count is derived from `sourceGroups()` — the same registry
//      the source modal is built from, called on each open, never hoisted. See the long note at
//      the top of ui/sources.js for why that rule exists.
//   2. GREEN REQUIRES A RECENT SUCCESSFUL CHECK. The pill counts connected sources, separately
//      from configured automatic feeds. Unknown, expired, partial and failed checks cannot pulse.
//      The freshness claim is separate, dated, and comes from `live.getLastDataTick()` — the last
//      time a poller actually confirmed something with a server. Before any poller has ticked it
//      says so rather than borrowing the page-load time.
//   3. IT IS A POPOVER, NOT AN OVERLAY. There is no backdrop and the page stays interactive
//      behind it, so `trapFocus()` — which asserts `aria-modal="true"` — would be describing
//      something this is not. It still behaves for a keyboard: focus moves in on open, Escape and
//      an outside click close it, and focus returns to the launcher. z-30 puts it under every
//      overlay (drill 50 < workspace 55 < modal 60), same as the alert stack.
//   4. IT ANIMATES ONLY WHILE IT IS OPEN. The panel's markup is torn down on close, so the
//      flow lines and the ~30 status dots stop costing anything the moment it is dismissed. The
//      launcher keeps one dot. Every animation is opacity/transform only, and
//      `prefers-reduced-motion` turns the lot off in CSS.

import { escapeHtml } from '../core/dom.js';
import { formatRelativeTime } from '../core/format.js';
import * as live from '../core/live.js';
import { state } from '../core/state.js';
import { sourceGroups, portfolioSource } from './sources.js';
import * as coverage from '../data/coverage.js';
import { openTwitterSources } from './twitter-sources.js';
import * as twitterHandles from '../core/twitter-handles.js';
import * as ipoFilings from '../data/ipo-filings.js';
import { ipoSourceGroup } from './ipo-sources.js';
import { sourceConnection, sourceSummary } from './source-connections.js';

const ROOT_ID = 'source-beacon-root';
const PANEL_ID = 'source-beacon-panel';

let rootEl = null;
let open = false;
let clock = null;
let offHandles = null;
let offIpos = null;
let offPortfolio = null;

/** Reads the registry — never a cached copy of it — and reduces it to what this widget draws. */
function readEstate() {
  const groups = sourceGroups();
  // Derived, like everything else here: the tab list each group already names, de-duplicated.
  const tabs = new Set();
  groups.forEach((g) => String(g.tabs || '').split('·').forEach((t) => t.trim() && tabs.add(t.trim())));
  return { groups, ...sourceSummary(groups), tabs: tabs.size };
}

/** The last moment a poller actually confirmed something with a server, or null before any did. */
function confirmedAt() {
  const tick = live.getLastDataTick();
  return Number.isFinite(tick) ? tick : null;
}

function freshnessText() {
  const at = confirmedAt();
  if (at) return `Latest feed activity confirmed ${formatRelativeTime(at)}`;
  // NEVER `state.dataLoadedAt` dressed up as a confirmation — loading a committed file is not a
  // feed answering. Say which it was.
  return state.dataLoadedAt ? 'Research captures loaded · source checks shown below' : 'Connecting your research workspace';
}

/** True when the reader has asked the OS for less motion. See rule 4 in the header. */
function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ---- The flow diagram ------------------------------------------------------------------------
//
// Drawn 1:1 in user units (no `preserveAspectRatio: none`), so the curves are not sheared and
// every wire carries the same weight.
//
// THERE IS ONE WIRE PER SOURCE GROUP, and each carries that group's own icon from the registry.
// The count is derived for the same reason every other figure here is: a fixed decorative number
// of wires would be a picture quietly making a claim about the estate, and it would stop being
// true the day a group is added or removed. One wire is one family of source, the icon says which
// family, and hovering that family in the list lights its own wire — see `wireFamilyHighlight`.
// The list beside them is the detail behind every one.
const FLOW = { w: 136, iconX: 7, originX: 21, joinX: 96, pitch: 38, padY: 22 };

function flowGeometry(count) {
  const n = Math.max(1, count);
  const h = (n - 1) * FLOW.pitch + FLOW.padY * 2;
  const joinY = h / 2;
  const origins = Array.from({ length: n }, (_, i) => FLOW.padY + i * FLOW.pitch);
  return { h, joinY, origins };
}

const wirePath = (y, joinY) => `M${FLOW.originX},${y} C${FLOW.originX + 38},${y} ${FLOW.joinX - 26},${joinY} ${FLOW.joinX},${joinY}`;

function flowSvg(groups) {
  const { h, joinY, origins } = flowGeometry(groups.length);
  const bed = origins.map((y) => `<path d="${wirePath(y, joinY)}" vector-effect="non-scaling-stroke"/>`).join('');
  // Staggered so the dashes never march in lockstep — synchronised wires read as one moving
  // object rather than as several feeds arriving on their own cadences.
  const lines = origins
    .map((y, i) => `<path class="beacon-flow-line" data-family="${i}" d="${wirePath(y, joinY)}" style="animation-delay:${(i * 0.21).toFixed(2)}s" vector-effect="non-scaling-stroke"/>`)
    .join('');
  const icons = origins
    .map((y, i) => `<text class="beacon-flow-icon" data-family="${i}" x="${FLOW.iconX}" y="${y}" dominant-baseline="central">${escapeHtml(groups[i].icon || '•')}</text>`)
    .join('');
  // One travelling mote per wire, on a longer and differently staggered cycle, so arrivals land
  // irregularly the way real captures do.
  //
  // These are SMIL, and the global `prefers-reduced-motion` block in index.html cannot reach
  // SMIL — it only turns off CSS animations. So the check is made here and the motes are simply
  // not drawn. The dashed lines beneath them are CSS and stop on their own.
  const motes = reducedMotion()
    ? ''
    : origins
        .map((y, i) => `<circle class="beacon-flow-mote" r="2.3">
          <animateMotion dur="${(2.7 + (i % 4) * 0.5).toFixed(2)}s" begin="${(i * 0.37).toFixed(2)}s" repeatCount="indefinite" path="${wirePath(y, joinY)}"/>
        </circle>`)
        .join('');

  return {
    h,
    joinY,
    svg: `
    <svg class="beacon-flow-svg" width="${FLOW.w}" height="${h}" viewBox="0 0 ${FLOW.w} ${h}" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="beacon-flow-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#c7d2fe" stop-opacity="0.35"/>
          <stop offset="50%" stop-color="#a855f7" stop-opacity="0.85"/>
          <stop offset="100%" stop-color="#6366f1" stop-opacity="1"/>
        </linearGradient>
      </defs>
      <g class="beacon-flow-bed">${bed}</g>
      ${lines}
      ${icons}
      ${motes}
    </svg>`,
  };
}

function flowRail(estate) {
  const flow = flowSvg(estate.groups);
  return `
    <div class="beacon-flow">
      <div class="beacon-flow-stage" style="width:${FLOW.w}px;height:${flow.h}px;--beacon-join-x:${((FLOW.joinX / FLOW.w) * 100).toFixed(3)}%;--beacon-join-y:${((flow.joinY / flow.h) * 100).toFixed(3)}%">
        ${flow.svg}
        <div class="beacon-core">
          <span class="beacon-core-halo" aria-hidden="true"></span>
          <span class="beacon-core-halo beacon-core-halo-2" aria-hidden="true"></span>
          <span class="beacon-mark beacon-mark-lg" aria-hidden="true"><img class="sattva-mark" src="/assets/brand/sattva-ventures-mark.svg" width="420" height="174" alt="" /></span>
        </div>
      </div>
      <div class="beacon-flow-caption">
        <div class="beacon-flow-title">Sattva Research</div>
        <div class="beacon-flow-sub">${estate.total} sources → ${estate.tabs} tabs</div>
      </div>
    </div>`;
}

// ---- The list --------------------------------------------------------------------------------

function rowHtml(item, i) {
  const { label, cls } = sourceConnection(item);
  const attributes = `data-beacon-name="${escapeHtml(item.name)}"${item.readState ? ` data-beacon-read-state="${escapeHtml(item.readState)}"` : ''}`;
  if (item.details) {
    return `<li><details data-beacon-source="${escapeHtml(item.id)}" class="beacon-source-details">
      <summary class="beacon-row ${cls}" ${attributes} aria-label="${escapeHtml(`${item.name}: ${label}. Source details`)}">
        <span class="beacon-dot" aria-hidden="true"></span>
        <span class="beacon-row-name">${escapeHtml(item.name)}</span>
        <span class="beacon-row-status">${escapeHtml(label)}</span>
      </summary>
      <div class="beacon-source-copy">${[item.cadence, ...item.details].filter(Boolean).map((note) => `<p>${escapeHtml(note)}</p>`).join('')}</div>
    </details></li>`;
  }
  // `feeds` is trusted markup in the registry (it carries <strong>), so it is NOT dropped into a
  // title attribute raw — strip the tags and escape what is left. The cadence is the useful half.
  const detail = String(item.cadence || '').replace(/<[^>]*>/g, '');
  return `
    <li class="beacon-row ${cls}" ${attributes}${item.id ? ` data-beacon-source="${escapeHtml(item.id)}"` : ''} title="${escapeHtml(`${item.name} — ${label} · ${detail}`)}">
      <span class="beacon-dot" style="animation-delay:${((i % 9) * 0.23).toFixed(2)}s" aria-hidden="true"></span>
      <span class="beacon-row-name">${escapeHtml(item.name)}</span>
      <span class="beacon-row-status">${escapeHtml(label)}</span>
    </li>`;
}

function listHtml(estate) {
  let i = 0;
  return estate.groups
    .map((g, gi) => {
      const rows = g.items.map((item) => rowHtml(item, i++)).join('');
      // A family the registry marks editable gets its control in its own heading, which is where a
      // reader looking at that list is already looking. Only Twitter/X has one today.
      const action = g.action
        ? `<button type="button" class="beacon-group-action" data-beacon-action="${escapeHtml(g.action.id)}">${escapeHtml(g.action.label)}</button>`
        : '';
      return `
        <li class="beacon-group" data-family="${gi}"${g.id ? ` data-beacon-group="${escapeHtml(g.id)}"` : ''}>
          <div class="beacon-group-head">
            <span class="beacon-group-icon" aria-hidden="true">${escapeHtml(g.icon || '•')}</span>
            <span class="beacon-group-title">${escapeHtml(g.title)}</span>
            <span class="beacon-group-count">${g.items.length}</span>
            ${action}
          </div>
          <div class="beacon-group-tabs">${escapeHtml(g.tabs || '')}</div>
          ${g.notes ? `<details class="beacon-group-details" data-beacon-notes="${escapeHtml(g.id)}"><summary>Connection &amp; coverage details</summary><div class="beacon-source-copy">${g.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}</div></details>` : ''}
          <ul class="beacon-rows">${rows}</ul>
        </li>`;
    })
    .join('');
}

function legendHtml(estate) {
  return [[estate.connected, 'connected', 'is-live'], [estate.automatic, 'automatic feeds', 'is-scheduled'],
    [estate.onRequest, 'on request', 'is-ondemand'], [estate.reference, 'reference & computed', 'is-static']]
    .filter(([n]) => n > 0).map(([n, label, cls]) => `<span class="beacon-legend-item ${cls}"><span class="beacon-dot beacon-dot-static" aria-hidden="true"></span>${n} ${escapeHtml(label)}</span>`)
    .join('');
}

function panelHtml() {
  const estate = readEstate();
  return `
    <section id="${PANEL_ID}" class="beacon-panel" role="dialog" aria-label="Data sources feeding this dashboard" tabindex="-1">
      <header class="beacon-panel-head">
        <div class="beacon-panel-titles">
          <h2 class="beacon-panel-title">Research connections</h2>
          <p class="beacon-panel-sub" data-beacon-fresh>${escapeHtml(freshnessText())}</p>
        </div>
        <span class="beacon-live-pill" title="Connected counts only sources with a recent successful check. Scheduled sources and retained copies are labelled separately.">
          <span class="beacon-live-dot" aria-hidden="true"></span>
          <span data-beacon-connected>${estate.connected} connected</span>
        </span>
        <button type="button" class="beacon-close" data-beacon-close aria-label="Close data sources">&times;</button>
      </header>

      <div class="beacon-body">
        <div class="beacon-list scrollbar-thin" tabindex="0">
          <ul class="beacon-groups">${listHtml(estate)}</ul>
        </div>
        ${flowRail(estate)}
      </div>

      <footer class="beacon-panel-foot">
        <div class="beacon-legend">${legendHtml(estate)}</div>
        <p class="beacon-foot-note">Automatic checks keep research moving. Expand a source for its latest check and coverage details.</p>
      </footer>
    </section>`;
}

function launcherHtml(estate) {
  return `
    <button type="button" class="beacon-launcher" data-beacon-toggle
      aria-expanded="false" aria-controls="${PANEL_ID}"
      title="See every source this dashboard reads">
      <span class="beacon-mark" aria-hidden="true"><img class="sattva-mark" src="/assets/brand/sattva-ventures-mark.svg" width="420" height="174" alt="" /></span>
      <span class="beacon-launcher-text">
        <span class="beacon-launcher-line" data-beacon-launch-count>${estate.total} research sources</span>
        <span class="beacon-launcher-sub" data-beacon-launch-sub>${estate.automatic} automatic feeds</span>
      </span>
      <span class="beacon-live-dot beacon-live-dot-sm" aria-hidden="true"></span>
    </button>`;
}

// ---- Lifecycle -------------------------------------------------------------------------------

function onDocClick(e) {
  if (!open || !rootEl) return;
  if (rootEl.contains(e.target)) return;
  // A click inside an overlay this popover opened — the Twitter Sources modal — is not an outside
  // click. Closing here would tear down the list the reader is editing, from underneath the dialog
  // that is editing it.
  if (e.target?.closest?.('#modal-overlay, #drill-panel, #workspace-overlay')) return;
  close();
}

function onKey(e) {
  if (e.key === 'Escape' && open) {
    // Only if nothing modal is on top — a reader pressing Escape over an open drill or workspace
    // means that one, and this popover sits underneath it.
    if (document.querySelector('#modal-overlay:not(.hidden), #workspace-overlay:not(.hidden)')) return;
    close();
    rootEl?.querySelector('[data-beacon-toggle]')?.focus({ preventScroll: true });
  }
}

/**
 * Hovering a family in the list lights that family's wire, and dims the rest.
 *
 * This is what stops the diagram being decoration. Seven wires carrying seven icons already say
 * "seven kinds of source converge here"; pairing them with the list says WHICH, so a reader can
 * point at a wire and find the eleven feeds behind it. Delegated on the list, so it costs one
 * listener rather than one per group, and it touches class names only — no layout, no repaint of
 * anything but the strokes.
 */
function wireFamilyHighlight(panel) {
  const list = panel.querySelector('.beacon-list');
  const stage = panel.querySelector('.beacon-flow-stage');
  if (!list || !stage) return;
  let current = null;

  const apply = (family) => {
    if (family === current) return;
    current = family;
    stage.classList.toggle('is-focused', family !== null);
    stage.querySelectorAll('[data-family]').forEach((n) => n.classList.toggle('is-hot', n.dataset.family === family));
    list.querySelectorAll('.beacon-group').forEach((n) => n.classList.toggle('is-hot', n.dataset.family === family));
  };

  list.addEventListener('mouseover', (e) => apply(e.target.closest?.('.beacon-group')?.dataset.family ?? null));
  list.addEventListener('mouseleave', () => apply(null));
}

function paintPanel() {
  const host = rootEl.querySelector('[data-beacon-panel-host]');
  host.innerHTML = panelHtml();
  host.querySelector('[data-beacon-close]')?.addEventListener('click', () => {
    close();
    rootEl.querySelector('[data-beacon-toggle]')?.focus({ preventScroll: true });
  });
  const panel = host.querySelector(`#${PANEL_ID}`);
  if (panel) {
    wireFamilyHighlight(panel);
    panel.querySelector('[data-beacon-action="edit-twitter"]')?.addEventListener('click', (e) => {
      // Not a close: the modal is z-60 and this popover is z-30, so it lands on top and the list
      // beneath it repaints as handles are added — which is the point of leaving it open.
      e.stopPropagation();
      openTwitterSources();
    });
    panel.focus({ preventScroll: true });
  }
}

// Refresh only IPO disclosures: never restart the flow animation or disturb another group.
function refreshIpoDetails() {
  const group = rootEl?.querySelector('[data-beacon-group="ipo-filings"]');
  if (!group) return;
  const list = rootEl.querySelector('.beacon-list'), scroll = list?.scrollTop || 0;
  const key = (el) => el?.dataset.beaconSource || el?.dataset.beaconNotes;
  const expanded = [...group.querySelectorAll('details[open]')].map(key);
  const focusKey = group.contains(document.activeElement) ? key(document.activeElement.closest('details')) : null;
  const template = document.createElement('template');
  template.innerHTML = listHtml({ groups: [ipoSourceGroup()] });
  group.innerHTML = template.content.firstElementChild.innerHTML;
  group.querySelectorAll('details').forEach((el) => {
    if (expanded.includes(key(el))) el.open = true;
    if (focusKey && focusKey === key(el)) el.querySelector('summary')?.focus({ preventScroll: true });
  });
  if (list) list.scrollTop = scroll;
}

// Update only the portfolio row; leave scrolling and the other sources untouched.
function refreshPortfolioStatus() {
  const row = rootEl?.querySelector('[data-beacon-source="family-portfolio"]');
  if (!row) return;
  const source = portfolioSource();
  row.dataset.beaconReadState = source.readState;
  row.classList.toggle('is-live', source.readState === 'read');
  row.classList.toggle('is-saved', source.readState !== 'read');
  row.querySelector('.beacon-row-status').textContent = source.readLabel;
  row.title = `${source.name} — ${source.readLabel} · ${source.cadence}`;
}

// Update connection state in place, without resetting expanded details, focus, scroll or motion.
function refreshConnections() {
  if (!rootEl) return;
  const estate = readEstate();
  rootEl.classList.toggle('has-connection', estate.connected > 0 && navigator.onLine !== false);
  const count = rootEl.querySelector('[data-beacon-launch-count]');
  if (count) count.textContent = `${estate.total} research sources`;
  const sub = rootEl.querySelector('[data-beacon-launch-sub]');
  if (sub) sub.textContent = `${estate.automatic} automatic feeds`;
  const connected = rootEl.querySelector('[data-beacon-connected]');
  if (connected) connected.textContent = `${estate.connected} connected`;
  const items = new Map(estate.groups.flatMap(g => g.items).map(i => [i.name, i]));
  for (const row of rootEl.querySelectorAll('[data-beacon-name]')) {
    const item = items.get(row.dataset.beaconName);
    if (!item) continue;
    const connection = sourceConnection(item);
    for (const cls of ['is-live', 'is-static', 'is-scheduled', 'is-saved', 'is-ondemand', 'is-mock', 'is-unreadable', 'is-pending']) row.classList.remove(cls);
    row.classList.add(connection.cls);
    row.querySelector('.beacon-row-status').textContent = connection.label;
    if (item.readState) row.dataset.beaconReadState = item.readState;
    if (row.tagName === 'SUMMARY') {
      row.setAttribute('aria-label', `${item.name}: ${connection.label}. Source details`);
      const copy = row.parentElement.querySelector('.beacon-source-copy');
      if (copy && item.details) copy.innerHTML = [item.cadence, ...item.details].filter(Boolean).map(note => `<p>${escapeHtml(note)}</p>`).join('');
    } else {
      row.title = `${item.name} — ${connection.label} · ${item.cadence || ''}`;
    }
  }
  const legend = rootEl.querySelector('.beacon-legend');
  if (legend) legend.innerHTML = legendHtml(estate);
}

function focusGroup(id) {
  const group = [...rootEl.querySelectorAll('[data-beacon-group]')].find((el) => el.dataset.beaconGroup === id);
  if (!group) return;
  const list = rootEl.querySelector('.beacon-list');
  if (list) list.scrollTop += group.getBoundingClientRect().top - list.getBoundingClientRect().top;
  group.querySelector('summary')?.focus({ preventScroll: true });
}

export function openBeacon({ group } = {}) {
  if (!rootEl) return;
  if (open) { if (group) focusGroup(group); return; }
  open = true;
  rootEl.classList.add('is-open');
  const toggle = rootEl.querySelector('[data-beacon-toggle]');
  toggle?.setAttribute('aria-expanded', 'true');
  paintPanel();
  if (group) focusGroup(group);

  // The launcher's own count is re-read on every open for the same reason the panel's is: it is a
  // measurement, and a measurement that is only taken once is the bug this registry was rewritten
  // to remove.
  refreshConnections();

  // Only the one line moves, never the panel: a full repaint would restart every animation in it.
  clock = setInterval(() => {
    const el = rootEl?.querySelector('[data-beacon-fresh]');
    if (el) el.textContent = freshnessText();
    // Age is recomputed even without a successful network response. Preserve disclosure state.
    if (open) { refreshIpoDetails(); refreshPortfolioStatus(); refreshConnections(); }
  }, 15000);

  document.addEventListener('click', onDocClick, true);
  // Adding or removing an X account changes this panel's rows and every count in its header, and
  // that happens in a modal on top of it. Repaint on the change rather than on a timer.
  offHandles = twitterHandles.onChange(() => {
    if (open) { paintPanel(); refreshConnections(); }
  });
  offIpos = ipoFilings.onChange(() => { if (open) { refreshIpoDetails(); refreshConnections(); } });
  offPortfolio = coverage.onChange(() => { if (open) { refreshPortfolioStatus(); refreshConnections(); } });
}

export function close() {
  if (!open || !rootEl) return;
  open = false;
  rootEl.classList.remove('is-open');
  rootEl.querySelector('[data-beacon-toggle]')?.setAttribute('aria-expanded', 'false');
  // Torn down rather than hidden — see rule 4. Nothing animates behind a closed panel.
  const host = rootEl.querySelector('[data-beacon-panel-host]');
  if (host) host.innerHTML = '';
  clearInterval(clock);
  clock = null;
  offHandles?.();
  offHandles = null;
  offIpos?.();
  offIpos = null;
  offPortfolio?.();
  offPortfolio = null;
  document.removeEventListener('click', onDocClick, true);
}

/**
 * Mounts the launcher once. Returns a disposer, though nothing calls it today: this is page-level
 * chrome with the same lifetime as the alert stack.
 */
export function mount() {
  rootEl = document.getElementById(ROOT_ID);
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = ROOT_ID;
    document.body.appendChild(rootEl);
  }
  if (rootEl.dataset.mounted === '1') return () => {};
  rootEl.dataset.mounted = '1';
  rootEl.className = 'beacon-root';

  rootEl.innerHTML = `<div data-beacon-panel-host></div>${launcherHtml(readEstate())}`;
  refreshConnections();
  rootEl.querySelector('[data-beacon-toggle]').addEventListener('click', () => (open ? close() : openBeacon()));
  document.addEventListener('keydown', onKey);
  // The closed launcher must age and lose its pulse when offline too; opening the panel is not
  // what makes a source check fresh. These listeners perform no network reads.
  const statusClock = setInterval(refreshConnections, 60000);
  const offTick = live.onGlobalTick(refreshConnections);
  window.addEventListener('offline', refreshConnections);
  window.addEventListener('online', refreshConnections);

  return () => {
    close();
    document.removeEventListener('keydown', onKey);
    clearInterval(statusClock); offTick();
    window.removeEventListener('offline', refreshConnections);
    window.removeEventListener('online', refreshConnections);
    rootEl?.remove();
    rootEl = null;
  };
}
