import * as refreshRegistry from '../core/refresh.js';
import { pauseFamilySession } from '../data/family-session.js';
// tabs/ask-research.js — a dashboard-wide conversational research workspace.

import { authHeaders } from '../core/host-context.js';
import { empty, el } from '../core/dom.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';
import { state, subscribe } from '../core/state.js';
import * as notifications from '../ui/notifications.js';
import { scopeLabel } from '../data/scope.js';
import { buildResearchEvidence, prepareResearchSources, researchSuggestions, resolveQuestionCompanies, DASHBOARD_RESEARCH_SOURCES } from '../research/estate.js';
import { renderResearchAnswer, renderResearchSources } from '../research/renderer.js';
import { connectPortfolio, portfolioConnected, privatePortfolioContext, readResearchPortfolio, onPortfolioInvalidation, portfolioConnectionState, onPortfolioConnection, unlockPortfolio, FAMILY_ORIGIN } from '../research/portfolio-bridge.js';

export const meta = {
  id: 'ask-research',
  title: 'Ask Research',
  subtitle: 'Ask across every dashboard tab.',
  subviews: [],
  allowEmptyScope: true,
};

const STORAGE_KEY = 'sattva:ask-research:v1';
const MAX_SESSIONS = 24;
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 8_000;

let sessions = loadSessions();
let activeId = sessions[0]?.id || null;
let ctxRef = null;
let uiDispose = null;
let configState = null;
let configPromise = null;
const generations = new Map();
onPortfolioInvalidation((version) => {
  for (const generation of generations.values()) {
    if (generation.portfolio && generation.portfolio.archiveVersion !== version) {
      generation.portfolioChanged = true;
      generation.controller.abort();
    }
  }
});

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `research-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newSession() {
  const now = new Date().toISOString();
  return {
    id: makeId(),
    title: 'New research',
    createdAt: now,
    updatedAt: now,
    messages: [],
    private: privatePortfolioContext(),
    draft: '',
    webResearch: false,
    status: 'idle',
    phase: '',
    error: null,
    streamText: '',
    streamSources: [],
    streamDashboard: [],
    streamCompanies: [],
  };
}

function normaliseSession(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.text === 'string')
        .slice(-MAX_MESSAGES)
        .map((message) => ({
          role: message.role,
          text: message.text.slice(0, MAX_MESSAGE_CHARS),
          // Keep the provenance of answers saved before the Muns migration. New requests are
          // dashboard-only, but rewriting an older answer's origin would be misleading.
          webResearch: message.webResearch === true,
          dashboardSources: Array.isArray(message.dashboardSources) ? message.dashboardSources.slice(0, 16) : [],
          // The companies the question resolved to, so a saved answer's citations still deep-link.
          companies: Array.isArray(message.companies) ? message.companies.filter((c) => c && typeof c.ticker === 'string').slice(0, 6).map((c) => ({ ticker: c.ticker, name: typeof c.name === 'string' ? c.name : c.ticker })) : undefined,
          webSources: Array.isArray(message.webSources) ? message.webSources.slice(0, 12) : [],
        }))
    : [];

  // A QUESTION THE PAGE CLOSED ON IS GIVEN BACK, NOT LEFT DANGLING. The question is pushed into
  // the transcript before the answer starts, so a reload mid-answer leaves a user message with
  // nothing under it — a conversation that looks like the assistant ignored it. There is no stream
  // to resume (the connection died with the page) and re-asking costs a real model run, so it is
  // never re-sent automatically: the question goes back into the composer exactly as an abort puts
  // it back, and the phase line says why it is there.
  let draft = typeof raw.draft === 'string' ? raw.draft.slice(0, 1500) : '';
  let interrupted = false;
  if (messages.length && messages.at(-1).role === 'user') {
    const pending = messages.pop().text;
    if (!draft.trim()) draft = pending.slice(0, 1500);
    interrupted = true;
  }

  return {
    id: raw.id,
    title: String(raw.title || 'Research conversation').slice(0, 120),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    messages,
    draft,
    webResearch: false,
    status: 'idle',
    phase: interrupted ? 'That question stopped when the page closed. Send it again when you are ready.' : '',
    error: null,
    streamText: '',
    streamSources: [],
    streamDashboard: [],
    streamCompanies: [],
  };
}

function loadSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normaliseSession).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

function persistSessions() {
  // Existing public history remains visible. New private conversations and
  // continued sessions using portfolio readings stay in memory only.
  try {
    const payload = sessions
      .filter((session) => !session.private)
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, MAX_SESSIONS)
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        webResearch: session.webResearch,
        // The typed-but-unsent question is the reader's work too, so it survives a reload the same
        // way the conversation does.
        draft: typeof session.draft === 'string' ? session.draft.slice(0, 1500) : '',
        messages: session.messages.slice(-MAX_MESSAGES),
      }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // The active in-memory conversation remains usable when device persistence is unavailable.
  }
}

function currentSession() {
  return sessions.find((session) => session.id === activeId) || null;
}

function ensureSession() {
  let session = currentSession();
  if (session) return session;
  session = newSession();
  sessions.unshift(session);
  activeId = session.id;
  return session;
}

function shortTitle(question) {
  const oneLine = String(question).replace(/\s+/g, ' ').trim();
  return oneLine.length > 76 ? `${oneLine.slice(0, 75)}…` : oneLine;
}

function timeLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function isBusy(session) {
  return generations.has(session.id);
}

/**
 * A METERED RUN IS THE ONE THING A RELOAD CANNOT GIVE BACK.
 *
 * `destroy()` deliberately does not abort a generation, so an answer survives the reader looking
 * at another tab — but nothing survives the document going away, and the question is already in
 * the transcript by then, so a reload mid-answer costs a real model run and leaves a user message
 * with nothing under it. The service-worker upgrade in `app.js` is the only thing here that can
 * reload the page without the reader asking, so it asks this first and waits.
 */
export function hasWorkInFlight() {
  return generations.size > 0;
}

/**
 * AN ANSWER IN FLIGHT OUTLIVES THE TAB IT WAS ASKED FROM.
 *
 * `destroy()` used to abort every running generation, so pressing Send and then looking at another
 * tab — the obvious thing to do while an answer that reads fifteen sources is being written —
 * cancelled it. The abort path puts the question back in the composer and takes the user message
 * back out of the transcript, so what the reader saw on returning was their own question sitting
 * unsent and nothing else: the work looked like it had never happened.
 *
 * A generation is module state, not DOM state, and nothing it does needs the tab to be mounted:
 * every paint is already guarded on `ctxRef`, and the finished answer is written to the session and
 * to the device. So it keeps running, and the reader gets the answer whenever they come back.
 *
 * What must still cancel it is a change to the EVIDENCE UNIVERSE, and that is the reason each
 * generation records the scope it was assembled under. An answer built from the book must never
 * land in a workspace labelled Watchlist. Those changes can now happen while this tab is
 * unmounted, so they are watched at module level rather than in `wire()`, whose subscriptions die
 * with the mount — a watchlist edit made from the header while Ask Research was off screen used to
 * invalidate nothing at all.
 */
function abortGenerations(match = () => true) {
  for (const generation of generations.values()) {
    if (match(generation)) generation.controller.abort();
  }
}

function abortActiveGenerations() {
  abortGenerations();
}

/** Anything assembled under a different scope from the one now in force. */
function abortOtherScopeGenerations(scope) {
  abortGenerations((generation) => generation.scope !== scope);
}

let stopInvalidation = null;
function watchEvidenceInvalidation() {
  if (stopInvalidation) return;
  const stops = [
    subscribe((reason, current) => {
      if (reason === 'scope') abortOtherScopeGenerations(current.scope);
    }),
    // Scope editors postpone the shell remount until they close, so the stores are the only signal
    // that the company set behind an in-flight packet has moved.
    watchlist.onChange(() => abortGenerations((generation) => generation.scope === 'watchlist')),
    scopeLists.onChange((scope) => abortGenerations((generation) => generation.scope === scope)),
  ];
  stopInvalidation = () => stops.forEach((stop) => stop());
}

function template(scope) {
  return `
    <section class="research-workspace" data-research-workspace>
      <div class="research-workspace-header">
        <div>
          <div class="flex items-center gap-2">
            <span class="research-spark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3Z" stroke-linejoin="round"/><path d="m19 15 .7 2.1L22 18l-2.3.9L19 21l-.7-2.1L16 18l2.3-.9L19 15Z" stroke-linejoin="round"/></svg>
            </span>
            <h2 class="font-display text-xl font-extrabold text-slate-900">Ask Research</h2>
          </div>
          <p class="mt-1 text-sm text-slate-500">One answer across every dashboard tab in ${scopeLabel(scope)} scope.</p>
          <p class="mt-1 text-sm text-slate-500" data-portfolio-connection></p>
        </div>
        <span class="research-estate-chip">
          <span class="h-1.5 w-1.5 rounded-full bg-indigo-500"></span>
          Reads the whole dashboard
        </span>
      </div>

      <div class="research-layout">
        <aside class="research-sidebar" aria-label="Research conversations">
          <div class="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3.5">
            <div>
              <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Library</div>
              <h3 class="mt-0.5 text-sm font-bold text-slate-800">Conversations</h3>
            </div>
            <button type="button" class="research-new-button" data-research-new aria-label="Start a new research conversation">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke-linecap="round"/></svg>
              New
            </button>
          </div>
          <div class="research-session-list scrollbar-thin" data-research-sessions></div>
          <div class="border-t border-slate-100 px-4 py-3 text-[11px] leading-relaxed text-slate-400">
            ${privatePortfolioContext() ? 'Portfolio-connected conversations stay in memory only and disappear when this page closes.' : 'Conversation history stays on this device.'} Each question and bounded source readings are sent to the Muns-hosted model for the answer.
          </div>
        </aside>

        <div class="research-thread">
          <div class="research-transcript scrollbar-thin" role="log" aria-live="polite" aria-label="Research conversation" data-research-transcript></div>

          <div class="research-composer-wrap">
            <div class="research-config-notice hidden" data-research-config role="status"></div>
            <div class="research-phase min-h-[1.25rem]" role="status" aria-live="polite" data-research-phase></div>
            <div class="research-composer" data-research-composer>
              <textarea rows="1" maxlength="1500" data-research-input placeholder="Ask about anything in these reports…" aria-label="Ask about the dashboard"></textarea>
              <div class="research-composer-actions">
                <button type="button" class="research-send-button" data-research-send aria-label="Send question">
                  <span>Send</span>
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 10 11-6-3 12-2.3-4.1L4 10Z" stroke-linejoin="round"/><path d="m9.7 11.9 2.4-3.1" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
            <p class="mt-2 text-center text-[10px] text-slate-400">Dashboard figures remain the source of truth.</p>
          </div>
        </div>
      </div>
    </section>`;
}

let unregisterRefresh = null;

export function render(ctx) {
  cleanupUi();
  // A scope change changes the evidence universe. Do not let an answer assembled under the old
  // scope land inside a workspace now labelled as the new one. The module-level watcher above
  // catches this the moment the scope moves, mounted or not; this is the same question asked of
  // the ctx actually being painted, so a generation can never outlive the scope on screen.
  abortOtherScopeGenerations(ctx.scope);
  ctxRef = ctx;
  if (!unregisterRefresh) unregisterRefresh = refreshRegistry.register('ask-research', {
    label: 'Research evidence', refresh: async () => {
      const { refreshSources } = await import('../data/daily-alerts.js');
      return refreshSources();
    },
  });
  ensureSession();
  ctx.root.innerHTML = template(ctx.scope);
  uiDispose = wire(ctx.root);
  paintAll();
  paintPortfolioConnection();
  void prepareResearchSources().catch(() => {});
  connectPortfolio().then(() => { if (ctxRef === ctx) paintPortfolioConnection(); });
  ensureConfig().then(() => {
    if (ctxRef === ctx) paintComposer();
  });
}

onPortfolioConnection(() => paintPortfolioConnection());

function paintPortfolioConnection() {
  const mount = ctxRef?.root.querySelector('[data-portfolio-connection]');
  if (!mount) return;
  empty(mount);
  if (portfolioConnected()) {
    mount.textContent = 'Portfolio connected · refreshed with every question';
  } else {
    const status = portfolioConnectionState();
    if (status === 'locked') {
      mount.append('Portfolio access needs sign-in · ');
      const unlock = el('button', { type: 'button', class: 'research-cite' }, 'Unlock portfolio');
      unlock.onclick = unlockPortfolio;
      mount.appendChild(unlock);
    } else mount.textContent = status === 'connecting' ? 'Connecting your portfolio…' : 'Portfolio connection unavailable · try again shortly';
  }
}

export function destroy() {
  unregisterRefresh?.(); unregisterRefresh = null;
  // Deliberately does NOT abort: an answer the reader asked for keeps being written while they
  // look at another tab, and lands in the conversation when they come back. See
  // `abortGenerations` above for what does cancel one.
  cleanupUi();
  ctxRef = null;
}

function cleanupUi() {
  try {
    uiDispose?.();
  } catch (error) {
    console.error('[ask-research] UI cleanup failed', error);
  }
  uiDispose = null;
}

function wire(root) {
  const input = root.querySelector('[data-research-input]');
  const onClick = (event) => {
    const sessionButton = event.target.closest('[data-research-session]');
    const deleteButton = event.target.closest('[data-research-delete]');
    const suggestion = event.target.closest('[data-research-suggestion]');
    if (deleteButton) {
      event.stopPropagation();
      deleteSession(deleteButton.dataset.researchDelete);
    } else if (sessionButton) {
      activeId = sessionButton.dataset.researchSession;
      paintAll();
    } else if (event.target.closest('[data-research-new]')) {
      const session = newSession();
      sessions.unshift(session);
      activeId = session.id;
      paintAll();
      root.querySelector('[data-research-input]')?.focus();
    } else if (event.target.closest('[data-research-send]')) {
      const generation = generations.get(activeId);
      if (generation) generation.controller.abort();
      else submitCurrent();
    } else if (suggestion) {
      const session = currentSession();
      if (!session) return;
      session.draft = suggestion.dataset.researchSuggestion || '';
      paintComposer();
      submitCurrent();
    }
  };
  let draftSave = null;
  const onInput = () => {
    const session = currentSession();
    if (!session) return;
    session.draft = input.value;
    autoSize(input);
    syncSendState();
    // Written to the device on a trailing timer rather than on every keystroke: the draft only has
    // to survive leaving the page, and localStorage is synchronous.
    clearTimeout(draftSave);
    draftSave = setTimeout(persistSessions, 400);
  };
  const onKeydown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submitCurrent();
  };
  root.addEventListener('click', onClick);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  return () => {
    root.removeEventListener('click', onClick);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
    // Leaving the tab is exactly when an unsaved draft would be lost, so flush rather than
    // dropping a pending timer.
    clearTimeout(draftSave);
    persistSessions();
  };
}

function deleteSession(id) {
  const session = sessions.find((item) => item.id === id);
  if (!session || isBusy(session)) return;
  sessions = sessions.filter((item) => item.id !== id);
  if (activeId === id) activeId = sessions[0]?.id || null;
  ensureSession();
  persistSessions();
  paintAll();
}

async function ensureConfig() {
  // A confirmed 200 response is stable for this page session. Transport and 5xx failures are not:
  // keep their explanatory state visible, but let the next mount retry instead of wedging the SPA.
  if (configState && configState.retryable !== true) return configState;
  if (configPromise) return configPromise;
  configPromise = fetch('api/research', { headers: { accept: 'application/json', ...authHeaders('api/research') }, cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      configState = {
        configured: body?.configured === true,
        webResearchAvailable: body?.webResearchAvailable === true,
        retryable: false,
        message: body?.configured ? '' : 'Ask Research is not configured on this server. Add the server-side Muns session token to enable answers.',
      };
      return configState;
    })
    .catch(() => {
      configState = {
        configured: false,
        webResearchAvailable: false,
        retryable: true,
        message: 'Ask Research needs the Cloudflare Worker runtime and its server-side Muns session token.',
      };
      return configState;
    })
    .finally(() => {
      configPromise = null;
    });
  return configPromise;
}

function paintAll() {
  if (!ctxRef) return;
  ensureSession();
  paintSidebar();
  paintTranscript();
  paintComposer();
  backfillCompanies(currentSession());
}

// ANSWERS SAVED BEFORE THEIR COMPANIES WERE STORED WITH THEM. A citation deep-links to the company
// the question named, and that used to be known only while the answer streamed — so every answer
// in a conversation from before this shipped opened the bare tab: General Alerts with 21,000 rows
// instead of the nineteen about IIFL. Resolve the question again, once, with the same resolver a
// live question uses; store the result on the message so it is never asked twice; repaint.
const backfilling = new Set();
function backfillCompanies(session) {
  if (!session || !ctxRef) return;
  const scope = ctxRef.scope;
  session.messages.forEach((message, index) => {
    if (message.role !== 'assistant' || Array.isArray(message.companies) || backfilling.has(message)) return;
    const question = session.messages.slice(0, index).reverse().find((item) => item.role === 'user')?.text;
    if (!question) {
      message.companies = [];
      return;
    }
    backfilling.add(message);
    resolveQuestionCompanies(question, scope)
      .then((companies) => {
        message.companies = companies.map((company) => ({ ticker: company.ticker, name: company.name }));
        persistSessions();
        if (ctxRef && activeId === session.id && !isBusy(session)) paintTranscript();
      })
      .catch(() => {
        message.companies = [];
      })
      .finally(() => backfilling.delete(message));
  });
}

function paintSidebar() {
  const root = ctxRef?.root;
  const list = root?.querySelector('[data-research-sessions]');
  if (!list) return;
  empty(list);
  const ordered = sessions.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  for (const session of ordered) {
    const busy = isBusy(session);
    const item = el('div', {
      class: `research-session ${session.id === activeId ? 'is-active' : ''}`,
    });
    const button = el('button', {
      type: 'button',
      class: 'flex min-w-0 flex-1 items-center text-left',
      'data-research-session': session.id,
      'aria-current': session.id === activeId ? 'true' : null,
    });
    const body = el('span', { class: 'min-w-0 flex-1 text-left' });
    body.appendChild(el('strong', { class: 'research-session-title' }, session.title));
    body.appendChild(el('span', { class: `research-session-meta ${session.status === 'needs-attention' ? 'text-rose-500' : ''}` }, busy ? session.phase || 'Answering…' : session.status === 'needs-attention' ? 'Needs attention' : timeLabel(session.updatedAt)));
    button.appendChild(body);
    const remove = el('button', {
      type: 'button',
      tabindex: busy ? '-1' : '0',
      class: 'research-session-delete',
      'data-research-delete': session.id,
      'aria-label': `Delete ${session.title}`,
      'aria-disabled': busy ? 'true' : 'false',
      title: busy ? 'Wait for this answer to finish' : 'Delete conversation',
    });
    remove.appendChild(el('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true' }, [
      el('path', { d: 'M5 6h10M8 6V4h4v2m-6 0 .7 10h6.6L14 6M8.5 9v4M11.5 9v4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    ]));
    item.appendChild(button);
    item.appendChild(remove);
    list.appendChild(item);
  }
}

function paintTranscript() {
  const root = ctxRef?.root;
  const transcript = root?.querySelector('[data-research-transcript]');
  const session = currentSession();
  if (!transcript || !session) return;
  const followLive = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
  const showOpening = !session.messages.length && !session.streamText && !isBusy(session);
  empty(transcript);

  if (showOpening) {
    transcript.appendChild(openingState(ctxRef.scope));
    transcript.scrollTop = 0;
    requestAnimationFrame(() => {
      if (transcript.isConnected) transcript.scrollTop = 0;
    });
  } else {
    const stack = el('div', { class: 'research-message-stack' });
    for (const message of session.messages) stack.appendChild(messageNode(message));
    if (isBusy(session)) stack.appendChild(streamNode(session));
    transcript.appendChild(stack);
  }

  if (!showOpening && followLive) {
    transcript.style.scrollBehavior = 'auto';
    transcript.scrollTop = transcript.scrollHeight;
    requestAnimationFrame(() => {
      if (!transcript.isConnected) return;
      transcript.scrollTop = transcript.scrollHeight;
      transcript.style.scrollBehavior = '';
    });
  }
}

function openingState(scope) {
  const wrap = el('div', { class: 'research-opening' });
  const icon = el('span', { class: 'research-opening-icon', 'aria-hidden': 'true' });
  icon.appendChild(el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7' }, [
    el('path', { d: 'm12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z', 'stroke-linejoin': 'round' }),
    el('path', { d: 'M5 15v4m-2-2h4M19 14v5m-2.5-2.5h5', 'stroke-linecap': 'round' }),
  ]));
  wrap.appendChild(icon);
  wrap.appendChild(el('h3', { class: 'font-display mt-5 text-2xl font-extrabold tracking-tight text-slate-900' }, 'Research the whole picture'));
  wrap.appendChild(el('p', { class: 'mt-2 max-w-2xl text-sm leading-6 text-slate-500' }, `Ask one question across every dashboard tab in ${scopeLabel(scope)} scope. Ask Research checks each source, preserves its period and provenance, and never turns missing data into a number.`));

  const promises = el('div', { class: 'research-opening-promises' });
  for (const item of [
    ['Every tab', 'Earnings, calls, chatter, technicals, filings, investor books and both alert feeds.'],
    ['Traceable', 'Material figures name the dashboard page they came from.'],
    ['Evidence-led', 'Answers stay grounded in the dashboard packet sent with each question.'],
  ]) {
    const card = el('div', { class: 'research-promise' });
    card.appendChild(el('span', { class: 'research-promise-dot' }));
    const copy = el('span');
    copy.appendChild(el('strong', { class: 'block text-xs font-bold text-slate-700' }, item[0]));
    copy.appendChild(el('span', { class: 'mt-0.5 block text-[11px] leading-4 text-slate-400' }, item[1]));
    card.appendChild(copy);
    promises.appendChild(card);
  }
  wrap.appendChild(promises);

  const label = el('div', { class: 'mt-7 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400' }, 'Try asking');
  wrap.appendChild(label);
  const suggestions = el('div', { class: 'research-suggestions' });
  for (const suggestion of researchSuggestions(scope)) {
    const button = el('button', { type: 'button', class: 'research-suggestion', 'data-research-suggestion': suggestion });
    button.appendChild(el('span', {}, suggestion));
    button.appendChild(el('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true' }, [el('path', { d: 'm7 4 6 6-6 6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })]));
    suggestions.appendChild(button);
  }
  wrap.appendChild(suggestions);
  return wrap;
}

/**
 * The link a `[Dashboard: Page]` citation opens — the page's own route, in the current scope,
 * seeded with the company the answer is about when there is exactly one. Names are matched by tab
 * title first (what the model is told to cite) and by source id second; a name that matches no
 * registered source resolves to nothing, and the renderer leaves it as text.
 */
/**
 * A `[Dashboard: …]` citation names a TAB, so it opens the TAB — not one contributor's sub-view.
 *
 * THIS IS THE FIX FOR A LINK THAT WENT SOMEWHERE ELSE, and the failure is worth keeping because
 * nothing about it looked broken. Four tab names are shared by two sources each — Earnings Hub,
 * Breakouts / Technical, Super Investors and News — and this resolver used `.find()`, so the FIRST
 * entry in the catalog silently won every time. On Breakouts that first entry is `technicals`,
 * whose route is `…/breakouts/technical-scanner`; so a question about strong breakouts produced a
 * correct answer, a correctly named citation, and a click that landed on the Technical Scanner. The
 * reader then had to find the sub-view picker and switch to Strong Breakouts themselves — which is
 * the tab's own FIRST sub-view, and therefore exactly where a bare tab route lands.
 *
 * So the destination is the tab's landing route, derived from the documented route shape
 * (`#/ws/tab/subview`) by dropping the sub-view. That does two things at once: it sends the reader
 * where the citation says, and it makes the collision harmless — every source sharing a tab now
 * resolves to one href, so there is no longer a first-match to get wrong.
 *
 * The per-source links under an answer are NOT changed: those name a specific source rather than a
 * tab, so they keep their own sub-view. See `renderResearchSources` below.
 */
function citeResolver(companies = []) {
  const scope = ctxRef?.scope || 'portfolio';
  const company = companies.length === 1 ? companies[0] : null;
  return (name) => {
    const wanted = String(name || '').trim().toLowerCase();
    if (wanted === 'ask sattva' || wanted === 'sattva family') return { href: `${FAMILY_ORIGIN}/ask`, title: 'Open the portfolio source in Sattva Family', label: 'Ask Sattva' };
    const source = DASHBOARD_RESEARCH_SOURCES.find((item) => item.tab.toLowerCase() === wanted) || DASHBOARD_RESEARCH_SOURCES.find((item) => item.id === wanted);
    if (!source) return null;
    return { href: dashboardHref(tabRoute(source.route), scope, company), title: company ? `Open ${source.tab} for ${company.name || company.ticker}` : `Open ${source.tab}`, label: source.tab };
  };
}

/**
 * `#/ws/tab/subview` -> `#/ws/tab`. Anything shorter is returned untouched.
 *
 * The shell resolves a tab with no sub-view to that tab's FIRST sub-view, which is the same rule
 * that makes the WORKSPACES array the landing page (see CLAUDE.md). So this lands a reader on the
 * view the tab itself opens on, rather than on whichever sub-view one contributing source happens
 * to belong to.
 */
function tabRoute(route) {
  const [path, query = ''] = String(route || '#').split('?');
  const segments = path.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (segments.length < 3) return route;
  return `#/${segments.slice(0, 2).join('/')}${query ? `?${query}` : ''}`;
}

function dashboardHref(route, scope, company) {
  const [path, query = ''] = String(route || '#').split('?');
  const params = new URLSearchParams(query);
  params.set('scope', scope);
  if (company?.ticker) params.set('company', company.ticker);
  return `${path}?${params.toString()}`;
}

function messageNode(message) {
  if (message.role === 'user') {
    const row = el('div', { class: 'research-user-row' });
    row.appendChild(el('div', { class: 'research-user-bubble' }, message.text));
    return row;
  }
  const article = el('article', { class: 'research-assistant-answer' });
  const label = el('div', { class: 'research-answer-label' });
  label.appendChild(el('span', { class: 'research-mini-spark', 'aria-hidden': 'true' }, '✦'));
  label.appendChild(el('span', {}, message.webResearch ? 'Dashboard + web research' : 'Dashboard research'));
  article.appendChild(label);
  const body = el('div', { class: 'research-answer-body' });
  const companies = message.companies || [];
  renderResearchAnswer(body, message.text, { cite: citeResolver(companies) });
  article.appendChild(body);
  if (message.incomplete) article.appendChild(el('p', { class: 'text-xs text-slate-500' }, 'Incomplete answer — the connection stopped. Your question is ready to retry below.'));
  if (Number.isFinite(message.timings?.firstTextMs)) {
    article.appendChild(el('p', { class: 'text-xs text-slate-500' }, `Answer started in ${(message.timings.firstTextMs / 1000).toFixed(1)}s · ${message.dashboardSources?.length || 0} dashboard pages read`));
  }
  if (message.portfolio) {
    const p = message.portfolio;
    const checked = new Date(p.checkedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const quotes = p.quotes?.asOf ? `${p.quotes.asOf} (${p.quotes.freshness === 'partial-or-stale' ? 'partial or stale' : 'per-symbol freshness unverified'})` : 'unavailable — workbook marks only';
    article.appendChild(el('p', { class: 'text-xs text-slate-500' }, `Portfolio book: ${p.bookAsOf}. Quotes: ${quotes}. Checked ${checked} IST. Snapshot for this answer, not a live refresh.`));
    if (p.sourceErrors?.length) article.appendChild(el('p', { class: 'text-xs text-slate-500' }, `Sources not read: ${p.sourceErrors.join(', ')}.`));
    const details = el('details');
    details.appendChild(el('summary', { class: 'research-cite' }, p.mode === 'verified-holdings' ? 'Verified portfolio context' : 'Portfolio source reading · Ask Sattva'));
    const reading = el('div', { class: 'research-answer-body' });
    renderResearchAnswer(reading, p.answer, { cite: citeResolver() });
    details.appendChild(reading);
    article.appendChild(details);
  }
  const sources = el('div', { class: 'research-sources' });
  const company = companies.length === 1 ? companies[0] : null;
  renderResearchSources(sources, {
    dashboard: (message.dashboardSources || []).map((item) => ({ ...item, route: dashboardHref(item.route, ctxRef?.scope || 'portfolio', company) })),
    web: message.webSources,
  });
  article.appendChild(sources);
  return article;
}

function streamNode(session) {
  const article = el('article', { class: 'research-assistant-answer is-streaming', 'aria-live': 'off', 'data-session-id': session.id });
  const label = el('div', { class: 'research-answer-label' });
  label.appendChild(el('span', { class: 'research-live-dot', 'aria-hidden': 'true' }));
  label.appendChild(el('span', {}, 'Dashboard research'));
  article.appendChild(label);
  if (session.streamText) {
    const body = el('div', { class: 'research-answer-body' });
    renderResearchAnswer(body, session.streamText, { cite: citeResolver(session.streamCompanies || []) });
    article.appendChild(body);
  } else {
    article.appendChild(el('div', { class: 'research-thinking' }, [
      el('span'), el('span'), el('span'), el('strong', {}, session.phase || 'Reading the dashboard'),
    ]));
  }
  return article;
}

function paintComposer() {
  const root = ctxRef?.root;
  const session = currentSession();
  if (!root || !session) return;
  const input = root.querySelector('[data-research-input]');
  const composer = root.querySelector('[data-research-composer]');
  const notice = root.querySelector('[data-research-config]');
  const phase = root.querySelector('[data-research-phase]');
  const busy = isBusy(session);
  const configured = configState?.configured === true;

  if (input.value !== session.draft) input.value = session.draft;
  input.disabled = busy || !configured;
  input.placeholder = configured ? 'Ask about anything in these reports…' : 'Assistant is not configured';
  autoSize(input);
  composer.classList.toggle('is-disabled', !configured);

  notice.classList.toggle('hidden', configured || configState === null);
  notice.textContent = configState?.message || '';
  phase.textContent = session.error || (busy ? session.phase : '');
  phase.classList.toggle('text-rose-600', !!session.error);
  syncSendState();
}

function syncSendState() {
  const root = ctxRef?.root;
  const session = currentSession();
  const send = root?.querySelector('[data-research-send]');
  if (!send || !session) return;
  const busy = isBusy(session);
  const disabled = !busy && (!configState?.configured || !session.draft.trim());
  send.disabled = disabled;
  send.classList.toggle('is-busy', isBusy(session));
  send.querySelector('span').textContent = busy ? 'Stop' : 'Send';
  send.setAttribute('aria-label', busy ? 'Stop answer' : 'Send question');
}

function autoSize(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(180, Math.max(44, input.scrollHeight))}px`;
}

function setPhase(session, phase) {
  session.phase = phase;
  const generation = generations.get(session.id);
  if (generation) { queueStreamPaint(session, generation); return; }
  if (activeId === session.id) {
    paintComposer();
    paintTranscript();
  }
  paintSidebar();
}

function dashboardSources(evidence) {
  const byTab = new Map();
  for (const source of evidence?.sources || []) {
    if (source.status !== 'ready' || byTab.has(source.tab)) continue;
    byTab.set(source.tab, { id: source.id, tab: source.tab, route: source.route });
  }
  return [...byTab.values()];
}

async function submitCurrent() {
  const session = currentSession();
  if (!session || isBusy(session) || !configState?.configured) return;
  const question = session.draft.trim();
  if (!question) return;

  const originalDraft = session.draft;
  session.private = session.private || privatePortfolioContext();
  const userMessage = { role: 'user', text: question };
  session.messages.push(userMessage);
  if (session.messages.filter((message) => message.role === 'user').length === 1) session.title = shortTitle(question);
  session.updatedAt = new Date().toISOString();
  session.draft = '';
  session.error = null;
  session.status = 'answering';
  session.streamText = '';
  session.streamSources = [];
  session.streamDashboard = [];

  // The scope is captured here, once. Everything downstream reads `generation.scope` rather than
  // `ctxRef`, which is null the moment the reader looks at another tab — and a packet built under
  // "whatever scope is mounted right now" would change meaning mid-answer.
  const generation = { controller: new AbortController(), paintQueued: false, scope: ctxRef?.scope || state.scope, question, startedAt: performance.now() };
  generations.set(session.id, generation);
  watchEvidenceInvalidation();
  setPhase(session, 'Opening every dashboard source…');
  paintAll();
  persistSessions();

  const resumePortfolioSync = pauseFamilySession();
  try {
    const history = session.messages.slice(0, -1).filter(message => !message.incomplete).map((message) => ({ role: message.role, text: message.text }));
    setPhase(session, 'Checking your holdings and reading dashboard sources…');
    const prepared = prepareResearchSources();
    const family = await readResearchPortfolio(question, generation.controller.signal, history);
    if (generation.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');

    generation.portfolio = family.holdings ? family.reading : null;
    const evidence = await buildResearchEvidence({
      question,
      history,
      prepared,
      signal: generation.controller.signal,
      scope: generation.scope,
      portfolio: family.reading,
      portfolioPositions: { sizes: family.sizes, holdings: family.holdings },
      onProgress: ({ completed, total, source }) => {
        if (!generation.controller.signal.aborted) setPhase(session, `Reading ${source} · ${completed} of ${total}`);
      },
    });
    if (generation.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    session.streamDashboard = dashboardSources(evidence);
    session.streamCompanies = (evidence.selection?.companies || []).map((company) => ({ ticker: company.ticker, name: company.name }));
    setPhase(session, 'Writing from dashboard evidence…');

    generation.evidenceMs = Math.round(performance.now() - generation.startedAt);
    const response = await fetch('api/research', {
      method: 'POST',
      headers: { accept: 'application/x-ndjson', 'content-type': 'application/json', ...authHeaders('api/research') },
      body: JSON.stringify({ question, requirePortfolio: true, scope: evidence.scope, webResearch: false, history, evidence }),
      signal: generation.controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `Research request failed (HTTP ${response.status}).`);
    }
    if (!response.body) throw new Error('The research response had no stream.');
    await consumeStream(response.body, session, generation);
  } catch (error) {
    const index = session.messages.lastIndexOf(userMessage);
    const keepPartial = session.streamText.trim() && !generation.controller.signal.aborted && !generation.portfolioChanged;
    if (keepPartial) session.messages.push({ role: 'assistant', text: session.streamText, incomplete: true, portfolio: generation.portfolio,
      dashboardSources: session.streamDashboard, companies: session.streamCompanies, webResearch: false });
    else if (index >= 0) session.messages.splice(index, 1);
    session.draft = originalDraft;
    session.streamText = '';
    session.streamSources = [];
    session.streamDashboard = [];
    session.streamCompanies = [];
    session.status = error?.name === 'AbortError' && !generation.portfolioChanged ? 'idle' : 'needs-attention';
    session.error = generation.portfolioChanged ? 'The Family workbook changed while this answer was being written. Send the question again to read the new book.' : error?.name === 'AbortError' ? null : error?.message || 'Research could not be completed.';
    session.phase = '';
    persistSessions();
  } finally {
    resumePortfolioSync();
    generations.delete(session.id);
    if (session.status === 'answering') session.status = 'idle';
    if (activeId === session.id && ctxRef) paintAll();
    else if (ctxRef) paintSidebar();
    // AN ANSWER THAT ARRIVED WHILE THE READER WAS ELSEWHERE HAS TO SAY SO, or keeping it running
    // is a feature nobody can see. This is a fact that arrived and one the reader asked for by
    // name, which is exactly what the alert stack is for; `key` is the session and the message
    // count, so a repaint cannot re-announce it. Nothing is pushed for a cancellation, and nothing
    // while the tab is on screen — the transcript is already showing it.
    if (!ctxRef && session.messages.at(-1)?.role === 'assistant') {
      notifications.push({
        key: `research:${session.id}:${session.messages.length}`,
        kind: 'research',
        title: 'Research answer ready',
        detail: session.title,
        href: `#/research/ask-research?scope=${encodeURIComponent(generation.scope)}`,
      });
    }
  }
}

async function consumeStream(stream, session, generation) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let streamError = null;
  const consumeEvent = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error('The answer stream was malformed.'); }
    if (event.type === 'text' && typeof event.text === 'string') {
      if (generation.firstTextMs === undefined && event.text) generation.firstTextMs = Math.round(performance.now() - generation.startedAt);
      if (session.streamText.length + event.text.length > MAX_MESSAGE_CHARS) throw new Error('The answer exceeded its display limit. Please ask a narrower question.');
      session.streamText += event.text;
      queueStreamPaint(session, generation);
    } else if (event.type === 'phase' && event.phase) setPhase(session, event.phase);
    else if (event.type === 'sources') session.streamSources = Array.isArray(event.sources) ? event.sources : [];
    else if (event.type === 'done') done = true;
    else if (event.type === 'error') streamError = event.message || 'Research could not be completed.';
  };
  try {
    while (!done && !streamError) {
      const part = await reader.read();
      if (generation.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (buffer.length > 64_000) throw new Error('The answer stream was malformed.');
      for (const line of lines) {
        consumeEvent(line);
        if (done || streamError) break;
      }
    }
    buffer += decoder.decode();
    if (!done && !streamError && buffer.trim()) consumeEvent(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (streamError) throw new Error(streamError);
  if (!done || !session.streamText.trim()) throw new Error('The answer ended before a complete response arrived.');

  session.messages.push({
    role: 'assistant',
    text: session.streamText.slice(0, MAX_MESSAGE_CHARS),
    webResearch: false,
    dashboardSources: session.streamDashboard,
    webSources: session.streamSources,
    companies: session.streamCompanies || [],
    portfolio: generation.portfolio,
    timings: { evidenceMs: generation.evidenceMs, firstTextMs: generation.firstTextMs, totalMs: Math.round(performance.now() - generation.startedAt) },
  });
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.updatedAt = new Date().toISOString();
  session.streamText = '';
  session.streamSources = [];
  session.streamDashboard = [];
  session.streamCompanies = [];
  session.status = 'idle';
  session.phase = '';
  session.error = null;
  persistSessions();
}

function queueStreamPaint(session, generation) {
  if (generation.paintQueued) return;
  generation.paintQueued = true;
  requestAnimationFrame(() => {
    generation.paintQueued = false;
    if (activeId !== session.id || !ctxRef || generations.get(session.id) !== generation) return;
    paintComposer();
    const transcript = ctxRef.root.querySelector('[data-research-transcript]');
    const article = transcript?.querySelector('.is-streaming');
    if (!article || article.dataset.sessionId !== session.id) { paintTranscript(); return; }
    const followLive = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
    if (session.streamText) {
      article.querySelector('.research-thinking')?.remove();
      let body = article.querySelector('.research-answer-body');
      if (!body) { body = el('div', { class: 'research-answer-body' }); article.appendChild(body); }
      if (generation.paintedText !== session.streamText || generation.paintedBody !== body) {
        renderResearchAnswer(body, session.streamText, { cite: citeResolver(session.streamCompanies || []) });
        generation.paintedText = session.streamText;
        generation.paintedBody = body;
      }
    } else {
      const status = article.querySelector('.research-thinking strong');
      if (status) status.textContent = session.phase || 'Reading the dashboard';
    }
    if (followLive) transcript.scrollTop = transcript.scrollHeight;
  });
}
