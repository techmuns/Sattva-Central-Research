// data/kpi-impact.js — WHICH OF A COMPANY'S OWN SECTOR KPIs AN ALERT'S EVIDENCE COULD MOVE.
//
// An AI Alerts card says what happened, and each evidence row says which of the desk's three
// questions it bears on (alert-drivers.js). The desk's next question is narrower and more useful:
// WHICH LINE OF THE MODEL moves. An order win moves Order Inflow and the Order Book for a capital-goods company, Deal
// Wins for an IT company, and nothing a bank reports; a QIP moves a bank's Capital Adequacy Ratio
// and a manufacturer's EPS. The sector decides, and `public/data/sector-kpis.json` — the ontology the
// desk supplied (scripts/fixtures/sector-kpi-ontology.yaml) with every classified company resolved
// into it — is what knows the sector.
//
// DETERMINISTIC AND FREE. No model call, no request per card: a fixed table of TRIGGERS (what kind of
// item this event is) crossed with the company's KPI GROUP (which KPIs its sector reports), read off
// fields the collectors already wrote. The whole cost is one ~20 KB (gzipped) file, loaded once.
//
// ---------------------------------------------------------------------------------------
// SIX RULES, AND THEY ARE THE REASON THE LINE IS ALLOWED ON A CARD AT ALL
//
// 1. A KPI IS NAMED ONLY FROM THE COMPANY'S OWN SECTOR LIST. Every KPI a rule can return is in the
//    ontology's list for that company's group, or is one of its global KPIs; `scripts/verify-kpi-
//    impact.mjs` asserts it for every rule, and the engine drops anything else at run time. A bank
//    can never be told an order moved its Order Book, because banks do not carry one.
// 2. NO SECTOR, NO LINE. A company the classification does not resolve gets nothing — never a
//    nearest sector's KPIs. The same for a feed with no topic (the tape, fund books, insider rows,
//    chatter), for market-wide news, for a related-entity report and for unconfirmed news.
// 3. THE TRIGGER MUST BE THE COMPANY'S OWN ITEM. The cheap readings of a keyword are the traps, and
//    each is measured on the shipped captures: 146 filings carry the word "acquisition" and almost
//    all are SEBI takeover-regulation SHAREHOLDING disclosures ("Substantial Acquisition of
//    Shares"), not a business being bought; "downgrade" in the news is mostly a broker cutting a
//    stock rating, not a credit agency; "commissioning" in an EPC headline is the customer's plant
//    in the scope of an order; a fire at the corporate office stops no production; a "digital capex
//    programme" builds no capacity. Each trigger below states its own exclusions.
// 4. OPERATOR KPIs NEED THE OPERATOR'S ASSET IN THE TEXT. NSE files telecom-equipment makers under
//    telecom and a visa-services company under travel, so their groups carry an operator's KPIs
//    (ARPU, room keys). A group rule that names an operating KPI therefore `requires` the asset —
//    rooms, beds, MW, a refinery — in the event's own words, or it names nothing.
// 5. A MENTION IS A MENTION. Where the source's own words name a KPI — a con-call highlight
//    "Cost-to-income 42.3% → 38.4%", a business update — the KPI is matched through the ontology's
//    own aliases, restricted to the company's group, with short acronyms required in capitals and a
//    stated list of words too generic to count ("sales", "volume", "yield", "tariff", "NAV").
// 6. NO DIRECTION AND NO FORECAST. The line says which KPIs are IN PLAY, with the trigger and the
//    mechanism in the tooltip. A FILED result's change is a measurement and travels as the source
//    reported it — sign changes in words, as everywhere else here — in the item's `value`, which the
//    card keeps to the chip's title because the result row already states it.
//
// It adds no score and no alert: a card is surfaced on its evidence (ai-alerts.js) and this only
// explains it, exactly as `alert-drivers.js` does. What it may change is how FAST a reader sees what
// matters, which is the product's only job.

import { revalidatedJson } from '../core/store.js';
import { isRelatedNewsContext, newsCanSupportAI } from './company-news-attribution.js';
import { isBrokerageResearch } from './portfolio-news-matching.js';
import { KEYWORDS } from './news-keywords.js';
import { ACQUISITION_COMPLETED, LEGAL_ORDER } from './filing-signals.js';

export const KPI_FILE = 'data/sector-kpis.json';
/** The most KPI chips one card DRAWS. The model keeps every KPI; the rest are a "+N" that names them. */
export const KPI_CHIP_LIMIT = 4;

// ---------------------------------------------------------------------------------------
// THE ONTOLOGY, LOADED AND KEPT CURRENT

let ontology = null;
let heldText = null;
let confirmedAt = 0;
let pending = null;
// WHAT THE LAST READ OF THE FILE CAME TO, kept apart from the ontology itself. A card with no KPI
// line means "nothing on it names a KPI" only while this says `ready`; after a failed read it means
// "the sector file could not be read", and the source registry and the AI Alerts page say which.
let readStatus = { state: 'idle', error: null, checkedAt: null, recheckError: null };

/**
 * How long a held copy counts as checked. The daily classification job publishes a new file while a
 * dashboard can stay open for days, so every AI Alerts check (on open, on Refresh, every 90 seconds
 * while visible) asks again once this has passed — one conditional GET, a 304 when nothing moved.
 */
export const RECHECK_MS = 60_000;

/** Validate and index a sector-kpis.json payload. Throws on a shape this module cannot read. */
export function indexOntology(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('sector-kpis: no payload');
  const { kpis, groups, companies, globals } = payload;
  if (!kpis || typeof kpis !== 'object' || !groups || typeof groups !== 'object' || !companies || typeof companies !== 'object' || !Array.isArray(globals)) {
    throw new Error('sector-kpis: payload is missing kpis, groups, companies or globals');
  }
  const groupKpis = new Map();
  for (const [group, entry] of Object.entries(groups)) {
    if (!Array.isArray(entry?.kpis)) throw new Error(`sector-kpis: group ${group} has no KPI list`);
    groupKpis.set(group, new Set([...entry.kpis, ...globals]));
  }
  return { payload, kpis, groups, companies, globals: new Set(globals), groupKpis, mentionIndex: new Map() };
}

// A PAYLOAD WHOSE CONTENT DID NOT CHANGE KEEPS THE ONTOLOGY IT ALREADY HAS. The ranking is memoised
// on this object (ai-alerts.js), so replacing it with an identical copy on every check would re-rank
// every card for nothing; a changed file — a new holding, a corrected mapping — replaces it.
function adopt(payload) {
  const text = JSON.stringify(payload);
  if (!ontology || text !== heldText) { ontology = indexOntology(payload); heldText = text; }
  confirmedAt = Date.now();
  readStatus = { state: 'ready', error: null, checkedAt: new Date(confirmedAt).toISOString(), recheckError: null };
  return ontology;
}

/** Seed the module from a payload already in hand (tests, a bootstrap that loaded it). */
export function prime(payload) {
  if (!payload) { ontology = null; heldText = null; confirmedAt = 0; return null; }
  return adopt(payload);
}

/** The loaded ontology, or null until `load()` has resolved (or if the file could not be read). */
export const snapshot = () => ontology;

/**
 * `idle` (not asked for yet), `loading`, `ready` or `failed` — with the reason, when this browser
 * last confirmed the file, and `recheckError` when a later re-read failed while an earlier copy is
 * still in use. The classification's own gaps travel with it: companies whose latest page re-read
 * failed, and classified companies the ontology maps to no group. A copy of the object, so a caller
 * cannot edit the module's record of what happened.
 */
export const status = () => ({
  ...readStatus,
  builtAt: ontology?.payload?.source?.classificationCapturedAt || null,
  classificationFailed: ontology ? Number(ontology.payload?.counts?.classificationFailed) || 0 : null,
  unresolved: ontology ? Number(ontology.payload?.counts?.unresolved) || 0 : null,
});

/**
 * Read `sector-kpis.json`, and read it again once the held copy is older than `RECHECK_MS`. A first
 * read that fails resolves to null and is not cached, so a later call can try again; cards carry no
 * KPI line meanwhile, and `status()` says the file could not be read — a missing line must never
 * pass for "nothing here moves a KPI". A RE-READ that fails keeps the copy already held, which was a
 * real read of a real file, and records the failure beside it: a failed re-check is not a failed read.
 *
 * A RE-READ NEVER HOLDS UP A PAINT. With a copy in hand the call answers with it at once and the
 * re-read lands behind it — the ranking reads `snapshot()` when it runs, so the collection that
 * started the re-read ranks on its answer — because the saved AI Alerts view must not wait on the
 * network, least of all offline, where a request can hang until its own timeout. `wait: true` is for
 * a caller that has nothing to paint until the answer arrives (the tests).
 */
export function load({ wait = false } = {}) {
  if (ontology && Date.now() - confirmedAt < RECHECK_MS) return Promise.resolve(ontology);
  if (!pending) {
    const held = ontology;
    if (!held) readStatus = { ...readStatus, state: 'loading' };
    pending = revalidatedJson(KPI_FILE, { optional: true })
      .then((payload) => {
        if (!payload) throw new Error(held ? 'the sector file could not be re-read' : 'the sector file is not published on this deployment');
        return adopt(payload);
      })
      .catch((err) => {
        const error = String(err?.message || err || 'the sector file could not be read');
        if (held && ontology === held) {
          readStatus = { ...readStatus, state: 'ready', recheckError: error };
          return held;
        }
        readStatus = { state: 'failed', error, checkedAt: new Date().toISOString(), recheckError: null };
        return null;
      })
      .finally(() => { pending = null; });
  }
  return ontology && !wait ? Promise.resolve(ontology) : pending;
}

/** The company's resolved sector context, or null where the classification does not reach it. */
export function companyContext(onto, ticker) {
  if (!onto || !ticker) return null;
  const entry = onto.companies[String(ticker).toUpperCase()];
  if (!entry || !onto.groups[entry.group]) return null;
  return {
    ticker: String(ticker).toUpperCase(),
    group: entry.group,
    groupLabel: onto.groups[entry.group].label || entry.group,
    sector: entry.sector || null,
    industry: entry.industry || null,
  };
}

// ---------------------------------------------------------------------------------------
// READING ONE EVENT

// Only the feeds that carry a company's own statements or a filed measurement can move a KPI
// reading. The rest supply no item: a volume ratio or a fund's book says nothing about which line of
// the model moved, and inventing one would be this dashboard asserting why somebody traded.
const FAMILY = {
  announcements: 'filing',
  'nse-filings': 'filing',
  news: 'news',
  earnings: 'result',
  concalls: 'call',
};

const KEYWORD_ID_BY_LABEL = new Map(KEYWORDS.map((k) => [k.label.toLowerCase(), k.id]));

function keywordIdsOf(event) {
  const ids = new Set(Array.isArray(event.keywordIds) ? event.keywordIds : []);
  for (const label of Array.isArray(event.keywords) ? event.keywords : []) {
    const id = KEYWORD_ID_BY_LABEL.get(String(label).toLowerCase());
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Lower-cased and flattened, as every pattern below is written. `&` and `%` survive.
 *
 * THE PATTERNS STAY INSIDE ONE SENTENCE WITH `[^.]`, SO A PERIOD THAT ENDS NO SENTENCE IS REMOVED:
 * the decimal in "Rs 5.8 per unit" and the abbreviation in "Rs. 2,500 crore" and "Ltd." would
 * otherwise cut a clause in two, and an Indian filing writes both in nearly every line.
 */
const flat = (value) => String(value || '')
  .toLowerCase()
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[–—]/g, '-')
  .replace(/(\d)\.(?=\d)/g, '$1')
  .replace(/\b(rs|no|nos|ltd|pvt|co|inc|mr|ms|dr|st|approx|vs|viz|hon'ble|u\.s)\./g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

// A con-call highlight about what was NOT said is not a KPI in play.
const DISCLOSURE_GAP = /\b(?:undisclosed|not disclosed|withheld|not quantified|no guidance|unclear|not shared|disclosure declined|declined to (?:disclose|share|quantify|comment)|did not (?:disclose|share|quantify))\b/;

/** The event's text, in the words the SOURCE used — never a sentence this dashboard composed. */
function readingOf(event) {
  const family = FAMILY[event.feed];
  if (!family) return null;
  if (family === 'filing') {
    // The exchange's subject plus the detail the collector kept: BSE's category and sub-category
    // ("Award of Order / Receipt of Order"), or NSE's own description. The same text
    // `announcementSignal` read to decide the filing's importance.
    const raw = [event.headline, event.detail].filter(Boolean).join(' · ');
    return { family, raw, text: flat(raw) };
  }
  if (family === 'news') {
    // THE HEADLINE ONLY. A standfirst is where several publishers put a related-links strip, which
    // is why the materiality rule reads the headline too (news-keywords.js).
    return { family, raw: String(event.headline || ''), text: flat(event.headline) };
  }
  if (family === 'call') {
    const tags = (Array.isArray(event.tags) ? event.tags : []).map(String).filter((tag) => !DISCLOSURE_GAP.test(flat(tag)));
    return { family, raw: tags.join(' · '), text: flat(tags.join(' · ')), tags };
  }
  return { family, raw: '', text: '' };
}

/** Whether this event may contribute at all. */
function eligible(event) {
  if (!event || event.aiEligible === false || event.contextOnly || isRelatedNewsContext(event)) return false;
  const family = FAMILY[event.feed];
  if (!family) return false;
  // News carries a KPI reading only once BOTH halves of the desk's rule hold — the story names the
  // company and a tracked keyword is in the headline — which is what `importance: 'high'` means on
  // this feed. A trigger marked `anyNews` (a USFDA inspection outcome) needs only the first.
  if (family === 'news') return newsCanSupportAI(event);
  return true;
}

// ---------------------------------------------------------------------------------------
// THE TRIGGERS — WHAT KIND OF ITEM AN EVENT IS
//
// Each trigger has `detect(event, reading, ids)` → null or a hit `{ kind }`, a table of KPIs per
// group (a list, `{ kpis, requires }` where the operator's asset must be in the text, or a function
// of the text), and one short sentence of mechanism per kind for the tooltip. A group absent from a
// table falls to its `default`, and a table without a `default` names nothing for unlisted groups.

const NONE = [];
const FINANCIALS = { banks: NONE, nbfc: NONE, insurance: NONE, capital_markets: NONE, investment_vehicles: NONE };

// The same regulator words `announcementSignal` would never confuse with a stock exchange.
const US_DRUG_REGULATOR = /\b(?:us\s?fda|usfda|u\.?\s?s\.?\s?fda|fda|anda)\b/;
const INDIA_DRUG_REGULATOR = /\b(?:dcgi|cdsco|drugs? controller)\b/;
const OTHER_DRUG_REGULATOR = /\b(?:ema|mhra|tga|anvisa|health canada|pmda|sahpra|who[- ]?gmp|eu[- ]?gmp|who prequalification)\b/;
const US_MARKET = /\b(?:us|usa|u\.s\.?|united states|american|north america)\b|\busfda\b/;
const INDIA_MARKET = /\b(?:india|indian|domestic)\b/;

// Words that make a capacity or commissioning phrase the SCOPE OF AN ORDER rather than the company's
// own plant: "order for supply, erection and commissioning of a 660 MW unit".
const ORDER_SCOPE = /\b(?:supply|erection|installation|design|engineering|epc|execution)\b[^.]{0,60}\bcommission\w*/;
// A project the company builds or advises on for somebody else: "EIL to execute Dangote's greenfield
// refinery". Its capacity words describe the client's plant, so no capacity KPI of ours is in play.
// (An order WIN is caught earlier by the order triggers, which suppress this one; "wins environmental
// clearance for the expansion" is the company's own capacity and must still read as it.)
const CLIENT_PROJECT = /\b(?:to execute|execution of|epc|pmc|project management consultan\w*|consultancy|for (?:the )?(?:client|customer)|on behalf of|letter of (?:award|intent))\b/;
const PLANT = /\b(?:plant|factory|unit|facility|refinery|mill|works|warehouse|mine|smelter|kiln|furnace|boiler|reactor|godown|operations|production|manufacturing)\b/;
// WHERE OUTPUT IS MADE. A fire, an accident or an explosion names an output KPI only at one of these:
// "Fire breaks out at Jyothy Labs corporate office" is an incident, not a lost day of production,
// and a warehouse or godown fire destroys stock rather than capacity. PLANT above stays wider,
// because a suspension of "operations" does stop output wherever it happens.
const PRODUCTION_SITE = /\b(?:plant|factory|unit|facility|refinery|mill|works|mine|smelter|kiln|furnace|boiler|reactor|production|manufacturing)\b/;
// WHAT A CAPEX FIGURE HAS TO BE FOR before it names volumes and utilisation: capacity, a site where
// output is made, or a unit of that output. A plan with none of these is spend and nothing more.
const CAPACITY_WORDS = /\b(?:capacit\w*|plants?|factor(?:y|ies)|facilit(?:y|ies)|greenfield|brownfield|debottleneck\w*|mw|gw|mtpa|tpa|klpd|tpd|tonnes?|furnaces?|kilns?|mills?|refiner(?:y|ies)|smelters?|terminals?|beds?|hospitals?|rooms?|stores?|warehouses?|production|manufacturing)\b/;
const NOT_A_SITE_INCIDENT = /\b(?:office|headquarters|head office|showroom|store|shop|mall|residence|residential|house|vehicle|truck|bus|car|tanker|train|ship|vessel|godown|warehouse)\b/;
const NOT_A_PLANT_EVENT = /\bsuspension of trading\b|\btrading (?:in (?:the )?(?:shares|securities) )?(?:is |was |has been )?suspended\b|\bsuspended from trading\b|\btrading (?:window|halt)\b|\bsuspension of (?:the )?(?:director|employee|official|officer|ceo|md|cfo|auditor|kmp|registration)\b|\brevocation of suspension\b|\bbook closure\b|\bstrike price\b/;

// An "order" a court, a tax officer or a regulator passes is not business won, and Indian companies
// disclose those under the same words — "Receipt of order from the Income Tax Department". That test
// is `LEGAL_ORDER`, imported from the materiality rule (filing-signals.js), so the alert and its KPI
// line cannot disagree about which filings are orders. What makes an order COMMERCIAL is this: a
// value, or the words a supply or works contract is written in.
const COMMERCIAL_ORDER = /\b(?:supply|supplies|work order|purchase order|contract|epc|project|tender|loa|letter of (?:award|intent|acceptance)|worth|valued|rs\.?|inr|crores?|cr|lakhs?|million|mn|billion|bn|usd)\b|₹|\$|\baward of order\b/;

const ORDER_GROUPS = {
  capital_goods: ['order_inflow', 'order_book', 'book_to_bill'],
  infrastructure: ['order_inflow_infra', 'order_book_infra', 'order_book_to_sales'],
  aerospace_defense: ['order_inflow_defense', 'order_book_defense', 'book_to_bill_defense'],
  it_services: ['deal_wins'],
  business_services: ['revenue_backlog'],
  hardware: ['order_book_hardware'],
  textiles: ['order_book_textiles'],
  semiconductors: ['book_to_bill_semiconductors'],
  reit: NONE,
  ...FINANCIALS,
  default: ['revenue'],
};

const OPERATING_GROUPS = {
  cement: ['volume_cement', 'capacity_utilization'],
  chemicals: ['volumes_chemicals', 'capacity_utilization'],
  metals: { kpis: ['production_volume_metals', 'sales_volume_metals'], requires: /\b(?:plant|smelter|furnace|mill|capacity|tpa|mtpa|ktpa|tonnes?|production|unit|line)\b/ },
  mining: { kpis: ['production_volume_mining', 'sales_volume_mining'], requires: /\b(?:mine|mines|mining|coal|ore|block|washery|capacity|mtpa|production)\b/ },
  paper: ['production_volume_paper', 'capacity_utilization_paper'],
  packaging: ['volume_packaging', 'capacity_utilization_packaging'],
  textiles: ['volume_textiles', 'capacity_utilization_textiles'],
  auto: ['volumes_auto'],
  auto_components: ['volume_auto_components', 'capacity_utilization_auto_components'],
  consumer_durables: ['volume_durables', 'capacity_utilization_durables'],
  consumer_staples: ['volume_growth'],
  power: { kpis: ['installed_capacity', 'units_generated'], requires: /\b(?:mw|gw|mwp|mwac|mwh|plant|project|capacity|unit|station)\b/ },
  oil_gas: { kpis: ['throughput', 'refinery_utilization'], requires: /\brefiner(?:y|ies)\b/ },
  hospitals: { kpis: ['occupied_beds', 'occupancy_rate'], requires: /\b(?:beds?|hospitals?)\b/ },
  hotels: { kpis: ['room_keys', 'occupancy_rate_hotels'], requires: /\b(?:rooms?|keys|hotels?|resorts?)\b/ },
  logistics: { kpis: ['volumes_logistics'], requires: /\b(?:warehous\w*|terminals?|berths?|ports?|icds?|rakes?|vessels?|fleet|capacity|teu)\b/ },
  aviation: { kpis: ['ask'], requires: /\b(?:aircraft|planes?|fleet|capacity|routes?|flights?)\b/ },
  semiconductors: ['fab_utilization'],
  hardware: ['units_shipped'],
  medical_devices: ['units_sold_devices'],
  education: { kpis: ['student_enrollments'], requires: /\b(?:campus\w*|schools?|seats?|students?|capacity)\b/ },
};

const NETWORK_NOUN = {
  store: /\b(?:stores?|outlets?|showrooms?|boutiques?)\b/,
  restaurant: /\b(?:restaurants?|outlets?|stores?|cafes?|kitchens?)\b/,
  lab: /\b(?:labs?|laborator(?:y|ies)|diagnostic cent(?:re|er)s?|collection cent(?:re|er)s?|patient service cent(?:re|er)s?)\b/,
  hospital: /\b(?:hospitals?|beds)\b/,
  hotel: /\b(?:hotels?|resorts?|rooms|keys)\b/,
  campus: /\b(?:campus(?:es)?|schools?|colleges?)\b/,
};
const NETWORK_GROUPS = {
  retail: { kpis: ['store_count'], noun: 'store' },
  restaurants: { kpis: ['store_count_restaurants'], noun: 'restaurant' },
  diagnostics: { kpis: ['centre_count'], noun: 'lab' },
  hospitals: { kpis: ['occupied_beds'], noun: 'hospital' },
  hotels: { kpis: ['room_keys'], noun: 'hotel' },
  education: { kpis: ['campus_count'], noun: 'campus' },
  consumer_durables: { kpis: ['dealer_count'], noun: 'store' },
};
const NETWORK_VERB = /\b(?:open(?:s|ed|ing)?|launch(?:es|ed|ing)?|inaugurat\w*|add(?:s|ed|ing)?|commenc\w*|unveil\w*|signs?|signed)\b/;

const EQUITY_RAISE = /\bqualified institutions?\s+placement\b|\bqip\b|\bpreferential\s+(?:issue|allotment)\b|\brights issue\b|\bfurther public offer\b/;
const DEBT_ONLY = /\b(?:non[- ]convertible|ncds?|debentures?|bonds?|commercial paper)\b/;
const EMPLOYEE_STOCK = /\b(?:esops?|esos|esps|employee stock|stock options?|sweat equity)\b/;

const RATING_ACTION = /\b(?:upgrad\w*|downgrad\w*|outlook\s+(?:revised|changed|to\s+(?:positive|negative|stable|developing))|revised\s+(?:the\s+)?(?:rating|outlook)|(?:placed|kept)\s+(?:on|under)\s+(?:rating\s+)?watch|credit\s?watch|rating watch)\b/;
const CREDIT_CONTEXT = /\b(?:credit ratings?|crisil|icra|care\s?(?:ratings?|edge)|india ratings|ind-?ra|brickwork|acuite|acuité|infomerics|moody'?s|s&p|fitch|bank (?:loan )?facilities|long[- ]term rating|short[- ]term rating|issuer rating|ncds?|debentures?|commercial paper)\b/;
const STOCK_CALL = /\b(?:target price|price target|buy|sell|hold|outperform|underperform|overweight|underweight|neutral|equal[- ]weight)\b/;

const ACQUIRES = /\b(?:acquisition of|acquires?|acquired|acquiring|to acquire|completes? (?:the )?acquisition|completion of (?:the )?acquisition|share purchase agreement|business transfer agreement|takeover of)\b/;
// A takeover-regulation shareholding disclosure, a promoter buying the company's own shares, a new
// subsidiary, money put into one, land, and the company as the TARGET are none of them a business
// being bought.
const NOT_A_PURCHASE = /\b(?:regulation\s*(?:10|29|31)|reg\.?\s*(?:10|29|31)|open market|promoters?\b[^.]{0,40}\bacquir\w*|by\s+(?:the\s+)?promoters?|shares\s+of\s+the\s+company|incorporat\w*|conversion of|inter[- ]?(?:corporate|company) loan|further investment|capital infusion|infus\w+|subscri\w+\s+(?:to|of|in)\s+(?:the\s+)?(?:rights|equity|shares)|pledge|encumbrance|open offer|acquisition of (?:land|property|premises|office|plot)|acquired by|to be acquired|takeover by)\b/;
// SEBI's (Substantial Acquisition of Shares and Takeovers) Regulations are NAMED by an ownership
// disclosure, and also by a completed acquisition of a listed business made under them. The name
// alone refuses a purchase only when no acquisition completed — the exception the materiality rule
// makes (filing-signals.js) — so a card that keeps its Acquisition reading keeps its KPIs too.
const SAST_NAME = /\b(?:sast|substantial acquisition|takeovers?\)?\s+regulations)\b/;
const notAPurchase = (text) => NOT_A_PURCHASE.test(text) || (SAST_NAME.test(text) && !ACQUISITION_COMPLETED.test(text));
const DIVESTS = /\b(?:slump sale|hive[- ]?off|divest(?:s|ed|ing|ment|iture)?|sale of (?:its |the |entire )?(?:business|undertaking|division|unit|plant|brand|facility|(?:\d+(?:\.\d+)?%\s+)?(?:stake|shareholding|equity stake) in (?:its |the )?(?:subsidiary|associate|joint venture|jv|step[- ]down)))\b/;
const NOT_A_BUSINESS_SALE = /\b(?:promoters?|offer for sale|ofs|block deal|bulk deal|open market|pledge)\b/;

const OWN_DEFAULT = /\bdefault(?:ed)?\s+in\s+(?:the\s+)?(?:payment|repayment|servicing)\b|\bdelay(?:ed)?\s+in\s+(?:the\s+)?(?:payment|repayment|servicing)\s+of\s+(?:interest|principal)\b|\bnon[- ]?payment\s+of\s+(?:interest|principal)\b/;

const BUSINESS_UPDATE = /\b(?:business|operational|operating|quarterly|monthly|provisional)\s+(?:update|performance|numbers?|data|figures?|highlights)\b|\b(?:sales|production|dispatch(?:es)?|volumes?|traffic|cargo|premium|disbursements?|collections?|pre[- ]?sales|bookings)\s+(?:update|numbers?|figures?|data|performance)\b|\bmonthly\s+(?:sales|production|business|volumes?)\b|\b(?:auto|vehicle|tractor)\s+sales\b|\bsales for the month\b/;
const NOT_AN_UPDATE = /\b(?:trading window|newspaper|clarification|spurt|price movement|volume movement|movement in (?:the )?(?:price|volume))\b/;

const FDA_OUTCOME = /\b(?:warning letter|import alert|form[\s-]?483|483 observations?|establishment inspection report|official action indicated|voluntary action indicated|no action indicated|zero observations?|nil observations?)\b|\b(?:eir|oai|vai|nai)\b/;

/**
 * The trigger table, in the order the card reads them. `label` is the item as a reader would name
 * it; `why[kind]` is the mechanism, one sentence, printed in the chip's tooltip.
 */
export const TRIGGERS = [
  {
    id: 'order-loss',
    label: 'Order cancelled',
    detect: (e, r, ids) => {
      const cancelled = /\b(?:order|contract|loa|letter of award)s?\b[^.]{0,60}\b(?:cancel\w*|terminat\w*|short[- ]?clos\w*|foreclos\w*|withdrawn|revoked|scrapped)\b|\b(?:cancel\w*|terminat\w*|scrap\w*|revok\w*)\b[^.]{0,40}\b(?:order|contract|loa)s?\b|\blos(?:es|t)\b[^.]{0,30}\b(?:order|contract)s?\b/;
      if (!cancelled.test(r.text) || LEGAL_ORDER.test(r.text)) return null;
      if (r.family === 'filing' && e.filingRule !== 'contract cancellation or suspension' && !ids.has('order') && !ids.has('receipt-of-order')) return null;
      return { kind: 'default' };
    },
    groups: {
      capital_goods: ['order_book'], infrastructure: ['order_book_infra'], aerospace_defense: ['order_book_defense'],
      it_services: ['revenue_usd'], business_services: ['revenue_backlog'], hardware: ['order_book_hardware'],
      textiles: ['order_book_textiles'], semiconductors: ['book_to_bill_semiconductors'], reit: NONE, ...FINANCIALS,
      default: ['revenue'],
    },
    why: { default: 'A cancelled or terminated order comes out of the order book, and out of the revenue it would have become.' },
  },
  {
    id: 'order-win',
    label: 'Order win',
    detect: (e, r, ids, fired) => {
      if (fired.has('order-loss')) return null;
      // A court's, a tax officer's or an arbitrator's order shares the words — "arbitral award on the
      // contract awarded by NHAI" matches even the filing rule — so a legal text is never business won.
      if (LEGAL_ORDER.test(r.text)) return null;
      if (e.filingRule === 'order or contract award') return { kind: 'default' };
      if (!ids.has('receipt-of-order') && !ids.has('order')) return null;
      // A filing also has to read as commercial — a value, a supply or works contract — because the
      // exchange's "Receipt of Order" label alone does not.
      // A hotel management contract, a franchise or a lease is the network growing, not an order.
      if (/\b(?:management|operating|franchise|lease|leave and licen[cs]e)\s+(?:contract|agreement)s?\b/.test(r.text)) return null;
      if (r.family === 'filing' && !COMMERCIAL_ORDER.test(r.text)) return null;
      return { kind: 'default' };
    },
    groups: ORDER_GROUPS,
    why: {
      default: 'A new order adds to order inflow and the order book, and becomes revenue as it is executed.',
    },
  },
  {
    id: 'order-book',
    label: 'Order book',
    detect: (e, r, ids) => (ids.has('orderbook') ? { kind: 'default' } : null),
    groups: {
      capital_goods: ['order_book', 'book_to_bill'], infrastructure: ['order_book_infra', 'order_book_to_sales'],
      aerospace_defense: ['order_book_defense', 'book_to_bill_defense'], hardware: ['order_book_hardware'],
      textiles: ['order_book_textiles'], business_services: ['revenue_backlog'], semiconductors: ['book_to_bill_semiconductors'],
      reit: NONE, ...FINANCIALS, default: ['revenue'],
    },
    why: { default: 'The order book is revenue won but not yet booked.' },
  },
  {
    id: 'capacity',
    label: 'Capacity',
    detect: (e, r, ids, fired) => {
      // An order's scope is the CUSTOMER's plant: "order for erection and commissioning of…".
      if (fired.has('order-win') || fired.has('order-book') || ORDER_SCOPE.test(r.text) || CLIENT_PROJECT.test(r.text)) return null;
      const commissioned = e.filingRule === 'commercial production start' ||
        (ids.has('commissioning') && /\b(?:plant|unit|facility|line|capacity|mw|gw|mtpa|tpa|klpd|tpd|furnace|kiln|mill|refinery|terminal|warehouse|hospital|beds?|stores?)\b/.test(r.text));
      if (commissioned) return { kind: 'commissioned' };
      if (ids.has('capacity-expansion') || /\benvironment(?:al)? clearance\b|\bconsent to (?:establish|operate)\b/.test(r.text)) return { kind: 'planned' };
      // A CAPEX FIGURE IS SPEND, AND IT IS CAPACITY ONLY WHERE THE TEXT SAYS WHAT IT BUILDS. "Rs 100
      // crore digital capex programme" is money going out, not volumes coming in — maintenance,
      // compliance, IT and office capex add no tonne — so it names the Capex KPI alone.
      if (ids.has('capex')) return CAPACITY_WORDS.test(r.text) ? { kind: 'planned' } : { kind: 'spend' };
      return null;
    },
    groups: {
      ...OPERATING_GROUPS,
      // Project businesses commission their CUSTOMERS' plants; their own capacity is a plan at most.
      capital_goods: ['capacity_utilization_capital_goods'],
      ...FINANCIALS,
      default: NONE,
    },
    // Planned capacity is spend first; the capex KPI leads, then what the capacity is for. A lender or
    // an insurer "expanding capacity" is not building a plant, so the financial groups name nothing.
    // Bare capex keeps the lead and nothing after it: `only` refuses the group's operating KPIs.
    lead: { planned: { keys: ['capex'], except: Object.keys(FINANCIALS) }, spend: { keys: ['capex'], except: Object.keys(FINANCIALS) } },
    only: { commissioned: (group) => !['capital_goods', 'infrastructure', 'aerospace_defense'].includes(group), spend: () => false },
    labels: { spend: 'Capex plan' },
    why: {
      planned: 'New capacity is capex now, and volumes and utilisation once it runs.',
      commissioned: 'Capacity that starts production adds to volumes; utilisation dips while it ramps up.',
      spend: 'A capex plan is spend now; the text names no capacity it builds, so no volume KPI is claimed.',
    },
  },
  {
    id: 'network',
    label: 'Network expansion',
    detect: (e, r) => (NETWORK_VERB.test(r.text) && Object.values(NETWORK_NOUN).some((noun) => noun.test(r.text)) ? { kind: 'default' } : null),
    groups: Object.fromEntries(Object.entries(NETWORK_GROUPS).map(([group, { kpis, noun }]) => [group, {
      kpis,
      // The verb and the sector's own noun in one clause: "opens 12 new stores".
      test: (text) => new RegExp(`${NETWORK_VERB.source}[^.]{0,40}${NETWORK_NOUN[noun].source}`).test(text),
    }])),
    why: { default: 'New stores, centres or properties add to the network this sector is measured on.' },
  },
  {
    id: 'launch',
    label: 'Product launch',
    detect: (e, r, ids) => (ids.has('product-launch') ? { kind: 'default' } : null),
    groups: {
      consumer_staples: ['new_product_revenue_share', 'volume_growth'],
      auto: ['volumes_auto'],
      consumer_durables: ['volume_durables'],
      medical_devices: ['units_sold_devices'],
      hardware: ['units_shipped'],
      pharma: (text) => (US_MARKET.test(text) ? ['us_revenue'] : INDIA_MARKET.test(text) ? ['domestic_formulations'] : NONE),
      telecom: { kpis: ['arpu'], requires: /\b(?:plans?|tariffs?|prepaid|postpaid)\b/ },
      media: { kpis: ['paid_subscribers', 'subscription_revenue'], requires: /\b(?:ott|streaming|subscription|subscribers?)\b/ },
    },
    why: { default: 'A launch adds a product to the volumes and revenue this sector reports.' },
  },
  {
    id: 'fda-inspection',
    label: 'USFDA inspection',
    anyNews: true,
    detect: (e, r) => (FDA_OUTCOME.test(r.text) && /\b(?:us\s?fda|usfda|fda|inspection|audit)\b/.test(r.text) ? { kind: 'default' } : null),
    groups: { pharma: ['us_revenue', 'anda_filings'], medical_devices: ['regulatory_approvals'] },
    why: { default: 'An inspection outcome decides whether a plant can keep supplying the US, and whether its pending ANDAs can be approved.' },
  },
  {
    id: 'approval',
    label: 'Regulatory approval',
    detect: (e, r, ids) => {
      const approved = e.filingRule === 'regulatory approval or patent grant' || ids.has('approval') ||
        /\b(?:approv\w+|nod|clearance|tentative approval|final approval)\b/.test(r.text);
      return approved && !FDA_OUTCOME.test(r.text) ? { kind: 'default' } : null;
    },
    groups: {
      pharma: (text) => (US_DRUG_REGULATOR.test(text) ? ['us_revenue', 'anda_filings'] : INDIA_DRUG_REGULATOR.test(text) ? ['domestic_formulations'] : OTHER_DRUG_REGULATOR.test(text) ? ['exports'] : NONE),
      medical_devices: { kpis: ['regulatory_approvals'], requires: /\b(?:fda|510\s?\(?k\)?|ce mark\w*|cdsco|dcgi)\b/ },
      power: { kpis: ['tariff'], requires: /\b(?:cerc|serc|tariff (?:order|petition|adoption))\b/ },
      utilities: { kpis: ['tariff_utilities'], requires: /\b(?:cerc|serc|tariff (?:order|petition))\b/ },
    },
    why: { default: "A regulator's approval opens that market to the product, or sets the tariff the sector is paid." },
  },
  {
    id: 'equity-raise',
    label: 'Equity raise',
    detect: (e, r, ids) => {
      const named = ['qip', 'qualified-institutional-placement', 'preferential-issue', 'rights-issue'].some((id) => ids.has(id)) || EQUITY_RAISE.test(r.text);
      if (!named || EMPLOYEE_STOCK.test(r.text) || (DEBT_ONLY.test(r.text) && !/\bequity\b/.test(r.text))) return null;
      return { kind: 'default' };
    },
    groups: {
      banks: ['capital_adequacy_ratio', 'eps', 'book_value_per_share'],
      nbfc: ['capital_adequacy_ratio_nbfc', 'eps', 'book_value_per_share'],
      insurance: ['solvency_ratio', 'eps'],
      reit: ['distribution_per_unit'],
      investment_vehicles: NONE,
      default: ['eps', 'book_value_per_share'],
    },
    why: {
      default: 'New shares spread the same profit across more shares, and add to equity and book value.',
    },
  },
  {
    id: 'buyback',
    label: 'Buyback',
    detect: (e, r, ids) => ((ids.has('buyback') || /\bbuy[\s-]?backs?\b/.test(r.text)) &&
      !/\bbuy[\s-]?back of (?:its )?(?:ncds?|bonds?|debentures?|notes|fccbs?)\b/.test(r.text) ? { kind: 'default' } : null),
    groups: { investment_vehicles: NONE, default: ['eps', 'cash_and_equivalents'] },
    why: { default: 'Fewer shares lift earnings per share; the payout comes out of cash.' },
  },
  {
    id: 'dividend',
    label: 'Dividend',
    detect: (e, r) => {
      const declared = (/\bdividends?\b/.test(r.text) && /\b(?:declar\w*|recommend\w*|approv\w*|announc\w*|interim|final|special)\b/.test(r.text)) ||
        /\bdistribution\b[^.]{0,40}\bper unit\b/.test(r.text);
      // A board meeting that will CONSIDER a dividend ("…and interim dividend, if any") is a calendar
      // entry, and the record-date notice for one "if declared" is the same: neither sets a figure.
      const notADeclaration = /\b(?:unclaimed|unpaid|iepf|investor education|tds|tax deduct\w*|payment of (?:the )?dividend|dividend distribution policy|credited|dividend income|dividend received|transfer of (?:equity )?shares|to consider|will consider|if any|if declared|board meeting intimation|intimation of board meeting)\b/;
      return declared && !notADeclaration.test(r.text) ? { kind: 'default' } : null;
    },
    groups: { reit: ['distribution_per_unit'], investment_vehicles: NONE, default: ['dividend_per_share'] },
    why: { default: 'A declared dividend sets the dividend per share.' },
  },
  {
    id: 'credit-rating',
    label: 'Credit rating action',
    detect: (e, r) => {
      if (!RATING_ACTION.test(r.text)) return null;
      const credit = CREDIT_CONTEXT.test(r.text) || e.filingRule === 'rating upgrade' || e.filingRule === 'rating downgrade';
      if (!credit) return null;
      // A broker moving a STOCK rating is not a credit agency moving the company's debt rating.
      if (r.family === 'news' && (isBrokerageResearch(r.raw) || STOCK_CALL.test(r.text))) return null;
      return { kind: 'default' };
    },
    groups: { banks: ['cost_of_funds'], nbfc: ['cost_of_borrowing'], insurance: NONE, investment_vehicles: NONE, default: ['finance_cost'] },
    why: { default: 'A credit rating action moves what the company pays to borrow.' },
  },
  {
    id: 'disruption',
    label: 'Plant disruption',
    detect: (e, r, ids) => {
      if (NOT_A_PLANT_EVENT.test(r.text)) return null;
      if (/\b(?:resum\w+|restart\w*|restor\w*|recommenc\w+)\b[^.]{0,40}\b(?:operations?|production|plant|unit|manufacturing)\b/.test(r.text)) return { kind: 'resumed' };
      // An incident names an output KPI only where the text puts it at a production site — and a
      // site word beside an office or a vehicle ("fire at the unit's office") is not enough on its own.
      const incident = (ids.has('fire') || ids.has('accident') || /\bexplosion\b/.test(r.text)) &&
        PRODUCTION_SITE.test(r.text) && !(NOT_A_SITE_INCIDENT.test(r.text) && !/\b(?:plant|factory|refinery|smelter|kiln|furnace|boiler|reactor)\b/.test(r.text));
      const stopped = /\b(?:suspen(?:d|ded|sion)|shut\s?down|shutdown|halt(?:s|ed)?|stoppage|closure|lock[- ]?out|strike)\b[^.]{0,60}\b(?:operations?|production|plant|factory|unit|facility|manufacturing|mine|refinery|smelter|kiln|furnace)\b|\b(?:operations?|production|plant|factory|unit|facility|manufacturing|mine|refinery)\b[^.]{0,40}\b(?:suspended|shut|halted|closed|stopped)\b/.test(r.text);
      return incident || stopped ? { kind: 'stopped' } : null;
    },
    groups: {
      ...OPERATING_GROUPS,
      power: { kpis: ['units_generated', 'plant_load_factor'], requires: /\b(?:plant|unit|station|generation|mw)\b/ },
      hospitals: { kpis: ['occupancy_rate'], requires: /\b(?:hospitals?|beds?)\b/ },
      hotels: { kpis: ['occupancy_rate_hotels'], requires: /\b(?:hotels?|resorts?|property)\b/ },
      capital_goods: ['capacity_utilization_capital_goods'],
      pharma: ['revenue'],
      ...FINANCIALS,
    },
    why: {
      stopped: 'An outage or suspension cuts output and utilisation until the plant runs again.',
      resumed: 'Operations resuming restore output and utilisation.',
    },
  },
  {
    id: 'acquisition',
    label: 'Acquisition',
    detect: (e, r, ids) => (ids.has('acquisition') && ACQUIRES.test(r.text) && !notAPurchase(r.text) ? { kind: 'default' } : null),
    groups: {
      banks: ['advances', 'deposits'], nbfc: ['aum'], insurance: ['gross_written_premium'], capital_markets: ['aum_capital_markets'],
      investment_vehicles: NONE, diversified_holding: ['segment_revenue'],
      default: ['revenue', 'ebitda', 'net_debt'],
    },
    why: { default: "An acquisition adds the target's revenue and EBITDA, and is paid for in cash, debt or shares." },
  },
  {
    id: 'divestment',
    label: 'Divestment',
    detect: (e, r) => (DIVESTS.test(r.text) && !NOT_A_BUSINESS_SALE.test(r.text) ? { kind: 'default' } : null),
    groups: { ...FINANCIALS, default: ['revenue', 'ebitda', 'net_debt'] },
    why: { default: "A sale takes the business's revenue and EBITDA out and brings cash in." },
  },
  {
    id: 'default',
    label: 'Payment default',
    detect: (e, r) => (OWN_DEFAULT.test(r.text) ? { kind: 'default' } : null),
    groups: { ...FINANCIALS, default: ['net_debt', 'finance_cost'] },
    why: { default: 'A missed or delayed payment is a debt-servicing problem: net debt and finance cost.' },
  },
  {
    id: 'business-update',
    label: 'Business update',
    filingsOnly: true,
    detect: (e, r) => (BUSINESS_UPDATE.test(r.text) && !NOT_AN_UPDATE.test(r.text) ? { kind: 'default' } : null),
    groups: {
      auto: ['volumes_auto', 'domestic_volumes', 'export_volumes'],
      cement: ['volume_cement'],
      metals: { kpis: ['production_volume_metals', 'sales_volume_metals'], requires: /\b(?:production|sales|dispatch\w*)\b/ },
      mining: { kpis: ['production_volume_mining', 'sales_volume_mining'], requires: /\b(?:production|offtake|dispatch\w*|sales)\b/ },
      power: { kpis: ['units_generated'], requires: /\b(?:generation|units?|mus?|bus?)\b/ },
      aviation: ['passengers_carried', 'passenger_load_factor'],
      logistics: { kpis: ['volumes_logistics', 'tonnage_handled'], requires: /\b(?:cargo|volumes?|teu|tonnage|throughput)\b/ },
      banks: ['advances', 'deposits', 'casa_ratio'],
      nbfc: ['aum', 'disbursements'],
      capital_markets: { kpis: ['aum_capital_markets'], requires: /\b(?:aum|assets under management)\b/ },
      insurance: ['new_business_premium', 'gross_written_premium'],
      real_estate: ['presales', 'collections'],
      retail: ['store_count'],
      oil_gas: { kpis: ['throughput'], requires: /\b(?:refiner\w*|throughput|crude processed)\b/ },
    },
    why: { default: 'A periodic business update reports these figures directly.' },
  },
];

const TRIGGER_BY_ID = new Map(TRIGGERS.map((t) => [t.id, t]));

/** The KPI keys one trigger names for one group, before the ontology filter. */
function groupKpis(trigger, group, text, hit) {
  const entry = Object.prototype.hasOwnProperty.call(trigger.groups, group) ? trigger.groups[group] : trigger.groups.default;
  const lead = trigger.lead?.[hit.kind];
  const leadKeys = lead && !lead.except.includes(group) ? lead.keys : NONE;
  // `only` refuses the GROUP's own KPIs for a kind; a lead it carries (Capex, for bare capex) stays.
  if (trigger.only?.[hit.kind] && !trigger.only[hit.kind](group)) return leadKeys;
  let keys = NONE;
  if (Array.isArray(entry)) keys = entry;
  else if (typeof entry === 'function') keys = entry(text) || NONE;
  else if (entry && Array.isArray(entry.kpis)) {
    const allowed = entry.test ? entry.test(text) : !entry.requires || entry.requires.test(text);
    keys = allowed ? entry.kpis : NONE;
  }
  return leadKeys.length ? [...leadKeys, ...keys] : keys;
}

// ---------------------------------------------------------------------------------------
// MENTIONS — WHERE THE SOURCE'S OWN WORDS NAME A KPI

// Global KPIs a highlight or an update can name. The valuation multiples, the balance-sheet totals
// and the per-share accounting lines are left out: a con-call rarely "moves" P/E, and a headline
// quoting one is a broker's view, which is not an event at the company.
const MENTION_GLOBALS = new Set([
  'revenue', 'ebitda', 'ebitda_margin', 'ebit_margin', 'gross_margin', 'operating_margin', 'net_profit_margin',
  'pat', 'adjusted_pat', 'eps', 'net_debt', 'debt_to_equity', 'free_cash_flow', 'cash_flow_from_operations',
  'roe', 'roce', 'market_share', 'capex', 'working_capital', 'receivable_days', 'inventory_days', 'other_income',
]);

// Aliases in the ontology that are ordinary words in a headline, or name two things. "Sales" is in a
// stake sale; "volume" is how an exchange asks about a price-and-volume spurt; "yield" is a bond's;
// "tariff" is a trade war's; NAV is the routine mutual-fund declaration; CFO is a person; MoU is a
// memorandum; COP is a climate conference; PCR is two different KPIs in the ontology itself.
const ALIAS_DENY = new Set([
  'sales', 'turnover', 'volume', 'volumes', 'total volume', 'production', 'output', 'capacity', 'generation', 'yield',
  'exports', 'keys', 'trucks', 'outlets', 'connections', 'admissions', 'spread', 'reserves', 'tariff', 'dividend',
  'installations', 'shipments', 'visitors', 'walk-ins', 'workforce', 'units sold', 'energy sold', 'fund assets',
  'net assets', 'nav', 'e', 'da', 'cop', 'pcr', 'mou', 'cfo', 'new sales', 'sales volume', 'bookings', 'new launches',
  'interest cost', 'borrowing cost', 'other operating income', 'operating profit',
]);
// A display name with its trailing "Ratio"/"Rate" is also what people write ("cost-to-income") —
// but not where what is left is a generic word.
const GENERIC_STEM = new Set(['loss', 'combined', 'expense', 'tax', 'growth', 'cost', 'margin', 'share', 'value', 'price', 'churn rate']);

const globalWordsCache = new WeakMap();
/** Every name and alias of a GLOBAL KPI, lower-cased. */
function globalWords(onto) {
  if (!globalWordsCache.has(onto)) {
    const words = new Set();
    for (const key of onto.globals) {
      const kpi = onto.kpis[key];
      if (!kpi) continue;
      words.add(kpi.name.toLowerCase());
      for (const alias of kpi.aliases) words.add(alias.toLowerCase());
    }
    globalWordsCache.set(onto, words);
  }
  return globalWordsCache.get(onto);
}

const mentionText = (value) => ` ${String(value || '').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[^a-z0-9%&']+/g, ' ').replace(/\s+/g, ' ').trim()} `;

function mentionTerms(onto, group) {
  if (onto.mentionIndex.has(group)) return onto.mentionIndex.get(group);
  const allowed = [...(onto.groups[group]?.kpis || []), ...[...onto.globals].filter((key) => MENTION_GLOBALS.has(key))];
  const terms = [];
  for (const key of new Set(allowed)) {
    const kpi = onto.kpis[key];
    if (!kpi) continue;
    const names = new Set(kpi.aliases.map((a) => a.toLowerCase().trim()));
    // A display name read without its parenthetical ("Order Book (Defence)" → "order book") is what
    // a highlight writes — unless that leaves a GLOBAL KPI's own word: "Revenue (USD)" → "revenue"
    // would file every rupee revenue line under the dollar figure.
    const display = kpi.name.toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (display === kpi.name.toLowerCase() || !globalWords(onto).has(display)) names.add(display);
    const stem = display.replace(/\s+(?:ratio|rate)$/, '').trim();
    if (stem !== display && (stem.includes(' ') || !GENERIC_STEM.has(stem)) && stem.length >= 5) names.add(stem);
    for (const name of names) {
      if (!name || ALIAS_DENY.has(name)) continue;
      const spaced = mentionText(name);
      const core = spaced.trim();
      if (!core || core.length < 2) continue;
      // Two-to-four letter acronyms must appear in CAPITALS in the source: "NIM", "CASA", "EPS".
      const acronym = /^[a-z]{2,4}$/.test(core);
      terms.push({ key, core, spaced, acronym: acronym ? new RegExp(`\\b${core.toUpperCase()}s?\\b`) : null });
    }
  }
  // Longest first, so "ebitda margin" is read before "ebitda" and "order book to sales" before
  // "order book".
  terms.sort((a, b) => b.core.length - a.core.length);
  onto.mentionIndex.set(group, terms);
  return terms;
}

/** The KPI keys the text names, in the order it names them. */
export function mentionedKpis(onto, group, raw) {
  if (!onto || !group || !raw) return [];
  let text = mentionText(raw);
  const found = [];
  for (const term of mentionTerms(onto, group)) {
    // The plural is the same KPI: "EBITDA margins", "order books".
    let span = term.spaced;
    let at = text.indexOf(span);
    if (at < 0 && !term.acronym) {
      span = `${term.spaced.trimEnd()}s `;
      at = text.indexOf(span);
    }
    if (at < 0) continue;
    if (term.acronym && !term.acronym.test(raw)) continue;
    found.push({ key: term.key, at });
    // Consume the span so a shorter alias inside it cannot match again.
    text = `${text.slice(0, at)}${' '.repeat(span.length)}${text.slice(at + span.length)}`;
  }
  return found.sort((a, b) => a.at - b.at).map((hit) => hit.key);
}

// ---------------------------------------------------------------------------------------
// A FILED RESULT — THE ONE MEASURED MOVE

const RESULT_METRICS = [
  { field: 'revenue', key: 'revenue' },
  { field: 'netProfit', key: 'pat' },
];

/** "+13%", "to profit", "loss narrowed" — the source's comparison, never a growth rate across zero. */
export function resultValue(metric) {
  if (!metric || typeof metric !== 'object') return null;
  const pct = Number(metric.pct);
  switch (metric.kind) {
    case 'normal': return Number.isFinite(pct) ? `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%` : null;
    case 'flat': return '0%';
    case 'turnaround': return 'to profit';
    case 'slipped-to-loss': return 'to loss';
    case 'loss-narrowed': return 'loss narrowed';
    case 'loss-widened': return 'loss widened';
    case 'loss-flat': return 'loss flat';
    // Nothing in the prior period: there is no growth rate, and the source's own transition is the
    // honest wording. The filed result still reports the line, so it is still a KPI in play.
    case 'from-zero': return 'from zero';
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------
// ONE CARD

const eventLabel = (event) => (event.feedLabel || event.feed || 'source');

/**
 * Which of the company's own sector KPIs the card's evidence could move.
 *
 * `events` is the card's evidence in score order, so the strongest item names its KPIs first and a
 * KPI is credited to the first event that names it. Returns null where the company has no resolved
 * sector or nothing on the card names a KPI; otherwise the group and EVERY KPI named. The chip cap
 * (`KPI_CHIP_LIMIT`) is the view's business: search, a bookmark and an export read the whole list,
 * so a KPI past the fourth chip is still findable by name rather than reduced to a count.
 */
export function kpiImpactOf(card, onto = ontology) {
  const company = companyContext(onto, card?.ticker);
  if (!company) return null;
  const allowed = onto.groupKpis.get(company.group);
  const items = [];
  const seen = new Set();
  const add = (key, detail) => {
    if (!allowed?.has(key) || !onto.kpis[key]) return;
    const name = onto.kpis[key].name;
    if (seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    items.push({ key, name, ...detail });
  };

  for (const event of card?.events || []) {
    if (!eligible(event)) continue;
    const reading = readingOf(event);
    if (!reading) continue;
    const base = { eventId: event.id ?? null, feed: event.feed, day: event.day || null, source: eventLabel(event) };

    if (reading.family === 'result') {
      const basis = event.resultBasis ? ` ${event.resultBasis}` : '';
      for (const { field, key } of RESULT_METRICS) {
        const value = resultValue(event.metrics?.[field]);
        if (!value) continue;
        add(key, { ...base, trigger: 'result', triggerLabel: 'Result filed', value,
          why: `Filed result${basis}: ${onto.kpis[key]?.name || key} ${value}, as the source reported it.` });
      }
      continue;
    }

    if (reading.family === 'call') {
      for (const tag of reading.tags) {
        for (const key of mentionedKpis(onto, company.group, tag)) {
          add(key, { ...base, trigger: 'mention', triggerLabel: 'Con-call highlight', why: `The con-call analysis names it: “${tag}”.` });
        }
      }
      continue;
    }

    const ids = keywordIdsOf(event);
    const fired = new Set();
    for (const trigger of TRIGGERS) {
      if (trigger.filingsOnly && reading.family !== 'filing') continue;
      if (reading.family === 'news' && event.importance !== 'high' && !trigger.anyNews) continue;
      const hit = trigger.detect(event, reading, ids, fired);
      if (!hit) continue;
      fired.add(trigger.id);
      const why = trigger.why[hit.kind] || trigger.why.default;
      for (const key of groupKpis(trigger, company.group, reading.text, hit)) {
        add(key, { ...base, trigger: trigger.id, triggerLabel: trigger.labels?.[hit.kind] || trigger.label, why });
      }
    }
    // A business update names its own figures; so can the filing that carries a trigger.
    if (reading.family === 'filing' && (fired.size || BUSINESS_UPDATE.test(reading.text))) {
      for (const key of mentionedKpis(onto, company.group, reading.raw)) {
        add(key, { ...base, trigger: 'mention', triggerLabel: 'Named in the filing', why: `The filing names it: “${String(event.headline || '').slice(0, 140)}”.` });
      }
    }
  }

  if (!items.length) return null;
  return { ...company, items, total: items.length };
}

/** The KPI line as plain text, for a bookmark or an export — every KPI, with a filed result's figure. */
export function kpiLine(impact) {
  if (!impact?.items?.length) return '';
  const chips = impact.items.map((item) => (item.value ? `${item.name} ${item.value}` : item.name));
  return `${chips.join(' · ')} (${impact.groupLabel})`;
}

export const triggerById = (id) => TRIGGER_BY_ID.get(id) || null;
