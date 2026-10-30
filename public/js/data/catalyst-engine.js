// data/catalyst-engine.js — THE CATALYST ENGINE BEHIND AI RECOMMENDATIONS.
//
// One deterministic analyst, run once on the runner (scripts/build-catalyst-ideas.mjs) over every
// capture this dashboard already holds, and published as public/data/ai-catalysts.json. It reads
// what a portfolio manager would read before calling an idea, for every listed company at once:
//
//   EARNINGS      the latest filed quarter: revenue and profit growth, turnarounds, operating leverage
//   GROWTH        what will change future earnings — order wins sized against revenue and market cap,
//                 capacity commissioned or approved, regulatory approvals and clean inspections,
//                 launches, network additions, acquisitions, demergers, favourable legal outcomes
//   SMART MONEY   promoters buying in the open market, tracked investors adding, institutions in
//                 bulk/block deals, credit upgrades, buybacks, broker BUY calls as printed
//   PRICE         whether the tape confirms it: trend, relative strength, breakouts
//   RISK          tax demands and penalties sized against market cap, auditor/CFO exits, defaults,
//                 adverse inspections, downgrades, promoter selling and pledges, earnings declines
//
// Every catalyst is read in the SECTOR'S OWN TERMS (catalyst-playbooks.js): an order is the thesis
// at a capital-goods company and nothing at a bank; a USFDA inspection is the thesis at a pharma
// company. The desk's sector → KPI ontology then names which line of the model moves.
//
// SIX RULES, AND THEY ARE WHY THE PAGE CAN BE TRUSTED:
//  1. NO FACT IS INVENTED. Every catalyst quotes a filing, a filed result, a disclosed trade or a
//     printed broker call, with its date and its link. Figures are the source's; the only figures
//     this engine computes are ratios of two source figures (an order against the latest quarter's
//     revenue, a demand against market cap), and each is labelled as derived.
//  2. NO TARGET PRICE, NO PROBABILITY, NO RETURN FORECAST. Scores are evidence points. A broker's
//     target is shown only as that broker printed it.
//  3. RISK IS SCORED, NOT HIDDEN. A strong order book beside a tax demand worth 8% of the company
//     is "Mixed", not an opportunity, and the risk is on the card.
//  4. SIZE MATTERS MORE THAN COUNT. A ₹20 lakh order and a ₹2,000 crore order are both "an order";
//     materiality against the company's own revenue or market cap is what separates them.
//  5. RECENCY DECAYS. Evidence halves in weight every few weeks (longer for capacity and
//     restructuring, which play out over years). Nothing older than WINDOW_DAYS counts.
//  6. THE SAME EVENT ONCE. A BSE filing, its NSE twin and the press release are one catalyst.

import { categorize } from './announcement-categories.js';
import { announcementSignal, LEGAL_ORDER, ACQUISITION_COMPLETED } from './filing-signals.js';
import { statedAmountsCr } from './relevance.js';
import { sourceStatement, isTypeOnly, clip } from './alert-claims.js';
import { playbookFor, sectorWeight } from './catalyst-playbooks.js';

export const ENGINE_VERSION = 'catalyst-engine-1';
export const WINDOW_DAYS = 180;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------
// THE CATALYST VOCABULARY
// ---------------------------------------------------------------------------------------------
//
//  pillar   which part of the score it feeds
//  tone     +1 supports the thesis, −1 is a risk, 0 is context only (shown, never scored)
//  base     points before size, sector and recency
//  life     half-life in days
//  theme    the filter group the reader sees

export const THEMES = [
  { id: 'earnings', label: 'Earnings' },
  { id: 'orders', label: 'Orders & contracts' },
  { id: 'capacity', label: 'Capacity & capex' },
  { id: 'approvals', label: 'Approvals & launches' },
  { id: 'deals', label: 'Deals & restructuring' },
  { id: 'smart-money', label: 'Smart money' },
  { id: 'capital', label: 'Capital & credit' },
  { id: 'legal', label: 'Legal & governance' },
  { id: 'price', label: 'Price action' },
];

export const CATALYSTS = {
  'earnings-beat': { label: 'Earnings momentum', pillar: 'earnings', tone: 1, theme: 'earnings' },
  turnaround: { label: 'Turnaround', pillar: 'earnings', tone: 1, theme: 'earnings' },
  'order-win': { label: 'Order win', pillar: 'growth', tone: 1, base: 12, life: 75, theme: 'orders' },
  'capacity-live': { label: 'Capacity commissioned', pillar: 'growth', tone: 1, base: 13, life: 75, theme: 'capacity' },
  'capacity-plan': { label: 'Capacity expansion', pillar: 'growth', tone: 1, base: 7, life: 90, theme: 'capacity' },
  approval: { label: 'Regulatory approval', pillar: 'growth', tone: 1, base: 9, life: 60, theme: 'approvals' },
  'inspection-clean': { label: 'Clean inspection', pillar: 'growth', tone: 1, base: 8, life: 75, theme: 'approvals' },
  launch: { label: 'Product launch', pillar: 'growth', tone: 1, base: 5, life: 45, theme: 'approvals' },
  network: { label: 'Network expansion', pillar: 'growth', tone: 1, base: 6, life: 60, theme: 'capacity' },
  deal: { label: 'Strategic deal', pillar: 'growth', tone: 1, base: 7, life: 75, theme: 'deals' },
  'value-unlock': { label: 'Value unlocking', pillar: 'growth', tone: 1, base: 8, life: 120, theme: 'deals' },
  'legal-win': { label: 'Legal win', pillar: 'growth', tone: 1, base: 6, life: 60, theme: 'legal' },
  'disruption-resolved': { label: 'Operations restored', pillar: 'growth', tone: 1, base: 3, life: 30, theme: 'capacity' },
  'business-update': { label: 'Business update', pillar: 'growth', tone: 1, base: 3, life: 35, theme: 'earnings' },
  'commentary-up': { label: 'Positive commentary', pillar: 'growth', tone: 1, base: 2.5, life: 60, theme: 'earnings' },
  'promoter-buy': { label: 'Promoter buying', pillar: 'smart', tone: 1, base: 9, life: 60, theme: 'smart-money' },
  'promoter-infusion': { label: 'Promoter infusion', pillar: 'smart', tone: 1, base: 8, life: 90, theme: 'smart-money' },
  'investor-buy': { label: 'Smart-money buying', pillar: 'smart', tone: 1, base: 6, life: 75, theme: 'smart-money' },
  'broker-buy': { label: 'Broker BUY', pillar: 'smart', tone: 1, base: 3.5, life: 30, theme: 'smart-money' },
  'rating-up': { label: 'Credit upgrade', pillar: 'smart', tone: 1, base: 6, life: 90, theme: 'capital' },
  'capital-return': { label: 'Capital return', pillar: 'smart', tone: 1, base: 6, life: 60, theme: 'capital' },
  'growth-capital': { label: 'Capital raise', pillar: 'growth', tone: 0, base: 0, life: 90, theme: 'capital' },
  'price-strength': { label: 'Price strength', pillar: 'technical', tone: 1, theme: 'price' },
  // ---- risks ----
  'earnings-miss': { label: 'Earnings decline', pillar: 'risk', tone: -1, theme: 'earnings' },
  'order-loss': { label: 'Order cancelled', pillar: 'risk', tone: -1, base: 9, life: 60, theme: 'orders' },
  'legal-risk': { label: 'Legal / tax action', pillar: 'risk', tone: -1, base: 6, life: 60, theme: 'legal' },
  governance: { label: 'Governance flag', pillar: 'risk', tone: -1, base: 12, life: 90, theme: 'legal' },
  distress: { label: 'Default / insolvency', pillar: 'risk', tone: -1, base: 18, life: 120, theme: 'capital' },
  'rating-down': { label: 'Credit downgrade', pillar: 'risk', tone: -1, base: 9, life: 90, theme: 'capital' },
  'inspection-adverse': { label: 'Adverse inspection', pillar: 'risk', tone: -1, base: 12, life: 120, theme: 'approvals' },
  disruption: { label: 'Operational disruption', pillar: 'risk', tone: -1, base: 8, life: 45, theme: 'capacity' },
  'promoter-sell': { label: 'Promoter selling', pillar: 'risk', tone: -1, base: 7, life: 60, theme: 'smart-money' },
  pledge: { label: 'Promoter pledge', pillar: 'risk', tone: -1, base: 5, life: 90, theme: 'smart-money' },
  'investor-exit': { label: 'Smart-money exit', pillar: 'risk', tone: -1, base: 3.5, life: 75, theme: 'smart-money' },
  'broker-sell': { label: 'Broker SELL', pillar: 'risk', tone: -1, base: 3.5, life: 30, theme: 'smart-money' },
  'commentary-down': { label: 'Negative commentary', pillar: 'risk', tone: -1, base: 2.5, life: 60, theme: 'earnings' },
  'price-weakness': { label: 'Weak price trend', pillar: 'risk', tone: -1, theme: 'price' },
};

// ---------------------------------------------------------------------------------------------
// READING ONE FILING
// ---------------------------------------------------------------------------------------------

const lower = (v) => String(v || '').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/''/g, "'").replace(/&#8377;/g, '₹').replace(/\s+/g, ' ').trim();

// THE REGULATION A FILING IS MADE UNDER IS NOT WHAT IT IS ABOUT. Nearly every Indian filing names
// "SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015" and "Regulation 30", so
// a word like "SEBI" or "order" in that boilerplate would make every postal-ballot result a SEBI
// action. The citation is removed before any rule reads the text; the statement shown keeps it.
const CITATION = [
  /\bsecurities and exchange board of india\s*\([^)]{2,160}\)\s*(?:\(\s*amendment\s*\)\s*)?regulations?,?\s*(?:\d{4})?(?:\s*\(?as amended\)?)?/g,
  /\bsebi\s*\(?\s*(?:lodr|listing obligations?[^)]{0,80}|listing regulations?|sast|pit|prohibition of insider trading|substantial acquisition[^)]{0,80}|depositories and participants|dp|icdr|issue of capital[^)]{0,80}|buy[- ]?back of securities|share based employee benefits[^)]{0,60})\s*\)?\s*(?:regulations?)?,?\s*(?:\d{4})?/g,
  /\blisting (?:obligations and disclosure requirements|regulations)\b/g,
  /\b(?:pursuant to|under|in terms of|as per|read with|in compliance with)?\s*(?:reg(?:ulation)?s?\.?|clause|para(?:graph)?|sub-?para|schedule)\s*\d+[a-z]?(?:\s*\(\s*\w+\s*\))*(?:\s*(?:and|&|,|read with)\s*\d+[a-z]?(?:\s*\(\s*\w+\s*\))*)*(?:\s*of)?/g,
  /\bannouncement under regulation 30 \(lodr\)-?/g,
];
const decite = (text) => CITATION.reduce((t, re) => t.replace(re, ' '), text).replace(/\s+/g, ' ');

// Filings that say nothing about the business, whatever words they happen to contain.
const NOISE = /\b(?:copy of newspaper|newspaper (?:publication|advertisement|cutting)|publication (?:of|in) newspapers?|certificate under|compliance certificate|trading window|declaration of nav|loss of share certificates?|duplicate share certificate|issue of duplicate|sought clarification|seeks clarification|clarification (?:sought|on|regarding|with respect to) (?:the )?(?:news|media|price|volume|movement)|news (?:item|verification|clarification)|spurt in (?:price|volume)|movement in (?:the )?(?:price|volume)|price movement|volume movement|structural digital database|statement of investor complaints|reconciliation of share capital|closure of trading window|record date for (?:the )?(?:payment of )?(?:interest|redemption)|intimation of record date for (?:interest|redemption)|redemption of (?:commercial paper|ncds?|debentures?)|payment of interest|kyc|dematerial[iz]\w*|physical share|unclaimed|iepf)\b/;

// A sentence that only points at an attachment is the weakest statement a filing can offer.
const POINTER = /^(?:please (?:find|refer)|kindly find|we (?:enclose|are enclosing|hereby (?:enclose|submit|inform)|wish to (?:inform|intimate|submit))|enclosed|attached|pursuant to|in terms of|in compliance|this is to inform|with reference to|further to|intimation (?:under|pursuant)|disclosure (?:under|pursuant)|announcement under|letter attached|outcome of (?:the )?board meeting(?: held)?)\b/i;
const AMOUNTISH = /(?:rs\.?\s?[\d,]|inr\s?[\d,]|₹|usd\s?[\d,]|\$\s?[\d,]|\d\s?(?:crores?|cr\b|lakhs?|million|billion|mn\b|bn\b|mw\b|gw\b|mtpa|tpa|klpd))/i;

/**
 * The filing's own words — the most informative of its subject, headline, NSE summary and
 * description. NSE's summary is often "X has informed the Exchange about Credit Rating" (the label
 * again) while BSE's headline for the same document says "Ind-Ra upgrades JSW Steel to IND AA+", so
 * the choice is by what a sentence carries, not by which field it came from.
 */
export function filingStatement(row) {
  const label = lower(row.subCategory || '');
  const seen = new Set();
  const candidates = [];
  for (const raw of [row.headline, row.summary, row.title, sourceStatement(row.description || ''), row.subject]) {
    const v = tidyStatement(String(raw || '').replace(/^announcement under regulation 30 \(lodr\)-?\s*/i, '')
      );
    const key = lower(v);
    if (!v || v.length < 8 || isTypeOnly(v) || seen.has(key)) continue;
    seen.add(key);
    const score = Math.min(v.length, 200) + (AMOUNTISH.test(v) ? 90 : /\d/.test(v) ? 15 : 0) - (POINTER.test(v) ? 140 : 0) -
      (key === label || key.length < 26 ? 110 : 0) - (/^(?:bagging\/receiving of orders\/contracts|credit rating|acquisition|updates?|general updates|press release|investor presentation)$/i.test(v) ? 150 : 0);
    candidates.push({ v, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return clip(candidates[0]?.v || row.subCategory || row.subject || row.title || '', 220);
}

// The exchange-generated and legal lead-ins in front of what a filing actually says. Removing them is
// typography, not a rewording: the remainder is the filing's own sentence.
const LEAD_INS = [
  [/^.{0,240}?\bhas\s+informed\s+the\s+exchanges?\b[\s,]*(?:about|regarding|that)?\s*/i, 4],
  [/^(?:intimation|disclosure|announcement)s?\s+(?:under|pursuant to|in terms of|of event or information under)\s+(?:the\s+)?[^–:]{0,200}?\s[-–:]\s*/i, 10],
  [/^(?:pursuant to|in terms of|in compliance with|under)\s+(?:the\s+)?(?:provisions of\s+)?(?:reg(?:ulation)?s?\.?\s*\d+[^,]{0,160}|sebi[^,]{0,160}|listing regulations[^,]{0,40})(?:,\s*(?:as amended|\d{4}))*,?\s*/i, 14],
  [/^(?:we|the company)\s+(?:wish|would like|hereby|are pleased|is pleased|are happy)\s+(?:to\s+)?(?:inform|intimate|update|announce|submit|bring to your (?:kind )?notice)\s+(?:you|the exchanges?|all (?:our )?stakeholders|our stakeholders|stakeholders)?\s*(?:that|on|about|of)?\s*/i, 14],
  [/^(?:this is to (?:inform|intimate) (?:you )?(?:that)?|it is hereby (?:informed|intimated) that)\s*/i, 14],
  [/^(?:this has reference to|with reference to|in continuation (?:of|to)|further to)\s+(?:our|the)\s+(?:earlier|previous|prior)?\s*(?:intimation|disclosure|letter|announcement|communication)s?[^,]{0,140},\s*(?:we\s+(?:wish|would like)\s+to\s+(?:inform|update)\s+(?:you\s+)?that\s*)?/i, 14],
  [/^(?:please|kindly) find (?:enclosed|attached)(?: herewith)?(?: the| a)?(?: copy of(?: the)?)?\s*(?:intimation|disclosure|letter|press release|outcome)?\s*(?:relating to|regarding|of|for|about|on|in respect of|with respect to)?\s*/i, 14],
];
export function tidyStatement(text) {
  let v = String(text || '').replace(/''/g, "'").replace(/&#8377;/g, '₹').replace(/\s*-\s*xbrl\b/ig, '').replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass++) {
    for (const [re, min] of LEAD_INS) {
      const next = v.replace(re, '').trim();
      if (next !== v && next.length >= min) v = next;
    }
  }
  v = sourceStatement(v);
  return v ? v[0].toUpperCase() + v.slice(1) : v;
}

const textOf = (row) => decite(lower([row.headline, row.summary, row.title, row.subject, sourceStatement(row.description), row.subCategory].filter(Boolean).join(' • ')));

// A company that grades its own orders by size (L&T: Significant ₹1,000–2,500 Cr, Large ₹2,500–5,000
// Cr, Major ₹5,000–10,000 Cr, Mega ₹10,000–15,000 Cr, Ultra-Mega above ₹15,000 Cr) states a size even
// without a number. The lower bound of the band is used, and the item says it is a band.
const ORDER_BAND = [[/\(ultra[- ]?mega\*?\)|\bultra[- ]?mega\*/, 15000], [/\(mega\*?\)|\bmega\*/, 10000], [/\(major\*?\)|\bmajor\*/, 5000], [/\(large\*?\)|\blarge\*/, 2500], [/\(significant\*?\)|\bsignificant\*/, 1000]];

// Words that put a capacity or commissioning phrase inside an ORDER's scope — the customer's plant.
const ORDER_SCOPE = /\b(?:supply|erection|installation|design|engineering|epc|execution|turnkey)\b[^.]{0,60}\bcommission\w*/;
const CLIENT_PROJECT = /\b(?:to execute|execution of|epc|pmc|project management consultan\w*|for (?:the )?(?:client|customer)|on behalf of)\b/;
const CAPACITY_NOUN = /\b(?:plant|unit|facilit(?:y|ies)|line|capacit\w*|mw|mwp|gw|mtpa|ktpa|tpa|klpd|tpd|tonnes?|furnace|kiln|mill|refinery|terminal|warehouse|hospital|beds?|stores?|factory|manufacturing|production|project|block|mine|smelter|reactor|berth)\b/;

const LIVE = /\b(?:commercial production|commercial operations?|commenc\w+ (?:of )?(?:the )?(?:commercial )?(?:production|operations)|start(?:ed)? (?:of )?(?:commercial )?production|commission(?:s|ed|ing)\b(?! (?:income|expense|agents?|paid|payable|on|of (?:rs|inr|₹)))|successfully commissioned|declared (?:the )?(?:commercial operation|cod)|\bcod\b|synchroni[sz]\w*|trial (?:production|run)|operationali[sz]\w*|inaugurat\w*)\b/;
const PLAN = /\b(?:capacity (?:expansion|addition|enhancement|augmentation)|expansion (?:of|project|plan)|(?:green|brown)field|debottleneck\w*|new (?:manufacturing |production )?(?:plant|facility|unit|line)|set(?:ting)? up (?:a |an |of )?(?:new )?(?:plant|unit|facility|manufacturing)|capex|capital expenditure|environment(?:al)? clearance|consent to (?:establish|operate)|land (?:for|acquisition for) (?:the )?(?:plant|project|expansion|manufacturing)|bhoomi pujan|ground[- ]?breaking|foundation stone)\b/;

const ORDER = /\b(?:order|orders|contract|contracts|letter of (?:award|intent|acceptance)|\bloa\b|\bloi\b|work order|purchase order|bagg\w*|bags|secur(?:es|ed)|wins?|won|awarded|l-?1|lowest bidder|successful bidder|power purchase agreement|\bppa\b)\b/;
const COMMERCIAL = /\b(?:supply|supplies|work order|purchase order|contract|epc|project|tender|loa|letter of (?:award|intent|acceptance)|worth|valued|rs\.?|inr|crores?|cr|lakhs?|million|mn|billion|bn|usd|ppa|power purchase)\b|₹|\$/;
const L1 = /\b(?:l-?1|lowest bidder|successful bidder|emerged as)\b/;
const GOVT = /\b(?:nhai|railway\w*|rvnl|ircon|rites|ntpc|bhel|power ?grid|pgcil|ministry|government|govt|defen[cs]e|indian (?:army|navy|air force)|\bmod\b|hal\b|bel\b|drdo|isro|metro|municipal|state|nhpc|sjvn|npcil|ongc|iocl|indian oil|gail|bpcl|hpcl|coal india|nmdc|sail|psu|nhidcl|cpwd|nhsrcl|dfccil|seci|discom)\b/;
const EXPORT = /\b(?:export|international|overseas|global|usa|u\.s\.|united states|europe\w*|middle east|africa\w*|gcc|saudi|uae|dubai|qatar|australia|latin america|asean)\b/;

const APPROVAL_REGULATOR = /\b(?:us\s?fda|usfda|u\.s\. fda|fda|anda|nda|dcgi|cdsco|drugs? controller|ema|mhra|tga|anvisa|health canada|pmda|who[- ]?gmp|eu[- ]?gmp|who prequalification|peso|bis|cerc|serc|pli|production linked incentive|ministry of (?:defen[cs]e|civil aviation|power|environment)|patent|environment(?:al)? clearance)\b/;
// A financial regulator's approval is a catalyst only when it is a licence or a registration.
const FINANCIAL_LICENCE = /\b(?:rbi|irdai|pfrda|sebi|ifsca)\b[^.]{0,60}\b(?:licen[cs]e|registration|certificate of registration|authori[sz]ation to (?:commence|operate|set up))\b|\b(?:licen[cs]e|registration|certificate of registration)\b[^.]{0,60}\b(?:rbi|irdai|pfrda|sebi|ifsca)\b/;
const APPROVAL_WORD = /\b(?:approv\w+|nod|clearance|licen[cs]e (?:granted|received|obtained)|grant(?:ed)? (?:of )?(?:a )?(?:patent|licen[cs]e)|patent (?:granted|received)|authori[sz]ation|registration (?:granted|received|certificate)|certificate of registration|tentative approval|final approval|selected under|eligible under)\b/;
const NOT_PRODUCT_APPROVAL = /\b(?:board|shareholders?|members?|stock exchanges?|bse|nse|in[- ]principle approval|listing (?:approval|of)|trading approval|scheme of|resolution|postal ballot|appointment|remuneration|sebi takeover|delisting|reclassification|esop|esos|call option|redemption|bonds?|debentures?|tier[- ]?(?:i|ii|1|2)|competition commission|\bcci\b)\b/;

const FDA_CONTEXT = /\b(?:us\s?fda|usfda|u\.s\. fda|fda|mhra|who|ema|anvisa|tga|pmda|health canada|cdsco|dcgi|drug|plant|facility|unit|site|manufactur\w*|recall)\b/;
const NOT_FDA = /\b(?:sebi|stock exchange|bse|nse|administrative warning|rbi|irdai)\b/;
const FDA_ADVERSE = /\b(?:warning letter|import alert|official action indicated|\boai\b|untitled letter|product recall|voluntary recall|recall(?:s|ed)? (?:of )?(?:\d+|batch|batches|lots?|units|tablets?|capsules|bottles))\b|\bform\s*-?\s*483\b[^.]{0,40}\b(?:[1-9]\d?|one|two|three|four|five|six|seven|eight|nine|ten)\s+observations?\b|\b(?:[1-9]\d?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\(\w+\)\s+)?observations?\b/;
const FDA_CLEAN = /\b(?:establishment inspection report|\beir\b|no action indicated|\bnai\b|zero observations?|nil observations?|no observations?|without any observations?|closure of (?:the )?(?:warning letter|import alert)|close[- ]out letter|import alert (?:has been )?(?:lifted|removed)|warning letter (?:has been )?(?:closed|lifted)|voluntary action indicated|\bvai\b)\b/;
const INSPECTION = /\b(?:inspection|audit|us\s?fda|usfda|fda|mhra|eu gmp|who gmp|anvisa|pmda|tga)\b/;

const DISRUPT = /\b(?:fire\b(?!\s*(?:safety|fighting|retardant|resistant|protection|extinguish\w*|proof|alarm|suppression|cables?))|explosion|blast\b(?! furnace)|accident|strike\b|lock[- ]?out|shut\s?down|shutdown|suspen(?:d|ded|sion) of (?:operations?|production|manufacturing)|temporar\w+ (?:closure|suspension)|halt(?:ed)? (?:of )?(?:operations?|production)|force majeure|flood(?:ing|s)?|cyber[- ]?(?:attack|security incident)|ransomware)\b/;
const SITE = /\b(?:plant|factory|unit|facility|refinery|mill|works|mine|smelter|kiln|furnace|boiler|reactor|production|manufacturing|operations?|hotel|premises)\b/;
const NOT_SITE = /\b(?:trading (?:window|halt|suspended)|suspension of trading|book closure|office|showroom|residence|vehicle|bus|truck|tanker)\b/;
const INCIDENT = /\b(?:incident|broke out|accident|explosion|caught fire|fire at|fire in|strike|lock[- ]?out|shut|suspen\w+|halt\w*|closure)\b/;
const RESUMED = /\b(?:resum\w+|restart\w*|restor\w*|recommenc\w+|re-?open\w*|lifting of (?:the )?(?:strike|lock[- ]?out)|called off)\b[^.]{0,40}\b(?:operations?|production|plant|unit|manufacturing|strike|hotel)\b|\brecommencement of operations\b/;

const LEGAL_CONTEXT = /\b(?:court|tribunal|nclt|nclat|sebi|income[- ]tax|gst|cgst|sgst|igst|tax|demand|penalt(?:y|ies)|fine\b|show[- ]cause|notice|adjudicat\w*|appellate|commissioner|customs|excise|enforcement directorate|\bed\b|cbi|search|seizure|raid|survey|arbitra\w*|litigation|dispute|petition|suit|fir\b|police|cci|competition commission|debar\w*|blacklist\w*|attachment|recovery proceedings?|order passed|order dated|pendency)\b/;
// A procedural filing that only cites a court or a regulator: shareholder meetings it convened,
// voting results, scheme notices. Not an action against the company.
const NOT_LEGAL = /\b(?:postal ballot|e-?voting|scrutini[sz]er|voting results|notice of (?:the )?(?:agm|egm|annual general|extra-?ordinary|meeting)|annual general meeting|nclt convened|meetings? of (?:the )?(?:equity shareholders|secured creditors|unsecured creditors|creditors)|monitoring committee|scheme of (?:arrangement|amalgamation)|(?:first|second) motion|book closure|board meeting)\b/;
const LEGAL_WIN = /\b(?:in (?:its|our|the company's) favou?r|in favou?r of (?:the )?company|favou?rable\b[^.]{0,30}\b(?:order|judgment|judgement|ruling|award|outcome|decision)|quash\w*|set aside|(?:appeal|petition|writ) (?:filed by (?:the )?company )?(?:has been |was )?allowed|allowed the (?:company's )?(?:appeal|petition|writ)|dismiss\w* the (?:petition|appeal|case|suit|complaint|writ)s? (?:filed )?(?:by [^.]{0,40} )?against (?:the company|us|it)\b|(?:appeal|petition) filed by (?:the )?(?:department|revenue|authorit\w*|respondent)s? (?:has been |was )?dismissed|demand (?:has been |was )?(?:deleted|dropped|withdrawn|quashed|set aside|nullified)|dropping of (?:the )?proceedings|proceedings (?:have been |were )?dropped|deletion of (?:the )?(?:demand|penalty)|stay (?:has been )?granted|arbitral award (?:in favou?r|for the company)|awarded (?:in favou?r|to the company)|refund (?:order|of rs|of inr|of ₹|sanctioned|received)|settle(?:ment agreement|d the dispute)|amicabl\w+ (?:resolved|settled)|no (?:liability|demand|penalty) (?:has been |was )?(?:imposed|raised|levied)|nil demand)\b/;
const LEGAL_RISK = /\b(?:demand|penalt(?:y|ies)|fine\b|show[- ]cause|notice|order (?:passed|dated|received|under)|search|seizure|raid|survey|attachment|debar\w*|blacklist\w*|fir\b|summons?|chargesheet|investigation|probe|prosecution|recovery|disallow\w*|levied|imposed|adverse|pendency of (?:litigation|any litigation)|litigation)\b/;

const AUDITOR_EXIT = /\b(?:statutory )?auditors?\b[^.]{0,80}\bresign\w*|\bresign\w*[^.]{0,80}\b(?:statutory )?auditors?\b/;
const INTERNAL_AUDITOR = /\b(?:internal|secretarial|cost|tax) auditors?\b/;
const TOP_EXIT = /\bresign\w*[^.]{0,60}\b(?:chief financial officer|cfo|chief executive officer|ceo|managing director|\bmd\b|whole[- ]time director|joint managing director)\b|\b(?:chief financial officer|cfo|chief executive officer|ceo|managing director|whole[- ]time director)\b[^.]{0,60}\bresign\w*/;
const FRAUD = /\bfraud\w*\b|\bforensic (?:audit|investigation)\b|\bmisappropriat\w*|\bembezzl\w*|\bfinancial irregularit\w*|\bsiphon\w*/;
const NOT_FRAUD = /\bfraud (?:prevention|detection|risk management|awareness)\b|\banti[- ]fraud\b|\bcyber[- ]?fraud\b|\bphishing\b|\bfraudulent (?:emails?|websites?|calls?|messages?|social media)\b|\bimpersonat\w*/;
const RESULT_DELAY = /\bdelay(?:ed)? in (?:the )?(?:submission|filing|declaration|publication) of (?:the )?(?:un)?(?:audited )?financial results\b|\bqualified (?:audit )?opinion\b|\bmodified (?:audit )?opinion\b|\bdisclaimer of opinion\b/;

const DISTRESS = /\b(?:corporate insolvency resolution process|\bcirp\b|insolvency (?:and bankruptcy|petition|application|proceedings?|resolution)|admitted (?:the )?(?:company )?(?:into|under|for) (?:insolvency|cirp)|winding[- ]up (?:petition|order)|liquidat(?:ion|or)|default(?:ed)? in (?:the )?(?:payment|repayment|servicing)|delay(?:ed)? in (?:the )?(?:payment|repayment|servicing) of (?:interest|principal)|non[- ]payment of (?:interest|principal)|one[- ]time settlement|\bots\b|declared (?:as )?(?:a )?(?:wilful defaulter|npa|non[- ]performing))\b/;
const NOT_DISTRESS = /\b(?:nil|no default|not in default|not applicable|confirmation of (?:payment|redemption)|timely (?:payment|servicing)|has been (?:paid|serviced)|certificate|against (?:a |one of (?:its|our) )?(?:customers?|debtors?|corporate debtor)|filed by the company against|as (?:a )?financial creditor|as (?:an )?operational creditor|subsidiar\w*|step[- ]?down\w*|voluntary liquidation|members'? voluntary|strik(?:e|ing) off|resolution plan (?:for|of) (?!the company)|successful resolution applicant|acquisition of [^.]{0,140} under (?:the )?(?:cirp|ibc|insolvency)|implementation of (?:the )?resolution plan|post[- ]completion of|post[- ]cirp|exit(?:ed)? from cirp)\b/;

const UPGRADE = /\bupgrad\w*\b|\boutlook (?:revised|changed|upgraded) (?:from \w+ )?to (?:positive|stable from negative)\b|\bassigned .* positive outlook\b/;
const DOWNGRADE = /\bdowngrad\w*\b|\boutlook (?:revised|changed) (?:from \w+ )?to negative\b|\b(?:placed|kept) (?:on|under) (?:rating )?watch with negative\b|\bissuer not cooperating\b|\binc\b(?=[^.]{0,20}\b(?:rating|category)\b)/;
const RATING = /\b(?:credit rating|rating|crisil|icra|care ratings?|careedge|india ratings|ind-?ra|brickwork|acuite|acuité|infomerics|moody'?s|fitch|s&p)\b/;

const BUYBACK = /\bbuy[- ]?back\b(?!\s+of\s+(?:its\s+)?(?:ncds?|bonds?|debentures?|notes|fccbs?|commercial paper))/;
const BONUS = /\bbonus (?:issue|shares?|equity)\b|\bissue of bonus\b|\bstock split\b|\bsub[- ]?division of (?:equity )?shares\b|\bsplit of (?:equity )?shares\b/;
const SPECIAL_DIV = /\bspecial (?:interim )?dividend\b/;
const CONSIDER = /\b(?:to consider|will consider|proposal to consider|if any|board meeting (?:to be held|intimation|scheduled)|intimation of board meeting|record date)\b/;

const EQUITY_RAISE = /\b(?:qualified institutions? placement|\bqip\b|preferential (?:issue|allotment|basis)|rights issue|warrants?|further public offer|\bfpo\b)\b/;
const TO_PROMOTER = /\b(?:to (?:the )?promoters?|promoter(?:s|\/promoter group| group)? (?:entit\w+|categor\w+)|promoter and promoter group|allot\w* to promoter|subscription by (?:the )?promoters?)\b/;
const EMPLOYEE_STOCK = /\b(?:esops?|esos|esps|employee stock|stock options?|sweat equity|employee (?:benefit|welfare) trust)\b/;

const ACQUIRE = /\b(?:acquisition of|acquires?|acquired|acquiring|to acquire|completes? (?:the )?acquisition|completion of (?:the )?acquisition|share purchase agreement|business transfer agreement|takeover of|strategic investment in|stake in)\b/;
// Moving a stake around inside the group is restructuring, not buying a business.
const INTRA_GROUP = /\b(?:(?:a|its|our|the company's)\s+(?:step[- ]?down\s+)?(?:wholly[- ]owned\s+)?(?:material\s+)?subsidiar(?:y|ies)|wholly[- ]owned subsidiar(?:y|ies) of the company|from (?:its|the) (?:holding|parent) compan\w*|group compan(?:y|ies)|inter[- ]?se|foundation\b|section 8 compan\w*)/;
const BECOMES_SUBSIDIARY = /\bbecom\w*\s+(?:a\s+)?(?:wholly[- ]owned\s+|material\s+)?subsidiar/;
const NOT_ACQUIRE = /\b(?:sale of|divest\w*|disinvest\w*|regulation\s*(?:10|29|31)|reg\.?\s*(?:10|29|31)|sast|substantial acquisition|open market|promoters?\b[^.]{0,40}\bacquir\w*|by (?:the )?promoters?|shares of the company|incorporat\w*|to be incorporated|wholly[- ]owned subsidiary (?:has been )?incorporated|conversion of|inter[- ]?(?:corporate|company) loan|further investment|capital infusion|infus\w+|subscri\w+ (?:to|of|in) (?:the )?(?:rights|equity|shares)|pledge|encumbrance|acquisition of (?:land|property|premises|office|plot)|acquired by|to be acquired|takeover by)\b/;
const PARTNER = /\b(?:strategic (?:partnership|alliance|collaboration|tie[- ]?up)|joint venture|\bjv\b|memorandum of understanding|\bmou\b|technology (?:transfer|licen[cs]\w*|partnership|collaboration)|licen[cs]ing agreement|distribution agreement|supply agreement|long[- ]term (?:agreement|contract|supply)|offtake agreement|definitive agreement|framework agreement|teaming agreement|collaborat\w+ with|partners? with|tie[- ]?up with)\b/;
const VALUE_UNLOCK = /\b(?:demerg\w*|hive[- ]?off|spin[- ]?off|listing of (?:its |the )?(?:subsidiary|unit|business)|ipo of (?:its |the )?(?:subsidiary|unit)|drhp (?:of|by) (?:its |the )?(?:subsidiary|unit)|separate(?:ly)? list\w*|value unlock\w*)\b/;
const VALUE_UNLOCK_NOISE = /\b(?:reduction of (?:share )?capital|newspaper|notice (?:of|to) (?:the )?(?:meeting|nclt convened|equity shareholders|shareholders)|postal ballot|e-voting|scrutini[sz]er|voting results|physical shareholders?|kyc|dematerial\w*|loss of share)\b/;
const LAUNCH = /\b(?:launch(?:es|ed|ing)?|introduc(?:es|ed|ing)|unveil\w*|rolls? out|rolled out|commerciali[sz]\w*)\b/;
const NOT_LAUNCH = /\b(?:launch\w* (?:of )?(?:the )?(?:qip|issue|ipo|ncds?|offer|scheme|esop|buyback|website|app for investors|investor)|re-?launch of (?:the )?website)\b/;
const NETWORK = /\b(?:open(?:s|ed|ing)?|launch(?:es|ed|ing)?|inaugurat\w*|add(?:s|ed|ing)?|commenc\w*|signs?|signed)\b[^.]{0,50}\b(?:new )?(?:stores?|outlets?|showrooms?|restaurants?|hospitals?|beds|hotels?|resorts?|rooms|keys|branches|clinics?|labs?|centres?|centers?|campus(?:es)?|schools?|warehouses?|dealerships?)\b/;
const BUSINESS_UP = /\b(?:highest[- ]ever|record (?:high|sales|production|volumes?|revenue|dispatches|order|bookings|collections)|all[- ]time high|grew|growth of|up by|increase of|rose)\b[^.]{0,40}\d/;
const BUSINESS_UPDATE = /\b(?:business|operational|operating|quarterly|monthly|provisional)\s+(?:update|performance|numbers?|data|figures?|highlights)\b|\b(?:sales|production|dispatch(?:es)?|volumes?|pre[- ]?sales|bookings|disbursements?|collections?)\s+(?:update|numbers?|figures?|data|performance|for (?:the month|october|september|q[1-4]))\b|\bmonthly\s+(?:sales|production|business|volumes?)\b/;

/**
 * What a single filing is, as a catalyst. Returns an array of { type, kind?, weight } — usually
 * one, never more than two. `weight` scales the type's base points for a weaker variant (an L1
 * bid is not yet an order; trial production is not yet commercial production).
 */
export function classifyFiling(row) {
  const text = textOf(row);
  if (!text) return [];
  const cats = new Set(categorize(row, 'filing').ids);
  const sig = announcementSignal(row);
  const out = [];
  const add = (type, extra = {}) => { if (!out.some((o) => o.type === type)) out.push({ type, weight: 1, ...extra }); };

  // ---- the routine and the calendar say nothing about the business ----
  if (cats.has('routine-admin') || NOISE.test(text)) return [];
  const intent = CONSIDER.test(text);

  // A company winning an insolvent business under a resolution plan is buying it, not in trouble.
  if (/\b(?:successful )?resolution applicant\b|\bresolution plan\b[^.]{0,80}\b(?:approv\w+|implement\w+|acqui\w+)\b/.test(text) && !/\b(?:of|for) the company\b/.test(text)) {
    return [{ type: 'deal', kind: 'acquisition', weight: /\bapprov\w+|implement\w+|complet\w+/.test(text) ? 1 : 0.7 }];
  }
  // ---- governance and distress first: they override everything else on the same filing ----
  if (DISTRESS.test(text) && !NOT_DISTRESS.test(text)) {
    // The exchange's label alone ("Corporate Insolvency Resolution Process") is also how a creditor or
    // a bidder reports somebody else's CIRP; only the company's own words make it the company's.
    const own = /\b(?:the company|our company|undergoing|admitted|resolution professional|\birp\b|\brp\b|committee of creditors|\bcoc\b|public announcement|form g|corporate debtor|default(?:ed)?|one time settlement|\bots\b|wilful defaulter)\b/.test(text);
    add('distress', { weight: own ? (/\b(?:admitted|initiated|commencement of cirp|declared)\b/.test(text) ? 1.2 : 0.8) : 0.2 });
  }
  if (/\bresolution plan\b/.test(text) && /\b(?:acqui\w+|implementation|approv\w+)\b/.test(text) && NOT_DISTRESS.test(text)) return [{ type: 'deal', kind: 'acquisition', weight: 0.9 }];
  if (AUDITOR_EXIT.test(text) && !INTERNAL_AUDITOR.test(text)) add('governance', { kind: 'auditor-exit', weight: 1.2 });
  else if (FRAUD.test(text) && !NOT_FRAUD.test(text)) add('governance', { kind: 'fraud', weight: 1.3 });
  else if (RESULT_DELAY.test(text)) add('governance', { kind: 'results-delay', weight: 0.9 });
  else if (TOP_EXIT.test(text)) add('governance', { kind: 'top-exit', weight: /\bappoint\w*/.test(text) ? 0.45 : 0.7 });
  if (out.length) return out;

  // ---- credit ratings ----
  if ((cats.has('credit-rating') || (RATING.test(text) && /\brating\b/.test(text))) && !/\besg\b/.test(text)) {
    if (DOWNGRADE.test(text)) return [{ type: 'rating-down', weight: 1 }];
    if (UPGRADE.test(text) && !/\bdowngrad/.test(text)) return [{ type: 'rating-up', weight: 1 }];
    if (cats.has('credit-rating')) return [];
  }

  // ---- inspections ----
  if ((cats.has('quality-inspection') || (INSPECTION.test(text) && (FDA_ADVERSE.test(text) || FDA_CLEAN.test(text)))) && FDA_CONTEXT.test(text) && !NOT_FDA.test(text)) {
    if (FDA_CLEAN.test(text) && !/\bwarning letter\b(?![^.]{0,30}\b(?:closed|lifted|closure))|\bimport alert\b(?![^.]{0,30}\b(?:lifted|removed))/.test(text)) {
      return [{ type: 'inspection-clean', weight: /\bvai\b|voluntary action/.test(text) ? 0.6 : 1 }];
    }
    if (FDA_ADVERSE.test(text)) return [{ type: 'inspection-adverse', weight: /\bwarning letter|import alert|\boai\b|official action/.test(text) ? 1.2 : 0.55 }];
  }

  // ---- operations ----
  if (RESUMED.test(text)) return [{ type: 'disruption-resolved', weight: 1 }];
  if ((cats.has('operations-disruption') || DISRUPT.test(text)) && DISRUPT.test(text) && SITE.test(text) && !NOT_SITE.test(text) && (INCIDENT.test(text) || !LIVE.test(text))) {
    return [{ type: 'disruption', weight: /\b(?:fire|explosion|blast)\b/.test(text) ? 1.1 : /\binsurance claim\b/.test(text) ? 0.4 : 0.9 }];
  }

  // ---- orders ----
  const legal = LEGAL_ORDER.test(text);
  if (cats.has('order-loss') || /\b(?:order|contract|loa)s?\b[^.]{0,40}\b(?:cancel\w*|terminat\w*|foreclos\w*|short[- ]?clos\w*|withdrawn|revoked)\b/.test(text)) {
    if (!legal) return [{ type: 'order-loss', weight: 1 }];
  }
  const orderish = cats.has('order-win') || sig.filingRule === 'order or contract award' ||
    (/\b(?:award of order|receipt of order|bagging|receiving of orders)\b/.test(text)) ||
    (ORDER.test(text) && COMMERCIAL.test(text) && /\b(?:order|contract|loa|loi|letter of (?:award|intent)|ppa|power purchase agreement|bidder)\b/.test(text));
  if (orderish && !legal && !/\bmanagement (?:contract|agreement)|\bfranchise|\blease\b|leave and licen/.test(text)) {
    const kind = /\bppa\b|power purchase agreement/.test(text) ? 'ppa' : L1.test(text) ? 'l1' : /\bletter of (?:intent|award)|\bloi\b|\bloa\b/.test(text) ? 'loa' : 'order';
    add('order-win', { kind, weight: kind === 'l1' ? 0.7 : kind === 'loa' ? 0.9 : 1, govt: GOVT.test(text), export: EXPORT.test(text) });
    return out;
  }

  // ---- legal: a win, or an action against the company ----
  if ((cats.has('legal-regulatory') || (legal && LEGAL_CONTEXT.test(text))) && !NOT_LEGAL.test(text)) {
    if (LEGAL_WIN.test(text)) return [{ type: 'legal-win', weight: 1 }];
    if (/\bfine (?:levied|imposed) by (?:the )?(?:stock )?exchanges?\b|\bcomments? (?:of (?:the )?board )?on (?:the )?fine\b/.test(text)) return [{ type: 'legal-risk', kind: 'compliance', weight: 0.25 }];
    if (LEGAL_RISK.test(text) || cats.has('legal-regulatory')) {
      const routine = /\bpendency of (?:any )?litigation|\bupdate on (?:the )?(?:hearing|litigation|matter|case)|\bactions? (?:initiated|taken) or orders passed\b/.test(text) && !/\d/.test(text.replace(/\b(?:sub-para|para|regulation|reg|section)\s*\d+\w*/g, ''));
      return [{ type: 'legal-risk', weight: routine ? 0.35 : 1, kind: /\b(?:income[- ]tax|gst|cgst|sgst|igst|tax|customs|excise)\b/.test(text) ? 'tax' : /\bsebi\b/.test(text) ? 'sebi' : /\b(?:search|seizure|raid|survey|enforcement directorate|cbi)\b/.test(text) ? 'search' : 'litigation' }];
    }
  }

  // ---- capacity: live, then planned (never the customer's plant inside an order's scope) ----
  if (!ORDER_SCOPE.test(text) && !CLIENT_PROJECT.test(text)) {
    if ((LIVE.test(text) || sig.filingRule === 'commercial production start') && CAPACITY_NOUN.test(text) && !intent) {
      add('capacity-live', { weight: /\btrial (?:production|run)\b/.test(text) ? 0.6 : /\binaugurat\w*/.test(text) ? 0.8 : 1 });
    } else if (cats.has('capacity-expansion') || PLAN.test(text)) {
      if (!intent || /\bapprov\w*/.test(text)) add('capacity-plan', { weight: /\bcapex|capital expenditure\b/.test(text) && !/\bcapacit|plant|facility|line|mw|tpa|unit\b/.test(text) ? 0.5 : 1 });
    }
  }

  // ---- approvals, launches, network ----
  if ((cats.has('product-approval') || APPROVAL_WORD.test(text)) && (APPROVAL_REGULATOR.test(text) || FINANCIAL_LICENCE.test(text)) && !NOT_PRODUCT_APPROVAL.test(text)) {
    add('approval', { weight: /\btentative\b/.test(text) ? 0.6 : /\bpatent\b/.test(text) ? 0.5 : 1 });
  } else if (LAUNCH.test(text) && !NOT_LAUNCH.test(text) && (cats.has('product-approval') || /\b(?:product|brand|model|variant|drug|tablet|injection|formulation|vehicle|suv|ev|scooter|motorcycle|range|portfolio|platform|service|plan|series|project)\b/.test(text))) {
    add('launch', { weight: 1 });
  }
  if (NETWORK.test(text) && !out.length) add('network', { weight: 1 });

  // ---- deals and restructuring ----
  if (VALUE_UNLOCK.test(text) && !VALUE_UNLOCK_NOISE.test(text) && !out.length) {
    add('value-unlock', { weight: /\b(?:approv\w*|sanction\w*|effective|record date for (?:the )?(?:demerger|scheme))\b/.test(text) ? 1.1 : 0.8 });
  }
  if (!out.length && (cats.has('acquisition') || ACQUIRE.test(text)) && ACQUIRE.test(text) && !NOT_ACQUIRE.test(text) && (!INTRA_GROUP.test(text) || BECOMES_SUBSIDIARY.test(text))) {
    add('deal', { kind: 'acquisition', weight: ACQUISITION_COMPLETED.test(text) ? 1.15 : intent ? 0.5 : 0.9 });
  } else if (!out.length && (cats.has('partnership-jv') || PARTNER.test(text)) && PARTNER.test(text)) {
    add('deal', { kind: 'partnership', weight: intent ? 0.35 : /\bmou\b|memorandum of understanding|framework/.test(text) ? 0.45 : 0.7 });
  }

  // ---- capital ----
  if (!out.length) {
    if (BUYBACK.test(text)) add('capital-return', { kind: 'buyback', weight: intent ? 0.6 : 1.2 });
    else if (BONUS.test(text) && !intent) add('capital-return', { kind: 'bonus', weight: 0.55 });
    else if (SPECIAL_DIV.test(text) && !intent) add('capital-return', { kind: 'special-dividend', weight: 0.8 });
    else if (EQUITY_RAISE.test(text) && !EMPLOYEE_STOCK.test(text) && !/\bnon[- ]convertible|\bncds?\b|\bdebentures?\b|commercial paper/.test(text)) {
      if (TO_PROMOTER.test(text)) add('promoter-infusion', { weight: intent ? 0.6 : 1 });
      else add('growth-capital', { weight: 1, kind: /\bqip\b|qualified institution/.test(text) ? 'qip' : /\brights\b/.test(text) ? 'rights' : 'preferential' });
    }
  }

  // ---- business updates ----
  if (!out.length && (cats.has('business-update') || BUSINESS_UPDATE.test(text)) && BUSINESS_UP.test(text) && !/\b(?:declin\w*|decreas\w*|lower|fell|down by|degrowth|contraction)\b/.test(text)) {
    add('business-update', { weight: 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SIZE, SECTOR AND TIME
// ---------------------------------------------------------------------------------------------

/** How material an amount is, against the latest quarter's revenue first and market cap second. */
export function materiality(amountCr, { quarterRevenueCr = null, mcapCr = null, type = '' } = {}) {
  if (!(amountCr > 0)) return { factor: type === 'order-win' ? 0.75 : type === 'legal-risk' ? 0.5 : 1, basis: null };
  if (type !== 'legal-risk' && quarterRevenueCr > 0) {
    const r = amountCr / quarterRevenueCr;
    const factor = r >= 2 ? 2.3 : r >= 1 ? 2 : r >= 0.5 ? 1.6 : r >= 0.25 ? 1.3 : r >= 0.1 ? 1 : r >= 0.03 ? 0.7 : 0.4;
    return { factor, basis: 'revenue', ratio: r };
  }
  if (mcapCr > 0) {
    const r = amountCr / mcapCr;
    const factor = type === 'legal-risk'
      ? (r >= 0.05 ? 2.4 : r >= 0.02 ? 1.7 : r >= 0.005 ? 1.0 : r >= 0.001 ? 0.45 : 0.15)
      : (r >= 0.15 ? 2.1 : r >= 0.05 ? 1.6 : r >= 0.02 ? 1.25 : r >= 0.005 ? 0.9 : r >= 0.001 ? 0.55 : 0.3);
    return { factor, basis: 'mcap', ratio: r };
  }
  // Absolute size is the only reading left, and a softer one.
  return { factor: amountCr >= 1000 ? 1.4 : amountCr >= 100 ? 1 : amountCr >= 10 ? 0.7 : 0.4, basis: 'absolute' };
}

export const decay = (ageDays, life = 60) => (ageDays <= 0 ? 1 : Math.pow(0.5, ageDays / life));

/** Diminishing returns within one catalyst type: the second order win counts less than the first. */
const STACK = [1, 0.6, 0.42, 0.3, 0.22, 0.16, 0.12, 0.1];
function stacked(points) {
  return points.sort((a, b) => b - a).reduce((sum, p, i) => sum + p * (STACK[i] ?? 0.08), 0);
}
const saturate = (raw, max, scale) => max * (1 - Math.exp(-Math.max(0, raw) / scale));

// ---------------------------------------------------------------------------------------------
// EARNINGS
// ---------------------------------------------------------------------------------------------

const pctOf = (m) => (m && m.kind === 'normal' && Number.isFinite(Number(m.pct)) ? Number(m.pct) : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Points for the latest filed quarter: { points (signed), facts, kind }. */
export function earningsReading(result) {
  if (!result) return null;
  const rev = pctOf(result.revenue), pat = pctOf(result.netProfit), gp = pctOf(result.grossProfit);
  const patKind = result.netProfit?.kind || null;
  let points = 0;
  if (rev != null) points += clamp(rev * 0.35, -8, 12);
  const smallBase = Math.abs(Number(result.netProfit?.prior) || 0) < 5 && Math.abs(Number(result.netProfit?.current) || 0) < 10;
  if (pat != null) points += clamp(pat * 0.15, -12, 14) * (smallBase ? 0.5 : 1);
  if (gp != null) points += clamp(gp * 0.08, -4, 4);
  if (patKind === 'turnaround') points += 14;
  else if (patKind === 'loss-narrowed') points += 4;
  else if (patKind === 'slipped-to-loss') points -= 16;
  else if (patKind === 'loss-widened') points -= 8;
  else if (patKind === 'loss-flat') points -= 3;
  const leverage = rev != null && pat != null && rev > 5 && pat > rev + 10;
  if (leverage) points += 3;
  return { points, rev, pat, gp, patKind, leverage, smallBase };
}

// ---------------------------------------------------------------------------------------------
// PRICE
// ---------------------------------------------------------------------------------------------

export function priceReading(t) {
  if (!t) return null;
  let points = 0;
  const notes = [];
  if (t.above_200dma) { points += 2; notes.push('above its 200-day average'); }
  if (t.above_50dma) points += 1.5;
  const rs = Number(t.relative_strength_6m);
  if (Number.isFinite(rs)) {
    if (rs >= 0.2) { points += 3; notes.push(`outperformed the index by ${Math.round(rs * 100)} pp over six months`); }
    else if (rs >= 0.05) { points += 2; notes.push(`outperformed the index by ${Math.round(rs * 100)} pp over six months`); }
  }
  if (t.consolidation_breakout?.breaks_out) { points += t.consolidation_breakout.volume_confirm ? 3 : 1.5; notes.push(t.consolidation_breakout.volume_confirm ? 'broke out of its base on volume' : 'broke out of its base'); }
  if (Number(t.high_proximity_pct) >= 0.93) { points += 1.5; notes.push('trading near its 52-week high'); }
  if (t.golden_cross) points += 0.5;
  const weak = !t.above_200dma && Number.isFinite(rs) && rs <= -0.15;
  return { points: clamp(points, 0, 10), notes, weak, rs: Number.isFinite(rs) ? rs : null };
}

/** Return since a date, from the captured close history (adjusted). Null where it does not reach. */
export function moveSince(t, day) {
  const rows = t?.closeHistory?.rows;
  if (!Array.isArray(rows) || !rows.length || !day) return null;
  const start = rows.find((r) => r[0] >= day) || null;
  const end = rows[rows.length - 1];
  if (!start || !(start[1] > 0) || start === end) return null;
  return { pct: (end[1] / start[1] - 1) * 100, from: start[0], to: end[0] };
}

// ---------------------------------------------------------------------------------------------
// ONE COMPANY
// ---------------------------------------------------------------------------------------------

const fmtCr = (v) => {
  if (!(v > 0)) return null;
  if (v >= 100) return `₹${Math.round(v).toLocaleString('en-IN')} Cr`;
  if (v >= 1) return `₹${v.toFixed(1)} Cr`;
  return `₹${(v * 100).toFixed(1)} lakh`;
};
const fmtPct = (v, digits = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%`;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

export function capBand(cr) {
  if (!(cr > 0)) return null;
  return cr >= 100000 ? 'Large' : cr >= 30000 ? 'Mid' : cr >= 5000 ? 'Small' : 'Micro';
}

const RESULT_KIND_WORDS = {
  turnaround: 'turned to profit', 'loss-narrowed': 'loss narrowed', 'slipped-to-loss': 'slipped to a loss',
  'loss-widened': 'loss widened', 'loss-flat': 'loss unchanged', flat: 'profit flat', 'from-zero': 'profit from zero',
};

function resultSentence(result, quarter) {
  const rev = pctOf(result.revenue), pat = pctOf(result.netProfit);
  const patWords = pat != null ? `net profit ${fmtPct(pat)}${pat >= 300 ? ' (low base)' : ''}` : RESULT_KIND_WORDS[result.netProfit?.kind] || null;
  const parts = [patWords, rev != null ? `revenue ${fmtPct(rev)}` : null].filter(Boolean);
  if (!parts.length) return null;
  return `${quarter ? quarter + ' ' : ''}${parts.join(', ')} YoY${result.basis ? ` (${String(result.basis).toLowerCase()})` : ''}`;
}

/**
 * Score one company from everything known about it.
 *
 * `c` = { ticker, name, group, groupLabel, sectorInferred, sector, industry, inBook, mcapCr,
 *         price: { cmp, asOf, changePct }, technicals, result, quarter, filings[], trades[],
 *         investorMoves[], brokerReports[], concall, fiiDii, nextResult }
 */
export function scoreCompany(c, { now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const items = [];
  const quarterRevenueCr = Number(c.result?.revenue?.current) > 0 ? Number(c.result.revenue.current) : null;
  const mcapCr = c.mcapCr > 0 ? c.mcapCr : null;
  const group = c.group || null;

  // ---- filings ----
  for (const f of c.filings || []) {
    const age = daysBetween(f.date, today);
    if (!(age >= -1) || age > WINDOW_DAYS) continue;
    for (const hit of f.catalysts) {
      const def = CATALYSTS[hit.type];
      if (!def || !def.tone) {
        if (def) items.push({ type: hit.type, kind: hit.kind || null, date: f.date, title: f.statement, url: f.url, source: f.source, points: 0, amountCr: f.amountCr ?? null });
        continue;
      }
      const size = ['order-win', 'order-loss', 'legal-risk', 'legal-win', 'deal', 'capacity-plan', 'capacity-live', 'capital-return'].includes(hit.type)
        ? materiality(f.amountCr, { quarterRevenueCr, mcapCr, type: hit.type }) : { factor: 1, basis: null };
      const sector = sectorWeight(group, hit.type);
      if (sector === 0) continue;
      const kindBoost = hit.type === 'order-win' ? (hit.export ? 1.08 : 1) : 1;
      const generic = GENERIC_STATEMENT.test(f.statement);
      const points = def.base * hit.weight * size.factor * sector * kindBoost * decay(age, def.life) * (generic && !(f.amountCr > 0) ? (hit.type === 'deal' ? 0.3 : 0.6) : 1);
      items.push({ type: hit.type, kind: hit.kind || null, date: f.date, title: f.statement, url: f.url, source: f.source, generic,
        amountCr: f.amountCr ?? null, amountBand: !!f.amountBand, ratio: size.ratio ?? null, ratioBasis: size.basis, points, govt: !!hit.govt, export: !!hit.export });
    }
  }

  // ---- earnings ----
  const er = earningsReading(c.result);
  if (er) {
    const sentence = resultSentence(c.result, c.quarter);
    const resultDay = c.result.resultDate || today;
    const age = Math.max(0, daysBetween(resultDay, today));
    const fresh = decay(age, 120) * sectorWeight(group, 'earnings');
    const profitFell = (er.pat != null && er.pat <= -10) || ['slipped-to-loss', 'loss-widened'].includes(er.patKind);
    if (er.points > 0 && !profitFell) {
      items.push({ type: er.patKind === 'turnaround' ? 'turnaround' : 'earnings-beat', date: resultDay, title: sentence, url: c.result.url || null,
        source: 'Results', points: er.points * fresh, rev: er.rev, pat: er.pat, leverage: er.leverage });
    } else if (er.points <= -4 || (profitFell && er.pat != null && er.pat <= -25)) {
      // One weak quarter is a risk to the thesis, not a verdict on the company: it is capped.
      items.push({ type: 'earnings-miss', date: resultDay, title: sentence, url: c.result.url || null, source: 'Results', points: Math.min(14, Math.max(4, -er.points * 0.7)) * fresh, rev: er.rev, pat: er.pat });
    }
  }

  // ---- insider and deal disclosures ----
  for (const t of c.trades || []) {
    const age = daysBetween(t.date, today);
    if (!(age >= -1) || age > 120) continue;
    const def = CATALYSTS[t.type];
    if (!def) continue;
    let size = 1;
    if (t.valueCr > 0 && mcapCr) {
      const r = t.valueCr / mcapCr;
      size = t.type === 'promoter-sell' ? (r >= 0.01 ? 2 : r >= 0.003 ? 1.5 : r >= 0.0005 ? 1 : 0.5)
        : (r >= 0.005 ? 2 : r >= 0.001 ? 1.5 : r >= 0.0002 ? 1 : 0.6);
    }
    items.push({ type: t.type, date: t.date, title: t.title, url: t.url, source: t.source, valueCr: t.valueCr ?? null, who: t.who || null,
      points: def.base * (t.weight || 1) * size * decay(age, def.life) });
  }

  // ---- tracked investors' filed books ----
  for (const m of c.investorMoves || []) {
    const def = CATALYSTS[m.type];
    const age = Math.max(0, daysBetween(m.date, today));
    const size = m.type === 'investor-buy' ? (m.action === 'new' ? 1.3 : m.deltaPp >= 1 ? 1.4 : m.deltaPp >= 0.3 ? 1 : 0.6) : (m.action === 'exited' ? 1.2 : 0.7);
    items.push({ type: m.type, date: m.date, title: m.title, url: m.url || null, source: 'Investor filings', who: m.who, points: def.base * size * decay(age, def.life) });
  }

  // ---- broker calls (as printed) ----
  const brokers = new Set();
  for (const b of c.brokerReports || []) {
    const age = daysBetween(b.date, today);
    if (age > 45) continue;
    const def = CATALYSTS[b.type];
    if (!def) continue;
    const firstFromBroker = !brokers.has(b.broker);
    brokers.add(b.broker);
    const upside = Number(b.upsidePct);
    const size = b.type === 'broker-buy' ? (Number.isFinite(upside) ? clamp(0.6 + upside / 40, 0.6, 2) : 1) * (b.upgrade ? 1.3 : 1) : 1;
    items.push({ type: b.type, date: b.date, title: b.title, url: b.url, source: b.broker, upsidePct: Number.isFinite(upside) ? upside : null,
      points: firstFromBroker ? def.base * size * decay(age, def.life) : 0 });
  }

  // ---- con-call highlights (third-party analysis, reproduced with its own markers) ----
  if (c.concall?.tags?.length) {
    const age = Math.max(0, daysBetween(c.concall.date, today));
    if (age <= 120) {
      for (const tag of c.concall.tags.slice(0, 6)) {
        const up = /^▲/.test(tag), down = /^▼/.test(tag);
        if (!up && !down) continue;
        const type = up ? 'commentary-up' : 'commentary-down';
        items.push({ type, date: c.concall.date, title: tag.replace(/^[▲▼●]\s*/, ''), url: c.concall.url || null, source: 'Con-call (third-party analysis)',
          points: CATALYSTS[type].base * decay(age, CATALYSTS[type].life) });
      }
    }
  }

  // ---- institutions in the shareholding pattern ----
  if (c.fiiDii && Number.isFinite(c.fiiDii.change)) {
    const ch = c.fiiDii.change;
    if (ch >= 1) items.push({ type: 'investor-buy', date: c.fiiDii.date || today, title: `FII + DII holding up ${ch.toFixed(1)} pp in the latest shareholding pattern`, url: null, source: 'Shareholding', points: clamp(2 + ch * 1.5, 2, 7) });
    else if (ch <= -1.5) items.push({ type: 'investor-exit', date: c.fiiDii.date || today, title: `FII + DII holding down ${Math.abs(ch).toFixed(1)} pp in the latest shareholding pattern`, url: null, source: 'Shareholding', points: clamp(1 + Math.abs(ch), 1, 5) });
  }

  // ---- price ----
  const pr = priceReading(c.technicals);
  if (pr && pr.points >= 3) items.push({ type: 'price-strength', date: c.technicals.bar_date || today, title: `Stock ${pr.notes.slice(0, 2).join(' and ')}`, url: null, source: 'Technicals', points: pr.points });
  if (pr?.weak) items.push({ type: 'price-weakness', date: c.technicals.bar_date || today, title: `Below its 200-day average and lagging the index by ${Math.round(Math.abs(pr.rs) * 100)} pp over six months`, url: null, source: 'Technicals', points: 2.5 });

  // ---- one event, once ----
  const deduped = dedupe(items);
  const scored = deduped.filter((i) => CATALYSTS[i.type]?.tone);
  if (!scored.length) return null;

  // ---- pillars ----
  const byPillar = { earnings: [], growth: [], smart: [], technical: [], risk: [] };
  const byType = new Map();
  for (const i of scored) {
    const key = `${CATALYSTS[i.type].pillar}|${i.type}`;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(i.points);
  }
  for (const [key, pts] of byType) byPillar[key.split('|')[0]].push(stacked(pts));
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const pillars = {
    earnings: Math.round(clamp(sum(byPillar.earnings), 0, 30)),
    growth: Math.round(saturate(sum(byPillar.growth), 40, 26)),
    smart: Math.round(saturate(sum(byPillar.smart), 20, 15)),
    technical: Math.round(clamp(sum(byPillar.technical), 0, 10)),
  };
  const risk = Math.round(saturate(sum(byPillar.risk), 100, 30));
  const conviction = pillars.earnings + pillars.growth + pillars.smart + pillars.technical;

  // ---- priced in? ----
  const lead = scored.filter((i) => CATALYSTS[i.type].tone > 0 && ['growth', 'earnings'].includes(CATALYSTS[i.type].pillar)).sort((a, b) => b.points - a.points)[0] || null;
  const since = lead ? moveSince(c.technicals, lead.date) : null;
  const pricedIn = since && since.pct >= 25 ? clamp((since.pct - 25) / 5, 0, 8) : 0;
  const net = Math.round(conviction - risk * 0.55 - pricedIn);

  const severe = scored.some((i) => (i.type === 'distress' || (i.type === 'governance' && ['auditor-exit', 'fraud'].includes(i.kind)) ||
    (i.type === 'inspection-adverse' && i.points >= 8) || i.type === 'rating-down') && daysBetween(i.date, today) <= 75);
  const fundamental = pillars.earnings + pillars.growth;
  let stance;
  if (risk >= 45 || (severe && risk >= 30) || (risk >= 28 && conviction < 30)) stance = conviction >= 40 ? 'mixed' : 'risk';
  else if (net >= 26 && fundamental >= 14) stance = 'opportunity';
  else if (conviction >= 32 && risk >= 22) stance = 'mixed';
  else stance = 'watch';
  const tier = stance === 'risk' ? (risk >= 60 ? 'High risk' : 'Elevated risk')
    : net >= 62 ? 'High conviction' : net >= 45 ? 'Strong' : net >= 30 ? 'Building' : 'Early';

  const ordered = [...deduped].sort((a, b) => (b.points - a.points) || (a.date < b.date ? 1 : -1));
  const positives = ordered.filter((i) => CATALYSTS[i.type]?.tone > 0 && i.points > 0.3);
  const negatives = ordered.filter((i) => CATALYSTS[i.type]?.tone < 0 && i.points > 0.3);

  // ---- the order book, summed ----
  const orders = deduped.filter((i) => i.type === 'order-win' && daysBetween(i.date, today) <= 120);
  const orderTotal = orders.reduce((s, i) => s + (i.amountCr > 0 ? i.amountCr : 0), 0);
  const orderSummary = orders.length ? {
    count: orders.length, sized: orders.filter((i) => i.amountCr > 0).length, totalCr: orderTotal > 0 ? Math.round(orderTotal * 10) / 10 : null,
    toQuarterRevenue: orderTotal > 0 && quarterRevenueCr ? Math.round((orderTotal / quarterRevenueCr) * 100) / 100 : null,
    toMcapPct: orderTotal > 0 && mcapCr ? Math.round((orderTotal / mcapCr) * 1000) / 10 : null,
    since: orders.map((o) => o.date).sort()[0], govt: orders.filter((o) => o.govt).length, export: orders.filter((o) => o.export).length,
    banded: orders.some((o) => o.amountBand),
  } : null;

  const thesis = composeThesis({ c, stance, positives, negatives, orderSummary });
  const playbook = playbookFor(group);
  const themes = [...new Set(scored.filter((i) => i.points > 0.5).map((i) => CATALYSTS[i.type].theme))];
  return {
    ticker: c.ticker, isin: c.isin || null, bseCode: c.bseCode || null, company: c.name, inBook: !!c.inBook,
    sector: c.sector || null, industry: c.industry || null, group, groupLabel: c.groupLabel || null, sectorInferred: !!c.sectorInferred,
    mcapCr, capBand: capBand(mcapCr), price: c.price || null,
    stance, tier, conviction, risk, net, pillars,
    pricedIn: since ? { pct: Math.round(since.pct * 10) / 10, from: since.from, penalty: Math.round(pricedIn * 10) / 10 } : null,
    headline: thesis.headline, why: thesis.why, risks: thesis.risks,
    lens: playbook.lens, watch: watchList({ playbook, positives, negatives, orderSummary, c }),
    orderSummary, themes,
    result: c.result ? { quarter: c.quarter || null, date: c.result.resultDate || null, basis: c.result.basis || null,
      revenueCr: quarterRevenueCr, revenuePct: pctOf(c.result.revenue), profitPct: pctOf(c.result.netProfit), profitKind: c.result.netProfit?.kind || null,
      profitCr: Number.isFinite(Number(c.result.netProfit?.current)) ? Number(c.result.netProfit.current) : null } : null,
    technical: pr ? { rs6mPct: pr.rs != null ? Math.round(pr.rs * 1000) / 10 : null, above200: !!c.technicals.above_200dma,
      nearHigh: Number(c.technicals.high_proximity_pct) >= 0.93, breakout: !!c.technicals.consolidation_breakout?.breaks_out,
      high52: c.technicals.high_52w ?? null, low52: c.technicals.low_52w ?? null } : null,
    nextResult: c.nextResult || null,
    evidence: ordered.slice(0, 14).map(publicItem),
    latestCatalystAt: [...scored].sort((a, b) => (a.date < b.date ? 1 : -1))[0]?.date || null,
  };
}

function publicItem(i) {
  const out = { type: i.type, date: i.date, title: i.title, source: i.source || null, url: i.url || null, points: Math.round(i.points * 10) / 10 };
  for (const key of ['kind', 'generic', 'amountCr', 'amountBand', 'ratio', 'ratioBasis', 'valueCr', 'who', 'upsidePct', 'govt', 'export']) {
    if (i[key] !== undefined && i[key] !== null && i[key] !== false) out[key] = typeof i[key] === 'number' ? Math.round(i[key] * 100) / 100 : i[key];
  }
  return out;
}

/** The same event twice — a BSE filing and its NSE twin — is kept once, the better-described copy. */
function dedupe(items) {
  const kept = new Map();
  const sig = (i) => {
    const amount = i.amountCr > 0 ? Math.round(i.amountCr) : '';
    const words = String(i.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 5).join(' ');
    return amount ? `${i.type}|${i.date}|${amount}` : `${i.type}|${i.date}|${words}`;
  };
  for (const i of items) {
    // Same type, same day, same company: exchange twins and repeated intimations of one event.
    const looseKey = `${i.type}|${i.date}`;
    const key = ['order-win', 'legal-risk', 'deal', 'investor-buy', 'investor-exit', 'broker-buy', 'broker-sell', 'commentary-up', 'commentary-down', 'promoter-buy', 'promoter-sell'].includes(i.type) ? sig(i) : looseKey;
    const held = kept.get(key);
    if (!held) { kept.set(key, i); continue; }
    const better = (i.amountCr > 0) - (held.amountCr > 0) || i.points - held.points || String(i.title).length - String(held.title).length;
    if (better > 0) kept.set(key, i);
  }
  // An unsized "has informed the exchange about bagging of orders" on the day a sized order exists
  // is the same disclosure.
  const sizedOrderDays = new Set([...kept.values()].filter((i) => i.type === 'order-win' && i.amountCr > 0).map((i) => i.date));
  const out = [...kept.values()].filter((i) => !(i.type === 'order-win' && !(i.amountCr > 0) && sizedOrderDays.has(i.date)));
  // ONE PROCESS, ONE CATALYST. A buyback files a daily report for weeks, a demerger a notice at every
  // step, a CIRP an update every month; each repeats the same event. Within PROCESS_DAYS only the
  // strongest copy of these types counts (an unsized legal update collapses the same way).
  const result = [];
  const held = new Map();
  const near = new Map();
  for (const i of out.sort((a, b) => b.points - a.points)) {
    // Repeated updates on one project ("Update on commissioning of the BESS project", then "…at
    // Rajasthan") share most of their words; within NEAR_DAYS they are one catalyst.
    // Two different stated amounts are two different events, however alike the wording ("KEC wins
    // orders of Rs 1,303 crore", then "…Rs 1,030 crore"): only amounts that agree can be one.
    const words = titleWords(i.title);
    const amount = i.amountCr > 0 ? i.amountCr : null;
    const sameAmount = (d) => d.amount === amount || (d.amount && amount && Math.abs(d.amount - amount) <= 0.05 * Math.max(d.amount, amount));
    const list0 = near.get(i.type) || [];
    if (words.size >= 2 && list0.some((d) => sameAmount(d) && Math.abs(Date.parse(d.date) - Date.parse(i.date)) <= NEAR_DAYS * DAY && jaccard(d.words, words) >= 0.5)) continue;
    list0.push({ date: i.date, words, amount }); near.set(i.type, list0);
    const process = PROCESS_TYPES.has(i.type) || (i.type === 'legal-risk' && !(i.amountCr > 0));
    if (!process) { result.push(i); continue; }
    const list = held.get(i.type) || [];
    if (list.some((d) => Math.abs(Date.parse(d) - Date.parse(i.date)) <= PROCESS_DAYS * DAY)) continue;
    list.push(i.date); held.set(i.type, list); result.push(i);
  }
  return result;
}
const PROCESS_TYPES = new Set(['capital-return', 'value-unlock', 'growth-capital', 'promoter-infusion', 'distress', 'governance', 'rating-up', 'rating-down',
  'inspection-clean', 'inspection-adverse', 'disruption', 'disruption-resolved', 'capacity-plan', 'network', 'pledge']);
const PROCESS_DAYS = 30;
const NEAR_DAYS = 21;
const STOP = new Set(['update', 'updates', 'intimation', 'regarding', 'disclosure', 'about', 'with', 'from', 'that', 'this', 'company', 'limited', 'project', 'further', 'pursuant', 'under', 'regulation', 'their', 'have', 'been', 'into', 'shares', 'equity']);
function titleWords(title) {
  return new Set(String(title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
}
function jaccard(a, b) {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / Math.max(1, a.size + b.size - both);
}

// ---------------------------------------------------------------------------------------------
// THE THESIS — composed from the facts, never beyond them
// ---------------------------------------------------------------------------------------------

function factLine(i, ctx) {
  switch (i.type) {
    case 'order-win': return null; // summarised once, below
    case 'earnings-beat': case 'turnaround': case 'earnings-miss': return i.title;
    case 'promoter-buy': case 'promoter-sell': return i.title;
    case 'broker-buy': return `${i.source}: ${i.title}`;
    case 'broker-sell': return `${i.source}: ${i.title}`;
    default: return i.title;
  }
}

function orderLine(o) {
  if (!o) return null;
  const size = o.totalCr ? `${o.banded ? 'At least ' : ''}${fmtCr(o.totalCr)} of new orders` : `${o.count} new order${o.count > 1 ? 's' : ''}`;
  const filings = o.count > 1 ? ` across ${o.count} filings` : '';
  const ratio = o.toQuarterRevenue >= 0.05 ? ` — ${o.toQuarterRevenue.toFixed(o.toQuarterRevenue >= 10 ? 0 : 1)}× the latest quarter's revenue`
    : o.toMcapPct >= 0.5 ? ` — ${o.toMcapPct.toFixed(1)}% of market cap` : '';
  const who = o.govt ? ' (incl. government/PSU)' : o.export ? ' (incl. export)' : '';
  return `${size}${filings} since ${o.since}${ratio}${who}`;
}

// An exchange label standing in for a statement: it says what kind of filing this is, not what happened.
const GENERIC_STATEMENT = /^(?:update[- ]?)?(?:acquisition(?: \(including agreement to acquire\))?|acquisition of 'to be incorporated companies'|bagging\/receiving of orders\/contracts(?:\s*\(sub-para 4-para b\))?|awarding of order\(s\)\/contract\(s\)|receiving of new orders|new orders? received|capacity addition(?:\s*\(sub-para 3-para b\))?|commencement of commercial production\/operations|agreements,contracts,arrangements,mou|actions? (?:initiated|taken)(?:\/taken)? or orders passed(?: \(sub-para 20\))?|pendency of (?:any )?litigation.*|product launch|credit rating(?:- (?:new|revision))?|scheme of arrangement|other restructuring)$/i;

// What leads the sentence: what changes earnings first, who is buying next, the tape last.
const HEADLINE_RANK = { growth: 0, earnings: 0, smart: 1, technical: 2 };
function composeThesis({ c, stance, positives, negatives, orderSummary }) {
  const why = [];
  const seen = new Set();
  const push = (line, list = why) => { const v = String(line || '').trim(); if (v && !seen.has(v)) { seen.add(v); list.push(v); } };
  let orderPushed = false;
  const ranked = [...positives].sort((a, b) => (!!a.generic - !!b.generic) || (HEADLINE_RANK[CATALYSTS[a.type].pillar] - HEADLINE_RANK[CATALYSTS[b.type].pillar]) || b.points - a.points);
  const perType = new Map();
  for (const i of ranked) {
    if (i.type === 'order-win') { if (!orderPushed) { push(orderLine(orderSummary)); orderPushed = true; } continue; }
    const n = perType.get(i.type) || 0;
    if (n >= 2) continue;
    perType.set(i.type, n + 1);
    push(factLine(i, c));
    if (why.length >= 5) break;
  }
  const risks = [];
  for (const i of negatives) { push(factLine(i, c), risks); if (risks.length >= 4) break; }
  const headline = stance === 'risk' ? [...risks.slice(0, 2)].join(' · ') || why[0]
    : stance === 'mixed' ? [why[0], risks[0]].filter(Boolean).join(' · ')
      : why.slice(0, 2).join(' · ') || risks.slice(0, 2).join(' · ');
  return { headline: clip(headline || '', 240), why, risks };
}

function watchList({ playbook, positives, negatives, orderSummary }) {
  const out = [];
  const types = new Set([...positives, ...negatives].map((i) => i.type));
  if (orderSummary?.totalCr) out.push(`Execution timeline of the ${fmtCr(orderSummary.totalCr)} of new orders`);
  if (types.has('capacity-live')) out.push('Ramp-up and utilisation of the newly commissioned capacity');
  if (types.has('capacity-plan')) out.push('Funding and commissioning timeline of the announced expansion');
  if (types.has('approval')) out.push('Launch timing and addressable market of the approved products');
  if (types.has('inspection-adverse')) out.push('Regulator follow-up on the inspection and its impact on supplies');
  if (types.has('legal-risk')) out.push('Outcome of the legal/tax matter, appeal status and any provisioning');
  if (types.has('earnings-beat') || types.has('turnaround')) out.push('Whether margins and growth sustain next quarter');
  if (types.has('deal')) out.push('Deal closure, funding and integration');
  if (types.has('value-unlock')) out.push('Regulatory approvals and record date for the restructuring');
  for (const w of playbook.watch || []) if (out.length < 5 && !out.includes(w)) out.push(w);
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------------------------
// A FILING, PREPARED ONCE
// ---------------------------------------------------------------------------------------------

/** The compact form of one filing the engine reads: statement, amount, catalysts. */
export function prepareFiling(row) {
  const catalysts = classifyFiling(row);
  if (!catalysts.length) return null;
  const statement = filingStatement(row);
  const words = [row.summary, row.headline, row.title, sourceStatement(row.description || '')].filter(Boolean).join(' • ');
  const amounts = statedAmountsCr(words);
  let amountCr = amounts.length ? Math.max(...amounts) : null, amountBand = false;
  if (!amountCr && catalysts.some((c) => c.type === 'order-win')) {
    const band = ORDER_BAND.find(([re]) => re.test(lower(words)));
    if (band) { amountCr = band[1]; amountBand = true; }
  }
  return {
    date: String(row.date || row.publishedAt || '').slice(0, 10),
    statement,
    url: row.url || null,
    source: row.source || (String(row.url || '').includes('nseindia') ? 'NSE' : 'BSE'),
    amountCr,
    amountBand,
    catalysts,
  };
}
