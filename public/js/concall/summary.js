import { escapeHtml } from '../core/dom.js';
import { openModal, closeModal } from '../ui/screener.js';
import { onHostContext } from '../core/host-context.js';
import * as summaries from '../data/concall-summaries.js';
import { summaryIdsForRow, summaryStateMessage, summaryScheduleMessage, SUMMARY_INTERVAL_MS, SUMMARY_CRON_OFFSET_MS } from '../data/concall-summaries-shared.js';

const e = escapeHtml;
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'Not checked';
const header = title => `<div class="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-100 bg-white px-6 py-5"><h2 class="font-display text-xl font-bold text-slate-900">${e(title)}</h2><button type="button" data-summary-close aria-label="Close summary" class="rounded-lg px-3 py-2 text-xl text-slate-600">×</button></div>`;
let closeSession = null, openVersion = 0;
export function stopSummary() { openVersion++; closeSession?.(); closeSession = null; }
function modal(html) {
  stopSummary();
  openModal(html, { size: 'wide', onClose: stopSummary });
  const content = document.getElementById('modal-content');
  content.dataset.summaryView = 'true';
  content.scrollTop = 0;
  const close = event => { if (event.target.closest('[data-summary-close]')) closeModal(); };
  content.addEventListener('click', close);
  const unsubscribe = onHostContext((_context, changes) => { if (changes?.session) { closeModal(); stopSummary(); } });
  closeSession = () => { unsubscribe(); content.removeEventListener('click', close); delete content.dataset.summaryView; };
  return openVersion;
}
function bodyHtml(body) {
  return body.blocks.map(block => {
    if (block.type === 'heading') return `<h3 class="mt-6 text-base font-bold text-slate-900">${e(block.text)}</h3>`;
    if (block.type === 'paragraph' || block.type === 'quote') return `<p class="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">${e(block.text)}</p>`;
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag} class="${block.ordered ? 'list-decimal' : 'list-disc'} space-y-2 pl-5 text-sm leading-relaxed text-slate-700">${block.items.map(item => `<li>${e(item)}</li>`).join('')}</${tag}>`;
    }
    return `<div class="overflow-x-auto"><table class="w-full text-left text-sm text-slate-700"><tbody>${block.rows.map(row => `<tr class="border-b border-slate-100">${row.map(cell => `<td class="px-3 py-2 align-top">${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }).join('');
}
function coverageNote() {
  const state = summaries.status();
  return `<p class="text-sm text-slate-600">${e(summaryStateMessage(state))}</p>${state?.cooldownUntil && Date.parse(state.cooldownUntil) > Date.now()
    ? `<p class="mt-2 text-xs text-slate-500">Next eligible source check: ${e(date(state.cooldownUntil))}. The source may impose a longer pause.</p>` : ''}`;
}
function checkBackMessage(records) {
  const state = summaries.status();
  const now = Date.now();
  const future = time => Number.isFinite(time) && time > now ? time : 0;
  const alarm = future(state?.schedule?.alarmAt);
  if (!alarm) return 'Please check back later.';
  const account = Math.max(...[Date.parse(state?.cooldownUntil), Date.parse(state?.nextBudgetAt)].map(future));
  const eligible = Math.min(...records.filter(record => record.active === true)
    .map(record => Math.max(account, future(Date.parse(record.nextAttemptAt)))));
  const timer = alarm + Math.max(0, Math.ceil((eligible - alarm) / SUMMARY_INTERVAL_MS)) * SUMMARY_INTERVAL_MS;
  const cron = Math.ceil((Math.max(now, eligible) - SUMMARY_CRON_OFFSET_MS) / SUMMARY_INTERVAL_MS)
    * SUMMARY_INTERVAL_MS + SUMMARY_CRON_OFFSET_MS;
  // Allow both timer phases to reach eligibility: a recent cron run can defer the durable timer.
  const next = Math.max(timer, cron);
  if (!Number.isFinite(next) || next <= now) return 'Please check back later.';
  const when = new Date(next).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long',
    day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
  return `Please check back — ${when} IST.`;
}
export async function openSummary(row, initialRecords = null) {
  const ids = summaryIdsForRow(row);
  if (!ids.length) return;
  const version = modal(`${header(`${row.name} · Summary`)}<div class="p-6 text-sm text-slate-600" aria-live="polite">Loading summary…</div>`);
  try {
    const records = initialRecords ?? await summaries.read(ids);
    if (version !== openVersion) return;
    const content = document.getElementById('modal-content');
    const focused = content.contains(document.activeElement);
    const ready = records.filter(record => record.status === 'ready');
    if (!ready.length) {
      content.innerHTML = `${header(`${row.name} · Summary`)}<div class="p-6" data-summary-reader><p data-summary-check-back class="text-sm text-slate-700" aria-live="polite">${e(checkBackMessage(records))}</p></div>`;
      const note = content.querySelector('[data-summary-check-back]');
      let checking = false, pendingRecords = records;
      const off = summaries.onChange(async () => {
        if (version !== openVersion || checking) return;
        checking = true;
        try {
          // Read private saved state only; this never requests a source summary.
          const updated = await summaries.read(ids);
          if (version !== openVersion) return;
          pendingRecords = updated;
          if (updated.some(record => record.status === 'ready')) { void openSummary(row, updated); return; }
          note.textContent = checkBackMessage(updated);
        } catch {
          if (version === openVersion) note.textContent = checkBackMessage(pendingRecords);
        } finally { checking = false; }
      });
      const release = closeSession;
      closeSession = () => { off(); release?.(); };
      if (focused) content.querySelector('[data-summary-close]')?.focus({ preventScroll: true });
      return;
    }
    content.innerHTML = `${header(`${row.name} · Summary`)}<div class="space-y-4 p-6" data-summary-reader>
      <p class="text-xs text-slate-500">Screener’s published notes, reproduced unchanged. Reading a saved copy does not request another summary from Screener.</p>
      ${ready.length > 1 ? `<label class="block text-sm text-slate-700">Source version <select data-summary-version class="ml-2 rounded-lg border border-slate-200 bg-white p-2">${ready.map((record, index) => `<option value="${index}">${e(record.kind)} · ${e(record.publishedDate)} · ${e(record.id)}</option>`).join('')}</select></label>` : ''}
      <div data-summary-body class="space-y-4"></div>
      ${records.length > ready.length ? '<p class="text-xs text-slate-500">Additional source notes for this call have not been collected yet.</p>' : ''}
      ${coverageNote()}</div>`;
    const paint = index => {
      const record = ready[index];
      if (!record) return;
      content.querySelector('[data-summary-body]').innerHTML = `<h3 class="text-base font-semibold text-slate-900">${e(record.body.title)}</h3><p class="text-xs text-slate-500">Saved from Screener on ${e(date(record.fetchedAt))}.</p>${bodyHtml(record.body)}`;
    };
    paint(0);
    content.querySelector('[data-summary-version]')?.addEventListener('change', event => paint(Number(event.target.value)));
    if (focused) content.querySelector('[data-summary-close]')?.focus({ preventScroll: true });
  } catch (error) {
    if (version !== openVersion) return;
    const content = document.getElementById('modal-content'), focused = content.contains(document.activeElement);
    content.innerHTML = `${header(`${row.name} · Summary`)}<div class="space-y-3 p-6"><p class="text-sm text-slate-700">${e(error.message)}</p>${coverageNote()}</div>`;
    if (focused) content.querySelector('[data-summary-close]')?.focus({ preventScroll: true });
  }
}
function coverageHtml() {
  const state = summaries.status();
  const labels = { matched: 'Discovered', 'ambiguous-identity': 'Source identity needs review',
    'no-matching-source-company': 'No confirmed company match in the source catalogue', 'no-published-summary': 'No summary listed by Screener' };
  return `${header('Portfolio summary coverage')}<div class="space-y-4 p-6">${coverageNote()}
    <p class="text-xs text-slate-500">Portfolio checked: ${e(date(state?.portfolioCheckedAt))}<br>Source catalogue checked: ${e(date(state?.sourceCheckedAt))}</p>
    <p data-summary-schedule class="text-xs text-slate-500">Automatic collection: ${e(summaryScheduleMessage(state) || (state?.enabled ? 'Timer scheduled; source coverage is reported separately.' : 'Not enabled.'))}<br>Timer last checked: ${e(date(state?.schedule?.lastAttemptAt ? new Date(state.schedule.lastAttemptAt).toISOString() : null))}<br>Next timer check: ${e(date(state?.schedule?.alarmAt ? new Date(state.schedule.alarmAt).toISOString() : null))}</p>
    <p class="text-xs text-slate-500">New holdings join automatically on the next successful portfolio and catalogue check. Saved notes have no automatic expiry. Source corrections without a new summary ID are not re-fetched automatically.</p>
    ${state?.holdings?.length ? `<div class="max-h-[520px] overflow-auto"><table class="w-full text-left text-sm text-slate-700"><thead><tr><th class="p-2">Company</th><th class="p-2">Saved</th><th class="p-2">Pending</th><th class="p-2">Coverage</th></tr></thead><tbody>${state.holdings.map(holding => `<tr class="border-b border-slate-100"><td class="p-2">${e(holding.name)}</td><td class="p-2">${e(holding.ready)}</td><td class="p-2">${e(holding.pending)}</td><td class="p-2">${e(labels[holding.discovery] || 'Unchecked')}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
}
export function openSummaryCoverage() {
  const version = modal(coverageHtml());
  const off = summaries.onChange(() => {
    if (version !== openVersion) return;
    const content = document.getElementById('modal-content'), focused = content.contains(document.activeElement);
    content.innerHTML = coverageHtml();
    if (focused) content.querySelector('[data-summary-close]')?.focus({ preventScroll: true });
  });
  const release = closeSession;
  closeSession = () => { off(); release?.(); };
}
export function summaryStatusHtml() {
  return `<div data-summary-coverage class="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500"><span>${e(summaryStateMessage(summaries.status()))}</span><button type="button" data-summary-coverage-open class="font-semibold text-indigo-600 underline">Summary coverage</button></div>`;
}
export function updateSummaryButtons(root) {
  root.dataset.summaryAvailable = String(summaries.available());
  for (const button of root.querySelectorAll('[data-screener-summary]'))
    button.hidden = !summaries.available((button.dataset.summaryIds || '').split(' '));
}
