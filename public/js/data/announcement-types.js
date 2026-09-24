// data/announcement-types.js — ONE LABEL PER FILING, READ FROM THE EXCHANGE'S OWN WORDS.
//
// The announcements stream carries a great deal that nobody at the desk acts on. Measured on the
// shipped captures (17 September 2026): of 3,936 BSE filings, 981 are newspaper copies of filings
// already made and 936 are AGM notices; of 1,315 NSE filings, 436 are mutual-fund NAV declarations.
// A reader looking for the one credit-rating revision or order win scrolls past all of it — and
// the filings the desk called out by name (a shareholder lost a physical certificate, so the company
// files that it converted the shares to demat) sit inside BSE's catch-all `General` sub-category,
// which is why the sub-category filter alone could never remove them.
//
// So every filing gets ONE type, and the Announcements view offers the types as a multi-select the
// reader can switch on and off, remembered on the device. Four rules keep that honest:
//
//  1. THE LABEL IS READ, NOT JUDGED. It is decided by the exchange's own sub-category (BSE) or
//     subject (NSE) where the exchange gave one that says something, and only then by the filing's
//     own subject line — never by the document, which is never opened. `announcementTypeOf` says
//     which of those it read, so every cell can name its reason.
//  2. FIRST RULE WINS, AND THE ORDER IS PART OF THE DEFINITION. A newspaper copy of a results
//     advertisement is routine before it is a result. The list below is that order — and the
//     exchange's own label is read before the subject line, so a filing BSE files under "Outcome of
//     Board Meeting" is a board meeting even when its subject line names the results it approved.
//  3. A FILING NO RULE RECOGNISES IS `other`, NOT A NEAREST GUESS. BSE's `General` and NSE's
//     `General Updates` are catch-alls whose label says nothing, and a subject line like
//     "Please find attached" says less; those stay under Other updates rather than being pushed into
//     a type on a hunch.
//  4. HIDING IS A DISPLAY DEFAULT, NEVER A COLLECTION OR DELETION RULE. `DEFAULT_HIDDEN_TYPES` hides
//     the routine type on a device that has chosen nothing; the chip still prints its count, one click
//     shows it, and nothing about capture or retention reads this file.

const RE = {
  routine: /newspaper|\bnav\b|net asset value|trading window|share certificates?|duplicate (?:share|certificate)|loss of (?:share|securit)|\bdemat\w*|\bremat\w*|reconciliation of share capital|\b74\s*\(5\)|\b7\s*\(3\)|\b40\s*\(9\)|\b13\s*\(3\)|certificate under reg|investor (?:complaints?|grievances?)|compliance certificate|secretarial compliance|large corporate|registered office|corporate office|change of address|confirmation of redemption|payment of interest|interest payment/i,
  results: /financial results?|quarterly results?|\bresults? for the (?:quarter|half|year|period)|\b(?:un)?audited\b/i,
  'board-meeting': /board meeting|meeting of (?:the )?board|outcome of (?:the )?board/i,
  orders: /award(?:ing)? of order|receipt of order|bagging|receiving of orders?|orders?\s*\/\s*contracts?|\bwork order|letter of (?:award|intent|acceptance)|\bcontracts? (?:worth|valued|for|from)\b|\borders? (?:worth|valued|from)\b|purchase order|\bloa\b|\bloi\b/i,
  'credit-rating': /credit rating|\bratings? (?:action|revision|reaffirm\w*|upgrade\w*|downgrade\w*|assign\w*|withdraw\w*|rationale)/i,
  'corporate-action': /book closure|record date|\bdividends?\b|\bbonus\b|stock split|sub-?division of|\bbuy-?back/i,
  capital: /issue of securities|preferential|allotment|alteration of capital|fund ?raising|\bqip\b|qualified institution|rights issue|\besop|\besos|\besps|\bwarrants?\b|conversion of|debentures?|\bncds?\b|commercial paper|\bborrowing|term loan|new listing|listing (?:of|approval)|trading approval|\bipo\b|public issue/i,
  deals: /acqui(?:re|red|ring|sition)|\bmergers?\b|amalgamation|scheme of arrangement|demerger|restructuring|open offer|takeover(?! regulations)|joint venture|\bjv\b|memorandum of understanding|\bmou\b|\bagreements?\b|\barrangements?\b|tie-?up|strategic|divest|stake sale|slump sale|incorporation of|subsidiar|wholly[- ]owned|investment in|sale of (?:business|undertaking|assets?)/i,
  management: /change in (?:management|directorate)|\bdirectors?\b|\bkmp\b|\bsmp\b|auditor|company secretary|compliance officer|chief (?:financial|executive|operating|technology)|\bcfo\b|\bceo\b|\bcoo\b|\bcto\b|managing director|chairman|chairperson|appointment|resignation|cessation|re-?appointment/i,
  'investor-meet': /analyst|investors? (?:meet|presentation|call|conference|day)|institutional investor|con\.? ?call|earnings call|presentation|press release|media release|press conference|interaction with [\w ]*media|\binterview/i,
  'shareholder-meeting': /\bagm\b|\begm\b|annual general meeting|extra-?ordinary general meeting|general meeting|postal ballot|shareholders?'? meeting|court convened|e-?voting|scrutini[sz]er|voting results|annual report|notice of (?:the )?(?:\d+\w* )?(?:annual|general) meeting/i,
  regulatory: /clarification|spurt in volume|price movement|penalt|show[- ]cause|orders? passed|actions? initiated|litigation|\bcourt\b|tribunal|\bnclt\b|\bnclat\b|insolvency|\bcirp\b|committee of creditors|resolution plan|takeover regulations|\bsast\b|insider trading|delisting|suspension|arbitration|tax (?:demand|order|notice)|\bgst\b|adjudicat|\bfir\b|investigation|\bsearch\b|\braid\b|\bdefault\b|\bnpa\b|\bfraud/i,
};

export const OTHER_TYPE = 'other';

/**
 * The vocabulary, in the order the rules are tried. `routine` is the one type hidden by default;
 * every other is shown until the reader switches it off. `hint` is what the chip's tooltip and the
 * provenance panel print, so the reader can see what a type covers without opening this file.
 */
export const ANNOUNCEMENT_TYPES = [
  { id: 'routine', label: 'Routine & administrative', routine: true,
    hint: 'Newspaper copies of filings already made, mutual-fund NAV declarations, trading-window closures, share-certificate and demat notices, compliance and reconciliation certificates, office-address changes and debt-servicing confirmations.' },
  { id: 'results', label: 'Results', hint: 'Financial results and replies to exchange clarifications about them.' },
  { id: 'board-meeting', label: 'Board meetings', hint: 'Board-meeting intimations and outcomes that do not name a result.' },
  { id: 'orders', label: 'Orders & contracts', hint: 'Orders and contracts received or awarded.' },
  { id: 'credit-rating', label: 'Credit rating', hint: 'Rating actions, revisions and withdrawals.' },
  { id: 'corporate-action', label: 'Corporate action dates', hint: 'Book closures, record dates, dividends, bonuses, splits and buybacks — the events the Corporate Actions view lists with their terms.' },
  { id: 'capital', label: 'Capital & allotments', hint: 'Issues and allotments of securities, preferential issues, QIPs, rights, ESOP allotments, debentures, borrowings and new listings.' },
  { id: 'deals', label: 'Deals & restructuring', hint: 'Acquisitions, mergers, schemes of arrangement, joint ventures, agreements, subsidiaries and divestments.' },
  { id: 'management', label: 'Management & auditors', hint: 'Appointments, resignations and changes among directors, key personnel, auditors and the company secretary.' },
  { id: 'investor-meet', label: 'Investor meets & presentations', hint: 'Analyst and investor meetings, con-call intimations, investor presentations and press releases.' },
  { id: 'shareholder-meeting', label: 'Shareholder meetings & votes', hint: 'AGM and EGM notices, postal ballots, voting results and annual reports.' },
  { id: 'regulatory', label: 'Regulatory, legal & clarifications', hint: 'Exchange clarifications, regulatory orders and notices, litigation, insolvency proceedings and takeover-regulation disclosures.' },
  { id: OTHER_TYPE, label: 'Other updates', hint: 'Filings whose exchange label is a catch-all (General, Updates) and whose subject line matches no rule. Nothing here is read as unimportant — it is simply unclassified.' },
];

const BY_ID = new Map(ANNOUNCEMENT_TYPES.map((t) => [t.id, t]));
export const typeById = (id) => BY_ID.get(String(id || '')) || BY_ID.get(OTHER_TYPE);
export const typeLabel = (id) => typeById(id).label;

// BSE's own category, used only when neither the sub-category nor the subject line matched a rule.
const CATEGORY_TYPE = {
  Result: 'results',
  'Board Meeting': 'board-meeting',
  'Corp. Action': 'corporate-action',
  'AGM/EGM': 'shareholder-meeting',
  'New Listing': 'capital',
};

// An exchange label that says nothing about the filing. A sub-category or subject in this set is
// skipped so the subject line (BSE) or the description (NSE) gets to decide instead.
const CATCH_ALL = new Set(['general', 'updates', 'general updates', 'meeting updates', 'others', 'other', 'company update', 'company updates']);
const isCatchAll = (s) => CATCH_ALL.has(String(s || '').trim().toLowerCase());

const clean = (value) => String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Memoised by the exact string: 3,148 of the 5,251 shipped filings are decided by one of about a
// hundred exchange labels, so the regex pass runs once per distinct label rather than once per row.
// Measured over a 31,506-row universe: 108ms → about a tenth of that. Bounded, because catch-all
// rows are decided by their subject line and those are mostly unique.
const RULE_MEMO = new Map();
const RULE_MEMO_MAX = 20_000;
function ruleFor(text) {
  if (!text) return null;
  let id = RULE_MEMO.get(text);
  if (id !== undefined) return id;
  id = null;
  for (const t of ANNOUNCEMENT_TYPES) {
    const re = RE[t.id];
    if (re && re.test(text)) { id = t.id; break; }
  }
  if (RULE_MEMO.size >= RULE_MEMO_MAX) RULE_MEMO.clear();
  RULE_MEMO.set(text, id);
  return id;
}

/**
 * Classify one merged announcement row.
 *
 * @returns {{ id: string, label: string, routine: boolean, from: 'sub-category'|'subject'|'description'|'category'|null, text: string }}
 *   `from` names what decided it and `text` is the exact string that was read, so a cell can say
 *   "read from BSE's sub-category: Newspaper Publication" rather than presenting the label as a fact
 *   about the document.
 */
export function announcementTypeOf(row = {}) {
  const subCategory = clean(row.subCategory);
  const subject = clean(row.title || row.headline || row.subject);
  const description = clean(row.summary || row.description);

  // 1. The exchange's own sub-category, where it is not a catch-all. On NSE rows the subject IS the
  //    exchange's label (the feed files it as `title`), so it is tried here under the same rule.
  const exchangeLabel = subCategory || (row.subCategory == null && !row.category ? subject : '');
  if (exchangeLabel && !isCatchAll(exchangeLabel)) {
    const id = ruleFor(exchangeLabel);
    if (id) return result(id, subCategory ? 'sub-category' : 'subject', exchangeLabel);
  }
  // 2. The filing's own subject line.
  if (subject && subject !== exchangeLabel) {
    const id = ruleFor(subject);
    if (id) return result(id, 'subject', subject);
  }
  // 3. NSE's description, which for a catch-all subject carries the real intimation
  //    ("… has informed the Exchange about Intimation under Regulation 30 …").
  if (description && (!subject || isCatchAll(subject))) {
    const id = ruleFor(description);
    if (id) return result(id, 'description', description.length > 160 ? `${description.slice(0, 157)}…` : description);
  }
  // 4. BSE's category, the coarsest label it gives.
  const byCategory = CATEGORY_TYPE[clean(row.category)];
  if (byCategory) return result(byCategory, 'category', clean(row.category));
  return result(OTHER_TYPE, null, exchangeLabel || subject || '');
}

function result(id, from, text) {
  const t = typeById(id);
  return { id: t.id, label: t.label, routine: t.routine === true, from, text };
}

/** Rows per type, every type present in the vocabulary even at zero, in vocabulary order. */
export function countTypes(rows = [], keep = null, typeOf = announcementTypeOf) {
  const counts = new Map(ANNOUNCEMENT_TYPES.map((t) => [t.id, 0]));
  for (const row of rows) {
    if (keep && !keep(row)) continue;
    const id = typeOf(row).id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// THE READER'S SELECTION, REMEMBERED ON THIS DEVICE.
//
// What is stored is the set of types switched OFF, not the set switched on: a type added to the
// vocabulary later then appears switched on rather than silently hidden by a stale saved list. An
// empty stored set is a real choice ("show everything, routine included") and is kept apart from
// "never chose", which gets the default.
// ---------------------------------------------------------------------------------------------

export const HIDDEN_TYPES_KEY = 'sattva:announcement-types:v1';
export const DEFAULT_HIDDEN_TYPES = Object.freeze(ANNOUNCEMENT_TYPES.filter((t) => t.routine).map((t) => t.id));

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** @returns {Set<string>} the hidden type ids — the saved choice, or the default where none was saved. */
export function loadHiddenTypes(store = storage()) {
  try {
    const raw = store?.getItem(HIDDEN_TYPES_KEY);
    if (!raw) return new Set(DEFAULT_HIDDEN_TYPES);
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.hidden)) return new Set(DEFAULT_HIDDEN_TYPES);
    return new Set(parsed.hidden.filter((id) => BY_ID.has(id)));
  } catch {
    return new Set(DEFAULT_HIDDEN_TYPES);
  }
}

/** Persist the hidden set; a failure (private window, full quota) keeps the session's choice working. */
export function saveHiddenTypes(hidden, store = storage()) {
  const list = [...hidden].filter((id) => BY_ID.has(id));
  try { store?.setItem(HIDDEN_TYPES_KEY, JSON.stringify({ hidden: list })); } catch { /* session-only */ }
  return list;
}

export const isDefaultSelection = (hidden) =>
  hidden.size === DEFAULT_HIDDEN_TYPES.length && DEFAULT_HIDDEN_TYPES.every((id) => hidden.has(id));
