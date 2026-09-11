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
