import * as refreshRegistry from '../core/refresh.js';
import { pauseFamilySession } from '../data/family-session.js';
// tabs/ask-research.js — a dashboard-wide conversational research workspace.

import { authHeaders } from '../core/host-context.js';
import { empty, el } from '../core/dom.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';
import { state, subscribe } from '../core/state.js';
import * as notifications from '../ui/notifications.js';
import { openModal } from '../ui/screener.js';
import { sourcesModalHtml } from '../ui/sources.js';
import { scopeLabel } from '../data/scope.js';
import { buildResearchEvidence, prepareResearchSources, researchSuggestions, resolveQuestionCompanies, DASHBOARD_RESEARCH_SOURCES } from '../research/estate.js';
import { renderResearchAnswer, renderResearchSources } from '../research/renderer.js';
import { researchPreview } from '../research/preview.js';
import { researchHistory } from '../research/history.js';
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
const ANSWER_TIMEOUT_MS = 55_000;

let sessions = loadSessions();
let activeId = sessions[0]?.id || null;
let ctxRef = null;
let uiDispose = null;
let configState = null;
let configPromise = null;
let readingView = false;
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
          incomplete: message.incomplete === true,
          error: typeof message.error === 'string' ? message.error.slice(0, 500) : null,
          stopped: message.stopped === true,
          // Keep the provenance of answers saved before the Muns migration. New requests are
          // dashboard-only, but rewriting an older answer's origin would be misleading.
          webResearch: message.webResearch === true,
          dashboardSources: Array.isArray(message.dashboardSources) ? message.dashboardSources.slice(0, 16) : [],
          // The companies the question resolved to, so a saved answer's citations still deep-link.
          companies: Array.isArray(message.companies) ? message.companies.filter((c) => c && typeof c.ticker === 'string').slice(0, 6).map((c) => ({ ticker: c.ticker, name: typeof c.name === 'string' ? c.name : c.ticker, inScope: c.inScope })) : undefined,
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
    <section class="research-workspace${readingView ? ' is-reading-view' : ''}" data-research-workspace>
      <div class="research-reading-toolbar">
        <div class="research-toolbar-title">
          <h2 class="font-display font-extrabold text-slate-900" data-research-title>${readingView ? `${scopeLabel(scope)} research` : 'Ask Research'}</h2>
          <span class="research-connection" data-portfolio-connection></span>
        </div>
        <div class="research-toolbar-actions">
          <button type="button" data-research-history aria-label="Conversation history" aria-haspopup="dialog" aria-expanded="false" aria-controls="research-history" title="Conversation history">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h9" stroke-linecap="round"/></svg><span>History</span>
          </button>
          <button type="button" data-research-new aria-label="Start a new research conversation" title="New conversation">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke-linecap="round"/></svg><span>New</span>
          </button>
          <button type="button" data-research-sources aria-label="Research sources" title="Research sources">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 3h9l3 3v11H4V3Z M12 3v4h4M7 10h6M7 13h6" stroke-linejoin="round"/></svg><span>Sources</span>
          </button>
          <button type="button" data-research-reading aria-label="${readingView ? 'Exit reading view' : 'Reading view'}" aria-pressed="${readingView}" title="${readingView ? 'Exit reading view' : 'Reading view'}">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${readingView ? 'Exit reading view' : 'Reading view'}</span>
          </button>
        </div>
      </div>
      <dialog id="research-history" class="research-sidebar" aria-label="Research conversations">
        <div class="research-history-header">
          <h3 class="font-display font-bold text-slate-900">Conversations</h3>
          <button type="button" data-research-history-close aria-label="Close conversation history">×</button>
        </div>
        <div class="research-session-list scrollbar-thin" data-research-sessions></div>
        <p class="research-history-note">${privatePortfolioContext() ? 'Portfolio conversations stay in memory until this page closes.' : 'Conversation history stays on this device.'} Questions and selected source readings go to the Muns-hosted model.</p>
      </dialog>
      <div class="research-layout">
        <div class="research-thread">
          <div class="research-transcript-wrap">
            <div class="research-transcript scrollbar-thin" role="log" aria-live="polite" aria-label="Research conversation" data-research-transcript></div>
            <button type="button" class="research-jump-latest" data-research-latest hidden>Latest answer ↓</button>
          </div>

          <div class="research-composer-wrap">
            <div class="research-config-notice hidden" data-research-config role="status"></div>
            <div class="research-phase" role="status" aria-live="polite" data-research-phase></div>
            <div class="research-composer" data-research-composer>
              <textarea rows="1" maxlength="1500" data-research-input placeholder="Ask a question…" aria-label="Ask about the dashboard"></textarea>
              <div class="research-composer-actions">
                <button type="button" class="research-send-button" data-research-send aria-label="Send question">
                  <span>Send</span>
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 10 11-6-3 12-2.3-4.1L4 10Z" stroke-linejoin="round"/><path d="m9.7 11.9 2.4-3.1" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
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
  mount.dataset.state = portfolioConnected() ? 'connected' : portfolioConnectionState();
  if (portfolioConnected()) {
    mount.textContent = 'Portfolio connected';
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
  const transcript = root.querySelector('[data-research-transcript]');
  const history = root.querySelector('#research-history');
  const historyButton = root.querySelector('[data-research-history]');
  const onHistoryClose = () => historyButton.setAttribute('aria-expanded', 'false');
  const onHistoryBackdrop = (event) => {
    if (event.target !== history) return;
    const box = history.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) history.close();
  };
  const onClick = (event) => {
    const sessionButton = event.target.closest('[data-research-session]');
    const deleteButton = event.target.closest('[data-research-delete]');
    const suggestion = event.target.closest('[data-research-suggestion]');
    if (event.target.closest('[data-research-reading]')) {
      readingView = !readingView;
      root.querySelector('[data-research-workspace]').classList.toggle('is-reading-view', readingView);
      const button = root.querySelector('[data-research-reading]');
      button.setAttribute('aria-pressed', String(readingView));
      const label = readingView ? 'Exit reading view' : 'Reading view';
      button.setAttribute('aria-label', label);
      button.title = label;
      button.querySelector('span').textContent = label;
      root.querySelector('[data-research-title]').textContent = readingView ? `${scopeLabel(ctxRef.scope)} research` : 'Ask Research';
      updateReadingControls();
    } else if (event.target.closest('[data-research-history]')) {
      history.showModal();
      historyButton.setAttribute('aria-expanded', 'true');
    } else if (event.target.closest('[data-research-history-close]')) {
      history.close();
    } else if (event.target.closest('[data-research-sources]')) {
      openModal(sourcesModalHtml(), { size: 'wide' });
    } else if (event.target.closest('[data-research-latest]')) {
      transcript.scrollTop = transcript.scrollHeight;
      updateReadingControls();
    } else if (event.target.closest('[data-research-preview] > summary')) {
      event.target.closest('[data-research-preview]').dataset.readerToggled = 'true';
    } else if (deleteButton) {
      event.stopPropagation();
      deleteSession(deleteButton.dataset.researchDelete);
    } else if (sessionButton) {
      activeId = sessionButton.dataset.researchSession;
      history.close();
      paintAll();
    } else if (event.target.closest('[data-research-new]')) {
      const session = newSession();
      sessions.unshift(session);
      activeId = session.id;
      paintAll();
      root.querySelector('[data-research-input]')?.focus();
    } else if (event.target.closest('[data-research-send]')) {
      const generation = generations.get(activeId);
      if (generation) { generation.stopped = true; generation.controller.abort(); }
      else submitCurrent();
    } else if (event.target.closest('[data-research-retry]')) {
      const session = currentSession();
      const pending = session?.messages.at(-1);
      if (pending?.incomplete) submitCurrent(session.messages.at(-2)?.text);
    } else if (event.target.closest('[data-research-reconnect]')) {
      configState = null;
      paintComposer();
      ensureConfig().then(paintComposer);
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
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submitCurrent();
  };
  const onWorkspaceKeydown = (event) => {
    if (event.key === 'Escape' && readingView && !history.open && !event.defaultPrevented) {
      root.querySelector('[data-research-reading]').click();
    }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onWorkspaceKeydown);
  history.addEventListener('close', onHistoryClose);
  history.addEventListener('click', onHistoryBackdrop);
  transcript.addEventListener('scroll', updateReadingControls, { passive: true });
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  return () => {
    history.close();
    history.removeEventListener('close', onHistoryClose);
    history.removeEventListener('click', onHistoryBackdrop);
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onWorkspaceKeydown);
    transcript.removeEventListener('scroll', updateReadingControls);
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
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 8000);
  configPromise = fetch('api/research', { headers: { accept: 'application/json', ...authHeaders('api/research') }, cache: 'no-store', signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      configState = {
        configured: body?.configured === true,
        webResearchAvailable: body?.webResearchAvailable === true,
        retryable: false,
        message: body?.configured ? '' : 'Ask Research is temporarily unavailable. Your question will stay here while you reconnect.',
      };
      return configState;
    })
    .catch(() => {
      configState = {
        configured: false,
        webResearchAvailable: false,
        retryable: true,
        message: 'Could not connect to Ask Research. Your question is saved here; try reconnecting.',
      };
      return configState;
    })
    .finally(() => {
      clearTimeout(deadline);
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
        message.companies = companies.map((company) => ({ ticker: company.ticker, name: company.name, inScope: company.inScope }));
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
    body.appendChild(el('span', { class: `research-session-meta ${session.status === 'needs-attention' ? 'text-rose-500' : ''}` }, busy ? 'Answering…' : session.status === 'needs-attention' ? 'Needs attention' : timeLabel(session.updatedAt)));
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
  updateReadingControls();
}

function updateReadingControls() {
  const root = ctxRef?.root;
  const transcript = root?.querySelector('[data-research-transcript]');
  const button = root?.querySelector('[data-research-latest]');
  if (button && transcript) button.hidden = !transcript.querySelector('.research-message-stack') || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
}

function openingState(scope) {
  const wrap = el('div', { class: 'research-opening' });
  wrap.appendChild(el('img', { class: 'sattva-wordmark research-opening-brand', src: '/assets/brand/sattva-ventures-wordmark.png', width: '2704', height: '302', alt: 'Sattva Ventures' }));
  wrap.appendChild(el('h3', { class: 'font-display mt-5 text-2xl font-extrabold tracking-tight text-slate-900' }, 'Research the whole picture'));
  wrap.appendChild(el('p', { class: 'mt-2 text-sm leading-6 text-slate-500' }, `Ask about ${scope === 'portfolio' ? 'your portfolio companies' : scopeLabel(scope).toLowerCase() + ' companies'}, with updates and links to the sources.`));

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
    const normalise = value => String(value || '').trim().toLowerCase().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');
    const wanted = normalise(name);
    if (wanted === 'ask sattva' || wanted === 'sattva family') return { href: `${FAMILY_ORIGIN}/ask`, title: 'Open the portfolio source in Sattva Family', label: 'Ask Sattva' };
    const source = DASHBOARD_RESEARCH_SOURCES.find((item) => normalise(item.tab) === wanted) || DASHBOARD_RESEARCH_SOURCES.find((item) => item.id === wanted);
    if (!source) return null;
    return { href: dashboardHref(tabRoute(source.route), company?.inScope === false ? 'universe' : scope, company), title: company ? `Open ${source.tab} for ${company.name || company.ticker}` : `Open ${source.tab}`, label: source.tab };
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
  label.appendChild(el('img', { class: 'research-mini-spark sattva-mark', src: '/assets/brand/sattva-ventures-mark.svg', width: '420', height: '174', alt: '', 'aria-hidden': 'true' }));
  label.appendChild(el('span', {}, message.webResearch ? 'Dashboard + web research' : 'Dashboard research'));
  article.appendChild(label);
  const body = el('div', { class: 'research-answer-body' });
  const companies = message.companies || [];
  renderResearchAnswer(body, message.text, { cite: citeResolver(companies), compactCitations: true });
  article.appendChild(body);
  if (message.incomplete) {
    const recovery = el('div', { class: 'research-recovery', role: 'status' });
    recovery.appendChild(el('strong', {}, message.stopped ? 'Answer stopped' : message.text ? 'Incomplete answer' : 'Answer interrupted'));
    recovery.appendChild(el('p', {}, message.error || 'You can retry this question using fresh portfolio readings.'));
    if (message === currentSession()?.messages.at(-1)) recovery.appendChild(el('button', {
      type: 'button', class: 'research-retry-button', 'data-research-retry': '',
    }, 'Retry answer'));
    article.appendChild(recovery);
  }
  const context = el('details', { class: 'research-answer-context' });
  context.appendChild(el('summary', {}, 'Source readings & portfolio context'));
  if (message.preview) context.appendChild(previewNode(message.preview, { open: true }));
  if (message.incomplete) context.open = true;
  if (Number.isFinite(message.timings?.firstTextMs)) {
    context.appendChild(el('p', { class: 'text-xs text-slate-500' }, `Answer started in ${(message.timings.firstTextMs / 1000).toFixed(1)}s · ${message.dashboardSources?.length || 0} dashboard pages read`));
  }
  if (message.portfolio) {
    const p = message.portfolio;
    const checked = new Date(p.checkedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const quotes = p.quotes?.asOf ? `${p.quotes.asOf} (${p.quotes.freshness === 'partial-or-stale' ? 'partial or stale' : 'per-symbol freshness unverified'})` : 'unavailable — workbook marks only';
    article.appendChild(el('p', { class: 'research-answer-freshness' }, `Portfolio snapshot: ${p.bookAsOf}. Quotes: ${quotes}.`));
    context.appendChild(el('p', { class: 'text-xs text-slate-500' }, `Portfolio book: ${p.bookAsOf}. Quotes: ${quotes}. Checked ${checked} IST. Snapshot for this answer, not a live refresh.`));
    if (p.sourceErrors?.length) article.appendChild(el('p', { class: 'text-xs text-slate-500' }, `Sources not read: ${p.sourceErrors.join(', ')}.`));
    const details = el('details');
    details.appendChild(el('summary', { class: 'research-cite' }, p.mode === 'verified-holdings' ? 'Verified portfolio context' : 'Portfolio source reading · Ask Sattva'));
    const reading = el('div', { class: 'research-answer-body' });
    renderResearchAnswer(reading, p.answer, { cite: citeResolver() });
    details.appendChild(reading);
    context.appendChild(details);
  }
  const sources = el('div', { class: 'research-sources' });
  const company = companies.length === 1 ? companies[0] : null;
  renderResearchSources(sources, {
    dashboard: (message.dashboardSources || []).map((item) => ({ ...item, route: dashboardHref(item.route, ctxRef?.scope || 'portfolio', company) })),
    web: message.webSources,
  });
  context.appendChild(sources);
  article.appendChild(context);
  if (message.text.trim()) {
    const actions = el('div', { class: 'research-answer-actions' });
    const copy = el('button', { type: 'button' }, message.incomplete ? 'Copy partial answer' : 'Copy answer');
    const status = el('span', { role: 'status' });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(message.text); status.textContent = 'Copied'; }
      catch { status.textContent = 'Select the answer text to copy it.'; }
    };
    const start = el('button', { type: 'button' }, 'Read from start ↑');
    start.onclick = () => {
      const transcript = article.closest('[data-research-transcript]');
      if (transcript) transcript.scrollTop += article.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 16;
    };
    actions.append(copy, start, status);
    article.appendChild(actions);
  }
  return article;
}

function streamNode(session) {
  const article = el('article', { class: 'research-assistant-answer is-streaming', 'aria-live': 'off', 'data-session-id': session.id });
  const label = el('div', { class: 'research-answer-label' });
  label.appendChild(el('img', { class: 'research-mini-spark sattva-mark', src: '/assets/brand/sattva-ventures-mark.svg', width: '420', height: '174', alt: '', 'aria-hidden': 'true' }));
  label.appendChild(el('span', { class: 'research-live-dot', 'aria-hidden': 'true' }));
  label.appendChild(el('span', {}, 'Dashboard research'));
  article.appendChild(label);
  if (session.streamPreview) article.appendChild(previewNode(session.streamPreview, { open: true }));
  if (session.streamText) {
    const body = el('div', { class: 'research-answer-body' });
    renderResearchAnswer(body, session.streamText, { cite: citeResolver(session.streamCompanies || []), compactCitations: true, streaming: true });
    label.after(body);
    const preview = article.querySelector('[data-research-preview]');
    if (preview) preview.open = false;
  } else {
    article.appendChild(el('div', { class: 'research-thinking' }, [
      el('span'), el('span'), el('span'), el('strong', {}, session.phase || 'Reading the dashboard'),
    ]));
  }
  return article;
}

function previewNode(preview, { open = false } = {}) {
  const details = el('details', { class: 'research-evidence-preview', 'data-research-preview': '' });
  details.open = open;
  details.appendChild(el('summary', {}, 'Source readings'));
  details.appendChild(el('p', { class: 'research-evidence-note' }, 'Matching dashboard headlines and excerpts, before the generated answer. Discussion claims are unverified; coverage may be partial.'));
  if (!preview.items.length) details.appendChild(el('p', { class: 'research-evidence-note' }, 'No matching headlines or excerpts in these selected readings. This does not establish that there are no updates.'));
  for (const item of preview.items) {
    const reading = el('div', { class: 'research-evidence-item' });
    reading.appendChild(el('div', { class: 'research-evidence-meta' }, [item.company, (item.date ? `${item.dateLabel ? `${item.dateLabel}: ` : ''}${item.date}` : null) || (item.period ? `Period: ${item.period}` : 'Date unavailable'), item.publisher].filter(Boolean).join(' · ')));
    if (item.attribution) reading.appendChild(el('div', { class: 'research-evidence-meta' }, item.attribution));
    reading.appendChild(el('p', {}, `${item.title}${item.truncated && !item.title.endsWith('…') ? '…' : ''}`));
    const target = citeResolver(item.ticker ? [{ ticker: item.ticker, name: item.company, inScope: item.inScope }] : [])(item.tab);
    if (target) reading.appendChild(el('a', { class: 'research-cite', href: target.href }, item.tab));
    if (item.url) reading.appendChild(el('a', { class: 'research-cite', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open original'));
    if (item.quality) reading.appendChild(el('span', { class: 'research-evidence-meta' }, ` ${item.quality} source readings`));
    details.appendChild(reading);
  }
  const coverage = el('details', { class: 'research-evidence-coverage' });
  coverage.appendChild(el('summary', {}, 'Source dates and coverage'));
  for (const source of preview.sources) coverage.appendChild(el('p', {},
    `${source.tab} · ${source.source}: ${source.status}${source.quality ? ` / ${source.quality}` : ''} · source as of ${source.asOf || 'unavailable'} · ${source.included} selected readings`));
  details.appendChild(coverage);
  return details;
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
  input.disabled = false;
  input.placeholder = configured ? busy ? 'Next question…' : 'Ask a question…' : 'Assistant unavailable';
  autoSize(input);
  composer.classList.toggle('is-disabled', !configured);

  notice.classList.toggle('hidden', configured || configState === null);
  notice.textContent = configState?.message || '';
  if (configState && !configured) notice.appendChild(el('button', {
    type: 'button', class: 'research-retry-button', 'data-research-reconnect': '',
  }, 'Reconnect'));
  phase.textContent = busy ? session.phase : '';
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
  // Mobile hides the text label, so the icon must also describe cancellation.
  const mode = busy ? 'stop' : 'send';
  if (send.dataset.mode !== mode) {
    send.dataset.mode = mode;
    send.querySelector('svg').innerHTML = busy
      ? '<rect x="5" y="5" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>'
      : '<path d="m4 10 11-6-3 12-2.3-4.1L4 10Z" stroke-linejoin="round"/><path d="m9.7 11.9 2.4-3.1" stroke-linecap="round"/>';
  }
}

function autoSize(input) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(136, Math.max(44, input.scrollHeight))}px`;
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

async function submitCurrent(retryQuestion) {
  const session = currentSession();
  if (!session || isBusy(session) || !configState?.configured) return;
  const question = String(retryQuestion ?? session.draft).trim();
  if (!question) return;

  const originalDraft = retryQuestion ?? session.draft;
  // Retry replaces only the last failed attempt. Its partial answer and failed
  // question must not enter the next model's history as a completed exchange.
  if (session.messages.at(-1)?.incomplete && session.messages.at(-2)?.role === 'user' &&
      session.messages.at(-2).text === question) session.messages.splice(-2);
  session.private = session.private || privatePortfolioContext();
  const userMessage = { role: 'user', text: question };
  session.messages.push(userMessage);
  if (session.messages.filter((message) => message.role === 'user').length === 1) session.title = shortTitle(question);
  session.updatedAt = new Date().toISOString();
  if (retryQuestion === undefined) session.draft = '';
  session.error = null;
  session.status = 'answering';
  session.streamText = '';
  session.streamSources = [];
  session.streamDashboard = [];
  session.streamCompanies = [];
  session.streamPreview = null;

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
    session.streamCompanies = (evidence.selection?.companies || []).map((company) => ({ ticker: company.ticker, name: company.name, inScope: company.inScope }));
    session.streamPreview = researchPreview(evidence);
    setPhase(session, 'Writing from dashboard evidence…');

    generation.evidenceMs = Math.round(performance.now() - generation.startedAt);
    // A stalled browser/proxy must not leave Stop spinning indefinitely even
    // if the server's own deadline never reaches this connection.
    generation.deadline = setTimeout(() => {
      generation.timedOut = true;
      generation.controller.abort();
    }, ANSWER_TIMEOUT_MS);
    const requestOptions = {
      method: 'POST',
      headers: { accept: 'application/x-ndjson', 'content-type': 'application/json', ...authHeaders('api/research') },
      body: JSON.stringify({ question, requirePortfolio: true, scope: evidence.scope, webResearch: false, history: researchHistory(history), evidence }),
      signal: generation.controller.signal,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch('api/research', requestOptions);
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.message || `Research request failed (HTTP ${response.status}).`);
        }
        if (!response.body) throw interruptedAnswer();
        await consumeStream(response.body, session, generation);
        break;
      } catch (error) {
        // Reconnect once only before any answer has arrived. A partial answer,
        // explicit provider/auth error, cancellation or changed book never
        // triggers a hidden duplicate inference or mixes two responses.
        if (attempt || session.streamText.trim() || generation.controller.signal.aborted ||
            !(error.retryable || error instanceof TypeError)) throw error;
        session.streamText = '';
        generation.firstTextMs = undefined;
        setPhase(session, 'The connection closed before an answer arrived. Reconnecting once…');
      }
    }
  } catch (error) {
    const invalidated = generation.portfolioChanged || (generation.controller.signal.aborted && !generation.stopped && !generation.timedOut);
    const keepReadings = !invalidated;
    session.error = generation.portfolioChanged ? 'The Family workbook changed while this answer was being written. Retry to read the new book.'
      : generation.timedOut ? 'The answer is taking too long. Your question and available readings are saved here; retry when you are ready.'
      : generation.stopped ? null
      : error?.name === 'AbortError' ? 'The research scope changed. Retry using the current scope.'
      : error?.message || 'Research could not be completed.';
    userMessage.incomplete = true;
    session.messages.push({ role: 'assistant', text: keepReadings ? session.streamText : '', incomplete: true,
      stopped: !!generation.stopped, error: session.error,
      portfolio: keepReadings ? generation.portfolio : null,
      preview: keepReadings ? session.streamPreview : null,
      dashboardSources: keepReadings ? session.streamDashboard : [],
      companies: keepReadings ? session.streamCompanies : [], webResearch: false });
    // A next question typed during streaming is the reader's work too.
    if (!session.draft.trim()) session.draft = originalDraft;
    session.streamText = '';
    session.streamSources = [];
    session.streamDashboard = [];
    session.streamCompanies = [];
    session.streamPreview = null;
    session.status = generation.stopped ? 'idle' : 'needs-attention';
    session.phase = '';
    persistSessions();
  } finally {
    clearTimeout(generation.deadline);
    resumePortfolioSync();
    generations.delete(session.id);
    if (session.status === 'answering') session.status = 'idle';
    if (activeId === session.id && ctxRef) {
      const transcript = ctxRef.root.querySelector('[data-research-transcript]');
      const article = transcript?.querySelector('.is-streaming');
      const followLive = transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
      if (article?.dataset.sessionId === session.id) {
        article.replaceWith(messageNode(session.messages.at(-1)));
        if (followLive) transcript.scrollTop = transcript.scrollHeight;
        paintComposer();
        paintSidebar();
      } else paintAll();
      updateReadingControls();
    }
    else if (ctxRef) paintSidebar();
    // AN ANSWER THAT ARRIVED WHILE THE READER WAS ELSEWHERE HAS TO SAY SO, or keeping it running
    // is a feature nobody can see. This is a fact that arrived and one the reader asked for by
    // name, which is exactly what the alert stack is for; `key` is the session and the message
    // count, so a repaint cannot re-announce it. Nothing is pushed for a cancellation, and nothing
    // while the tab is on screen — the transcript is already showing it.
    if (!ctxRef && session.messages.at(-1)?.role === 'assistant' && !session.messages.at(-1).incomplete) {
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

function interruptedAnswer() {
  return Object.assign(new Error('The answer ended before a complete response arrived.'), { retryable: true });
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
      if (generation.firstTextMs === undefined && event.text.trim()) generation.firstTextMs = Math.round(performance.now() - generation.startedAt);
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
  if (!done || !session.streamText.trim()) throw interruptedAnswer();

  session.messages.push({
    role: 'assistant',
    text: session.streamText.slice(0, MAX_MESSAGE_CHARS),
    webResearch: false,
    dashboardSources: session.streamDashboard,
    webSources: session.streamSources,
    companies: session.streamCompanies || [],
    preview: session.streamPreview,
    portfolio: generation.portfolio,
    timings: { evidenceMs: generation.evidenceMs, firstTextMs: generation.firstTextMs, totalMs: Math.round(performance.now() - generation.startedAt) },
  });
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.updatedAt = new Date().toISOString();
  session.streamText = '';
  session.streamSources = [];
  session.streamDashboard = [];
  session.streamCompanies = [];
  session.streamPreview = null;
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
    if (session.streamPreview && !article.querySelector('[data-research-preview]')) {
      article.querySelector('.research-answer-label').after(previewNode(session.streamPreview, { open: true }));
    }
    if (session.streamText) {
      article.querySelector('.research-thinking')?.remove();
      let body = article.querySelector('.research-answer-body');
      if (!body) {
        body = el('div', { class: 'research-answer-body' });
        article.querySelector('.research-answer-label').after(body);
        const preview = article.querySelector('[data-research-preview]');
        if (preview && !preview.dataset.readerToggled) preview.open = false;
      }
      if (generation.paintedText !== session.streamText || generation.paintedBody !== body) {
        renderResearchAnswer(body, session.streamText, { cite: citeResolver(session.streamCompanies || []), compactCitations: true, streaming: true });
        generation.paintedText = session.streamText;
        generation.paintedBody = body;
      }
    } else {
      const status = article.querySelector('.research-thinking strong');
      if (status) status.textContent = session.phase || 'Reading the dashboard';
    }
    if (followLive) transcript.scrollTop = transcript.scrollHeight;
    updateReadingControls();
  });
}
