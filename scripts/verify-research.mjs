#!/usr/bin/env node
// Focused unit/integration checks for Ask Research. Dependency-free by repository contract.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildMunsRequest,
  handleResearch,
  providerEvidence,
  researchConfigured,
  takeNdjsonLines,
  validateResearchBody,
} from '../worker/research.mjs';

const memoryStorage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => memoryStorage.has(key) ? memoryStorage.get(key) : null,
    setItem: (key, value) => memoryStorage.set(key, String(value)),
    removeItem: (key) => memoryStorage.delete(key),
  },
});
const { DASHBOARD_RESEARCH_SOURCES, RESEARCH_EVIDENCE_CHAR_BUDGET, ROW_RESERVE_SHARE, fitEvidenceToBudget, queryPlan } = await import('../public/js/research/estate.js');
const { providerEvidenceChars } = await import('../public/js/research/evidence-shared.js');
const estateSource = readFileSync(new URL('../public/js/research/estate.js', import.meta.url), 'utf8');
const askResearchSource = readFileSync(new URL('../public/js/tabs/ask-research.js', import.meta.url), 'utf8');

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log('PASS  ' + label);
};
const requestFor = (body) => new Request('https://dashboard.example/api/research', {
  method: 'POST',
  headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const parseEvents = async (response) =>
  (await response.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

ok('the runtime research catalog covers every visible research tab, and nothing that is not one', () => {
  const tabs = new Set(DASHBOARD_RESEARCH_SOURCES.map((source) => source.tab));
  for (const title of ['AI Alerts', 'All Alerts', 'Earnings Hub', 'Con-call', 'Public Chatter', 'Breakouts / Technical', 'Super Investors', 'News', 'Corp Announcements', 'Insider Trades']) {
    assert.equal(tabs.has(title), true, title);
  }
  // The mock ledger was the fifteenth source and cited itself as "Portfolio Analytics", linking
  // into a hidden workspace with no way back. Both are deleted: an evidence source must be a tab
  // the reader can actually open, and no source may route outside Research Central.
  assert.equal(tabs.has('Portfolio Analytics'), false);
  for (const source of DASHBOARD_RESEARCH_SOURCES) {
    assert.match(source.route, /^#\/research\//, source.id);
  }
  assert.equal(new Set(DASHBOARD_RESEARCH_SOURCES.map((source) => source.id)).size, DASHBOARD_RESEARCH_SOURCES.length);
});

ok('earnings calendar evidence keeps paginated results and upcoming calls separate from filed results', () => {
  assert.match(
    estateSource,
    /id: 'earnings-calendar',[\s\S]*?read\(\{ plan \}\)[\s\S]*?scheduledRows[\s\S]*?Moneycontrol scheduled results plus Screener upcoming[\s\S]*?Result rows use Moneycontrol All exchanges[\s\S]*?every page of Screener/
  );
  const block = estateSource.match(/\n    id: 'earnings-calendar',\n    read[\s\S]*?\n  \},\n  \{\n    id: 'concall'/)?.[0] || '';
  assert.doesNotMatch(block, /earningsLive\.(?:load|dateRange|reportedOn)/);
});

ok('every source loads before any source reads, so the company index is built from the whole estate', () => {
  assert.match(estateSource, /Phase one:[\s\S]*?loadErrors[\s\S]*?Phase two:[\s\S]*?queryPlan\(question, companyIndex\(deferred\)[\s\S]*?Phase three:/);
});

ok('Public Chatter evidence preserves failure state and separately samples unresolved topics', () => {
  assert.match(estateSource, /if \(meta\.ok !== true\) throw new Error/);
  assert.match(estateSource, /const unresolved = chatter\.uncovered\(\);[\s\S]*?unresolvedTopics: \{/);
});

ok('saved web-researched answers retain their historical provenance after the provider migration', () => {
  assert.match(askResearchSource, /webResearch: message\.webResearch === true/);
  assert.match(askResearchSource, /message\.webResearch \? 'Dashboard \+ web research' : 'Dashboard research'/);
  assert.match(askResearchSource, /body: JSON\.stringify\(\{ question, requirePortfolio: true, scope: evidence\.scope, webResearch: false/);
});

ok('configuration accepts the dedicated or existing Muns session-token bindings', () => {
  assert.equal(researchConfigured({}), false);
  assert.equal(researchConfigured({ MUNS_TOKEN: 'short' }), false);
  assert.equal(researchConfigured({ MUNS_TOKEN: 'muns-session-token-value' }), true);
  assert.equal(researchConfigured({ MUNS_NEWS_TOKEN: 'muns-news-session-token' }), true);
  assert.equal(researchConfigured({ MUNS_LLM_TOKEN: 'muns-llm-session-token' }), true);
  assert.equal(researchConfigured({ ANTHROPIC_API_KEY: 'real-anthropic-key-must-not-leave' }), false);
  assert.equal(researchConfigured({
    ANTHROPIC_API_KEY: 'legacy-muns-session-token',
    MUNS_LLM_LEGACY_ANTHROPIC_BINDING: 'confirmed-muns-token',
  }), true);
});

const valid = validateResearchBody({
  question: 'What changed?',
  scope: 'portfolio',
  webResearch: true,
  history: [{ role: 'user', text: 'Earlier question' }, { role: 'tool', text: 'not permitted' }],
  evidence: { catalog: [{ id: 'earnings-hub' }], sources: [] },
});

ok('request validation bounds history and disables unsupported web mode', () => {
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.history, [{ role: 'user', text: 'Earlier question' }]);
  assert.equal(valid.webResearch, false);
  assert.equal(validateResearchBody({ evidence: {} }).error, 'missing_question');
});

const longHistory = Array.from({ length: 12 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  text: 'm' + String(index).padStart(2, '0') + '-' + 'x'.repeat(3_996),
}));
const boundedHistory = validateResearchBody({
  question: 'Follow up',
  scope: 'portfolio',
  history: longHistory,
  evidence: { catalog: [], sources: [] },
}).history;
ok('history budgeting retains the newest messages and restores chronological order', () => {
  assert.deepEqual(boundedHistory.map((message) => message.text.slice(0, 3)), ['m10', 'm11']);
  assert.equal(boundedHistory.reduce((sum, message) => sum + message.text.length, 0), 3_000);
});

const oversizedEvidence = {
  generatedAt: '2026-09-02T09:00:00.000Z',
  scope: 'portfolio',
  selection: { sourcesRegistered: 14, sourcesReady: 14 },
  catalog: Array.from({ length: 14 }, (_, index) => ({ id: `source-${index}`, tab: `Tab ${index}`, route: `#/tab-${index}`, status: 'ready', rowCount: 20 })),
  sources: Array.from({ length: 14 }, (_, index) => ({
    id: `source-${index}`,
    tab: `Tab ${index}`,
    route: `#/tab-${index}`,
    description: `Description ${index}`,
    status: 'ready',
    source: `Provider ${index}`,
    asOf: '2026-09-02',
    rowCount: 20,
    coverage: { scope: 'portfolio', total: 20 },
    matchedRows: index === 0 ? 8 : 0,
    omittedRows: 0,
    rows: Array.from({ length: 20 }, (_, row) => ({ company: `Company ${index}-${row}`, detail: 'x'.repeat(900) })),
  })),
};
const fittedEvidence = fitEvidenceToBudget(oversizedEvidence);
ok('the local-model evidence budget retains every source before sharing space across ranked rows', () => {
  assert.equal(providerEvidenceChars(fittedEvidence) <= RESEARCH_EVIDENCE_CHAR_BUDGET, true);
  assert.equal(fittedEvidence.catalog.length, 14);
  assert.equal(fittedEvidence.sources.length, 14);
  assert.equal(fittedEvidence.sources.every((source) => source.tab && source.route && source.status === 'ready' && source.source && source.coverage), true);
  assert.equal(fittedEvidence.sources.some((source) => source.includedRows > 0), true);
  // The budget is spent on rows, not just measured: the matched source is served first, and no
  // source with rows is left at zero while its skeleton fits.
  assert.equal(fittedEvidence.sources[0].includedRows > 0, true);
  assert.equal(fittedEvidence.sources.every((source) => source.includedRows > 0), true);
  assert.equal(fittedEvidence.selection.evidenceChars, providerEvidenceChars(fittedEvidence));
});

// THE FAILURE THIS FILE SHIPPED WITH: a skeleton that alone exceeds the budget. Every row was pushed
// and popped, `includedRows` read 0 on all fourteen sources, and the model answered that the
// dashboard held no company data. The skeleton must give way before the rows do.
const fatSkeleton = {
  ...oversizedEvidence,
  // Twelve short keys rather than one long string: string values are clipped by the packet's own
  // metadata bound, so a genuinely fat skeleton has to be fat in structure.
  sources: oversizedEvidence.sources.map((source) => ({ ...source, summary: Object.fromEntries(Array.from({ length: 12 }, (_, key) => [`figure${key}`, 'y'.repeat(90)])) })),
};
const fittedFat = fitEvidenceToBudget(fatSkeleton);
ok('a skeleton larger than the budget is trimmed, and says so, before a single row is refused', () => {
  const rowless = JSON.stringify(fatSkeleton.sources.map(({ rows: _rows, ...rest }) => rest)).length;
  assert.equal(rowless > RESEARCH_EVIDENCE_CHAR_BUDGET, true, 'fixture skeleton must exceed the budget');
  assert.equal(providerEvidenceChars(fittedFat) <= RESEARCH_EVIDENCE_CHAR_BUDGET, true);
  assert.equal(fittedFat.sources.every((source) => source.includedRows > 0), true);
  assert.equal(fittedFat.sources.some((source) => source.trimmed?.includes('summary')), true);
  assert.equal(fittedFat.sources.every((source) => source.status === 'ready' && source.source && source.definition !== ''), true);
  const skeletonChars = providerEvidenceChars({ ...fittedFat, sources: fittedFat.sources.map((source) => ({ ...source, rows: [] })) });
  assert.equal(skeletonChars <= Math.floor(RESEARCH_EVIDENCE_CHAR_BUDGET * (1 - ROW_RESERVE_SHARE)), true);
});

const companyIndex = [
  { ticker: 'IIFL', name: 'IIFL Finance Ltd', aliases: ['IIFL Finance', 'IIFL Finance Ltd.'] },
  { ticker: 'IIFLCAPS', name: 'IIFL Capital Services Ltd', aliases: [] },
  { ticker: 'COALINDIA', name: 'Coal India Ltd', aliases: ['Coal India'] },
  { ticker: 'DIVISLAB', name: "Divi's Laboratories Ltd", aliases: ['Divis Lab.'] },
  { ticker: 'TATAMOTORS', name: 'Tata Motors Ltd', aliases: [] },
  { ticker: 'TATASTEEL', name: 'Tata Steel Ltd', aliases: [] },
  { ticker: 'IDEA', name: 'Vodafone Idea Ltd', aliases: [] },
  { ticker: 'HFCL', name: 'HFCL Limited', aliases: [] },
];
const holdings = [{ ticker: 'IIFL', name: 'IIFL Finance' }, { ticker: 'COALINDIA', name: 'Coal India' }];
ok('a question naming a company resolves it to a ticker, in scope or not, and stops its words scoring as hits', () => {
  const iifl = queryPlan('anything i should know about IIFL finance?', companyIndex, { scope: 'portfolio', holdings });
  assert.deepEqual(iifl.companies, [{ ticker: 'IIFL', name: 'IIFL Finance Ltd', inScope: true }]);
  assert.deepEqual(iifl.tokens, []);
  const lower = queryPlan('what is happening with iifl finance lately', companyIndex, { scope: 'portfolio', holdings });
  assert.deepEqual(lower.companies.map((company) => company.ticker), ['IIFL']);
  const outside = queryPlan('Summarise HFCL', companyIndex, { scope: 'portfolio', holdings });
  assert.deepEqual(outside.companies, [{ ticker: 'HFCL', name: 'HFCL Limited', inScope: false }]);
  const two = queryPlan('Compare Coal India with Divis on results', companyIndex, { scope: 'universe' });
  assert.deepEqual(two.companies.map((company) => company.ticker), ['COALINDIA', 'DIVISLAB']);
  assert.deepEqual(two.tokens, ['results']);
});

ok('an ambiguous or merely English word is not read as a company', () => {
  assert.deepEqual(queryPlan('any idea what the market did?', companyIndex).companies, []);
  assert.deepEqual(queryPlan('IDEA results', companyIndex).companies.map((company) => company.ticker), ['IDEA']);
  assert.deepEqual(queryPlan('what about tata?', companyIndex).companies, []);
  assert.deepEqual(queryPlan('Which companies in my portfolio have the strongest recent evidence across multiple tabs?', companyIndex).companies, []);
});

ok('scope and dashboard vocabulary never become ranking tokens', () => {
  const plan = queryPlan('Which companies in my portfolio have the strongest recent evidence across multiple tabs?', companyIndex);
  assert.deepEqual(plan.tokens, []);
  assert.deepEqual(queryPlan('insider trades and earnings for my watchlist', companyIndex).tokens, ['insider', 'trades', 'earnings']);
});

ok('the provider prompt removes duplicate UI fields without dropping an analytical source', () => {
  const providerPacket = providerEvidence(fittedEvidence);
  assert.equal(providerPacket.catalog, undefined);
  assert.equal(providerPacket.sources.length, 14);
  assert.equal(providerPacket.sources.every((source) => !('route' in source) && !('description' in source)), true);
  assert.equal(providerPacket.sources.every((source) => source.status === 'ready' && source.source && source.coverage), true);
  assert.equal(JSON.stringify(providerPacket).length < JSON.stringify(fittedEvidence).length, true);
});

ok('the Muns request preserves evidence and selects low-latency local streaming by default', () => {
  const request = buildMunsRequest(valid);
  assert.equal(request.llm_type, 'local_llm');
  assert.equal(request.stream, true);
  assert.equal(request.temperature, 0.2);
  assert.equal(request.max_tokens, 768);
  assert.match(request.query, /Complete the answer within 450 words/);
  assert.match(request.query, /DASHBOARD_EVIDENCE object is the only source of dashboard facts/);
  assert.match(request.query, /USER: Earlier question/);
  assert.match(request.query, /QUESTION:\nWhat changed\?/);
  assert.match(request.query, /DASHBOARD_EVIDENCE:/);
  assert.equal(buildMunsRequest(valid, { MUNS_LLM_TYPE: 'hosted_llm' }).llm_type, 'hosted_llm');
});

ok('NDJSON framing waits for complete network chunks', () => {
  const first = takeNdjsonLines('{"text":"Hel');
  assert.deepEqual(first.lines, []);
  const second = takeNdjsonLines(first.rest + 'lo"}\n{"text":"world"}\n');
  assert.deepEqual(second.lines.map((line) => JSON.parse(line).text), ['Hello', 'world']);
  assert.equal(second.rest, '');
});

const body = {
  question: 'What changed?',
  scope: 'portfolio',
  webResearch: false,
  history: [],
  evidence: {
    catalog: [{ id: 'earnings-hub', status: 'ready' }],
    sources: [{ id: 'earnings-hub', status: 'ready', rows: [] }],
  },
};

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://fastapi.muns.io/query-router');
    assert.equal(init.headers.authorization, 'Bearer llm-token-wins-over-the-fallback');
    assert.equal(init.headers.accept, 'application/x-ndjson');
    const requested = JSON.parse(init.body);
    assert.equal(requested.llm_type, 'local_llm');
    assert.equal(requested.stream, true);
    assert.match(requested.query, /QUESTION:\nWhat changed\?/);
    return new Response('{"text":"Earnings"}\n{"text":" improved. [Dashboard: Earnings Hub]"}\n', {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });
  };

  const response = await handleResearch(requestFor(body), {
    MUNS_LLM_TOKEN: 'llm-token-wins-over-the-fallback',
    MUNS_NEWS_TOKEN: 'news-token-fallback',
    MUNS_TOKEN: 'general-token-fallback',
    RESEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  const events = await parseEvents(response);
  ok('the Worker forwards every Muns text chunk and completes the dashboard stream', () => {
    assert.equal(response.status, 200);
    assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => event.text), [
      'Earnings',
      ' improved. [Dashboard: Earnings Hub]',
    ]);
    assert.equal(events.at(-1).type, 'done');
  });
} finally {
  globalThis.fetch = originalFetch;
}

try {
  let releaseProvider;
  globalThis.fetch = async () => new Promise((resolve) => {
    releaseProvider = () => resolve(new Response('{"text":"Ready"}\n', {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    }));
  });
  const response = await handleResearch(requestFor(body), { MUNS_TOKEN: 'muns-session-token-value' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  const second = decoder.decode((await reader.read()).value);
  ok('the browser receives working status without waiting for the provider first token', () => {
    assert.match(first + second, /"type":"start"/);
    assert.match(first + second, /"type":"phase"/);
    assert.equal(typeof releaseProvider, 'function');
  });
  releaseProvider();
  while (!(await reader.read()).done) {
    // Drain the completion so every promise is accounted for.
  }
} finally {
  globalThis.fetch = originalFetch;
}

try {
  globalThis.fetch = async () => new Response('{"error":"Token expired"}\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
  const response = await handleResearch(requestFor(body), { MUNS_TOKEN: 'muns-session-token-value' });
  const events = await parseEvents(response);
  ok('an error event inside a successful upstream stream fails closed', () => {
    assert.equal(events.some((event) => event.type === 'error' && event.message === 'Token expired'), true);
    assert.notEqual(events.at(-1).type, 'done');
  });
} finally {
  globalThis.fetch = originalFetch;
}

try {
  globalThis.fetch = async () => new Response('{"error":{"message":"expired"}}', { status: 401 });
  const response = await handleResearch(requestFor(body), { MUNS_TOKEN: 'muns-session-token-value' });
  const events = await parseEvents(response);
  ok('an HTTP authentication failure gives a safe operator-facing error', () => {
    assert.equal(events.some((event) => event.type === 'error' && /session token/i.test(event.message)), true);
  });
} finally {
  globalThis.fetch = originalFetch;
}

const notConfigured = await handleResearch(new Request('https://dashboard.example/api/research'), {});
const configBody = await notConfigured.json();
ok('the configuration route fails closed without exposing provider details', () => {
  assert.deepEqual(configBody, { configured: false, webResearchAvailable: false, history: 'device' });
});

const configured = await handleResearch(
  new Request('https://dashboard.example/api/research'),
  { MUNS_NEWS_TOKEN: 'muns-news-session-token' }
);
const configuredBody = await configured.json();
ok('the configuration route advertises dashboard research without unsupported web mode', () => {
  assert.deepEqual(configuredBody, { configured: true, webResearchAvailable: false, history: 'device' });
});

const wrongOrigin = await handleResearch(
  new Request('https://dashboard.example/api/research', {
    method: 'POST',
    headers: { origin: 'https://elsewhere.example', 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Test', evidence: {} }),
  }),
  { MUNS_TOKEN: 'muns-session-token-value' }
);
ok('the paid research route rejects cross-origin submissions', () => {
  assert.equal(wrongOrigin.status, 403);
});

const oversized = await handleResearch(
  new Request('https://dashboard.example/api/research', {
    method: 'POST',
    headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' },
    body: 'x'.repeat(180_001),
  }),
  { MUNS_TOKEN: 'muns-session-token-value' }
);
ok('the request-body bound is enforced on bytes without a content-length header', () => {
  assert.equal(oversized.status, 413);
});

console.log('\n' + checks + ' Ask Research checks passed.');
