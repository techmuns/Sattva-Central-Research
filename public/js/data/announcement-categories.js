// data/announcement-categories.js — THE MASTER LIST OF INVESTOR-RELEVANT CATEGORIES.
//
// ONE FIXED, EDITABLE LIST, AND SEVERAL TAGS PER ITEM. Every corporate announcement, news story and
// alert is tagged against the array below — never against a free-form label a model invented — so a
// filter, a feedback vote and a ranking feature all mean the same thing everywhere. To change the
// vocabulary, edit `ANNOUNCEMENT_CATEGORY_LIST`: add an entry, rename a label, widen a pattern. Run
// `node scripts/verify-relevance.mjs`; the next announcement-index build re-tags every retained
// filing with the new list, and the browser picks it up on the next release.
//
// HOW AN ITEM IS READ. The exchange's own label first (BSE's sub-category, NSE's subject), then the
// filing's own subject line, then NSE's description with its mechanical lead-in removed
// (`sourceStatement`), and for a news story its headline, with the standfirst only as a fallback —
// several outlets fill that field with a related-links strip (see news-keywords.js, rule 0). No
// document is opened to choose a tag.
//
// FOUR RULES KEEP THE TAGS HONEST:
//  1. A tag is a TOPIC, not a verdict. "Legal, regulatory & tax actions" says what a filing is about;
//     whether it hurts is for the reader (and the AI Read, which opens the document) to say.
//  2. ROUTINE COPIES ARE EXCLUSIVE. A newspaper copy of the results advertisement is routine before it
//     is a result, so a routine match drops every other tag — it must never borrow a result's weight.
//  3. A WEAK MATCH YIELDS TO A STRONG ONE IN THE SAME GROUP. NSE's "Allotment of Securities" is a
//     preferential issue on one row and an ESOP allotment on the next; the generic word only tags the
//     row when nothing more specific in the group did.
//  4. NOTHING IS GUESSED. A filing no rule recognises is `other`, not a nearest guess, and stays fully
//     visible — "unclassified" is not "unimportant".
//
// `dims` are the prior reading of what a category usually means for an investor, on four axes the
// desk asked relevance to consider — materiality, financial impact, governance and future
// implications. They are a STARTING POINT, not a rule: the shared Important / Not important feedback
// moves each category's weight (js/data/relevance.js), and nothing here is hard-coded per example.

import { sourceStatement, isTypeOnly } from './alert-claims.js';
import { keywordById } from './news-keywords.js';

export const CATEGORY_VERSION = '2026-10-01-v2';

/** The groups the filter panel lists categories under, in order. */
export const CATEGORY_GROUPS = [
  { id: 'earnings', label: 'Earnings & business updates' },
  { id: 'business', label: 'Business & operations' },
  { id: 'deals', label: 'Deals & structure' },
  { id: 'capital', label: 'Capital & shareholder returns' },
  { id: 'ownership', label: 'Ownership' },
  { id: 'governance', label: 'Governance & management' },
  { id: 'regulatory', label: 'Legal & regulatory' },
  { id: 'calendar', label: 'Meetings & investor calendar' },
  { id: 'admin', label: 'Routine & other' },
];

const kw = (id) => keywordById(id)?.test || null;

/**
 * THE MASTER LIST. Order matters only for display: tags are printed in this order.
 *
 *  id      stable key used by filters, feedback and the server index — never rename one in place;
 *          retire it and add a new id, or old feedback attaches to the wrong topic.
 *  label   what every surface prints.
 *  group   one of CATEGORY_GROUPS.
 *  hint    the tooltip and the filter panel's description.
 *  dims    { materiality, financial, governance, future } on a 0–4 scale (see relevance.js).
 *  label/text/weak  patterns over the exchange label / the subject, description or headline / a weak
 *          generic word (rule 3). Strings are compiled case-insensitive.
 *  not     a pattern that cancels this category's TEXT match (never a label match).
 *  routine true for the one exclusive routine category (rule 2).
 */
export const ANNOUNCEMENT_CATEGORY_LIST = [
  {
    id: 'results', label: 'Results', group: 'earnings',
    hint: 'Quarterly and annual financial results, and exchange clarifications about them.',
    dims: { materiality: 3, financial: 3, governance: 0, future: 1 },
    label_: ['financial results?', '^results?$', 'clarification\\s*-?\\s*financial results', 'reply to clarification-?\\s*financial results', 'integrated filing.{0,20}financ'],
    text: ['\\b(?:un)?audited\\b.{0,80}\\bfinancial results?\\b', '\\bfinancial results?\\b.{0,60}\\b(?:quarter|half[- ]year|year|period|q[1-4])\\b',
      '\\bquarterly results?\\b', '\\bq[1-4]\\s?(?:fy)?\\s?[\'’]?\\d{2}\\b.{0,40}\\b(?:results?|profit|loss|revenue|earnings|ebitda)\\b',
      '\\b(?:net|consolidated|standalone)\\s+(?:profit|loss)\\b', '\\bprofit (?:after tax|before tax)\\b',
      '\\bresults?\\s+(?:beat|miss(?:es|ed)?|in line)\\b', '\\b(?:q[1-4]|quarterly|annual)\\s+earnings\\b'],
  },
  {
    id: 'business-update', label: 'Business update & guidance', group: 'earnings',
    hint: 'Monthly or quarterly business and operating updates, provisional figures, sales volumes and guidance.',
    dims: { materiality: 2, financial: 2, governance: 0, future: 2 },
    label_: ['monthly business updates?', 'business updates?', 'operational updates?', 'provisional'],
    text: ['\\bperformance\\b.{0,40}\\b(?:month|quarter)\\b', '\\bproduction volumes?\\b', '\\b(?:business|operational|operating|quarterly|key business) updates?\\b', '\\bprovisional (?:financial )?(?:figures|numbers|update|business|data)\\b',
      '\\b(?:monthly|quarterly)\\s+(?:sales|volumes?|production|disbursements?|deposits?|business|operating)\\b', '\\bsales (?:volumes?|numbers|figures|update)\\b',
      '\\b(?:revenue|earnings|growth|margin)\\s+guidance\\b', '\\bguidance\\b.{0,30}\\b(?:raise|cut|revis|maintain|reiterat)\\w*', '\\b(?:auto|vehicle|tractor|two-wheeler)\\s+sales\\b',
      '\\bunits? sold\\b', '\\btotal (?:sales|dispatches)\\b', '\\bloan book\\b|\\bdeposit growth\\b|\\baum\\b.{0,20}\\b(?:grew|rose|crossed|up)\\b'],
  },
  {
    id: 'order-win', label: 'Order / contract win', group: 'business',
    hint: 'Orders, contracts, letters of award or intent, and bids won.',
    dims: { materiality: 3, financial: 3, governance: 0, future: 2 },
    label_: ['award of order', 'receipt of order', 'bagging\\s*/?\\s*receiving of orders', 'orders?\\s*/\\s*contracts?'],
    text: [kw('order'), kw('receipt-of-order'), '\\bletter of (?:award|intent|acceptance)\\b', '\\b(?:lowest|l-?1|successful) bidder\\b',
      '\\b(?:work|purchase|supply|export|repeat)\\s+orders?\\b', '\\bbags?\\b.{0,60}\\b(?:order|contract|project)s?\\b'],
    // An order a court, tribunal or tax officer PASSED is filed under the very same exchange label
    // ("Award of Order / Receipt of Order") — the trap `announcementSignal` names. Its own words
    // cancel the tag, whether it came from the label or the text; Legal & regulatory reads it instead.
    not: ['\\b(?:cancel\\w*|terminat\\w*|withdraw\\w*|foreclos\\w*|short[- ]?clos\\w*)\\b.{0,20}\\b(?:order|contract|letter of (?:award|intent|acceptance)|loa|loi)\\b',
      '\\b(?:court|tribunal|nclt|nclat|income[- ]?tax|gst|goods and services tax|tax department|assessment|assessing|penalt\\w*|show[- ]?cause|appellate|appeal order|commissioner|customs|excise|adjudicat\\w*|refund|rectification|demand (?:order|notice)|enforcement directorate|first motion|second motion|sebi|police|judg(?:e)?ment|stay order|interim order|scheme of (?:arrangement|amalgamation)|sanction\\w* (?:the|of the|of) scheme)\\b'],
    notLabel: true,
  },
  {
    id: 'order-loss', label: 'Order cancellation / loss', group: 'business',
    hint: 'Cancelled, terminated or withdrawn orders and contracts.',
    dims: { materiality: 3, financial: 3, governance: 0, future: 1 },
    text: ['\\b(?:order|contract|agreement|loa)s?\\s+(?:has been |have been |was |were )?(?:cancel\\w*|terminat\\w*|withdrawn|revoked|foreclosed|short[- ]?closed)\\b',
      '\\b(?:cancel\\w*|terminat\\w*|foreclos\\w*|withdrawal) of (?:the )?(?:order|contract|agreement|letter of (?:award|intent)|loa)\\b'],
  },
  {
    id: 'capacity-expansion', label: 'Capacity, capex & commissioning', group: 'business',
    hint: 'Capacity additions, capital expenditure, new plants, commissioning and start of commercial production.',
    dims: { materiality: 2, financial: 2, governance: 0, future: 3 },
    label_: ['capacity addition', 'commencement of commercial production', 'commercial production', 'commercial operations?'],
    text: [kw('capacity-expansion'), kw('capex'), kw('commissioning'), '\\bnew (?:manufacturing|production) (?:plant|facility|unit|line)\\b',
      '\\b(?:plant|facility|capacity|unit) expansion\\b', '\\bexpansion (?:project|plan)\\b', '\\bground[- ]?breaking\\b|\\bbhoomi pujan\\b'],
  },
  {
    id: 'product-approval', label: 'Product launch & approvals', group: 'business',
    hint: 'Product launches, drug and product approvals, licences, patents and trial outcomes.',
    dims: { materiality: 2, financial: 2, governance: 0, future: 3 },
    text: ['\\bcertificate of registration\\b|\\bregistration certificate\\b', kw('product-launch'), kw('patent'), kw('trial'),
      '\\b(?:us\\s?fda|usfda|fda|ema|mhra|cdsco|dcgi|who|anvisa|tga|pmda|health canada)\\b.{0,60}\\b(?:approv\\w*|nod|clearance|tentative|authori[sz]ation|eua|grant\\w*)\\b',
      '\\b(?:final|tentative)\\s+approval\\b', '\\b(?:anda|nda|bla|dmf|505\\s?\\(?b\\)?\\s?\\(?2\\)?)\\b', '\\bmarketing authori[sz]ation\\b',
      '\\blicen[cs]e\\b.{0,30}\\b(?:granted|received|obtained|issued)\\b', '\\b(?:granted|receives?|received|obtains?|obtained)\\b.{0,40}\\blicen[cs]e\\b',
      '\\bapi licen[cs]e\\b', '\\b(?:launch(?:es|ed)?|introduc(?:es|ed))\\b.{0,40}\\b(?:in (?:india|the us|us market|europe))\\b'],
    not: ['\\b(?:board|shareholders?|members?|stock exchanges?|bse|nse)\\b.{0,20}\\bapprov'],
  },
  {
    id: 'quality-inspection', label: 'Plant inspection, recall & quality', group: 'regulatory',
    hint: 'Regulator inspections and their outcomes (Form 483, warning letters, import alerts, EIRs), product recalls and quality actions.',
    dims: { materiality: 3, financial: 2, governance: 1, future: 2 },
    text: ['\\bform\\s*-?\\s*483\\b', '\\bwarning letter\\b', '\\bimport alert\\b', '\\bofficial action indicated\\b', '\\b(?:oai|vai|nai)\\s+(?:status|classification)\\b',
      '\\bestablishment inspection report\\b|\\beir\\b', '\\b(?:us\\s?fda|usfda|fda|mhra|who|ema|regulatory)\\b.{0,40}\\b(?:inspection|audit|observations?)\\b',
      '\\b(?:inspection|audit)\\b.{0,40}\\b(?:us\\s?fda|usfda|fda|mhra|who)\\b', '\\b(?:product|voluntary|batch|drug)\\s+recall\\b|\\brecall(?:s|ed|ing)?\\b.{0,40}\\b(?:units|batch|batches|lots?|tablets?|capsules|vehicles|bottles)\\b',
      '\\bzero observations?\\b|\\bnil observations?\\b|\\bwith \\d+ observations?\\b', '\\bgmp\\b.{0,30}\\b(?:certif|non[- ]?complian|inspection)\\w*'],
  },
  {
    id: 'operations-disruption', label: 'Operational disruption', group: 'business',
    hint: 'Fires, accidents, strikes and lockouts, plant shutdowns, cyber incidents and force majeure.',
    dims: { materiality: 3, financial: 2, governance: 1, future: 2 },
    label_: ['strikes?\\s*/\\s*lock-?outs?', 'disturbances?', 'force majeure'],
    text: ['\\bdisruption\\b', kw('fire'), kw('accident'), '\\b(?:strike|lock-?out)\\b.{0,40}\\b(?:plant|factory|unit|workers?|employees|union)\\b', '\\b(?:plant|factory|unit|operations?|production)\\b.{0,30}\\bshut\\s?down\\b',
      '\\bshut\\s?down of\\b', '\\bsuspension of (?:operations|production|manufacturing|work)\\b', '\\bforce majeure\\b', '\\bcyber[- ]?(?:attack|security incident|incident)\\b|\\bransomware\\b|\\bdata breach\\b',
      '\\b(?:flood|cyclone|earthquake)\\w*\\b.{0,40}\\b(?:plant|facility|operations|unit)\\b'],
  },
  {
    id: 'acquisition', label: 'Acquisition & investment', group: 'deals',
    hint: 'Acquisitions, investments in other companies, share purchase agreements and open offers.',
    dims: { materiality: 3, financial: 3, governance: 0, future: 3 },
    label_: ['^acquisition', 'acquisition \\(including agreement to acquire\\)', 'takeover\\b(?!.{0,5}regulations)', '^open offer'],
    text: ['\\bacqui(?:res?|red|ring|sitions?)\\b.{0,80}\\b(?:stake|shares|equity|company|business|undertaking|entity|subsidiary|controlling|interest|%|per ?cent)\\b',
      '\\b(?:share|stock|business) purchase agreement\\b|\\bspa\\b', '\\binvest(?:s|ed|ment)\\b.{0,30}\\b(?:in|into)\\b.{0,60}\\b(?:limited|ltd|pvt|private|company|startup|subsidiary|llp|inc)\\b',
      '\\bcontrolling stake\\b', '\\bbuys?\\b.{0,30}\\bstake\\b', '\\bopen offer\\b', '\\btakeover\\b(?!.{0,5}regulations)'],
    // SEBI's Substantial Acquisition of Shares and Takeovers Regulations name "acquisition" — a
    // holder's own shareholding disclosure under them is not the company buying anything.
    not: ['\\b(?:sast|substantial acquisition of shares)\\b(?!.{0,80}\\bcomplet)', '\\bregulation\\s*(?:29|31|10)\\b', '\\btakeover regulations\\b',
      // The exchanges file a new subsidiary under "Acquisition"; setting one up is not buying anything.
      '^(?!.*\\bacqui(?:re|red|ring|sition)\\w*\\b.{0,60}\\b(?:stake|shares|equity|company|business|interest)).*\\bincorporat\\w+\\b'],
    notLabel: true,
  },
  {
    id: 'partnership-jv', label: 'Partnership, JV & agreements', group: 'deals',
    hint: 'Joint ventures, partnerships, MoUs, licensing and commercial agreements.',
    dims: { materiality: 2, financial: 1, governance: 0, future: 3 },
    label_: ['joint venture', 'memorandum of understanding', '^agreements?$', 'mou\\b', 'collaboration'],
    text: [kw('joint-venture'), kw('partnership'), '\\b(?:signs?|signed|enters? into|entered into|execut\\w+)\\b.{0,60}\\b(?:agreement|mou|contract|term sheet)\\b',
      '\\bcollaborat\\w+\\b.{0,30}\\bwith\\b', '\\blicen[cs]ing (?:agreement|deal|partner)\\b', '\\bstrategic (?:investment|partner\\w*|alliance)\\b'],
    weak: ['\\bagreements?\\b'],
  },
  {
    id: 'subsidiary-structure', label: 'Subsidiaries & group structure', group: 'deals',
    hint: 'Incorporation, dissolution or striking off of subsidiaries and other changes to the group structure.',
    dims: { materiality: 1, financial: 1, governance: 0, future: 1 },
    label_: ['^incorporation', 'striking off', 'dissolution'],
    text: ['\\bincorporat\\w+\\b.{0,80}\\b(?:subsidiar\\w*|step[- ]down|company|entity|llp)\\b', '\\b(?:wholly[- ]owned|step[- ]down)\\s+subsidiar\\w*\\b',
      '\\bdissolution\\b|\\bstrik(?:e|ing) off\\b|\\bstruck off\\b', '\\bceases? to be (?:a )?subsidiar\\w*\\b'],
  },
  {
    id: 'divestment', label: 'Divestment & stake sale', group: 'deals',
    hint: 'Sale of businesses, assets, subsidiaries or stakes, slump sales and monetisation.',
    dims: { materiality: 3, financial: 3, governance: 0, future: 2 },
    label_: ['sale or disposal', 'disinvestment', 'diversification\\s*/\\s*disinvestment', 'slump sale'],
    text: ['\\bsale of\\b.{0,60}\\b(?:entire )?stake\\b', kw('stake-sale'), '\\bslump sale\\b', '\\bsale of (?:the )?(?:business|undertaking|division|unit|assets?|stake|subsidiar\\w*|land|plant|property|brand)\\b',
      '\\bdisinvest\\w*\\b', '\\bmoneti[sz]\\w+\\b', '\\bhive[- ]?off\\b'],
    not: ['\\bblock deal\\b'],
  },
  {
    id: 'merger-restructuring', label: 'Merger, demerger & restructuring', group: 'deals',
    hint: 'Mergers, amalgamations, demergers, schemes of arrangement and corporate restructuring.',
    dims: { materiality: 3, financial: 2, governance: 1, future: 3 },
    label_: ['scheme of arrangement', 'amalgamation', 'merger', 'demerger', '^restructuring', 'court convened meeting'],
    text: [kw('merger'), '\\bdemerg\\w+\\b', '\\bcorporate restructuring\\b', '\\brestructuring\\b.{0,40}\\b(?:business|group|company|subsidiar)', '\\bscheme of (?:arrangement|amalgamation)\\b'],
  },
  {
    id: 'capital-raise', label: 'Capital raise & dilution', group: 'capital',
    hint: 'Preferential issues, QIPs, rights issues, warrants, convertibles, FPOs and other equity fund raising.',
    dims: { materiality: 3, financial: 3, governance: 1, future: 2 },
    // NSE's "Alteration of Capital and Fund Raising" XBRL label covers every allotment — debentures
    // and ESOPs included — so it is a weak reading the filing's own words can overrule.
    label_: ['issue of securities', 'preferential issue', 'qualified institutional placement', 'raising of funds', 'rights issue', 'further public offer'],
    text: [kw('qip'), kw('qualified-institutional-placement'), kw('preferential-issue'), kw('rights-issue'), '\\bfund[- ]?rais\\w+\\b', '\\braise\\w*\\b.{0,40}\\b(?:capital|funds|equity)\\b',
      '\\bconvertible (?:warrants?|debentures?|notes|preference)\\b', '\\bwarrants?\\b.{0,40}\\b(?:allot|issu|convert|exercis)\\w*', '\\bfccbs?\\b', '\\bfurther public offer\\b|\\bfpo\\b',
      '\\b(?:institutional|private) placement\\b', '\\bequity infusion\\b', '\\bin[- ]principle approval\\b.{0,60}\\b(?:issue|allot|listing|warrants|shares)\\b'],
    weak: ['\\ballot(?:ment|ted)\\b.{0,60}\\b(?:equity shares|shares|securities)\\b', '^allotment of (?:equity shares|securities)', 'alteration of capital and fund raising'],
    // A private placement of non-convertible debentures or commercial paper is borrowing, not equity
    // dilution; Debt & borrowing reads it.
    not: ['\\bnon[- ]convertible\\b', '\\bncds?\\b', '\\bcommercial papers?\\b', '\\bsecured,? rated,? listed\\b'],
    notLabel: true,
  },
  {
    id: 'debt-financing', label: 'Debt & borrowing', group: 'capital',
    hint: 'Debentures, commercial paper, bonds, term loans and other borrowing, and guarantees given.',
    dims: { materiality: 1, financial: 2, governance: 0, future: 1 },
    label_: ['giving guarantees', 'borrowings?$', 'debt securities'],
    text: ['\\bnon[- ]convertible (?:debentures?|securities|bonds?|redeemable)\\b|\\bncds?\\b', '\\bcommercial papers?\\b', '\\bdebentures?\\b', '\\bbonds?\\b.{0,30}\\b(?:issue|allot|rais|worth|rs|₹|crore|coupon)\\w*',
      '\\bterm loans?\\b', '\\bloan (?:agreement|facility|sanction\\w*)\\b', '\\bexternal commercial borrow\\w*\\b|\\becbs?\\b', '\\bcorporate guarantee\\b|\\bgiving guarantees?\\b'],
  },
  {
    id: 'shareholder-returns', label: 'Dividend, buyback, bonus & split', group: 'capital',
    hint: 'Dividends, buybacks, bonus issues and stock splits.',
    dims: { materiality: 2, financial: 2, governance: 0, future: 1 },
    label_: ['^dividend', 'bonus', 'buy-?back', 'stock split', 'sub-?division'],
    text: [kw('buyback'), '\\b(?:interim|final|special)\\s+dividends?\\b', '\\bdividends?\\b.{0,30}\\b(?:declar|recommend|approv|record date|per (?:equity )?share|rs|₹|%)\\w*',
      '\\bbonus (?:issue|shares?)\\b', '\\bstock split\\b', '\\bsub-?division of (?:equity )?shares\\b', '\\bsplit of (?:equity )?shares\\b'],
  },
  {
    id: 'credit-rating', label: 'Credit rating', group: 'capital',
    hint: 'Credit rating assignments, upgrades, downgrades, reaffirmations and withdrawals.',
    dims: { materiality: 2, financial: 2, governance: 1, future: 1 },
    label_: ['credit rating'],
    text: ['\\bcredit rating\\b', '\\bratings?\\b.{0,25}\\b(?:upgrad|downgrad|reaffirm|assign|revis|withdr|outlook|watch)\\w*', '\\b(?:upgrad|downgrad|reaffirm)\\w*\\b.{0,25}\\bratings?\\b',
      '\\b(?:crisil|icra|care ratings|india ratings|brickwork|acuite|infomerics|moody\'?s|fitch|s&p)\\b.{0,60}\\b(?:rating|outlook|upgrad|downgrad|reaffirm)\\w*'],
    not: ['\\besg\\b'],
  },
  {
    id: 'shareholding-changes', label: 'Promoter & shareholding changes', group: 'ownership',
    hint: 'Promoter and large-holder buying or selling, pledges and encumbrances, SAST and insider-trading disclosures, bulk and block deals.',
    dims: { materiality: 2, financial: 1, governance: 2, future: 1 },
    label_: ['sast', 'takeover regulations', 'insider trading', 'reg\\.?\\s*(?:29|31|10)\\b', 'shareholding', 'encumbrance', 'pledge', 'sale of shares', '\\bpit\\b'],
    text: ['\\bpromoters?\\b.{0,50}\\b(?:buy|bought|sell|sold|acquir|increas|decreas|rais|cut|pledg|encumb|stake|offload|divest|transfer)\\w*',
      '\\bpledg(?:e|ed|es|ing)\\b|\\bencumbrance\\b', '\\bsubstantial acquisition of shares\\b|\\bsast\\b', '\\binsider trading\\b|\\bpit regulations\\b',
      '\\b(?:bulk|block) deals?\\b', '\\binter[- ]?se transfer\\b', '\\bstake (?:hike|increase|cut|reduction|sale)\\b', '\\bshareholding\\b.{0,30}\\b(?:change|increase|decrease|pattern)\\b'],
  },
  {
    id: 'management-change', label: 'Management & KMP changes', group: 'governance',
    hint: 'Appointments, resignations and other changes among the CEO, CFO, managing director, chairman and other key managerial or senior personnel.',
    dims: { materiality: 2, financial: 0, governance: 3, future: 2 },
    label_: ['change in management', 'change in senior management', 'resignation of chief', 'appointment of chief', 'resignation of director/kmp/smp', 'resignation of company secretary', 'appointment of company secretary'],
    text: ['\\b(?:ceo|cfo|coo|cto|cxo|md|chief executive|chief financial|chief operating|chief technology|chief business|managing director|whole[- ]?time director|executive director|executive chairman|chairman|chairperson|key managerial personnel|kmp|senior management|smp|company secretary|compliance officer)\\b.{0,80}\\b(?:appoint|resign|cessation|ceas|step(?:s|ped)? down|retire|demise|re-?designat|elevat|takes? (?:over|charge)|join|exit|quit|tenure|succeed)\\w*',
      '\\b(?:appoint|resign|cessation|step(?:s|ped)? down|retire|demise|re-?designat|elevat|succeed|join)\\w*\\b.{0,80}\\b(?:ceo|cfo|coo|cto|md|chief executive|chief financial|chief operating|managing director|whole[- ]?time director|executive director|chairman|chairperson|key managerial personnel|kmp|senior management|company secretary|compliance officer)\\b'],
  },
  {
    id: 'board-change', label: 'Board, director & auditor changes', group: 'governance',
    hint: 'Appointments, resignations and retirements of directors, and changes of statutory or secretarial auditor.',
    dims: { materiality: 1, financial: 0, governance: 2, future: 1 },
    label_: ['change in directorate', 'change in director', 'resignation of director', 'appointment of director', '^cessation', '^retirement', '^demise', 'change in auditors', 'appointment of statutory auditor', 'change in directors/kmp/smp/auditor'],
    text: ['\\bvacation of office\\b', '\\bdirectors?\\b.{0,60}\\b(?:appoint|resign|cessation|ceas|retire|demise|re-?appoint|nominat|induct)\\w*', '\\b(?:appoint|resign|cessation|re-?appoint|nominat|induct)\\w*\\b.{0,60}\\bdirectors?\\b',
      '\\b(?:statutory|secretarial|internal|cost) auditors?\\b.{0,40}\\b(?:appoint|re-?appoint|change)\\w*', '\\b(?:appoint|re-?appoint)\\w*\\b.{0,40}\\b(?:statutory|secretarial) auditors?\\b'],
    weak: ['^appointment$', '^resignation$'],
  },
  {
    id: 'governance-red-flag', label: 'Governance red flags', group: 'governance',
    hint: 'Auditor resignations, qualified or modified audit opinions, fraud, forensic audits, whistle-blower complaints, independent-director exits with reasons, and penalties for non-compliance.',
    dims: { materiality: 3, financial: 1, governance: 4, future: 2 },
    label_: ['resignation of statutory auditors?', 'forensic'],
    // A secretarial, internal or cost auditor leaving is housekeeping; the statutory auditor is the
    // one whose exit is a red flag.
    text: ['\\b(?<!secretarial |internal |cost )auditors?\\b.{0,60}\\bresign\\w*', '\\bresign\\w*\\b.{0,60}\\b(?<!secretarial |internal |cost )(?:statutory )?auditors?\\b', kw('fraud'), '\\bforensic (?:audit|review|investigation)\\b', '\\bwhistle[- ]?blower\\b',
      '\\b(?:qualified|modified|adverse) (?:audit )?(?:opinion|report)\\b|\\bdisclaimer of opinion\\b', '\\bemphasis of matter\\b', '\\bmaterial (?:weakness|uncertainty)\\b|\\bgoing concern\\b',
      '\\bindependent directors?\\b.{0,60}\\bresign\\w*', '\\bresign\\w*\\b.{0,60}\\bindependent directors?\\b',
      '\\bdelay (?:in|of) (?:submission|filing|declaration) of (?:financial )?results\\b', kw('corporate-governance')],
  },
  {
    id: 'legal-regulatory', label: 'Legal, regulatory & tax actions', group: 'regulatory',
    hint: 'Orders and notices from courts, tribunals, SEBI, tax and other authorities — tax demands, GST notices, penalties, show-cause notices, litigation and investigations.',
    dims: { materiality: 2, financial: 2, governance: 2, future: 1 },
    label_: ['action\\(?s?\\)? (?:taken|initiated)', 'orders? passed', 'pendency of litigation', 'litigation', '^dispute'],
    text: ['\\b(?:order|notice|demand|assessment)s?\\b.{0,60}\\b(?:income[- ]?tax|gst|customs|excise|tax act)\\b', '\\b(?:court|tribunal|nclt|nclat|sat|high court|supreme court|cci|competition commission|enforcement directorate|cbi|dgca|dgft|customs|excise|commissioner|adjudicating)\\b.{0,80}\\b(?:order|notice|judg\\w*|ruling|verdict|penalt|fine|direct\\w*|summon|attach|stay|dismiss|uphold|quash)\\w*',
      '\\b(?:income[- ]?tax|gst|goods and services tax|tax|service tax|vat|customs|excise)\\b.{0,60}\\b(?:demand|notice|order|assessment|penalt|search|survey|raid|refund|appeal|show[- ]?cause|dispute)\\w*',
      '\\b(?:demand|show[- ]?cause|assessment)\\s+(?:notice|order)s?\\b', '\\bpenalt(?:y|ies)\\b', kw('lawsuit'), kw('investigation'), '\\bsebi\\b.{0,40}\\b(?:order|notice|probe|penalt|settle|interim|ban|bar)\\w*',
      '\\barbitra(?:l|tion|tor)\\b.{0,40}\\b(?:award|claim|order|proceeding)\\w*', '\\bfavou?rable (?:order|judgment|ruling|award)\\b',
      '\\bfines?\\b.{0,40}\\b(?:levied|imposed)\\b', '\\bnon[- ]?complian\\w*\\b.{0,40}\\b(?:regulation|listing|lodr|sebi)\\b'],
    not: ['\\b(?:receipt|award) of (?:work|purchase)?\\s?orders?\\b(?!.{0,40}\\b(?:court|tribunal|tax|gst|penalt))'],
  },
  {
    id: 'distress', label: 'Default, insolvency & distress', group: 'governance',
    hint: 'Payment defaults and delays, insolvency (CIRP) and liquidation proceedings, NPAs, one-time settlements and other signs of financial distress.',
    dims: { materiality: 4, financial: 3, governance: 3, future: 2 },
    label_: ['cirp', 'corporate insolvency', 'committee of creditors', 'insolvency', 'liquidation', 'default'],
    text: ['\\bdefault(?:s|ed)?\\b.{0,40}\\b(?:payment|repayment|interest|principal|loan|debt|ncd|debenture|bank|dues|obligation)\\w*', '\\binsolvenc\\w*\\b', '\\bcirp\\b',
      '\\bbankrupt\\w*\\b', '\\bliquidat(?:ion|or)\\b', '\\bwinding[- ]?up\\b', '\\bcommittee of creditors\\b', '\\bresolution (?:plan|professional|applicant)\\b', '\\bsarfaesi\\b',
      '\\bwilful defaulter\\b', '\\bone[- ]time settlement\\b', '\\bnon[- ]performing assets?\\b.{0,30}\\b(?:account|classif|declar)\\w*', '\\bdelay(?:ed)? (?:in )?(?:payment|servicing|repayment)\\b',
      '\\bnclt\\b.{0,40}\\b(?:admit\\w*|petition|section 7|section 9|section 10|ibc)\\b', '\\b(?:section|sec\\.?) (?:7|9|10) of (?:the )?ibc\\b|\\binsolvency and bankruptcy code\\b'],
    // Closing a dormant subsidiary on purpose is group housekeeping, not distress at the listed company.
    not: ['\\bvoluntar\\w* (?:liquidat|winding)\\w*', '\\bliquidat\\w*\\b.{0,40}\\b(?:subsidiar|step[- ]down)\\w*', '\\b(?:subsidiar|step[- ]down)\\w*\\b.{0,60}\\bliquidat\\w*'],
  },
  {
    id: 'clarification', label: 'Exchange clarification', group: 'regulatory',
    hint: 'Replies to exchange queries about price or volume movement, news items and rumours.',
    dims: { materiality: 1, financial: 0, governance: 0, future: 0 },
    label_: ['^clarification', 'news verification', 'rumou?r verification', 'price movement', 'spurt in (?:price|volume)', 'movement in (?:price|volume)'],
    text: ['\\bclarification\\b.{0,60}\\b(?:price|volume|movement|news|article|media|rumou?r|query)\\b', '\\b(?:price|volume) movement\\b|\\bmovement in (?:the )?(?:price|volume)\\b',
      '\\bspurt in (?:price|volume)\\b', '\\brumou?r verification\\b|\\bnews verification\\b', '\\breply to (?:the )?(?:exchange )?quer(?:y|ies)\\b'],
  },
  {
    id: 'board-meeting', label: 'Board meeting', group: 'calendar',
    hint: 'Board-meeting intimations, outcomes, postponements and revisions.',
    dims: { materiality: 1, financial: 1, governance: 0, future: 1 },
    label_: ['^board meeting', 'board meeting intimation', 'outcome of board meeting', 'outcome without intimation', 'board meeting rescheduled', 'revision of outcome', 'meeting updates'],
    text: ['\\bboard meeting\\b', '\\bmeeting of (?:the )?board\\b', '\\boutcome of (?:the )?(?:board|meeting)\\b', '\\bboard of directors\\b.{0,60}\\b(?:approved|considered|meeting|at its meeting)\\b'],
  },
  {
    id: 'investor-communication', label: 'Investor meets, calls & presentations', group: 'calendar',
    hint: 'Analyst and investor meetings, earnings-call intimations, transcripts and recordings, investor presentations and press releases.',
    dims: { materiality: 1, financial: 1, governance: 0, future: 1 },
    label_: ['analysts?\\s*/\\s*(?:institutional )?investors? meet', 'investor meet', 'con\\.? ?call', 'investor presentation', 'earnings call transcript', 'press release', 'media release', 'audio recording', 'transcript'],
    text: ['\\b(?:analysts?|investors?|institutional investors?)\\b.{0,30}\\b(?:meet\\w*|conference|call|day|interaction|presentation)\\b', '\\bcon(?:ference)?\\.?\\s?call\\b|\\bearnings call\\b',
      '\\binvestor presentation\\b', '\\btranscripts?\\b', '\\baudio (?:recording|call)\\b', '\\bpress release\\b|\\bmedia release\\b'],
  },
  {
    id: 'shareholder-meeting', label: 'AGM, EGM & voting', group: 'calendar',
    hint: 'Annual and extraordinary general meetings, postal ballots, e-voting, voting results and annual reports.',
    dims: { materiality: 0.5, financial: 0, governance: 0.5, future: 0.5 },
    label_: ['^agm$', '^egm$', 'agm/egm', 'shareholders? meeting', 'postal ballot', 'notice of shareholders meetings', 'voting results', 'scrutini[sz]er', 'e-?voting', 'annual report', 'dividend/agm'],
    text: ['\\boutcome of (?:the )?(?:\\d+\\w* )?(?:annual |extra[- ]?ordinary )?general meeting\\b', '\\bannual general meeting\\b|\\bagm\\b', '\\bextra[- ]?ordinary general meeting\\b|\\begm\\b', '\\bpostal ballot\\b', '\\be-?voting\\b', '\\bvoting results?\\b', '\\bscrutini[sz]er\\b', '\\bannual report\\b',
      '\\bnotice of (?:the )?(?:\\d+\\w* )?(?:annual|extra[- ]?ordinary|general) meeting\\b'],
  },
  {
    id: 'record-date', label: 'Record date & book closure', group: 'calendar',
    hint: 'Record dates, book closures and dividend payment dates.',
    dims: { materiality: 0.5, financial: 0.5, governance: 0, future: 0 },
    label_: ['record date', 'book closure', 'date of payment of dividend'],
    text: ['\\brecord date\\b', '\\bbook closure\\b'],
  },
  {
    id: 'listing-delisting', label: 'Listing, delisting & suspension', group: 'capital',
    hint: 'New listings, listing and trading approvals for new shares, delisting, trading suspensions and migrations.',
    dims: { materiality: 2, financial: 1, governance: 1, future: 2 },
    label_: ['new listing', 'delisting', '^suspension', 'trading approval', 'listing approval', 'listing of'],
    text: ['\\bdelist\\w*\\b', '\\bsuspension (?:of|in) trading\\b|\\btrading suspension\\b', '\\b(?:listing|trading) (?:approval|permission)\\b', '\\bnew listing\\b', '\\brevocation of suspension\\b', '\\bmigrat\\w+\\b.{0,30}\\bmain board\\b'],
  },
  {
    id: 'esop', label: 'ESOP & employee grants', group: 'capital',
    hint: 'Employee stock option grants and allotments.',
    dims: { materiality: 0.5, financial: 0.5, governance: 0, future: 0 },
    label_: ['allotment of esop', 'esop\\s*/\\s*esos', 'options to purchase securities'],
    text: ['\\besops?\\b|\\besos\\b|\\besps\\b', '\\bemployee stock (?:option|purchase|appreciation)\\w*', '\\bstock options?\\b', '\\bgrant of (?:stock )?options\\b', '\\brestricted stock units?\\b|\\brsus?\\b'],
  },
  {
    id: 'routine-admin', label: 'Routine & administrative', group: 'admin', routine: true,
    hint: 'Newspaper copies of filings already made, trading-window closures, mutual-fund NAV declarations, share-certificate, KYC and IEPF notices, compliance certificates, debt-servicing confirmations and office-address changes. Kept visible and ranked lower; never hidden.',
    dims: { materiality: 0, financial: 0, governance: 0, future: 0 },
    label_: ['regulation\\s*7\\s*\\(1\\)', 'regulation\\s*6\\s*\\(1\\)', 'specifications related to isin', 'utili[sz]ation of (?:issue )?proceeds', 'compliance-?\\s*57', 'registrar (?:&|and) share transfer agent', 'change in rta', 'newspaper publication', 'closure of trading window', 'trading window', 'certificate under (?:reg|sebi)', 'declaration of nav', 'confirmation of redemption', 'payment of interest',
      'structural digital database', 'large corporate', 'annual secretarial compliance', 'reg\\.?\\s*24\\s*\\(?a\\)?', 'business responsibility', '\\bbrsr\\b', 'reg\\.?\\s*57', 'reg\\.?\\s*54', 'asset cover',
      'security cover certificate', 'code of conduct', 'change (?:in|of) registered office', 'change of address', 'loss of share', 'duplicate share', 'compliance report on corporate governance',
      'reg\\.?\\s*32\\s*\\(1\\)', 'statement of deviation', 'repayment of commercial paper', 'interest rates? updates', 'half yearly report', 'initial disclosure to be made by an entity identified',
      'monitoring agency report', 'disclosure under regulation 51', 'investor complaints'],
    text: ['\\bregistrar (?:&|and) (?:share )?transfer agents?\\b|\\bchange in (?:the )?rta\\b', '\\butili[sz]ation of (?:issue )?proceeds\\b', '\\bregulation\\s*57\\s*\\(5\\)', '\\bnewspaper (?:publication|advertisement|cutting|ad)\\b', '\\btrading window\\b', '\\bdeclaration of nav\\b|\\bnet asset value\\b', '\\bshare certificates?\\b|\\bduplicate (?:share|certificate)s?\\b|\\bloss of (?:share|securit)\\w*',
      '\\b(?:de|re)mat\\w*\\b', '\\biepf\\b|\\binvestor education and protection fund\\b|\\bunclaimed dividends?\\b|\\bunpaid dividends?\\b', '\\bkyc\\b|\\bnomination\\b.{0,30}\\bphysical\\b|\\bshares? (?:held )?in physical form\\b',
      '\\breconciliation of share capital\\b', '\\bcompliance certificate\\b|\\bsecretarial compliance\\b', '\\bcertificate under reg\\w*\\b', '\\bstructural digital database\\b',
      '\\bconfirmation of (?:redemption|payment)\\b|\\b(?:timely )?payment of interest\\b|\\binterest (?:and|&) principal\\b', '\\binterest paid\\b.{0,60}\\b(?:debenture|bond|ncd|holders)\\w*', '\\bchange (?:in|of) (?:the )?(?:registered|corporate) office\\b|\\bchange of address\\b',
      '\\bregulation\\s*(?:74\\s*\\(5\\)|7\\s*\\(3\\)|40\\s*\\(9\\)|13\\s*\\(3\\)|39\\s*\\(3\\))'],
  },
  {
    id: 'other', label: 'Other updates', group: 'admin', fallback: true,
    hint: 'Filings and stories whose label is a catch-all and whose text matches no category. Unclassified is not unimportant — it is simply not tagged.',
    dims: { materiality: 1, financial: 0, governance: 0, future: 0 },
  },
];

// ONE PATTERN PER CATEGORY AND RULE KIND. Every text is lower-cased once and every pattern is written
// lower-case (the tracked-keyword patterns already are), so no `i` flag is needed, and each rule kind
// is one alternation — one regex test per category per text instead of one per pattern. Measured over
// the 192,598 retained filings: 21.8 s with a test per pattern, a small fraction of that combined.
const source = (p) => (p instanceof RegExp ? p.source : String(p));
const union = (list) => {
  const parts = (list || []).filter(Boolean).map(source);
  return parts.length ? new RegExp(parts.map((part) => `(?:${part})`).join('|')) : null;
};

export const ANNOUNCEMENT_CATEGORIES = Object.freeze(ANNOUNCEMENT_CATEGORY_LIST.map((c) => Object.freeze({
  id: c.id, label: c.label, group: c.group, hint: c.hint, dims: Object.freeze({ ...c.dims }),
  routine: c.routine === true, fallback: c.fallback === true,
  rules: Object.freeze({ label: union(c.label_), text: union(c.text), weak: union(c.weak), not: union(c.not), notLabel: c.notLabel === true }),
})));

const BY_ID = new Map(ANNOUNCEMENT_CATEGORIES.map((c) => [c.id, c]));
export const OTHER_CATEGORY = 'other';
export const ROUTINE_CATEGORY = 'routine-admin';
export const MAX_TAGS = 4;
export const categoryById = (id) => BY_ID.get(String(id || '')) || null;
export const categoryLabel = (id) => categoryById(id)?.label || String(id || '');
/** Position of each category in a compact mask (the server index stores tags as one number). */
export const CATEGORY_BIT = new Map(ANNOUNCEMENT_CATEGORIES.map((c, i) => [c.id, i]));
// Arithmetic, not bitwise: `|` and `<<` stop at 32 bits, and the list may grow past that. A double
// holds 53 exact bits, which is the real ceiling.
if (ANNOUNCEMENT_CATEGORIES.length > 52) throw new Error('The category master list may hold at most 52 entries (mask width).');
export const categoryMask = (ids = []) => [...new Set(ids)].reduce((mask, id) => (CATEGORY_BIT.has(id) ? mask + 2 ** CATEGORY_BIT.get(id) : mask), 0);
export const maskHas = (mask, id) => CATEGORY_BIT.has(id) && Math.floor(mask / 2 ** CATEGORY_BIT.get(id)) % 2 === 1;
export const maskCategories = (mask) => ANNOUNCEMENT_CATEGORIES.filter((c) => maskHas(mask, c.id)).map((c) => c.id);

// Most subjects carry no markup and no entity; only those pay for the full clean.
const clean = (value) => {
  let text = String(value ?? '');
  if (!text) return '';
  if (text.includes('<') || text.includes('&')) {
    text = text.replace(/<[^>]+>/g, ' ')
      .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
      .replace(/&(?:amp|quot|apos|lt|gt|nbsp);/g, ' ');
  }
  return /\s{2}|[\t\n\r\f\v]|^\s|\s$/.test(text) ? text.replace(/\s+/g, ' ').trim() : text;
};

// An exchange label that says nothing about the filing; the subject or description decides instead.
const CATCH_ALL = /^(?:general|updates?|general updates?|company updates?|meeting updates|others?|disclosures?|intimations?|announcements?|news|filing)$/i;
// BSE titles a great many filings "Announcement under Regulation 30 (LODR)-Acquisition": the topic
// after the dash is the company's own label for the filing, so it is read as one.
const REG30_TOPIC = /^(?:announcement|intimation|disclosure|fresh intimation)s?\s+under\s+regulation\s+30\b[^-–:]{0,60}[-–:]\s*(.{3,120})$/i;

/**
 * The texts a classification reads, normalised and lower-cased. Exported so the relevance features
 * and the event stitcher read the same words the tags were chosen from.
 */
export function categoryInput(item = {}, kind = null) {
  kind = kind || (item.kind === 'news' || item.kind === 'filing' ? item.kind : null)
    || (item.feed === 'news' || item.feed === 'market-news' || item.publisher || item.outlet ? 'news' : 'filing');
  const subCategory = clean(item.subCategory || item.filingSubCategory);
  const exchangeCategory = clean(typeof item.category === 'string' ? item.category : '');
  const subject = clean(item.title || item.headline || item.subject || item.filingSubject);
  const rawDescription = clean(item.summary || item.description || item.filingDescription || item.standfirst);
  if (kind === 'news') return { kind, label: '', topic: '', subject: subject.toLowerCase(), description: rawDescription.toLowerCase(), exchangeCategory: '' };
  // NSE files its own label as the subject and the real statement as the description.
  const isNse = !subCategory && !exchangeCategory;
  const label = subCategory && !CATCH_ALL.test(subCategory) ? subCategory : (isNse && subject && !CATCH_ALL.test(subject) ? subject : '');
  const topic = (REG30_TOPIC.exec(subject)?.[1] || '').trim();
  const description = rawDescription ? sourceStatement(rawDescription) : '';
  // Where NSE's subject IS its label ("Alteration Of Capital and Fund Raising-XBRL") it has already
  // been read as one; reading it again as free text would let a label's generic words ("fund raising")
  // overrule the description that says what was actually allotted. It is read as text only when there
  // is no description to read instead.
  const subjectIsLabel = isNse && !!label && label === subject && !!description;
  return { kind, label: label.toLowerCase(), topic: CATCH_ALL.test(topic) ? '' : topic.toLowerCase(), subject: subjectIsLabel ? '' : subject.toLowerCase(),
    description: description.toLowerCase(), exchangeCategory: exchangeCategory.toLowerCase() };
}

// BSE's coarse category, read only when nothing more specific matched.
const EXCHANGE_CATEGORY_FALLBACK = {
  result: 'results', 'board meeting': 'board-meeting', 'corp. action': 'shareholder-returns', 'corp action': 'shareholder-returns',
  'agm/egm': 'shareholder-meeting', 'new listing': 'listing-delisting', 'insider trading / sast': 'shareholding-changes',
};

// The exchanges use about a hundred labels between them; their reading is computed once each.
const LABEL_MEMO = new Map();
function labelMatches(label) {
  if (!label) return null;
  let hit = LABEL_MEMO.get(label);
  if (hit) return hit;
  hit = ANNOUNCEMENT_CATEGORIES.filter((c) => c.rules.label && c.rules.label.test(label)).map((c) => c.id);
  if (LABEL_MEMO.size > 5000) LABEL_MEMO.clear();
  LABEL_MEMO.set(label, hit);
  return hit;
}

/**
 * Tag one item against the master list.
 *
 * @returns {{ ids: string[], primary: string, routine: boolean, from: Record<string,string> }}
 *   `ids` in master-list order (at most MAX_TAGS), `from` names what decided each tag
 *   ('label' | 'subject' | 'description' | 'headline' | 'standfirst' | 'category' | 'fallback').
 */
export function categorize(item = {}, kind = null) {
  const input = categoryInput(item, kind);
  const texts = input.kind === 'news'
    ? [['headline', input.subject]]
    : [['subject', isTypeOnly(input.subject) ? '' : input.subject], ['description', input.description]];
  const evidence = texts.map(([, value]) => value).filter(Boolean).join(' • ');
  const labelled = new Set([...(labelMatches(input.label) || []), ...(labelMatches(input.topic) || [])]);
  const strong = new Map();
  const weak = new Map();
  for (const category of ANNOUNCEMENT_CATEGORIES) {
    if (category.fallback) continue;
    const rules = category.rules;
    if (labelled.has(category.id) && !(rules.notLabel && rules.not && rules.not.test(evidence))) { strong.set(category.id, 'label'); continue; }
    let found = null;
    if (rules.text) {
      for (const [where, value] of texts) {
        if (value && rules.text.test(value) && !(rules.not && rules.not.test(value))) { found = where; break; }
      }
    }
    if (found) { strong.set(category.id, found); continue; }
    if (rules.weak && !(rules.not && rules.not.test(evidence))) {
      for (const [where, value] of [['label', input.label], ...texts]) {
        if (value && rules.weak.test(value)) { weak.set(category.id, where); break; }
      }
    }
  }
  // A news story with no headline tag may still be tagged from its standfirst (rule 0 of
  // news-keywords.js: a standfirst is weaker evidence, so it is used only when the headline is mute).
  if (input.kind === 'news' && !strong.size && input.description) {
    for (const category of ANNOUNCEMENT_CATEGORIES) {
      if (category.fallback || category.routine || !category.rules.text) continue;
      const { text, not } = category.rules;
      if (text.test(input.description) && !(not && not.test(input.description))) strong.set(category.id, 'standfirst');
    }
  }
  // Rule 3: a weak match counts only where nothing in its group matched strongly — and it stays
  // marked weak, so the relevance reading gives it half the weight of a reading the filing states.
  const weakIds = [];
  for (const [id, where] of weak) {
    const group = BY_ID.get(id).group;
    if (![...strong.keys()].some((other) => BY_ID.get(other).group === group)) { strong.set(id, `${where}-weak`); weakIds.push(id); }
  }
  if (!strong.size && input.exchangeCategory) {
    const fallback = EXCHANGE_CATEGORY_FALLBACK[input.exchangeCategory.trim()];
    if (fallback) strong.set(fallback, 'category');
  }
  // Rule 2: routine is exclusive.
  if (strong.has(ROUTINE_CATEGORY)) {
    return { ids: [ROUTINE_CATEGORY], primary: ROUTINE_CATEGORY, routine: true, weak: [], from: { [ROUTINE_CATEGORY]: strong.get(ROUTINE_CATEGORY) } };
  }
  if (!strong.size) return { ids: [OTHER_CATEGORY], primary: OTHER_CATEGORY, routine: false, weak: [], from: { [OTHER_CATEGORY]: 'fallback' } };
  // Specific beats generic: an outcome that approved results is tagged Results first; the calendar
  // groups (board meeting, investor communication) are kept only while there is room.
  const ranked = ANNOUNCEMENT_CATEGORIES.filter((c) => strong.has(c.id))
    .sort((a, b) => (a.group === 'calendar') - (b.group === 'calendar'));
  const kept = new Set(ranked.slice(0, MAX_TAGS).map((c) => c.id));
  const ids = ANNOUNCEMENT_CATEGORIES.filter((c) => kept.has(c.id)).map((c) => c.id);
  return { ids, primary: ranked[0].id, routine: false, weak: weakIds.filter((id) => kept.has(id)), from: Object.fromEntries(ids.map((id) => [id, strong.get(id)])) };
}

// Memoised by row object (rows are replaced, never edited — CLAUDE.md "A per-row cache is keyed on
// the row object"). A text-keyed cache would miss on every distinct subject.
const memos = { news: new WeakMap(), filing: new WeakMap(), auto: new WeakMap() };
export function categoriesOf(item, kind = null) {
  if (!item || typeof item !== 'object') return categorize(item || {}, kind);
  const memo = memos[kind] || memos.auto;
  const hit = memo.get(item);
  if (hit) return hit;
  const value = categorize(item, kind);
  memo.set(item, value);
  return value;
}

/** Category counts over a set of items, every category present (zero included), in list order. */
export function countCategories(items = [], read = (item) => categoriesOf(item)) {
  const counts = new Map(ANNOUNCEMENT_CATEGORIES.map((c) => [c.id, 0]));
  for (const item of items) for (const id of read(item).ids) counts.set(id, (counts.get(id) || 0) + 1);
  return counts;
}
