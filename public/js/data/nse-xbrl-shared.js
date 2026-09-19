// data/nse-xbrl-shared.js — the NSE XBRL announcement, read as a filing rather than as markup.
//
// PURE AND DEPENDENCY-FREE, imported by the browser (js/ui/xbrl-filing.js) and by the Worker
// (worker/index.js), the same arrangement as finology-shared.js and stockscans-shared.js — so the
// two can never disagree about which URLs are filings or about what a filing says.
//
// WHY THIS EXISTS. Nine per cent of NSE's announcement feed links to a raw XBRL file rather than a
// PDF: measured on a live pull, 150 of 1,693 items, `.../corporate/xbrl/<FORM>_<id>_WebXMLFile_
// <stamp>.xml`. Those are not a second copy of a PDF — they are the whole filing, and often the
// richer one: Man Industries' 10 Sep order announcement carries the amount, the counterparty, the
// nature of the contract and the execution period as separate facts, where the PDF is a scan.
// Opening one in a browser shows "This XML file does not appear to have any style information
// associated with it" over a tree of namespaces, which is the exchange's data with none of its
// meaning.
//
// AND NSE PUBLISHES NO READABLE TWIN. Measured against the live archive for one such filing:
// `<file>.html`, `<file>_WEB.html` and `/corporate/ixbrl/<file>_iXBRL_WEB.html` all 404, the
// document carries no XSLT stylesheet, and the response has no `access-control-allow-origin`
// header at all — so the browser cannot even read it. (Integrated Filings are the exception: NSE
// publishes those directly as `_iXBRL_WEB.html`, already readable, and this module leaves them
// alone.) Rendering it is therefore ours to do, through the Worker, or the reader gets the XML.
//
// WHAT IT MAY DO, AND WHAT IT MAY NOT. This REPRODUCES the exchange's own document — the rule the
// con-call and Institutions feeds follow. Values travel verbatim: a date stays the date the
// company filed, `true` stays `true`, a number keeps its digits and gains only the unit the
// document itself declares. Nothing is summed, scored, re-banded or re-worded, and a fact this
// parser does not recognise is still rendered, under its own name, because a filing is not ours to
// edit. The only thing added is presentation: the tag's own CamelCase name, spaced into words.

/** The one host and path shape these filings come from. Anything else is not one. */
export const XBRL_HOST = 'nsearchives.nseindia.com';
const XBRL_PATH = '/corporate/xbrl/';

/**
 * Is this URL an NSE XBRL announcement we can render?
 *
 * THIS IS ALSO THE WORKER ROUTE'S ALLOW-LIST, so it is deliberately strict rather than a substring
 * test: `https` only, the host EXACTLY (a hostname that merely ends in `nseindia.com` is somebody
 * else's — the same trap `isMunshotApi()` closes), the path under `/corporate/xbrl/`, and an
 * `.xml` file at the end of it. A route that fetched whatever it was handed would be an open proxy
 * wearing this dashboard's origin.
 */
export function isXbrlFilingUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.hostname.toLowerCase() !== XBRL_HOST) return false;
  const path = u.pathname;
  if (!path.startsWith(XBRL_PATH)) return false;
  if (path.includes('..')) return false;
  return /\.xml$/i.test(path);
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Kept here rather than imported from worker/nse-ann.mjs: this module may not depend on the Worker
// (the browser imports it), and entity decoding is a primitive rather than a policy — the thing
// this codebase refuses to define twice is a rule, and there is no rule in six lines of unescaping.
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

// Acronyms SEBI's taxonomy writes as one run of capitals. Splitting CamelCase already keeps them
// together ("NSESymbol" gives "NSE Symbol"); this is what stops the sentence-casing below from
// lowering them back down again.
const KEEP_CAPS = /^(?:[A-Z]{2,}|[A-Z]+\d+|\d+)$/;

/**
 * "WhetherTheOrdersOrContractsIsOrdinaryCourseOfBusiness" becomes "Whether the orders or contracts
 * is ordinary course of business". The tag IS the exchange's own name for the fact, so this changes
 * only its spacing and case — never the words, and never their order.
 */
export function humanLabel(tag) {
  const spaced = String(tag || '')
    .replace(/[_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // A trailing index is what separates one repeated block from the next ("ChangeInManagement1"),
    // so it becomes its own word. Only after a lower-case letter: "REG30" is one token in SEBI's
    // own form codes and splitting it would rename their form.
    .replace(/([a-z])(\d)/g, '$1 $2')
    .trim();
  if (!spaced) return '';
  return spaced
    .split(/\s+/)
    .map((w, i) => (i === 0 || KEEP_CAPS.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

/**
 * The block a fact belongs to.
 *
 * A REPEATED SECTION IS A CONTEXT, NOT A FIELD NAME. RailTel's 10 Sep filing reports four auditor
 * re-appointments as `D_ChangeInManagement1..4` / `I_ChangeInManagement1..4` — the same six tags,
 * four times over. Flattened into one list they read as one contradictory record; grouped by
 * context they read as four appointments. The `I_`/`D_` prefix and the `_I`/`_D`/`I`/`D` suffix are
 * the taxonomy's instant/duration marker for the SAME block (`MainI` and `MainD` are one header,
 * `OneI`/`OneD` one body), so they are folded away and everything else is kept as written.
 */
export function blockKey(contextRef) {
  let s = String(contextRef || '').trim();
  if (!s) return 'Main';
  s = s.replace(/^[ID]_/, '').replace(/_[ID]$/, '');
  if (/[a-z0-9][ID]$/.test(s)) s = s.slice(0, -1);
  return s || 'Main';
}

// The block every filing opens with, whatever the taxonomy calls it. Rendered without a heading:
// it is the filing's own identification, not a section of it.
const HEADER_BLOCKS = new Set(['Main', 'One']);

export const isHeaderBlock = (key) => HEADER_BLOCKS.has(String(key || ''));

const FACT = /<in-capmkt:([A-Za-z0-9_.-]+)\b([^>]*)>([\s\S]*?)<\/in-capmkt:\1>/g;

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs || '');
  return m ? m[1] : null;
}

/**
 * Every `in-capmkt:` fact in the document, in the document's own order, grouped into blocks.
 *
 * READ BY SHAPE, NOT BY FIELD NAME — the Deep Dive rule, and it matters more here because the
 * taxonomy is SEBI's and moves on its own schedule: measured across twelve form types in one pull
 * (orders, board intimations, director changes, shareholder notices, restructuring, trading-window
 * closure, CIRP, analyst meets and more), between 9 and 45 facts each, and not one field this code
 * has to know by name. A form published next month arrives laid out rather than dropped.
 */
export function parseXbrlFiling(xml) {
  const src = String(xml || '');
  const order = [];
  const byBlock = new Map();
  const seen = new Set();
  let count = 0;

  FACT.lastIndex = 0;
  for (let m = FACT.exec(src); m; m = FACT.exec(src)) {
    const [, tag, attrs, rawValue] = m;
    const value = decodeEntities(rawValue.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim();
    if (!value) continue; // an empty fact is a field the company left blank, not a finding
    // A FACT IS AN ELEMENT WITH A `contextRef`, AND STRUCTURE IS NOT A FACT. RailTel's filing
    // declares its repeated blocks with `<in-capmkt:ChangeInManagementDomain>` members nested
    // inside `<xbrli:context>` — same namespace, no context of their own, and four of them landed
    // at the top of the panel reading "Change in management domain: ChangeInManagementDomain1"
    // before this line existed. The taxonomy's own rule is the discriminator, so a typed member of
    // any name is excluded without this code having to know the name.
    const context = attr(attrs, 'contextRef');
    if (context === null) continue;
    const key = blockKey(context);
    // The same fact repeated under two contexts of one block (the instant and duration halves of a
    // header) is one statement, not two rows.
    const dedupe = `${key} ${tag} ${value}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (!byBlock.has(key)) { byBlock.set(key, []); order.push(key); }
    byBlock.get(key).push({ tag, label: humanLabel(tag), value, unit: attr(attrs, 'unitRef') });
    count += 1;
  }

  const blocks = order.map((key) => ({
    key,
    title: isHeaderBlock(key) ? null : humanLabel(key),
    facts: byBlock.get(key),
  }));

  // The identification fields, pulled out for the panel's heading. Absent stays absent — a filing
  // whose company name could not be read is titled from the row that opened it, never from a guess.
  const first = (tag) => {
    for (const b of blocks) for (const f of b.facts) if (f.tag === tag) return f.value;
    return null;
  };

  return {
    ok: count > 0,
    company: first('NameOfTheCompany'),
    symbol: first('NSESymbol'),
    isin: first('ISIN'),
    scripCode: first('ScripCode'),
    factCount: count,
    blocks,
  };
}

// ---- the filing in one line -------------------------------------------------------------------
//
// WHY A BOUNDED READING EXISTS AT ALL. The panel above renders the whole document, which is right
// on a screen and impossible in an email: the team brief carries up to eighty filings, and a
// reader who is told only "Acquisition (including agreement to acquire)" has been told the
// exchange's category and nothing about the event — which is exactly the complaint this closes.
// So a brief line reproduces as much of the filing as a line can hold and links to the rest.
//
// IT REPRODUCES, IT DOES NOT SUMMARISE. Every entry is one fact as filed — the exchange's own
// label, the company's own value, its own unit — in the document's own words. Nothing is combined,
// reworded, rounded or inferred, and what is not printed is COUNTED rather than dropped silently:
// a bounded view that hides its own bound claims the filing says less than it does.

/**
 * The identification fields, which every REG30 form opens with and which say nothing about the
 * event. They are excluded here because the surface that shows a line has already named the
 * company (the brief files every story under it) — and because `parseXbrlFiling` already exposes
 * each of them by name, so this is the same list read twice rather than a second vocabulary.
 */
const IDENTIFICATION = new Set(['NSESymbol', 'NameOfTheCompany', 'ScripCode', 'MSEISymbol', 'ISIN']);

/** Every fact in the filing, in the document's own order, identification aside. */
export function filingFacts(filing) {
  const out = [];
  for (const block of filing?.blocks || []) {
    for (const fact of block.facts || []) {
      if (IDENTIFICATION.has(fact.tag)) continue;
      out.push({ ...fact, block: block.title || null });
    }
  }
  return out;
}

// A form's own single-word answers and its stamps. These are facts and stay in the filing; they
// simply go last, because "Whether ... is an outcome of the board meeting: false" is the shape of
// the document rather than the substance of the event.
const SINGLE_WORD_ANSWER = /^(?:true|false|yes|no|na|n\/a|nil|none|not applicable|notlisted|not listed)$/i;
const STAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?$|^\d{1,2}:\d{2}(?::\d{2})?$/;

/**
 * Does this fact carry a particular of the event — a figure the company declared a unit for, or
 * text it typed?
 *
 * THE TEST IS THE VALUE'S SHAPE, NEVER THE FIELD'S NAME. SEBI's taxonomy is SEBI's and moves on
 * its own schedule — the parser above reads twelve form types without knowing one field by name,
 * and a hand-kept list of "interesting fields" here would quietly stop finding the interesting
 * ones the month a form changes. Measured on the shipped fixtures, the shape test alone puts the
 * order's amount, counterparty and nature ahead of its yes/no boxes.
 */
const figure = (fact) => !!fact.unit;
const typed = (fact) => {
  const text = String(fact.value || '').trim();
  return !SINGLE_WORD_ANSWER.test(text) && !STAMP.test(text) && /\s/.test(text);
};

// A value longer than this is cut at a word boundary with an ellipsis, so a line stays a line. It
// is visible truncation of a value that is reachable in full one click away — never a rewording,
// and never a silent one.
const VALUE_CHARS = 180;
const clip = (value) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= VALUE_CHARS) return { value: text, clipped: false };
  const cut = text.slice(0, VALUE_CHARS);
  const space = cut.lastIndexOf(' ');
  return { value: `${(space > VALUE_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`, clipped: true };
};

/**
 * As much of the filing as one line can carry: the first figure the company declared, then the
 * filing's own particulars in the document's own order, then its single-word answers and stamps —
 * each as `{ label, value, unit }`, with `omitted` counting every fact left in the document.
 *
 * WHY A FIGURE LEADS. A REG30 form opens with two or three clauses of the regulation it is filed
 * under, and on the shipped fixtures those clauses alone spend most of a line — so document order
 * on its own puts "Cost of acquisition: 1850000000 INR" and "Amount of the orders or contracts:
 * 6000000000 INR" outside it. A declared figure is the one particular a reader cannot guess from
 * the category, so exactly ONE of them is carried to the front. Everything after it stays in the
 * order the company filed it in; nothing is ranked, weighed or chosen by what it says.
 *
 * TWO BOUNDS, AND NEITHER MAY STARVE THE LINE. A fact that does not fit the character budget is
 * SKIPPED rather than ending the reading — one 165-character regulation clause would otherwise
 * spend the whole line and leave the counterparty and the nature of the order in the "and 18
 * more". And one statement repeated across a form's repeated blocks — RailTel files four auditor
 * re-appointments as four copies of the same six fields — is printed once, because a line that
 * reads "Designation: Statutory Auditor" four times has told the reader one thing four times.
 * Both are still counted in `omitted`.
 */
export function filingParticulars(filing, { limit = 6, maxChars = 420 } = {}) {
  const facts = filingFacts(filing);
  const lead = facts.find(figure);
  const rest = facts.filter((f) => f !== lead);
  const ordered = [lead, ...rest.filter(typed), ...rest.filter((f) => !typed(f))].filter(Boolean);
  const kept = [];
  const seen = new Set();
  let chars = 0;
  for (const fact of ordered) {
    if (kept.length >= limit) break;
    const label = String(fact.label || fact.tag);
    const { value, clipped } = clip(fact.value);
    const statement = `${label}: ${value}`;
    if (seen.has(statement)) continue;
    if (kept.length && chars + statement.length > maxChars) continue;
    seen.add(statement);
    kept.push({ tag: fact.tag, label, value, unit: fact.unit || null, clipped });
    chars += statement.length;
  }
  return { facts: kept, omitted: facts.length - kept.length, total: facts.length };
}

/**
 * One fact as a sentence: `Label: value UNIT`.
 *
 * `pure` is the taxonomy's unit for a number that HAS no unit — a count, a ratio — so it is the one
 * unit not printed: "4 pure" is the document's plumbing showing through, where "4" is the company's
 * own value. Every other unit travels, because it is part of what the figure means.
 */
export const factStatement = (fact) => `${fact.label || fact.tag}: ${fact.value}${fact.unit && !/^pure$/i.test(fact.unit) ? ` ${fact.unit}` : ''}`;

/** The same reading as one string: `Label: value · Label: value`. */
export const filingParticularsLine = (filing, options) => filingParticulars(filing, options).facts.map(factStatement).join(' · ');
