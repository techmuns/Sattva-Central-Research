// concall/deep-dive.js — the Deep Dive panel: trigger a run on the Concall Deep Dive dashboard,
// watch it, and show what it produced.
//
//   openDeepDive(row, opts)   full-screen overlay for one company
//
// THE REPORT IS SOMEBODY ELSE'S ANALYSIS AND THE PANEL NEVER PRETENDS OTHERWISE.
//   Every heading, verdict, number and quote in it comes from the Concall Deep Dive pipeline.
//   This file lays it out; it computes nothing, re-bands nothing, drops nothing and adds no
//   judgement. An "Open on Concall Deep Dive ↗" link sits at the top of every finished report so
//   their own rendering — the canonical one — is always one click away. Same rule as the
//   StockScans scores in the table behind it.
//
//   That includes the QUOTED SPEECH. A finished report carries transcript quotes attributed to
//   named executives and named sell-side analysts. Those are real words from a real call, lifted
//   by their pipeline — the opposite of the synthetic-speech case CLAUDE.md forbids, where the
//   words would have been invented. Nothing here edits, paraphrases or generates any of it, the
//   ribbon above every report says whose extraction it is, and `meta.sources` links the filed
//   transcript so the primary document is one click away. If that ever stopped being true — if a
//   quote could be model-written rather than transcript-lifted — this panel would have to stop
//   rendering quotes, not caveat them.
//
// THE LOADING WINDOW IS THEIR WORDS, NOT OUR GUESS.
//   A run takes minutes. The progress panel prints the `stage` and `message` their pipeline
//   reports on each poll, the elapsed time, and every stage seen so far as a trail. A generic
//   spinner would be inventing reassurance; "extract · pulling the transcript" is what is
//   actually happening.
//
//   WHICH IS EXACTLY WHY REOPENING MUST NOT SHOW IT. That screen used to paint the moment the panel
//   opened, for a reattach as much as for a dispatch — so returning to a report finished an hour ago
//   showed "Starting the analysis… 5%" and the seven-step checklist while a free GET was in flight.
//   Nothing was being run and nothing was being charged, but the panel said otherwise, and a reader
//   has no way to tell a screen that means "we are spending your money" from one that means "we are
//   asking a question we already know the answer to". So a reattach opens on `opening` — one quiet
//   line that says no run is being started — and only a status their API actually reports as in
//   flight promotes it to the pipeline screen.
//
// A REPORT ALREADY READ SHOULD NEVER HAVE TO BE PAID FOR TWICE.
//   Finished reports are kept on this device (see js/data/deep-dive.js). Reopening one paints from
//   there with no request at all, then re-checks them in the background: unchanged is the common
//   case and repaints nothing, a newer report replaces it, and a failure — including their store
//   having dropped the report after its fortnight — leaves our copy exactly where it is. Dropping
//   to the confirm step in that last case, which is what this did before, asked the reader to spend
//   a fresh run to get back something we were holding the whole time.
//
// WHY THE REPORT RENDERER IS SHAPE-DRIVEN AND NOT FIELD-DRIVEN
//   `report.schema.json` lives in that repo, not this one, and the payload is expected to grow.
//   So this renders sections IN THEIR OWN KEY ORDER and decides how to draw each one from its
//   SHAPE — a uniform array of short scalars is a table, an array carrying prose is a stack of
//   cards, a flat object is a definition grid — rather than from a list of field names we would
//   have to keep in sync. A section they add next month arrives laid out, not dropped and not
//   dumped as JSON. `meta` is the one exception: it is provenance, so it gets a purpose-built
//   strip, and even that falls back to the generic path if its shape changes.
//
//   It is also EXTERNAL CONTENT, so every string is escaped and only http(s) links are ever
//   turned into anchors. Nothing from that API reaches the DOM as markup.

import { openWorkspace, closeWorkspace, refreshWorkspace, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import * as api from '../data/deep-dive.js';

// The panel's whole state, kept at module level because the workspace re-renders itself lazily
// and a poll tick has to be able to repaint whatever tab is showing.
let live = null;

/**
 * Open the panel for one call row.
 *
 * `ready` is that company's row from their `/api/summary` index, when they already hold a report
 * for it. That case skips the confirm step and opens the report straight away, because there is
 * nothing to confirm: fetching a finished report is a plain GET and costs nobody anything. Every
 * other row lands on the confirm step, because a dispatch starts a real pipeline run.
 *
 * `onRecorded(slug)` fires the moment a run gets its id, so the table behind can mark the row.
 *
 * NO URL MIRRORING, DELIBERATELY — and this is the one workspace that opts out of the kit's usual
 * `ctx.setParamsQuiet()` contract. Reopening from the URL has to happen after every paint, and the
 * Con-call tab repaints on every live tick; a reopen mid-run would tear down a job that has been
 * going for ten minutes. There is also little to link to: the report's canonical address is on the
 * Deep Dive dashboard itself, and every finished panel carries that link.
 */
export function openDeepDive(row, { onRecorded = null, onSaved = null, ready = null } = {}) {
  stop();
  const ticker = row.ticker || null;
  const company = row.name || ticker || '';
  const known = api.remembered(ticker);
  const saved = api.savedFor(ticker);

  // A report this device holds, a run this browser started, or a report their index says exists.
  // Any of the three means there is a slug to open, and opening one is free — so the panel goes
  // straight there instead of asking a question whose answer it already has.
  //
  // Their index wins the RE-CHECK, because it names the newest report they hold and ours may be a
  // quarter behind. It does not win the PAINT: the saved copy goes up immediately either way, and
  // is replaced in place if the check turns up something newer.
  const attachSlug = ready?.slug || known?.slug || saved?.slug || null;

  live = {
    ticker,
    company,
    onRecorded,
    onSaved,
    ready,
    phase: !api.configured() ? 'connect' : attachSlug ? 'opening' : 'confirm',
    progress: null,
    displayPct: 0,
    report: null,
    slug: attachSlug,
    savedSlug: saved?.slug || null,
    savedAt: null,
    // Where THIS PAINT came from ('store' | 'live') and when the dashboard last confirmed it —
    // two different facts, and the ribbon prints both. A re-check moves the second, not the first.
    origin: null,
    checkedAt: null,
    revalidating: false,
    upstreamGone: false,
    checkFailed: null,
    partial: false,
    cached: false,
    error: null,
    controller: null,
  };

  openWorkspace({
    title: company,
    subtitle: `${ticker ? `${ticker} · ` : ''}Concall Deep Dive${ready?.quarter ? ` · ${ready.quarter}` : ''}`,
    avatarName: company,
    badges: [
      '<span class="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200">External analysis</span>',
    ],
    tabs: [{ id: 'run', label: 'Deep Dive', render: renderPanel, wire: wirePanel }],
    activeTab: 'run',
    onClose: () => stop(),
  });

  // REATTACH ON OPEN — this is what makes "Leave it running" mean what it says.
  //
  // `resume()` only ever polls `GET /api/report`, which is free, so doing it unprompted breaks no
  // rule: the one thing that must never fire on its own is a dispatch. If the run is still going
  // the reader lands straight on its live progress; if it finished while the panel was closed they
  // land on the report; if the slug has aged out upstream, the copy on this device is what they
  // land on. Before this, reopening showed a confirm panel with a "Reattach to it" link — the run
  // was never lost, but you had to know to ask for it.
  if (attachSlug && api.configured()) reopen(attachSlug);
}

/**
 * Open a slug we already have: this device's copy first, then a re-check against them.
 *
 * The order is the whole point. The stored report is painted before any request is made, so the
 * common case — reopening something already read — is instant and silent. The re-check that follows
 * is free, and can only ever improve what is on screen: replace it with a newer report, or leave it
 * alone. It cannot take it away.
 */
async function reopen(attachSlug) {
  const owner = live;
  const saved = owner.savedSlug ? await api.savedReport(owner.savedSlug) : null;
  if (live !== owner) return; // the reader closed it while the store was being read

  if (saved?.report) {
    live.report = saved.report;
    live.partial = saved.partial;
    live.slug = saved.slug;
    live.savedAt = saved.savedAt;
    live.origin = 'store';
    live.revalidating = true;
    live.phase = 'done';
    refreshWorkspace();
  }
  // `background` keeps the paint that is already up — a report on screen is not replaced by a
  // progress screen just because we are asking whether there is a newer one.
  run({ resume: true, slug: attachSlug, auto: true, background: !!saved?.report });
}

/**
 * Stop polling and drop the state. The run itself continues on their side.
 *
 * Exported because the shell closes overlays on every route change with `{ silent: true }`, which
 * skips `onClose` — without this the poller would outlive the panel it repaints, ticking against
 * a workspace that is no longer on screen for the rest of the session.
 */
export function stopDeepDive() {
  if (!live) return;
  live.controller?.abort();
  live = null;
}

const stop = stopDeepDive;

// ---------------------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------------------

function renderPanel() {
  if (!live) return '';
  switch (live.phase) {
    case 'connect':
      return connectPanel();
    case 'confirm':
      return confirmPanel();
    case 'opening':
      return openingPanel();
    case 'running':
      return runningPanel();
    case 'error':
      return errorPanel();
    case 'done':
      return reportPanel();
    default:
      return '';
  }
}

function connectPanel() {
  return `
    <div class="mx-auto max-w-2xl px-6 py-10">
      <h3 class="font-display text-lg font-bold text-slate-900">Connect the Deep Dive dashboard</h3>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">
        Concall Deep Dive runs on its own Cloudflare Worker, and its URL is assigned per deployment — nobody in this
        repo can know it, so it is not committed here. Paste it once and it is remembered in this browser.
      </p>
      <label class="mt-5 block text-xs font-bold uppercase tracking-wider text-slate-500" for="dd-base">Dashboard URL</label>
      <input id="dd-base" type="url" spellcheck="false" placeholder="https://concall-sattva.your-subdomain.workers.dev"
        class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-400 focus:outline-none" />
      <p data-dd-connect-error class="mt-2 hidden text-xs text-rose-700"></p>
      <div class="mt-4 flex flex-wrap gap-2">
        <button data-dd-save class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-opacity hover:opacity-90">Save and continue</button>
        <button data-dd-cancel class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Cancel</button>
      </div>
      <p class="mt-6 text-xs leading-relaxed text-slate-500">
        To set it for everyone instead of just this browser, add
        <code class="rounded bg-slate-100 px-1">window.SATTVA_DEEPDIVE_URL = '…'</code> in
        <code class="rounded bg-slate-100 px-1">public/index.html</code>.
      </p>
    </div>`;
}

function confirmPanel() {
  const known = api.remembered(live.ticker);
  const rerun = !!live.rerun;
  return `
    <div class="mx-auto max-w-2xl px-6 py-10">
      <h3 class="font-display text-lg font-bold text-slate-900">${rerun ? 'Re-run the Deep Dive on' : 'Run a Deep Dive on'} ${escapeHtml(live.company)}</h3>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">
        This asks the <strong>Concall Deep Dive</strong> dashboard to analyse this company's latest call. The analysis is
        entirely theirs — this page triggers it, shows its progress, and displays what it returns.
      </p>
      <div class="mt-4 rounded-xl bg-amber-50 p-4 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
        <strong>A run costs real compute.</strong> Each dispatch starts an LLM pipeline on their side and takes several
        minutes. A report produced in the last fortnight is reused automatically and costs nothing, which is what
        usually happens on a second click.
        ${rerun ? '<strong> Forcing a fresh run skips that reuse, so this one will cost a full run.</strong>' : ''}
      </div>
      ${
        known?.slug && !rerun
          ? `<p class="mt-3 text-xs text-slate-500">A previous run for this company is on record (<code class="rounded bg-slate-100 px-1">${escapeHtml(known.slug)}</code>). <button data-dd-resume class="font-semibold text-indigo-600 hover:underline">Reattach to it</button> instead of starting a new one.</p>`
          : ''
      }
      <div class="mt-5 flex flex-wrap items-center gap-2">
        <button data-dd-start class="rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition-opacity hover:opacity-90">${rerun ? 'Yes, start a fresh run' : 'Start the Deep Dive'}</button>
        <label class="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" data-dd-force class="rounded border-slate-300" ${rerun ? 'checked' : ''} />
          Force a fresh run, ignoring any cached report
        </label>
        ${rerun && live.report ? '<button data-dd-back class="rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Back to the report</button>' : ''}
      </div>
      <p class="mt-6 text-xs text-slate-500">Connected to <code class="rounded bg-slate-100 px-1">${escapeHtml(api.baseUrl())}</code> · <button data-dd-reconnect class="font-semibold text-indigo-600 hover:underline">change</button></p>
    </div>`;
}

/**
 * Opening something that already exists — NOT the pipeline screen.
 *
 * This is a free `GET /api/report` on a slug we already have. It usually resolves in a few hundred
 * milliseconds, and what it is waiting on is a lookup, not an analysis. Showing the run screen here
 * — stage labels, a checklist, a percentage climbing from 5% — describes work that is not happening
 * and reads exactly like the metered thing the reader was careful not to start. One line, and it
 * says so outright.
 */
function openingPanel() {
  return `
    <div class="mx-auto max-w-2xl px-6 py-16 text-center">
      <div class="inline-flex items-center gap-2 text-sm font-medium text-slate-600">
        <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-500"></span>
        Opening the report for ${escapeHtml(live.company)}…
      </div>
      <p class="mt-3 text-xs leading-relaxed text-slate-400">
        No run is being started — this only reads the analysis Concall Deep Dive already holds.
      </p>
    </div>`;
}

/**
 * The loading window — THEIR progress screen, not ours.
 *
 * Their API sends one field while a run is in flight: a `stage` key. Their own dashboard turns it
 * into a sentence, a percentage and a checklist using the table in js/data/deep-dive.js, and this
 * is that same screen: spinner line, stage label, percentage, bar, the seven steps with the ones
 * behind you ticked.
 *
 * WHAT WAS REMOVED, AND WHY. An earlier version printed a raw stage key ("EXTRACT"), an elapsed
 * clock, a running trail of every stage with timestamps, the slug, and two paragraphs about how
 * long runs take. None of it is on their screen, and one line was actively misleading: it showed
 * "Waiting for the pipeline to report in…" as the message, because their payload has no `message`
 * field at all — so the panel implied nothing was happening while the stage beside it said the
 * pipeline was mid-way through reading the transcript. The stage IS the information.
 */
function runningPanel() {
  const info = api.stageInfo(live.progress?.stage);
  const pct = Math.round(live.displayPct ?? info.pct);
  return `
    <div class="mx-auto max-w-2xl px-6 py-10">
      <div class="mb-8 text-center">
        <div class="mb-3 inline-flex items-center gap-2 text-xs text-slate-400">
          <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-500"></span>
          Analysing — this usually takes a few minutes
        </div>
        <h2 class="font-display text-2xl font-bold text-slate-800">${escapeHtml(live.company)}</h2>
        ${live.ticker ? `<p class="mt-1 font-mono text-sm text-slate-400">${escapeHtml(live.ticker)}</p>` : ''}
      </div>

      <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <div class="mb-2 flex items-center justify-between text-sm">
          <span class="font-medium text-slate-600">${escapeHtml(info.label)}</span>
          <span class="font-mono tabular-nums text-slate-400">${pct}%</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div class="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-700" style="width:${pct}%"></div>
        </div>

        <ul class="mt-6 space-y-3">
          ${api.CHECKLIST_STAGES.map((s) => {
            const idx = api.stageInfo(s.key).index;
            const done = idx < info.index;
            const active = idx === info.index;
            return `<li class="flex items-center gap-3 text-sm ${done ? 'text-slate-600' : active ? 'font-medium text-slate-800' : 'text-slate-400'}">
              <span class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${
                done ? 'bg-emerald-500 text-white' : active ? 'bg-indigo-600 text-white' : 'text-slate-300 ring-1 ring-slate-200'
              }">
                ${
                  done
                    ? '<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
                    : active
                      ? '<svg class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>'
                      : '<svg class="h-2 w-2" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="12"/></svg>'
                }
              </span>
              <span>${escapeHtml(s.label)}</span>
            </li>`;
          }).join('')}
        </ul>

        <div class="mt-7 border-t border-slate-100 pt-5 text-center">
          <button data-dd-close class="rounded-lg bg-slate-100 px-5 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200">Leave it running</button>
          <p class="mt-4 text-xs text-slate-400">
            This run keeps going in the background. Close this, switch tabs or reload — reopening it picks the progress back up.
          </p>
        </div>
      </div>
    </div>`;
}

function errorPanel() {
  const url = api.reportUrl(live.slug);
  return `
    <div class="mx-auto max-w-2xl px-6 py-10">
      <h3 class="font-display text-lg font-bold text-slate-900">The Deep Dive did not finish</h3>
      <div class="mt-3 rounded-xl bg-rose-50 p-4 text-sm leading-relaxed text-rose-900 ring-1 ring-rose-200">${escapeHtml(live.error || 'Unknown error.')}</div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button data-dd-start class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:opacity-90">Try again</button>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="rounded-lg px-4 py-2 text-sm font-semibold text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50">Open on Concall Deep Dive ↗</a>` : ''}
        <button data-dd-reconnect class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Change dashboard URL</button>
      </div>
    </div>`;
}

/**
 * The panel is titled with OUR row's company; the report is titled with THEIRS. Those must agree.
 *
 * A slug is derived on their side, and this dashboard resolves one from a ticker in three places —
 * their summary index, this browser's memory of a dispatch, and this device's saved reports. If any
 * of them ever pointed at the wrong report, the result would be one company's analysis rendered
 * under another's name, which is the worst thing this panel could do. So it checks, and says so
 * loudly rather than quietly presenting it. Missing identity on their side is not a mismatch — only
 * a contradiction is. The third source cannot produce one: `run()` refuses to file a report under a
 * ticker it contradicts, so nothing that fails this check is ever written to the store.
 */
function identityMismatch(report) {
  if (!api.conflictsWith(report, live.ticker)) return '';
  const theirs = String(report?.meta?.ticker || '').toUpperCase();
  const ours = String(live.ticker || '').toUpperCase();
  return `
    <div class="mb-5 rounded-2xl bg-rose-50 p-4 text-xs leading-relaxed text-rose-900 ring-1 ring-rose-200">
      <strong>This report is for a different company.</strong> The row opened was
      <strong>${escapeHtml(live.company)}</strong> (${escapeHtml(ours)}), but Concall Deep Dive returned a report for
      <strong>${escapeHtml(String(report?.meta?.company || theirs))}</strong> (${escapeHtml(theirs)}).
      Read it as that company's, not this one's — and the link above goes to their copy, which is the one to trust.
    </div>`;
}

/**
 * Where THIS paint came from, in the ribbon's own words.
 *
 * `origin` is where the bytes on screen came from and `checkedAt` is when the dashboard last
 * confirmed them — the same two facts `deliveryNote()` prints for the polled feeds, and they are
 * deliberately separate. A stored report that has not been re-checked yet says so; one that has
 * says when. Neither is allowed to read as "fresh from Concall Deep Dive" unless it is.
 */
function deliveryLine() {
  const when = live.savedAt ? ` ${escapeHtml(formatRelativeTime(live.savedAt))}` : '';
  if (live.origin === 'store') {
    const check = live.rebuilding
      ? 'Concall Deep Dive is running a fresh analysis of this call right now — it will replace this when it lands.'
      : live.revalidating
        ? 'Checking Concall Deep Dive for a newer one…'
        : live.upstreamGone
          ? '<span class="text-amber-800">Concall Deep Dive no longer holds this report — their store keeps one for about a fortnight — so this device’s copy is the one there is.</span>'
          : live.checkFailed
            ? `<span class="text-amber-800">Concall Deep Dive could not be reached to check for a newer one (${escapeHtml(live.checkFailed)}), so this has not been re-checked.</span>`
            : 'Confirmed unchanged with Concall Deep Dive just now.';
    return `Shown from the copy saved on this device${when} — no run, and nothing downloaded to open it. ${check}`;
  }
  const kept = live.saved ? ' It is now saved on this device, so opening it again costs nothing at all.' : '';
  if (live.replacedStored) return `Concall Deep Dive had a newer report than the one saved here, and this is it.${kept}`;
  if (live.ready)
    return `A report they already held${live.ready.generated_at ? `, generated ${escapeHtml(formatRelativeTime(live.ready.generated_at))}` : ''} — opening it started no run.${kept}`;
  if (live.cached) return `Served from their cache rather than a fresh run.${kept}`;
  return `Produced by a run started from this page.${kept}`;
}

function reportPanel() {
  const url = api.reportUrl(live.slug);
  const report = live.report;
  return `
    <div class="px-6 py-6">
      ${identityMismatch(report)}
      <div class="mb-5 flex flex-wrap items-center gap-3 rounded-2xl bg-indigo-50/60 p-4 ring-1 ring-indigo-100">
        <div data-dd-ribbon class="min-w-0 flex-1 text-xs leading-relaxed text-slate-700">${ribbonText()}</div>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="flex-shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:opacity-90">Open on Concall Deep Dive ↗</a>` : ''}
      </div>
      ${report ? renderReport(report) : '<p class="text-sm text-slate-500">The run finished but returned no report body. Their own page above will have it.</p>'}
      <div class="mt-6 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <button data-dd-rerun class="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Re-run from scratch…</button>
        <button data-dd-raw class="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">View raw JSON</button>
        <span class="text-[11px] text-slate-400">Re-running starts a fresh pipeline run and asks first.</span>
      </div>
    </div>`;
}

const ribbonText = () => `
  <strong>This analysis is Concall Deep Dive's, reproduced here unchanged.</strong>
  Nothing on this panel is computed or re-scored by Sattva Central Research.
  ${deliveryLine()}
  ${live.partial ? '<span class="text-amber-800"> Some fields were unavailable, so the report is incomplete in places.</span>' : ''}`;

/**
 * Repaint the ribbon alone, for when the re-check changed the delivery and nothing else.
 *
 * A full `refreshWorkspace()` re-renders the report and sends the reader back to the top of it,
 * which is a rude thing to do to someone mid-paragraph in order to announce that nothing changed.
 * Every caller has already set `phase` to `done`, so a missing ribbon means the report is not on
 * screen yet — a reattach that failed back onto the saved copy, say — and that needs a full render.
 */
function updateRibbon() {
  if (!live || live.phase !== 'done') return;
  const node = document.querySelector('#workspace-panel [data-dd-ribbon]');
  if (node) node.innerHTML = ribbonText();
  else refreshWorkspace();
}

// ---------------------------------------------------------------------------------------
// The report renderer — see "shape-driven, not field-driven" in the header
//
// One rule decides everything: WHAT SHAPE IS THIS VALUE?
//
//   short scalar            a figure or a chip
//   long string             a paragraph
//   array of scalars        a bullet list (or chips, when they are all short)
//   array of objects, short a table
//   array of objects, prose a stack of cards, first field as the card's title
//   flat object             a definition grid
//   nested object           labelled blocks, one per key
//
// Nothing keys off a field NAME except `meta` (provenance, so it earns a purpose-built strip)
// and the two presentational hints below. That is what lets a section they add next month
// arrive laid out rather than dumped as JSON.
// ---------------------------------------------------------------------------------------

// Two name-based hints, both cosmetic and both safe if the field disappears:
//   quote — transcript speech, so it reads as speech rather than as another data field
//   *_url / url — an address, so it is clickable
const QUOTE_KEYS = new Set(['quote', 'anchor', 'sample']);
const isUrlKey = (k) => /(^|_)url$/i.test(k);
// The width at which a value stops being a table cell and becomes prose.
const PROSE_AT = 90;

const humanise = (k) =>
  String(k)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b(pct|yoy|qoq|fy\d+[ae]?|pe|ev|ebitda|aum|cmp|roa|qa|rbi|ltv|npa)\b/gi, (m) => m.toUpperCase())
    .replace(/\bcr\b/gi, 'Cr')
    .replace(/^./, (c) => c.toUpperCase());

const isScalar = (v) => v === null || typeof v !== 'object';
const longest = (arr, key) => Math.max(0, ...arr.map((o) => (typeof o?.[key] === 'string' ? o[key].length : 0)));

// A machine timestamp is data; printing it raw is just less readable, not more honest. Formatting
// one is presentation — unlike a number, where re-rendering could change what it claims.
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const stamp = (s) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(s) : `${d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · ${formatRelativeTime(s)}`;
};

const scalarText = (v) =>
  typeof v === 'number'
    ? formatNumber(v, { decimals: Number.isInteger(v) ? 0 : 2 })
    : typeof v === 'boolean'
      ? v
        ? 'Yes'
        : 'No'
      : ISO_AT.test(String(v))
        ? stamp(v)
        : String(v);

/** Only ever produce an anchor for a real http(s) address — this is external content. */
function safeLink(value, label) {
  const s = String(value || '').trim();
  if (!/^https?:\/\//i.test(s)) return escapeHtml(s);
  return `<a href="${escapeHtml(s)}" target="_blank" rel="noopener noreferrer" class="break-all font-medium text-indigo-600 hover:underline">${escapeHtml(label || s)}</a>`;
}

function renderReport(report) {
  if (!report || typeof report !== 'object') return `<p class="text-sm text-slate-700">${escapeHtml(String(report ?? ''))}</p>`;
  // THEIR key order, not ours. It is deliberate on their side and it reads well; reordering it
  // here would be this dashboard editing their report, and would silently misfile a new section.
  return Object.entries(report)
    .map(([key, value]) => {
      if (key === 'meta') return metaStrip(value);
      const body = renderValue(value, 0, key);
      if (!body) return '';
      return `<section class="mb-7">
        <h3 class="font-display mb-2.5 border-b border-slate-100 pb-1.5 text-sm font-bold uppercase tracking-wider text-indigo-700">${escapeHtml(humanise(key))}</h3>
        ${body}
      </section>`;
    })
    .join('');
}

/**
 * `meta` is the report's provenance: who it is about, when it was generated, what it was priced
 * off, and — the part that matters most — a link to the filed transcript the whole thing was
 * read from. That is the primary document, so it gets a real link rather than a table cell.
 * Anything unexpected in `meta` falls through to the generic renderer.
 */
function metaStrip(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return renderValue(meta, 0, 'meta');
  const { sources, inputs, company, ticker, slug, ...rest } = meta;
  const facts = Object.entries(rest).filter(([, v]) => v != null && v !== '' && isScalar(v));
  const links = [
    ['Filed transcript', sources?.transcript_url],
    ['Investor presentation', sources?.ppt_url],
  ].filter(([, u]) => typeof u === 'string' && /^https?:\/\//i.test(u));

  return `
    <section class="mb-7 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div class="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Report provenance · Concall Deep Dive</div>
      <div class="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-slate-600">
        ${facts.map(([k, v]) => `<span><span class="text-slate-400">${escapeHtml(humanise(k))}</span> <span class="font-semibold text-slate-800">${escapeHtml(scalarText(v))}</span></span>`).join('')}
        ${sources?.concall_date ? `<span><span class="text-slate-400">Call date</span> <span class="font-semibold text-slate-800">${escapeHtml(String(sources.concall_date))}</span></span>` : ''}
      </div>
      ${
        links.length
          ? `<div class="mt-2.5 flex flex-wrap gap-3 text-xs">${links.map(([label, u]) => `<span>↗ ${safeLink(u, label)}</span>`).join('')}</div>
             <p class="mt-1.5 text-[11px] leading-relaxed text-slate-400">The filings above are the primary source. Everything below is Concall Deep Dive's reading of them.</p>`
          : ''
      }
      ${inputs && typeof inputs === 'object' ? `<div class="mt-3 border-t border-slate-200 pt-2"><div class="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Priced off</div>${renderValue(inputs, 2, 'inputs')}</div>` : ''}
    </section>`;
}

/**
 * Render an arbitrary JSON value by its shape.
 *
 * `depth` keeps nesting from running away; `key` is used only for the two cosmetic hints above.
 * Every string is escaped — this is another service's output.
 */
function renderValue(v, depth, key = '') {
  if (v == null || v === '') return '';

  if (typeof v === 'boolean') return `<p class="text-sm text-slate-700">${v ? 'Yes' : 'No'}</p>`;
  if (typeof v === 'number') return `<p class="text-sm font-semibold tabular-nums text-slate-900">${escapeHtml(scalarText(v))}</p>`;

  if (typeof v === 'string') {
    if (isUrlKey(key)) return `<p class="text-sm">${safeLink(v)}</p>`;
    if (QUOTE_KEYS.has(key)) return quoteBlock(v);
    // Paragraph breaks preserved; nothing else about the string is interpreted.
    return v
      .split(/\n{2,}/)
      .map((para) => `<p class="mb-2 text-sm leading-relaxed text-slate-700">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  if (Array.isArray(v)) {
    if (!v.length) return '';

    // All scalars: short ones read as chips, longer ones as a bullet list.
    if (v.every(isScalar)) {
      const max = Math.max(...v.map((x) => String(x ?? '').length));
      if (max <= 28) {
        return `<div class="flex flex-wrap gap-1.5">${v
          .map((x) => `<span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">${escapeHtml(scalarText(x))}</span>`)
          .join('')}</div>`;
      }
      return `<ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-700">${v.map((x) => `<li>${escapeHtml(scalarText(x))}</li>`).join('')}</ul>`;
    }

    const objects = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objects.length === v.length) {
      const cols = [...new Set(v.flatMap((o) => Object.keys(o)))];
      const flat = v.every((o) => Object.values(o).every(isScalar));
      const wide = cols.some((c) => longest(v, c) > PROSE_AT);
      // A table only where every cell is a short scalar. One 400-character "evidence" field turns
      // a table into an unreadable wall, and that is exactly what these reports carry.
      if (flat && !wide && cols.length <= 8 && depth < 3) return objectTable(v, cols);
      return v.map((item) => itemCard(item, depth)).join('');
    }
    // Mixed bag — render each element on its own terms.
    return v.map((x) => `<div class="mb-3">${renderValue(x, depth + 1)}</div>`).join('');
  }

  // Plain object.
  const entries = Object.entries(v).filter(([, val]) => val != null && val !== '' && !(Array.isArray(val) && !val.length));
  if (!entries.length) return '';
  if (entries.every(([, val]) => isScalar(val))) return definitionGrid(entries);
  return entries
    .map(([k, val]) => {
      const body = renderValue(val, depth + 1, k);
      return body
        ? `<div class="mb-4">
             <div class="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">${escapeHtml(humanise(k))}</div>
             ${body}
           </div>`
        : '';
    })
    .join('');
}

/** Speech from the call, set as speech. */
const quoteBlock = (s) =>
  `<blockquote class="border-l-2 border-indigo-200 pl-3 text-sm italic leading-relaxed text-slate-600">${escapeHtml(String(s))}</blockquote>`;

/**
 * One chip on a card's title line.
 *
 * A bare figure needs its field name and a word does not: "+38%" is meaningless without knowing
 * it is the YoY delta, while "FY27", "hard" and "Transcript" say what they are. So the label is
 * printed only for values that are purely numeric — otherwise the chips stay clean.
 */
const BARE_NUMBER = /^[+\-−]?[\d.,]+\s*%?$/;
const chip = (k, val) => {
  const text = scalarText(val);
  const labelled = BARE_NUMBER.test(text);
  return `<span class="inline-flex items-baseline gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600" title="${escapeHtml(humanise(k))}">${
    labelled ? `<span class="font-medium text-slate-400">${escapeHtml(humanise(k))}</span>` : ''
  }${escapeHtml(text)}</span>`;
};

function objectTable(rows, cols) {
  return `<div class="overflow-x-auto rounded-xl ring-1 ring-slate-200">
    <table class="w-full text-sm"><thead class="bg-slate-50"><tr>
      ${cols
        .map(
          (c, i) =>
            `<th scope="col" class="whitespace-nowrap px-3 py-2 text-xs font-bold uppercase tracking-wider text-slate-600 ${i && typeof rows[0][c] === 'number' ? 'text-right' : 'text-left'}">${escapeHtml(humanise(c))}</th>`
        )
        .join('')}
    </tr></thead><tbody>
      ${rows
        .map(
          (row) => `<tr class="border-t border-slate-100">${cols
            .map((c, i) => {
              const cell = row[c];
              const num = typeof cell === 'number';
              const body =
                cell == null || cell === ''
                  ? '<span class="text-slate-300">—</span>'
                  : isUrlKey(c)
                    ? safeLink(cell, 'link')
                    : escapeHtml(scalarText(cell));
              return `<td class="px-3 py-2 align-top ${num ? 'tabular-nums' : ''} ${i && num ? 'text-right' : 'text-left'} ${i === 0 ? 'font-semibold text-slate-900' : 'text-slate-700'}">${body}</td>`;
            })
            .join('')}</tr>`
        )
        .join('')}
    </tbody></table>
  </div>`;
}

/**
 * One element of an array of objects, as a card.
 *
 * The FIRST key is the title — their key order puts the identifying field first in every section
 * of a real report (`theme`, `risk`, `catalyst`, `metric`, `trigger`, `analyst`), so this needs no
 * list of field names. Short scalars become chips on the title line; prose and quotes stack below.
 */
function itemCard(item, depth) {
  const entries = Object.entries(item).filter(([, val]) => val != null && val !== '' && !(Array.isArray(val) && !val.length));
  if (!entries.length) return '';
  const [titleKey, titleValue] = entries[0];
  const rest = entries.slice(1);
  const chips = rest.filter(([k, val]) => isScalar(val) && !QUOTE_KEYS.has(k) && !isUrlKey(k) && String(val).length <= 28);
  const blocks = rest.filter((e) => !chips.includes(e));

  return `
    <div class="mb-2.5 rounded-xl bg-white p-3.5 ring-1 ring-slate-200">
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span class="text-sm font-bold text-slate-900">${isScalar(titleValue) ? escapeHtml(scalarText(titleValue)) : escapeHtml(humanise(titleKey))}</span>
        ${chips.map(([k, val]) => chip(k, val)).join('')}
      </div>
      ${!isScalar(titleValue) ? renderValue(titleValue, depth + 1, titleKey) : ''}
      ${blocks
        .map(([k, val]) => {
          const body = renderValue(val, depth + 1, k);
          if (!body) return '';
          // A quote carries its own visual voice, so it needs no label above it.
          if (QUOTE_KEYS.has(k)) return `<div class="mt-2">${body}</div>`;
          return `<div class="mt-2">
            <div class="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(humanise(k))}</div>
            ${body}
          </div>`;
        })
        .join('')}
    </div>`;
}

function definitionGrid(entries) {
  return `<dl class="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
    ${entries
      .map(
        ([k, val]) => `<div class="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1">
          <dt class="text-xs text-slate-500">${escapeHtml(humanise(k))}</dt>
          <dd class="text-right text-sm font-semibold text-slate-900 ${typeof val === 'number' ? 'tabular-nums' : ''}">${isUrlKey(k) ? safeLink(val, 'link') : escapeHtml(scalarText(val))}</dd>
        </div>`
      )
      .join('')}
  </dl>`;
}

// ---------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------

function wirePanel(panel) {
  if (!live) return;
  const on = (sel, fn) => panel.querySelector(sel)?.addEventListener('click', fn);

  on('[data-dd-cancel]', () => closeWorkspace());
  on('[data-dd-close]', () => closeWorkspace());
  on('[data-dd-reconnect]', () => {
    live.phase = 'connect';
    refreshWorkspace();
  });
  on('[data-dd-start]', () => run({ force: !!panel.querySelector('[data-dd-force]')?.checked }));
  // "Re-run" goes BACK TO THE CONFIRM STEP rather than dispatching. It is the one control on a
  // finished report that spends money, and a single stray click on it should not be able to.
  on('[data-dd-rerun]', () => {
    live.phase = 'confirm';
    live.rerun = true;
    refreshWorkspace();
  });
  on('[data-dd-resume]', () => run({ resume: true }));
  on('[data-dd-back]', () => {
    live.rerun = false;
    live.phase = 'done';
    refreshWorkspace();
  });
  on('[data-dd-raw]', () =>
    openModal(
      `<div class="px-6 py-5">
         <div class="mb-3 flex items-start justify-between gap-4">
           <h2 class="font-display text-lg font-bold text-slate-900">Report as returned</h2>
           <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
         </div>
         <pre class="scrollbar-thin max-h-[60vh] overflow-auto rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">${escapeHtml(JSON.stringify(live.report, null, 2))}</pre>
       </div>`,
      { size: 'wide' }
    )
  );

  const save = panel.querySelector('[data-dd-save]');
  if (save) {
    const input = panel.querySelector('#dd-base');
    const err = panel.querySelector('[data-dd-connect-error]');
    input?.focus();
    const commit = () => {
      const url = api.setBaseUrl(input.value);
      if (!url) {
        err.textContent = 'Enter the dashboard URL, for example https://concall-sattva.your-subdomain.workers.dev';
        err.classList.remove('hidden');
        return;
      }
      live.phase = 'confirm';
      refreshWorkspace();
    };
    save.addEventListener('click', commit);
    input?.addEventListener('keydown', (e) => e.key === 'Enter' && commit());
  }
}

async function run({ force = false, resume = false, slug = null, auto = false, background = false } = {}) {
  if (!live) return;
  const controller = new AbortController();
  live.controller?.abort();
  live.controller = controller;
  live.error = null;
  live.checkFailed = null;
  live.upstreamGone = false;
  live.rebuilding = false;

  // Resolved ONCE, and both the screen and the request branch off it. `opening` tells the reader in
  // as many words that no run is being started, so the flag that decides which screen to show has
  // to be the same one that decides whether a dispatch happens — not a separate reading of the same
  // intent that could drift into showing that sentence over a `POST /api/analyze`.
  const resumeSlug = resume ? slug || api.remembered(live.ticker)?.slug : null;

  // A dispatch opens on the pipeline screen because a pipeline is what it starts. A reattach opens
  // on `opening`, and a re-check behind a report we already have changes nothing on screen at all.
  if (!background) {
    live.phase = resumeSlug ? 'opening' : 'running';
    live.progress = { status: 'queued', stage: null };
    live.displayPct = api.stageInfo(null).pct;
    refreshWorkspace();
  }

  const onProgress = (p) => {
    if (!live || live.controller !== controller) return;
    live.progress = p;
    if (p.slug && p.slug !== live.slug) {
      live.slug = p.slug;
      // The table behind this panel marks companies with a run on record, and it only repaints on
      // a live tick. Tell it now so the mark appears with the run rather than a minute later.
      live.onRecorded?.(p.slug);
    }
    live.displayPct = creep(live.displayPct, p.stage);
    // THE PIPELINE SCREEN IS FOR A PIPELINE THAT IS ACTUALLY RUNNING. A reattach only earns it
    // once their API says a run is in flight; until then "opening" stands, and a report already on
    // screen is never traded for a progress bar.
    const inFlight = !p.transientError && (p.status === 'running' || p.status === 'queued' || p.status === 'dispatching');
    if (live.phase === 'opening' && inFlight) live.phase = 'running';
    if (live.phase === 'running' || live.phase === 'opening') refreshWorkspace();
    // A check behind a saved report that finds a run genuinely in flight: the report stays put —
    // it is what the reader came for — but the ribbon stops saying we are merely looking.
    else if (background && inFlight && !live.rebuilding) {
      live.rebuilding = true;
      updateRibbon();
    }
  };

  try {
    // `resumeSlug` only ever polls; `api.start` is the single path in this file that can dispatch.
    const out = resumeSlug
      ? await api.resume(resumeSlug, { onProgress, signal: controller.signal })
      : await api.start({ company: live.company, ticker: live.ticker, force }, { onProgress, signal: controller.signal });
    if (!live || live.controller !== controller) return;

    const wasStored = live.origin === 'store';
    const changed = !live.report || JSON.stringify(live.report) !== JSON.stringify(out.report);
    live.report = out.report;
    live.slug = out.slug;
    live.partial = out.partial;
    live.cached = out.cached;
    live.checkedAt = Date.now();
    live.revalidating = false;
    live.replacedStored = wasStored && changed;
    // A stored paint that came back unchanged is still a stored paint — what moved is when it was
    // last confirmed, not where it came from. Only bytes that actually arrived make the origin live.
    live.origin = wasStored && !changed ? 'store' : 'live';
    live.phase = 'done';

    // KEEP IT. A report costs a metered run to produce and their store forgets one after a
    // fortnight, so this is the difference between reopening it next month and paying for it again.
    // Never filed under our ticker when the report contradicts it — see `conflictsWith`. Only
    // written when the bytes are actually new: re-storing an identical report would restamp
    // "saved on this device <when>" with a time nothing happened at.
    if (changed && out.report && !api.conflictsWith(out.report, live.ticker)) {
      const onSaved = live.onSaved;
      const savedSlug = out.slug;
      live.savedSlug = savedSlug;
      api.saveReport({
        slug: savedSlug,
        ticker: live.ticker,
        company: live.company,
        quarter: live.ready?.quarter || out.report?.meta?.quarter || null,
        report: out.report,
        partial: out.partial,
      }).then((stored) => {
        if (!stored) return;
        if (live?.slug === savedSlug) {
          live.saved = true;
          live.savedAt = Date.now();
          if (live.phase === 'done') updateRibbon();
        }
        onSaved?.(savedSlug);
      });
    }

    // Unchanged, behind a report the reader is already looking at: say so in the ribbon and leave
    // the rest of the panel — and their scroll position — exactly where they were.
    if (background && !changed) {
      updateRibbon();
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return; // the reader closed the panel; the run continues
    if (!live || live.controller !== controller) return;

    // A REPORT WE ALREADY HOLD IS NEVER THROWN AWAY BECAUSE A LATER REQUEST FAILED. `unknown` here
    // means their store has dropped it, which is precisely when this device's copy is the only one
    // left; a network failure means we could not ask. Neither is a reason to show the reader a
    // confirm step that asks them to buy back an analysis they have already read.
    if (live.report) {
      live.revalidating = false;
      live.upstreamGone = err?.code === 'unknown';
      live.checkFailed = err?.code === 'unknown' ? null : String(err.message || err);
      live.phase = 'done';
      updateRibbon();
      return;
    }
    // An auto-resume that finds nothing on record and nothing saved here is not an error to show
    // anybody: the slug this browser remembered has aged out upstream. Offer to start a run.
    if (auto && err?.code === 'unknown') {
      live.slug = null;
      live.phase = 'confirm';
      refreshWorkspace();
      return;
    }
    live.error = String(err.message || err);
    live.phase = 'error';
  }
  refreshWorkspace();
}

/**
 * Move the bar toward the current stage's floor, and drift gently within it.
 *
 * Their own screen does this, and the reason is visible on a real run: `research` and `verify`
 * each take minutes, so a bar pinned exactly to the stage floor looks frozen and reads as a hung
 * job. The drift is bounded by the NEXT stage's floor, so it can never claim progress past a
 * stage the pipeline has not actually reached, and it never moves backwards.
 */
function creep(current, stage) {
  const info = api.stageInfo(stage);
  const next = api.STAGES[info.index + 1];
  const ceiling = next ? next.pct - 1 : info.pct;
  return Math.min(ceiling, Math.max(current ?? 0, info.pct) + (stage ? 0.6 : 0));
}
