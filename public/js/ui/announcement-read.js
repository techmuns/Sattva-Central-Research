// ui/announcement-read.js — THE AI READ POPUP, CORPORATE ANNOUNCEMENTS ONLY.
//
// A click on a filing opens this popup and only then asks for it to be read (POST /api/announcement-read).
// The list itself never carries a generated headline or summary: its subject is the exchange's own.
//
// THE SAME FIVE SECTIONS FOR EVERY FILING, in the same order (announcement-read-shared.js):
//   What happened · Key details · Why it matters / Investment impact · Related event history · Source
// The content adapts to the filing; the layout never does. "Related event history" is the stitched
// event (never written by the model) and "Source" is the exchange's own record with the Open
// Original Filing link — so a reading that cannot be had still leaves the reader everything the
// exchange published, and says in words why the AI part is missing.
//
// The Important / Not important controls sit at the foot: the shared relevance preference learns
// from a filing the reader has actually opened.
import { escapeHtml } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { openModal } from './screener.js';
import { categoryChips } from './category-chips.js';
import { feedbackBar, wireFeedback } from './relevance-feedback-ui.js';
import { formatMarketCap, MCAP_BANDS } from '../data/company-profile.js';
import { READ_SECTIONS, readReason } from '../data/announcement-read-shared.js';
import { announcementSourceUrls } from '../data/announcements-shared.js';

const SECTION = Object.fromEntries(READ_SECTIONS.map((s) => [s.id, s.title]));
const DIRECTION_WORD = { positive: 'Positive', negative: 'Negative', mixed: 'Mixed', neutral: 'Neutral', unclear: 'Unclear' };
const HORIZON_WORD = { 'near-term': 'near term', 'medium-term': 'medium term', 'long-term': 'long term', unclear: 'horizon unclear' };
const cache = new Map(); // row id -> settled reading response, for this page session
let openId = 0;

const when = (row) => [row.date ? formatDate(row.date) : 'Date not supplied', row.time ? `${String(row.time).slice(0, 5)} IST` : null].filter(Boolean).join(' · ');
const bandLabel = (band) => MCAP_BANDS.find((b) => b.id === band)?.short || null;

function originalLinks(row) {
  const links = announcementSourceUrls(row);
  const list = links.length ? links : (row.url ? [{ source: row.source || 'Source', url: row.url }] : []);
  return list.filter((l) => /^https:\/\//.test(l.url || ''));
}

const loadingBlock = (lines = 3) => `<div class="ann-read-loading" aria-hidden="true">${Array.from({ length: lines }, (_, i) => `<span style="width:${92 - i * 14}%"></span>`).join('')}</div>`;

function shell(row, item) {
  const links = originalLinks(row);
  const primary = links[0];
  const cap = formatMarketCap(row.mcapCr);
  return `<div class="ann-read" data-ann-read>
    <header class="ann-read-head">
      <div class="ann-read-head-top">
        <p class="ann-read-company">${escapeHtml(row.company || row.ticker || 'Company not supplied')}
          ${row.ticker ? `<span class="ann-read-ticker">${escapeHtml(row.ticker)}</span>` : ''}
          ${cap ? `<span class="ann-read-cap" title="${escapeHtml(`Market cap ${cap}${row.mcapAsOf ? ` as of ${String(row.mcapAsOf).slice(0, 10)}` : ''}${row.mcapSource ? ` · ${row.mcapSource}` : ''}`)}">${escapeHtml(cap)}${bandLabel(row.band) ? ` · ${escapeHtml(bandLabel(row.band))} cap` : ''}</span>` : ''}
        </p>
        <button type="button" data-modal-close class="ann-read-close" aria-label="Close">×</button>
      </div>
      <h2 class="ann-read-subject">${escapeHtml(row.title || '(no subject)')}</h2>
      <p class="ann-read-meta">${escapeHtml(when(row))}${row.sources?.length ? ` · ${escapeHtml(row.sources.join(' / '))}` : ''}${row.subCategory ? ` · ${escapeHtml(row.subCategory)}` : ''}</p>
      <div class="ann-read-tags">${categoryChips(row.categories || [], { weak: row.weakCategories || [], max: 6 })}</div>
      <div class="ann-read-actions">
        ${primary ? `<a class="ann-read-original" href="${escapeHtml(primary.url)}" target="_blank" rel="noopener noreferrer">Open Original Filing ↗</a>` : '<span class="ann-read-note">The exchange published no document link for this filing.</span>'}
        ${links.slice(1).map((l) => `<a class="ann-read-alt" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.source || 'Copy')} copy ↗</a>`).join('')}
        ${!primary && row.referenceUrl ? `<a class="ann-read-alt" href="${escapeHtml(row.referenceUrl)}" target="_blank" rel="noopener noreferrer">Source reference page ↗</a>` : ''}
      </div>
    </header>
    <div class="ann-read-body">
      <section class="ann-read-section" data-section="what"><h3>${escapeHtml(SECTION.what)}</h3><div data-slot="what">${loadingBlock(2)}</div></section>
      <section class="ann-read-section" data-section="details"><h3>${escapeHtml(SECTION.details)}</h3><div data-slot="details">${loadingBlock(3)}</div></section>
      <section class="ann-read-section" data-section="why"><h3>${escapeHtml(SECTION.why)}</h3><div data-slot="why">${loadingBlock(3)}</div></section>
      <section class="ann-read-section" data-section="history"><h3>${escapeHtml(SECTION.history)}</h3><div data-slot="history">${row.event ? loadingBlock(2) : '<p class="ann-read-muted">No other filing is linked to this one.</p>'}</div></section>
      <section class="ann-read-section" data-section="source"><h3>${escapeHtml(SECTION.source)}</h3><div data-slot="source">${sourceBlock(row, null)}</div></section>
    </div>
    <footer class="ann-read-foot">${feedbackBar(item)}</footer>
  </div>`;
}

function sourceBlock(row, read) {
  const links = originalLinks(row);
  const parts = [
    `<li><span>Filed with</span> ${escapeHtml((row.sources || []).join(' / ') || row.source || 'Not specified')}${row.date ? `, ${escapeHtml(when(row))}` : ''}</li>`,
    row.category || row.subCategory ? `<li><span>Exchange category</span> ${escapeHtml([row.category, row.subCategory].filter(Boolean).join(' · '))}</li>` : '',
    links.length ? `<li><span>Documents</span> ${links.map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.source || 'Document')} ↗</a>`).join(' · ')}</li>` : '',
    row.providers?.length ? `<li><span>Retrieved through</span> ${escapeHtml(row.providers.join(' / '))}</li>` : '',
    read?.state === 'ready'
      ? `<li><span>AI reading</span> read ${escapeHtml(read.format === 'pdf' ? 'the full PDF' : read.format === 'xbrl' ? "the filing's XBRL facts" : 'the document')}${read.readAt ? ` on ${escapeHtml(formatDate(String(read.readAt).slice(0, 10)))}` : ''}. Generated text — check figures against the original filing. Not investment advice.</li>`
      : '',
  ];
  return `<ul class="ann-read-source">${parts.join('')}</ul>`;
}

function fillReading(root, row, read) {
  const slot = (id) => root.querySelector(`[data-slot="${id}"]`);
  if (!slot('what')) return;
  if (read?.state === 'ready' && read.reading) {
    const r = read.reading;
    slot('what').innerHTML = `${r.documentType ? `<p class="ann-read-kicker">${escapeHtml(r.documentType)}</p>` : ''}<p>${escapeHtml(r.whatHappened)}</p>`;
    slot('details').innerHTML = r.keyDetails?.length
      ? `<dl class="ann-read-details">${r.keyDetails.map((d) => `<div><dt>${escapeHtml(d.label)}</dt><dd>${escapeHtml(d.value)}
          <blockquote title="${escapeHtml(d.location ? `From the filing, ${d.location}` : 'From the filing')}">“${escapeHtml(d.quote)}”${d.location ? ` <cite>${escapeHtml(d.location)}</cite>` : ''}</blockquote></dd></div>`).join('')}</dl>`
      : '<p class="ann-read-muted">The filing states no figures, parties or dates beyond what is above.</p>';
    const impact = r.impact || {};
    slot('why').innerHTML = `<p>${escapeHtml(r.whyItMatters)}</p>
      <div class="ann-read-impact"><p class="ann-read-impact-head">Investment impact <span>AI reading · ${escapeHtml(DIRECTION_WORD[impact.direction] || 'Unclear')} · ${escapeHtml(HORIZON_WORD[impact.horizon] || 'horizon unclear')}</span></p>
      ${impact.text ? `<p>${escapeHtml(impact.text)}</p>` : ''}</div>`;
  } else {
    const reason = readReason(read?.reason);
    const retry = read?.retryAt ? ` Try again after ${new Date(read.retryAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST.` : '';
    slot('what').innerHTML = `${row.summary ? `<p class="ann-read-kicker">Exchange description (as filed)</p><p>${escapeHtml(row.summary)}</p>` : `<p>${escapeHtml(row.title || '')}</p>`}
      <p class="ann-read-unavailable" role="status">AI reading unavailable: ${escapeHtml(reason)}${escapeHtml(retry)} The exchange's own record and the original filing are below.</p>`;
    slot('details').innerHTML = '<p class="ann-read-muted">Not read — open the original filing for the figures.</p>';
    slot('why').innerHTML = '<p class="ann-read-muted">Not read — no investment reading is offered without the document.</p>';
  }
  slot('source').innerHTML = sourceBlock(row, read);
}

function fillHistory(root, row, event) {
  const slot = root.querySelector('[data-slot="history"]');
  if (!slot) return;
  if (!event || event.failed) {
    slot.innerHTML = `<p class="ann-read-muted">${event?.failed ? 'The related filings could not be read just now.' : 'No other filing is linked to this one.'}</p>`;
    return;
  }
  const members = event.members || [];
  if (members.length < 2) { slot.innerHTML = '<p class="ann-read-muted">No other filing is linked to this one.</p>'; return; }
  slot.innerHTML = `<p class="ann-read-muted">${members.length} filings by this company are linked as one event${event.local ? ' (linked within the selected period on this copy)' : ''}, oldest first.</p>
    <ol class="ann-read-history">${members.map((m) => {
      const link = m.url || m.referenceUrl;
      const current = m.id === row.id;
      return `<li${current ? ' aria-current="true" class="is-current"' : ''}><span class="ann-read-history-date">${escapeHtml(m.date ? formatDate(m.date) : '—')}${m.time ? ` ${escapeHtml(String(m.time).slice(0, 5))}` : ''}</span>
        <span class="ann-read-history-title">${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.title || '(no subject)')} ↗</a>` : escapeHtml(m.title || '(no subject)')}
        <small>${escapeHtml([(m.sources || []).join(' / '), m.subCategory].filter(Boolean).join(' · '))}${current ? ' · this filing' : ''}</small></span></li>`;
    }).join('')}</ol>`;
}

async function requestRead(row, related) {
  if (cache.has(row.id)) return cache.get(row.id);
  let read;
  try {
    const response = await fetch('api/announcement-read', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: row.id, url: row.url, sourceUrls: (row.sourceUrls || []).map((s) => s.url), title: row.title, company: row.company,
        ticker: row.ticker, date: row.date, time: row.time, category: row.category, subCategory: row.subCategory, summary: row.summary,
        categories: row.categories, mcapCr: row.mcapCr, sector: row.group,
        related: related.filter((m) => m.id !== row.id).map((m) => ({ date: m.date, title: m.title, source: (m.sources || [])[0] || null })) }),
    });
    const isJson = /json/.test(response.headers.get('content-type') || '');
    const body = isJson ? await response.json().catch(() => null) : null;
    read = body?.ok ? body : { state: 'failed', reason: body?.reason || (isJson ? 'upstream' : 'read-unavailable') };
  } catch { read = { state: 'failed', reason: 'read-unavailable' }; }
  // A stored or final answer is kept for the session; a temporary failure is asked again next time.
  if (read.state === 'ready' || (read.state === 'failed' && !read.retryAt && read.reason !== 'read-unavailable')) cache.set(row.id, read);
  return read;
}

/**
 * Open the popup for one filing. `loadEvent(event)` resolves the stitched event's members (the server
 * index or the local engine); `item` is the feedback descriptor for this filing.
 */
export function openAnnouncementRead(row, { loadEvent = null, item }) {
  const mine = ++openId;
  openModal(shell(row, item), { size: 'wide' });
  const root = document.querySelector('#modal-content [data-ann-read]');
  if (!root) return;
  const release = wireFeedback(root, item);
  const observer = new MutationObserver(() => { if (!root.isConnected) { release(); observer.disconnect(); } });
  observer.observe(document.getElementById('modal-content') || document.body, { childList: true });
  const eventPromise = row.event && loadEvent
    ? loadEvent(row.event).catch(() => ({ failed: true }))
    : Promise.resolve(null);
  // The reading waits briefly for the event, so the model can place the filing in its sequence;
  // it never waits long — the event is context, not a prerequisite.
  const related = Promise.race([eventPromise.then((e) => e?.members || []), new Promise((resolve) => setTimeout(() => resolve([]), 1500))]);
  void eventPromise.then((event) => { if (mine === openId && root.isConnected) fillHistory(root, row, event); });
  void related.then((members) => requestRead(row, members)).then((read) => { if (mine === openId && root.isConnected) fillReading(root, row, read); });
}
