// data/news-keywords.js — THE TRACKED-KEYWORD VOCABULARY, AND THE ONLY DEFINITION OF IT.
//
// Thirty keywords, supplied by the desk, that say what a story has to be ABOUT before it is worth
// a reader's attention. They are the answer to a measured problem rather than a wish: the shipped
// company-news capture holds 11,060 stories across 559 companies, and the search that produced them
// is a name match, so a company called iDream Film collects Bollywood reunion coverage and a company
// called GOCL collects "stock on fire". Filtering that capture by these keywords leaves 2,889 rows —
// a 74% cut — and every one of the thirty fires at least twice on the shipped data, so no entry in
// the vocabulary is dead weight.
//
// ONE DEFINITION, imported by the News tab, the market-wide news list and the General Alerts
// collectors. The same rule `stockscans-shared.js` and `finology-shared.js` follow: two copies of a
// vocabulary are two things that can disagree about what "Order" means.
//
// ---------------------------------------------------------------------------------------
// WHAT THIS IS, AND THE FOUR THINGS IT IS NOT
//
// 1. IT IS A TOPIC READING, NEVER A SENTIMENT ONE. `tabs/news.js` says in its own header that this
//    tab carries no sentiment and no ranking of ours, because scoring somebody else's reporting
//    puts our judgement beside their words. That rule is intact and this does not bend it: a
//    keyword says what a story is ABOUT. "Lawsuit" is a topic and a company can be the plaintiff;
//    "Approval" is a topic and the approval can be somebody else's. So every company-news event
//    stays DIRECTIONALLY NEUTRAL in General Alerts, exactly as it was, and what a match changes is
//    IMPORTANCE — is this worth surfacing — which is precisely what the desk's list encodes.
//
// 2. A MATCH IS A WORD IN A HEADLINE, NOT A VERIFIED EVENT. Everything written to a reason string
//    says "matched the tracked keyword X", never "the company won an order". The distance between
//    those two sentences is the whole honesty of this file.
//
// 3. THE DESK'S WORDS ARE REPRODUCED, THE PATTERNS ARE OURS AND ARE NARROWER. `label` is the term
//    as it was given and is what every surface prints; `test` is what actually matches, and several
//    are deliberately tighter than the bare word because the bare word does not survive contact with
//    a news feed. Measured on the shipped capture:
//      • `\btrials?\b` matched 26 stories, of which the majority were "free trial" boilerplate and
//        one was an album release. Requiring clinical or courtroom context leaves 7.
//      • `\bfire\b` matched 20, of which "Eureka Forbes Under Fire", "GOCL stock on fire" and a
//        wrestling billing were typical. Requiring an industrial-incident context leaves 1, and it
//        is a real factory fire.
//      • `\bquits?\b` under Resignation matched "quit California"; it is gone, and resign / steps
//        down carry the keyword on their own.
//    Every such narrowing is recorded in that keyword's `note`, which the UI shows, so a reader can
//    always see where our pattern is not the plain English word.
//
// 4. IT DOES NOT CHANGE WHAT IS FETCHED, AND THE ARITHMETIC IS WHY. Read literally, "company name +
//    keyword" is a search per company per keyword: 559 companies × 30 keywords is 16,770 requests
//    against an upstream capped near sixty a minute — four and a half hours for one pass, on a feed
//    the scrape already covers in one request per company. This is the same trap CLAUDE.md names
//    under *Ask the axis the data is published on*, arrived at from the other side: there is no
//    cheaper axis for a search endpoint, so the honest move is to spend nothing extra and classify
//    the capture we already pay for. The upstream already searched by company NAME, so every row is
//    a company-name hit; this file supplies the "+ keyword" half.
//
// ---------------------------------------------------------------------------------------
// `namesCompany` — THE OTHER HALF OF "COMPANY NAME + KEYWORD", OFFERED AND NEVER IMPOSED
//
// A row is filed under the company we searched for, which is not the same as a story that is about
// it: the search is a name match and names collide. So `namesCompany(row)` asks whether a
// distinctive word from the search term survives in the headline or standfirst.
//
// It is a HEURISTIC AND IT IS TREATED AS ONE. It reads `false` for a story that refers to a company
// by a brand the search term does not contain — GOCL Corporation trading as Gulf Oil is the case in
// the shipped data — so using it to drop rows silently would be discarding real coverage on a guess.
// Measured, it would drop 332 of the 3,221 keyword matches. It is therefore:
//   • RETURNED AS A SIGNAL the row can display, never applied behind the reader's back;
//   • OFFERED AS ITS OWN, LABELLED FILTER OPTION, so the strict reading is one click away;
//   • `null` — not `false` — where the row carries no search term to check against, because "we
//     cannot tell" and "it does not" are different answers and only one of them is a measurement.

/** The families the thirty keywords sort into, in the order the filter offers them. */
export const GROUPS = [
  { id: 'growth', label: 'Growth & operations' },
  { id: 'deals', label: 'Deals & structure' },
  { id: 'regulatory', label: 'Regulatory & IP' },
  { id: 'results', label: 'Results' },
  { id: 'capital', label: 'Capital raising' },
  { id: 'risk', label: 'Risk & governance' },
];

const GROUP_LABEL = new Map(GROUPS.map((g) => [g.id, g.label]));

/**
 * The thirty tracked keywords, in the order the desk supplied them.
 *
 * `label` is theirs and is what every surface prints. `test` is the pattern actually applied, and a
 * `note` is present wherever that pattern is narrower or wider than the plain word — see rule 3 in
 * the header. Patterns are non-global on purpose: a `/g` regex carries `lastIndex` between calls and
 * would match every other row.
 */
export const KEYWORDS = [
  {
    id: 'capacity-expansion',
    label: 'Capacity Expansion',
    group: 'growth',
    test: /\bcapacity\s+(?:expansion|addition|augmentation|enhancement|increase)\b|\bexpand(?:s|ing|ed)?\s+(?:its\s+)?(?:\w+\s+){0,2}?capacity\b|\bbrownfield\b|\bgreenfield\b|\bdebottleneck\w*\b|\bnew (?:plant|facility|unit|line)\b/,
    note: 'Also counts the words a capacity announcement is usually written in — brownfield, greenfield, debottlenecking, a new plant or line.',
  },
  { id: 'capex', label: 'Capex', group: 'growth', test: /\bcapex\b|\bcapital expenditure\b|\bcapital outlay\b/ },
  {
    id: 'order',
    label: 'Order',
    group: 'growth',
    // THE GAP BETWEEN THE VERB AND THE NOUN IS CHARACTERS, NOT WORDS, and that is not a stylistic
    // choice. It was `(?:\w+\s+){0,3}?` and `\w` excludes the hyphen, so "bags Rs 135-crore order"
    // — the single commonest way an Indian order win is headlined — did not match, while the
    // wordier "wins a large export order" did. A pattern that fails on the house style of the thing
    // it is looking for reads as a quiet feed.
    //
    // The lookbehind is the other half: a bare "order" is also how adjudication, court and
    // regulator notices are titled, which is the same trap `announcementSignal` names.
    test: /\b(?:order|contract)s?\s+(?:worth|valued|of|for|from)\b|\b(?:(?:bags?|bagged|bagging|wins?|won|winning|secures?|secured|securing|receives?|received|receiving|lands|landed|gets|got)\b|(?:rs\.?|₹|inr)\s?[\d,.]+)[^.!?]{0,40}?\b(?<!\b(?:court|interim|adjudicat\w{0,3}|final|sebi|tribunal|nclt|restraining|stay|penalty in a?|against the)\s)(?:order|contract)s?\b|\b(?:order|contract)s?\s+(?:win|wins|award\w*|inflow\w*)\b|\bletter of (?:intent|award)\b|\bloa\b/,
    note: 'The bare word is not enough: "in order to" is not business won, and a court, interim or SEBI order is a different event that shares the word. A commercial verb or a stated value has to sit beside it.',
  },
  { id: 'orderbook', label: 'Orderbook', group: 'growth', test: /\border[\s-]?book\b|\border\s+backlog\b|\bunexecuted order\w*\b/ },
  {
    id: 'receipt-of-order',
    label: 'Receipt of Order',
    group: 'growth',
    test: /\breceipt of\s+(?:\w+\s+){0,3}?(?:order|contract|work order|purchase order|letter of intent)s?\b/,
    note: "The exchange's own filing phrase, kept as its own keyword because a filing titled this way is a stronger claim than a headline that merely mentions an order.",
  },
  {
    id: 'product-launch',
    label: 'Product launch',
    group: 'growth',
    test: /\bproduct launch\b|\bnew product\b|\b(?:launch(?:es|ed|ing)?|unveil(?:s|ed|ing)?|introduc(?:es|ed)|roll(?:s|ed)\s+out)\b(?=[^.]{0,60}\b(?:product|brand|range|platform|service|model|variant|drug|app|offering|portfolio|vehicle|line|solution)\b)/,
    note: 'A launch verb only counts when a product noun follows it within the same sentence — otherwise every launched investigation and launched IPO is a product.',
  },
  {
    id: 'commissioning',
    label: 'Commissioning',
    group: 'growth',
    test: /\bcommission(?:s|ed|ing)\b|\bcommencement of (?:the )?(?:commercial )?(?:production|operations)\b|\bcommences? (?:commercial )?(?:production|operations)\b/,
  },
  { id: 'joint-venture', label: 'Joint Venture', group: 'growth', test: /\bjoint ventures?\b|\bjv\b/ },
  {
    id: 'partnership',
    label: 'Partnership',
    group: 'growth',
    test: /\bpartnership\b|\bpartners with\b|\bstrategic (?:alliance|partnership|tie[\s-]?up)\b|\btie[\s-]?up with\b|\bmou\b|\bmemorandum of understanding\b/,
    note: 'Includes the MoU and tie-up wording an Indian partnership release is usually written in.',
  },
  {
    id: 'stake-sale',
    label: 'Stake sale',
    group: 'deals',
    test: /\bstake sale\b|\bsells?\s+(?:its\s+)?(?:\w+\s+){0,3}?stake\b|\bsold\s+(?:its\s+)?(?:\w+\s+){0,3}?stake\b|\bpares? (?:its )?stake\b|\bdivest(?:s|ed|ment|iture)?\b|\boffer for sale\b|\bblock deal\b/,
  },
  { id: 'merger', label: 'Merger', group: 'deals', test: /\bmergers?\b|\bmerg(?:es|ed|ing)\b|\bamalgamation\b|\bscheme of arrangement\b|\bdemerger\b/ },
  { id: 'acquisition', label: 'Acquisition', group: 'deals', test: /\bacqui(?:res?|red|ring|sitions?)\b|\btakeover\b|\bbuys?\s+(?:out|stake)\b|\bcontrolling stake\b|\bopen offer\b/ },
  { id: 'patent', label: 'Patent', group: 'regulatory', test: /\bpatents?\b|\bpatented\b/ },
  {
    id: 'approval',
    label: 'Approval',
    group: 'regulatory',
    test: /\bapprov(?:al|als|ed|es|ing)\b|\bregulatory nod\b|\bgets? (?:the )?nod\b|\bclearance\b|\blicen[cs]e granted\b/,
    note: 'The commonest match by far, and deliberately broad: a board approval, a CCI clearance and a drug approval are all things this desk tracks.',
  },
  {
    id: 'trial',
    label: 'Trial',
    group: 'regulatory',
    test: /\b(?:clinical|phase\s*(?:i{1,3}|1|2|3)|human|pivotal|bioequivalence|bioavailability)[\s-]*trials?\b|\btrials?\s+(?:data|results?|success\w*|failure|begins?|start\w*)\b|\bstands? trial\b|\bfaces? trial\b|\bgoes? on trial\b|\btrial court\b/,
    note: 'Context is required. The bare word matched 26 stories on the shipped capture and most were "free trial" boilerplate; clinical and courtroom context leaves 7.',
  },
  {
    id: 'earnings',
    label: 'Earnings',
    group: 'results',
    test: /\bearnings\b|\bquarterly results\b|\bq[1-4]\s?fy\s?\d{2}\b|\bnet profit\b|\bprofit\s+(?:rose|fell|jump\w*|declin\w*|surge\w*|drop\w*|slump\w*)\b|\bresults?\s+(?:beat|miss(?:es|ed)?)\b/,
    note: 'A bare "results" is not included — election results and match results are not this. The quarter tag, the profit line and the beat/miss wording are.',
  },
  { id: 'qip', label: 'QIP', group: 'capital', test: /\bqip\b/ },
  { id: 'qualified-institutional-placement', label: 'Qualified Institutional Placement', group: 'capital', test: /\bqualified institution(?:s|al)?\s+placement\b/ },
  { id: 'preferential-issue', label: 'Preferential Issue', group: 'capital', test: /\bpreferential\s+(?:issue|allotment)\b/ },
  { id: 'rights-issue', label: 'Rights Issue', group: 'capital', test: /\brights issue\b/ },
  { id: 'buyback', label: 'Buyback', group: 'capital', test: /\bbuy[\s-]?backs?\b/ },
  { id: 'corporate-governance', label: 'Corporate Governance', group: 'risk', test: /\bcorporate governance\b|\bgovernance\s+(?:concern|issue|lapse|failure|red flag)\w*\b/ },
  { id: 'fraud', label: 'Fraud', group: 'risk', test: /\bfraud\w*\b|\bembezzl\w*\b|\bmisappropriat\w*\b|\bforger(?:y|ies)\b|\bscam\b|\bsiphon\w*\b/ },
  { id: 'lawsuit', label: 'Lawsuit', group: 'risk', test: /\blawsuits?\b|\bsues?\b|\bsued\b|\blitigation\b|\blegal action\b|\bclass action\b|\barbitration\b/ },
  {
    id: 'resignation',
    label: 'Resignation',
    group: 'risk',
    test: /\bresign(?:s|ed|ation|ations)\b|\bsteps? down\b|\bstepped down\b/,
    note: 'A bare "quits" is excluded — it matched a story about a company quitting California.',
  },
  {
    id: 'investigation',
    label: 'Investigation',
    group: 'risk',
    test: /\binvestigat\w*\b|\bprob(?:e|es|ed|ing)\b|\braid(?:s|ed)?\b|\bsummons\b|\bshow[\s-]?cause\b|\bsearch(?:es)?\s+(?:by|conducted)\b/,
  },
  {
    id: 'fire',
    label: 'Fire',
    group: 'risk',
    test: /\bfire\s+(?:broke out|breaks out|incident|accident|safety|at\s+(?:its|the|a)\b)|\b(?:factory|plant|warehouse|unit|godown|refinery|mill|depot)\s+fire\b|\bmajor fire\b|\bblaze\b|\bfire\s+(?:damage|destroy)\w*\b|\bgutted\s+(?:by|in)\s+(?:a\s+)?fire\b/,
    note: 'Industrial context is required. The bare word matched "under fire", "stock on fire" and a wrestling billing; this leaves the one real factory fire in the capture.',
  },
  { id: 'accident', label: 'Accident', group: 'risk', test: /\baccident\w*\b|\bmishap\b|\bexplosion\b|\bcasualt(?:y|ies)\b/ },
  {
    id: 'default',
    label: 'Default',
    group: 'risk',
    test: /\bdefault(?:s|ed|ing)?\b|\binsolvenc\w*\b|\bnclt\b|\bnclat\b|\bbankrupt\w*\b|\bwinding[\s-]?up\b|\bliquidation\b/,
    note: 'Includes the tribunal and insolvency wording an Indian default is reported under.',
  },
  { id: 'downgrade', label: 'Downgrade', group: 'risk', test: /\bdowngrad(?:e|es|ed|ing)\b|\brating cut\b|\bcuts? (?:the )?rating\b/ },
];

const BY_ID = new Map(KEYWORDS.map((k) => [k.id, k]));

/** The keyword the desk knows by this word, or null. */
export const keywordById = (id) => BY_ID.get(String(id || '')) || null;

/** The group's reader-facing name, or the id if it is not one of ours. */
export const groupLabel = (id) => GROUP_LABEL.get(String(id || '')) || String(id || '');

/** Lower-cased, curly quotes flattened, whitespace collapsed. Patterns are written against this. */
function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ');
}

/**
 * Every tracked keyword the text carries, in the desk's own order.
 *
 * `where` records whether the match was in the headline or only in the standfirst, because those
 * are different strengths of evidence and the caller may want to say so — a headline is what the
 * publisher chose to lead with, a standfirst is a paragraph that happened to mention the word.
 */
export function matchKeywords(title, summary = '') {
  const head = normalise(title);
  const body = normalise(summary);
  const both = body ? `${head} ${body}` : head;
  const hits = [];
  for (const k of KEYWORDS) {
    if (!k.test.test(both)) continue;
    hits.push({ id: k.id, label: k.label, group: k.group, note: k.note || null, where: k.test.test(head) ? 'title' : 'summary' });
  }
  return hits;
}

// Words that carry no identity: every second Indian company name contains one, so a story matching
// only on these has told us nothing about whether it is the right company.
const NAME_STOPWORDS = new Set([
  'ltd', 'ltds', 'limited', 'india', 'indian', 'industries', 'industry', 'company', 'companies',
  'corporation', 'corp', 'private', 'pvt', 'enterprises', 'enterprise', 'group', 'holding',
  'holdings', 'international', 'technologies', 'technology', 'systems', 'services', 'service',
  'products', 'product', 'solutions', 'projects', 'infra', 'infrastructure', 'finance', 'financial',
  'capital', 'bank', 'banks', 'global', 'national', 'auto', 'motors', 'steel', 'power', 'energy',
  'chemicals', 'pharma', 'pharmaceuticals', 'labs', 'laboratories', 'engineering', 'exports',
  'mills', 'and', 'the', 'new', 'film', 'films', 'media',
]);

/** The distinctive words in a search term — what a story would have to carry to be about it. */
export function identifyingWords(query) {
  return normalise(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !NAME_STOPWORDS.has(w));
}

/**
 * Does this story actually name the company it is filed under?
 *
 * `null` where the row carries no search term to check against, or where the term is nothing but
 * stopwords — "we cannot tell" is a different answer from "it does not", and only one of them is a
 * measurement. See the header: this is a signal, never a silent exclusion.
 */
export function namesCompany(row = {}) {
  // An archived row may have arrived under several reviewed searches. Treat a brand/former-name
  // mention as valid attribution even when the first observation used the legal name; the full
  // `matchedQueries` list is evidence from collection, not a fuzzy alias inferred here.
  const queries = Array.isArray(row.matchedQueries) && row.matchedQueries.length
    ? row.matchedQueries
    : [row.query || row.company || ''];
  const words = [...new Set(queries.flatMap(identifyingWords))];
  if (!words.length) return null;
  const text = normalise(`${row.title || ''} ${row.summary || ''}`);
  return words.some((w) => text.includes(w));
}

/**
 * One story's whole reading: which keywords, which groups, and whether it names its company.
 *
 * `tracked` is the plain answer to "is this one of the thirty things we watch". `targeted` is the
 * strict reading of "company name + keyword" — tracked AND the story names the company — with a
 * `null` from `namesCompany` counting as tracked, because an unverifiable name is not a failed one.
 */
export function classifyStory(row = {}) {
  const keywords = matchKeywords(row.title, row.summary);
  const named = namesCompany(row);
  return {
    keywords,
    ids: keywords.map((k) => k.id),
    labels: keywords.map((k) => k.label),
    groups: [...new Set(keywords.map((k) => k.group))],
    inTitle: keywords.some((k) => k.where === 'title'),
    namesCompany: named,
    tracked: keywords.length > 0,
    targeted: keywords.length > 0 && named !== false,
  };
}

// ---------------------------------------------------------------------------------------
// The filter, shared by the two news surfaces
// ---------------------------------------------------------------------------------------

export const FILTER_ALL = 'all';
export const FILTER_TRACKED = 'tracked';
export const FILTER_TARGETED = 'targeted';
export const FILTER_UNTRACKED = 'untracked';

/**
 * The Topic dropdown's options: everything, the two tracked readings, each family, then each of the
 * thirty by name, and finally the stories none of them matched.
 *
 * THE LAST OPTION IS NOT DECORATION. A filter that can only ever narrow to what it recognises can
 * never be checked: the reader has no way to see what it threw away, and a pattern that is silently
 * too narrow looks exactly like a quiet feed. "No tracked keyword" is how a miss gets found.
 *
 * @param {(value: string) => number|null} [count] optional per-option row count, appended in brackets.
 */
export function topicFilterOptions(count = null) {
  const label = (value, text) => {
    const n = count ? count(value) : null;
    return { value, label: n == null ? text : `${text} (${n})` };
  };
  const options = [
    label(FILTER_ALL, 'All topics'),
    label(FILTER_TRACKED, 'Any tracked keyword'),
    label(FILTER_TARGETED, 'Tracked keyword · names the company'),
  ];
  for (const g of GROUPS) options.push(label(`group:${g.id}`, `— ${g.label}`));
  for (const k of KEYWORDS) options.push(label(`kw:${k.id}`, `· ${k.label}`));
  options.push(label(FILTER_UNTRACKED, 'No tracked keyword'));
  return options;
}

/**
 * Does this reading pass the selected Topic option?
 *
 * Takes a `classifyStory()` result rather than a row, so a caller that classifies once per paint
 * does not re-run thirty regexes per row per keystroke.
 */
export function matchesTopic(reading, value) {
  if (!value || value === FILTER_ALL) return true;
  if (!reading) return false;
  if (value === FILTER_TRACKED) return reading.tracked;
  if (value === FILTER_TARGETED) return reading.targeted;
  if (value === FILTER_UNTRACKED) return !reading.tracked;
  if (value.startsWith('group:')) return reading.groups.includes(value.slice(6));
  if (value.startsWith('kw:')) return reading.ids.includes(value.slice(3));
  return true;
}

/** The reader-facing name of a Topic value, for a modal or an export banner. */
export function topicLabel(value) {
  if (!value || value === FILTER_ALL) return 'All topics';
  if (value === FILTER_TRACKED) return 'Any tracked keyword';
  if (value === FILTER_TARGETED) return 'Tracked keyword, and the story names the company';
  if (value === FILTER_UNTRACKED) return 'No tracked keyword matched';
  if (value.startsWith('group:')) return groupLabel(value.slice(6));
  if (value.startsWith('kw:')) return keywordById(value.slice(3))?.label || value;
  return value;
}
