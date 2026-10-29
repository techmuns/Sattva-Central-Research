// AI Alerts' Compact list: one row per company — company, CMP, market cap, what happened — and the
// row opens its source. The rows come from data/ai-alerts-compact.js; this file only draws them.
//
// THE WHOLE ROW IS THE CONTROL. The company name carries the row's link (or, for broker views, the
// button that lists every report) and its ::after covers the row, so a click anywhere opens the
// source without nesting one interactive element inside another. The report links and the broker
// toggle sit above that layer and stay separately clickable.
import { escapeHtml } from '../core/dom.js';
import { alertPriceHtml } from './alert-price.js';
import { alertReadingHtml } from './alert-reading.js';
import { brokerCall } from '../data/broker-reports-shared.js';
import { highlightHtml } from './ai-alert-search.js';

const MONTH = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const shortDay = (day, today) => {
  if (!day) return 'Date unavailable';
  if (day === today) return 'Today';
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? MONTH.format(ms) : day;
};
const when = (day, time, today) => `${shortDay(day, today)}${time ? ` · ${time}` : ''}`;
const istDay = (iso) => { const ms = Date.parse(iso || ''); return Number.isFinite(ms) ? new Date(ms + 19800000).toISOString().slice(0, 10) : null; };
const istTime = (iso) => { const ms = Date.parse(iso || ''); return Number.isFinite(ms) ? new Date(ms + 19800000).toISOString().slice(11, 16) : null; };

const ICON_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
const ICON_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const ICON_REPORTS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>';
const ICON_ARCHIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_RESTORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const STANCE_LABEL = { bullish: 'Bullish', neutral: 'Neutral', bearish: 'Bearish' };

function reportMarkup(event, today) {
  const r = event.brokerReport;
  const changed = r.previous?.rating && r.rating && r.previous.rating !== r.rating;
  const figures = [r.target != null ? `TP ₹${r.target.toLocaleString('en-IN')}` : null,
    r.upsidePct != null ? `${Math.abs(r.upsidePct)}% ${r.upsidePct < 0 ? 'downside' : 'upside'}` : null].filter(Boolean);
  const rating = r.rating
    ? `<span class="ai-compact-stance" data-stance="${escapeHtml(r.stance)}" title="${escapeHtml(`${STANCE_LABEL[r.stance]} — the broker's own ${r.rating} rating${changed ? `, previously ${r.previous.rating}` : ''}`)}">${changed ? `${escapeHtml(r.previous.rating)} → ` : ''}${escapeHtml(r.rating)}</span>` : '';
  const words = r.points || r.reportTitle;
  return `<li><a class="ai-compact-report" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer"
      aria-label="${escapeHtml(`${r.broker}${r.kind === 'initiation' ? ', initiated coverage' : ''}: ${brokerCall(r) || 'no rating or target printed'}. Open the report post`)}">
    <span class="ai-compact-report-broker">${escapeHtml(r.broker)}${r.kind === 'initiation' ? '<span class="ai-compact-report-new">New</span>' : ''}</span>
    <span class="ai-compact-report-call">${rating}${figures.map((f) => `<span${/downside/.test(f) ? ' data-direction="negative"' : ''}>${escapeHtml(f)}</span>`).join('')}</span>
    <span class="ai-compact-report-points">${words ? escapeHtml(words) : '<span class="ai-compact-muted">No title printed</span>'}</span>
    <span class="ai-compact-report-when">${escapeHtml(when(istDay(r.publishedAt), istTime(r.publishedAt), today))}${ICON_OPEN}</span>
  </a></li>`;
}

function rowMarkup(row, { today, open, archived, fresh, highlight = '' }) {
  const name = highlight ? highlightHtml(row.company, highlight) : escapeHtml(row.company);
  const tone = archived ? 'neutral' : row.badge?.tone || 'neutral';
  const isNew = !archived && fresh.has(row.key);
  const isOpen = open.has(row.key);
  const listId = `ai-compact-reports-${row.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const label = `${row.company}: ${row.fullText}`;
  const hit = row.brokerLed
    ? `<button type="button" class="ai-compact-hit" data-ai-brokers-toggle aria-expanded="${isOpen}" aria-controls="${listId}"
        aria-label="${escapeHtml(`${label} Show each broker report`)}" title="${escapeHtml(`${row.brokers.length} broker ${row.brokers.length === 1 ? 'report' : 'reports'} — show each one`)}"><span class="ai-compact-name">${name}</span></button>`
    : row.href
      ? `<a class="ai-compact-hit" href="${escapeHtml(row.href)}" ${row.external ? 'target="_blank" rel="noopener noreferrer"' : ''}
          aria-label="${escapeHtml(`${label} Opens the ${row.opens}`)}" title="${escapeHtml(`Opens the ${row.opens}${row.folded ? ` · ${row.folded} other ${row.folded === 1 ? 'report' : 'reports'} of this event shown once here` : ''}`)}"><span class="ai-compact-name">${name}</span></a>`
      : `<span class="ai-compact-hit"><span class="ai-compact-name">${name}</span></span>`;
  const badge = tone !== 'neutral' && row.badge ? `<span class="ai-compact-badge" data-tone="${escapeHtml(tone)}">${escapeHtml(row.badge.label)}</span>` : '';
  // THE REPORTS ARE BEHIND A BUTTON THAT LOOKS LIKE ONE: a pill with the count, the calls in short,
  // and an explicit Show / Hide segment whose chevron turns. A broker-led row's sentence already names
  // the calls, so its pill carries the count and the action alone.
  const count = row.brokers.length;
  const summary = row.brokerLed ? '' : row.brokers.slice(0, 4).map((e) => brokerCall(e.brokerReport) || e.brokerReport.broker).join(', ');
  const brokers = count
    ? `<button type="button" class="ai-compact-brokers" data-ai-brokers-toggle aria-expanded="${isOpen}" aria-controls="${listId}">
        <span class="ai-compact-brokers-icon">${ICON_REPORTS}</span>
        <span class="ai-compact-brokers-count">${count} ${row.brokerLed ? '' : 'broker '}${count === 1 ? 'report' : 'reports'}</span>
        ${summary ? `<span class="ai-compact-brokers-summary">${escapeHtml(summary)}</span>` : ''}
        <span class="ai-compact-brokers-action"><span class="ai-compact-brokers-show">Show</span><span class="ai-compact-brokers-hide">Hide</span>${ICON_CHEVRON}</span>
      </button>`
    : '';
  const reports = row.brokers.length
    ? `<ul class="ai-compact-reports" id="${listId}" ${isOpen ? '' : 'hidden'}>${row.brokers.map((e) => reportMarkup(e, today)).join('')}</ul>` : '';
  return `<article class="ai-compact-row" data-ai-compact-row data-ai-key="${escapeHtml(row.key)}" data-ticker="${escapeHtml(row.ticker || '')}"
      data-tone="${escapeHtml(tone)}" data-kind="${escapeHtml(row.kind)}" data-open="${isOpen}"${isNew ? ' data-ai-new' : ''}>
    <div class="ai-compact-company">${hit}
      <div class="ai-compact-meta">${isNew ? '<span class="ai-new-chip" title="Arrived while this list was open. Sort or filter again to put it in order.">New</span>' : ''}${badge}<span class="ai-compact-ticker">${escapeHtml(row.ticker || 'No exchange ticker')}</span><span aria-hidden="true">·</span>
        <time datetime="${escapeHtml(row.time ? `${row.day}T${row.time}+05:30` : row.day || '')}">${escapeHtml(when(row.day, row.time, today))}</time></div>
    </div>
    ${alertPriceHtml(row.ticker, { variant: 'compact' })}
    <div class="ai-compact-what">
      <p class="ai-compact-text" title="${escapeHtml(row.fullText)}"><span class="ai-compact-kind" data-kind="${escapeHtml(row.kind)}">${escapeHtml(row.kindLabel)}</span>${escapeHtml(row.text)}</p>
      ${row.brokerLed || !row.lead ? '' : alertReadingHtml(row.lead)}
      ${brokers}${reports}
    </div>
    <span class="ai-compact-go" aria-hidden="true">${row.brokerLed ? ICON_CHEVRON : row.external ? ICON_OPEN : ICON_ARROW}</span>
    ${archived
      ? `<button type="button" class="ai-compact-dismiss" data-ai-compact-restore aria-label="${escapeHtml(`Restore ${row.company} to AI Alerts`)}" title="Restore to AI Alerts">${ICON_RESTORE}</button>`
      : `<button type="button" class="ai-compact-dismiss" data-ai-compact-archive aria-label="${escapeHtml(`Archive ${row.company}`)}" title="Archive · it returns if new material evidence arrives">${ICON_ARCHIVE}</button>`}
  </article>`;
}

/** The list, header included. `open` is the set of row keys whose broker reports are expanded. */
export function compactListMarkup(rows, { today, open = new Set(), archived = false, remaining = 0, total = rows.length, page = 100, fresh = new Set(), highlight = '' } = {}) {
  const more = remaining > 0
    ? `<div class="ai-compact-foot"><button type="button" class="ai-compact-more" data-ai-compact-more>Show ${Math.min(page, remaining)} more</button><span>${rows.length.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} companies shown</span></div>` : '';
  return `<section class="ai-compact" data-ai-compact aria-label="AI Alerts, compact list">
    <div class="ai-compact-head" aria-hidden="true"><span>Company</span><span class="ai-compact-right">CMP</span><span class="ai-compact-right">Market cap</span><span>What happened</span><span></span></div>
    <div class="ai-compact-rows" role="list">${rows.map((row) => `<div role="listitem" data-ai-row="${escapeHtml(row.key)}">${rowMarkup(row, { today, open, archived, fresh, highlight })}</div>`).join('')}</div>
    ${more}
  </section>`;
}
