// data/catalyst-playbooks.js — HOW EACH SECTOR IS ANALYSED, IN ONE EDITABLE TABLE.
//
// The catalyst engine (catalyst-engine.js) reads the same evidence for every company, but an order
// win means something very different at a defence manufacturer than at a bank, and a commissioned
// plant is the whole story for a chemicals company and nothing for an IT services firm. This table is
// that judgement, written down per sector group of the desk's own sector → KPI ontology
// (public/data/sector-kpis.json), so it is reviewable and changeable without touching the engine.
//
//  lens     one sentence: what actually moves earnings in this sector. Printed on the thesis.
//  weights  multiplier per catalyst type (default 1). 0 means "not a catalyst in this sector" —
//           a bank does not win orders. Weights reorder evidence; they never create a fact.
//  watch    what a portfolio manager should monitor next for this sector. Printed as a checklist,
//           never as a forecast.
//
// A group missing here falls back to DEFAULT_PLAYBOOK. A company the classification does not reach
// gets the default too, and the thesis says its sector was not classified.

export const PLAYBOOK_VERSION = '2026-10-30-v1';

const ORDER_LED = { 'order-win': 1.5, 'order-loss': 1.4, 'capacity-plan': 0.8, 'capacity-live': 0.8, launch: 0.6, network: 0.3 };
const CAPACITY_LED = { 'capacity-live': 1.5, 'capacity-plan': 1.25, 'order-win': 0.7, disruption: 1.3, launch: 0.7 };
const LENDER = { 'order-win': 0, 'order-loss': 0, 'capacity-live': 0, 'capacity-plan': 0, launch: 0.3, network: 0.6, 'rating-up': 1.4, 'rating-down': 1.5, 'growth-capital': 1.3, 'business-update': 1.4, distress: 1.3 };

export const SECTOR_PLAYBOOKS = {
  aerospace_defense: {
    lens: 'Order inflow from the defence ministry and PSUs sets revenue visibility for years; execution and indigenisation set margins.',
    weights: { ...ORDER_LED, 'order-win': 1.7, approval: 0.8 },
    watch: ['Order book to revenue cover', 'Execution pace on large orders', 'Indigenisation share and export orders'],
  },
  capital_goods: {
    lens: 'Order inflow and the order book drive revenue 4–12 quarters out; book-to-bill above 1 means growth is already contracted.',
    weights: { ...ORDER_LED },
    watch: ['Order book to TTM revenue', 'Execution and working-capital days', 'Commodity cost pass-through in contracts'],
  },
  infrastructure: {
    lens: 'Contract wins build the order book; execution speed, payment cycles and balance sheet strength decide what reaches profit.',
    weights: { ...ORDER_LED, 'legal-win': 1.4, 'legal-risk': 1.2, earnings: 0.85 },
    watch: ['Order book to sales', 'Arbitration claims and receivables', 'Bid pipeline and win rate'],
  },
  it_services: {
    lens: 'Large deal wins (TCV), constant-currency growth and margin bands drive the stock; client concentration is the key risk.',
    weights: { 'order-win': 1.3, 'capacity-plan': 0.2, 'capacity-live': 0.2, deal: 1.2, launch: 0.5, network: 0.25 },
    watch: ['Deal TCV and ramp-up', 'Constant-currency revenue growth', 'Attrition and utilisation'],
  },
  business_services: {
    lens: 'Revenue backlog and billing rates set growth; contract renewals are the catalyst.',
    weights: { 'order-win': 1.2, 'capacity-plan': 0.4, 'capacity-live': 0.4 },
    watch: ['Backlog and renewals', 'Billing rate trend', 'Headcount growth'],
  },
  pharma: {
    lens: 'US approvals, plant inspection outcomes and launches drive US revenue; domestic formulations growth is the steady base.',
    weights: { approval: 1.7, 'inspection-clean': 1.6, 'inspection-adverse': 1.7, launch: 1.4, 'order-win': 0.5, 'capacity-live': 0.9, 'legal-risk': 1.2 },
    watch: ['USFDA inspection status of key plants', 'Pipeline of ANDA approvals and launches', 'Price erosion in US generics'],
  },
  medical_devices: {
    lens: 'Regulatory approvals open markets; installed base and service revenue build the annuity.',
    weights: { approval: 1.6, 'inspection-adverse': 1.5, launch: 1.3 },
    watch: ['Approvals (FDA 510(k), CE, CDSCO)', 'Installed base growth', 'Service revenue share'],
  },
  chemicals: {
    lens: 'New capacity and its utilisation drive volumes; realisations follow global spreads, so commissioning is the clearest earnings catalyst.',
    weights: { ...CAPACITY_LED, approval: 0.6 },
    watch: ['Ramp-up of new capacity', 'Realisation and spreads vs China pricing', 'Utilisation of existing plants'],
  },
  metals: {
    lens: 'Volumes from new capacity and realisations against costs drive EBITDA per tonne; the cycle dominates.',
    weights: { ...CAPACITY_LED },
    watch: ['Capacity ramp-up', 'Realisations vs input costs', 'Net debt during capex'],
  },
  mining: {
    lens: 'Production growth from new blocks and realisations drive earnings; regulatory approvals gate output.',
    weights: { ...CAPACITY_LED, approval: 1.3 },
    watch: ['Production and offtake', 'Block approvals and clearances', 'Realisation trend'],
  },
  cement: {
    lens: 'Capacity additions, regional pricing and cost per tonne drive EBITDA per tonne.',
    weights: { ...CAPACITY_LED, deal: 1.3 },
    watch: ['Utilisation after capacity additions', 'Regional price trends', 'Fuel and freight cost per tonne'],
  },
  paper: { lens: 'Capacity, utilisation and pulp costs drive margins.', weights: { ...CAPACITY_LED }, watch: ['Utilisation', 'Pulp and chemical costs', 'Realisations'] },
  packaging: { lens: 'Volume growth from new lines and conversion margins drive earnings.', weights: { ...CAPACITY_LED }, watch: ['Utilisation of new lines', 'Conversion margin', 'Client wins'] },
  textiles: {
    lens: 'Export orders and capacity utilisation drive volumes; input cost and realisation spreads drive margins.',
    weights: { ...CAPACITY_LED, 'order-win': 1.1 },
    watch: ['Export order book', 'Cotton and yarn spreads', 'Utilisation'],
  },
  auto: {
    lens: 'Monthly volumes, new launches and mix (EVs, premiumisation) drive revenue; commodity costs drive margins.',
    weights: { launch: 1.5, 'business-update': 1.4, 'capacity-live': 1.1, 'order-win': 0.6 },
    watch: ['Monthly dispatches and market share', 'Launch pipeline and EV mix', 'Commodity costs per vehicle'],
  },
  auto_components: {
    lens: 'Content per vehicle, new OEM and export programmes, and capacity for them drive growth.',
    weights: { 'order-win': 1.2, 'capacity-live': 1.2, 'capacity-plan': 1.1, launch: 1.1, deal: 1.1 },
    watch: ['New programme wins', 'Export share', 'Capacity utilisation'],
  },
  consumer_durables: {
    lens: 'Volume growth, distribution reach and new capacity (often PLI-backed) drive growth.',
    weights: { 'capacity-live': 1.2, launch: 1.3, network: 1.1, approval: 0.8 },
    watch: ['Volume growth and channel inventory', 'PLI capacity ramp-up', 'Input costs'],
  },
  consumer_staples: {
    lens: 'Volume growth, pricing and distribution expansion drive revenue; input costs drive gross margin.',
    weights: { launch: 1.3, deal: 1.2, 'order-win': 0.4, 'capacity-live': 0.9, 'business-update': 1.2 },
    watch: ['Volume vs price growth', 'Rural demand', 'Gross margin vs input costs'],
  },
  retail: {
    lens: 'Store additions and same-store sales growth drive revenue; revenue per square foot drives returns.',
    weights: { network: 1.6, 'business-update': 1.3, 'order-win': 0.3, 'capacity-plan': 0.6 },
    watch: ['Store additions', 'Same-store sales growth', 'Revenue per sq ft'],
  },
  restaurants: { lens: 'Store additions and same-store sales drive growth.', weights: { network: 1.6, 'order-win': 0.2 }, watch: ['Store openings', 'Same-store sales', 'Delivery mix'] },
  hospitals: {
    lens: 'Bed additions and occupancy drive revenue; ARPOB and payer mix drive margins.',
    weights: { network: 1.5, 'capacity-live': 1.4, 'capacity-plan': 1.2, deal: 1.2, 'order-win': 0.3 },
    watch: ['Bed additions and ramp-up', 'Occupancy and ARPOB', 'Payer mix'],
  },
  diagnostics: { lens: 'Network reach and test volumes drive growth; pricing competition is the risk.', weights: { network: 1.4, deal: 1.2, 'order-win': 0.4 }, watch: ['Centre additions', 'Tests per patient', 'Pricing'] },
  hotels: {
    lens: 'Room additions (owned and managed) and RevPAR growth drive earnings.',
    weights: { network: 1.5, 'capacity-live': 1.3, deal: 1.2, 'order-win': 0.3 },
    watch: ['RevPAR and occupancy', 'Pipeline of signed rooms', 'ADR growth'],
  },
  power: {
    lens: 'Commissioned capacity (MW), signed PPAs and tariffs drive revenue; PLF and receivables drive cash.',
    weights: { 'capacity-live': 1.6, 'capacity-plan': 1.2, 'order-win': 1.3, approval: 1.2, deal: 1.2 },
    watch: ['MW commissioned vs pipeline', 'PPA tariffs and counterparties', 'Plant load factor'],
  },
  utilities: { lens: 'Regulated returns and tariff orders drive earnings.', weights: { approval: 1.3, 'capacity-live': 1.1 }, watch: ['Tariff orders', 'AT&C losses', 'Customer additions'] },
  oil_gas: {
    lens: 'Refining and marketing margins, throughput and new capacity drive earnings; government pricing is the swing factor.',
    weights: { 'capacity-live': 1.2, deal: 1.2, 'order-win': 0.7 },
    watch: ['Refining margins', 'Throughput and utilisation', 'Marketing margins'],
  },
  logistics: { lens: 'Volumes, network capacity and realisations drive earnings.', weights: { 'capacity-live': 1.2, network: 1.2, 'order-win': 1.0, deal: 1.2 }, watch: ['Volumes', 'Fleet/terminal capacity', 'Realisation per unit'] },
  aviation: { lens: 'Capacity (ASK), yields and fuel costs drive earnings.', weights: { network: 1.2, 'capacity-live': 1.2 }, watch: ['Yields and load factor', 'Fleet additions', 'Fuel cost'] },
  telecom: { lens: 'Operators earn on ARPU and subscriber growth; telecom-equipment makers on their order book and capacity for it.', weights: { launch: 1.0, approval: 1.1, 'order-win': 1.1, 'capacity-plan': 1.1 }, watch: ['ARPU and tariff hikes', 'Subscriber adds', 'Capex'] },
  media: { lens: 'Advertising and subscriptions drive revenue; content costs drive margins.', weights: { launch: 1.2, deal: 1.2, 'order-win': 0.5 }, watch: ['Ad revenue trend', 'Subscribers', 'Content costs'] },
  real_estate: {
    lens: 'Pre-sales, new launches and land additions drive future revenue; collections drive cash.',
    weights: { launch: 1.4, deal: 1.3, 'business-update': 1.4, 'capacity-plan': 0.8, 'order-win': 0.8, network: 0.4, earnings: 0.5 },
    watch: ['Pre-sales and collections', 'Launch pipeline', 'Land acquisitions'],
  },
  reit: { lens: 'Occupancy, rentals and acquisitions drive distributions.', weights: { deal: 1.3, 'order-win': 0 }, watch: ['Occupancy', 'Re-leasing spreads', 'Acquisitions'] },
  education: { lens: 'Enrolments and campus additions drive revenue.', weights: { network: 1.4 }, watch: ['Enrolments', 'Fee growth', 'Campus additions'] },
  semiconductors: { lens: 'Design wins and fab utilisation drive revenue.', weights: { 'order-win': 1.2, 'capacity-live': 1.3, approval: 1.1 }, watch: ['Design wins', 'Utilisation', 'Book-to-bill'] },
  hardware: { lens: 'Order book and units shipped drive revenue.', weights: { 'order-win': 1.3, 'capacity-live': 1.1 }, watch: ['Order book', 'Units shipped', 'Channel inventory'] },
  banks: {
    lens: 'Loan growth, net interest margin and asset quality drive earnings; capital adequacy limits growth.',
    weights: { ...LENDER },
    watch: ['Loan and deposit growth', 'NIM and cost of funds', 'Slippages and credit costs'],
  },
  nbfc: {
    lens: 'AUM growth, spreads and credit costs drive earnings; access to funding (ratings, capital) gates growth.',
    weights: { ...LENDER },
    watch: ['AUM and disbursement growth', 'Cost of borrowing vs yields', 'GNPA and credit costs'],
  },
  insurance: {
    lens: 'Premium growth, combined ratio (general) or VNB margin (life) drive value; solvency gates growth.',
    weights: { ...LENDER, 'rating-up': 1, 'rating-down': 1 },
    watch: ['Premium growth', 'Combined ratio / VNB margin', 'Solvency ratio'],
  },
  capital_markets: {
    lens: 'Market activity, AUM flows and client additions drive revenue; regulation is the swing risk.',
    weights: { ...LENDER, 'legal-risk': 1.4, approval: 1.2 },
    watch: ['Market volumes and AUM flows', 'Client additions', 'Regulatory changes'],
  },
  investment_vehicles: { lens: 'NAV and distributions drive returns.', weights: { 'order-win': 0, 'capacity-live': 0, 'capacity-plan': 0 }, watch: ['NAV', 'Distribution yield', 'Premium/discount to NAV'] },
  diversified_holding: {
    lens: 'Segment performance and value unlocking (demergers, listings) close the holding-company discount.',
    weights: { 'value-unlock': 1.6, deal: 1.2 },
    watch: ['Segment growth', 'Demerger and listing timelines', 'Holding-company discount'],
  },
};

export const DEFAULT_PLAYBOOK = {
  lens: 'Revenue growth, margin direction and cash conversion drive earnings; material new business and capacity are the main catalysts.',
  weights: {},
  watch: ['Revenue and margin trend next quarter', 'Execution on announced catalysts', 'Cash flow and working capital'],
};

/** The playbook for a sector group, never null. */
export function playbookFor(group) {
  return SECTOR_PLAYBOOKS[group] || DEFAULT_PLAYBOOK;
}

/** Multiplier for one catalyst type in one sector. */
export function sectorWeight(group, type) {
  const w = playbookFor(group).weights?.[type];
  return Number.isFinite(w) ? w : 1;
}

// WHEN THE CLASSIFICATION DOES NOT REACH A COMPANY, its industry name (Moneycontrol's or the
// exchange's own words) is read for the group. This is a stated inference: the idea carries
// `sectorInferred: true` and the thesis says so. Ordered: the first match wins.
const INDUSTRY_HINTS = [
  [/\b(?:bank)s?\b/, 'banks'],
  [/\b(?:nbfc|finance|financial services|housing finance|microfinance|leasing)\b/, 'nbfc'],
  [/\binsurance\b/, 'insurance'],
  [/\b(?:broking|stock exchange|asset management|capital markets?|depositor)/, 'capital_markets'],
  [/\b(?:defen[cs]e|aerospace|shipbuilding)\b/, 'aerospace_defense'],
  [/\b(?:pharma\w*|drugs?|api\b|formulations?|biotech\w*)/, 'pharma'],
  [/\b(?:hospital|healthcare services)/, 'hospitals'],
  [/\bdiagnostic/, 'diagnostics'],
  [/\b(?:medical|surgical) (?:devices?|equipment)/, 'medical_devices'],
  [/\b(?:software|it services|it - |information technology|computers)/, 'it_services'],
  [/\b(?:auto ancillar|auto components?|auto parts|tyres?|bearings?|castings?|forgings?)/, 'auto_components'],
  [/\b(?:automobiles?|passenger cars?|two[- ]wheelers?|commercial vehicles?|tractors?)\b/, 'auto'],
  [/\b(?:cement)/, 'cement'],
  [/\b(?:chemicals?|agrochemicals?|fertili[sz]ers?|pesticides?|dyes|pigments?|specialty)/, 'chemicals'],
  [/\b(?:steel|iron|alumin|copper|zinc|metals?|ferro|alloys?)/, 'metals'],
  [/\b(?:mining|minerals?|coal)\b/, 'mining'],
  [/\b(?:power|energy|solar|wind|renewable)/, 'power'],
  [/\b(?:oil|gas|refiner|petroleum|lpg|petro)/, 'oil_gas'],
  [/\b(?:construction|infrastructure|infra|engineering - construction|roads?|epc)\b/, 'infrastructure'],
  [/\b(?:capital goods|electrical equipment|engineering|industrial machinery|heavy electrical|cables?|transformers?|pumps?|valves?|compressors?)/, 'capital_goods'],
  [/\b(?:textiles?|apparel|garments?|yarn|cotton|spinning)/, 'textiles'],
  [/\b(?:paper)/, 'paper'],
  [/\b(?:packaging)/, 'packaging'],
  [/\b(?:fmcg|food|beverages?|personal care|household|tobacco|dairy|consumer staples|breweries|distilleries|sugar|tea|edible oils?)/, 'consumer_staples'],
  [/\b(?:consumer durables?|electronics|appliances?|air condition|white goods)/, 'consumer_durables'],
  [/\b(?:retail|jewel)/, 'retail'],
  [/\b(?:restaurants?|qsr|quick service)/, 'restaurants'],
  [/\b(?:hotels?|resorts?|hospitality)/, 'hotels'],
  [/\b(?:logistics|shipping|ports?|courier|freight|warehous)/, 'logistics'],
  [/\b(?:airlines?|aviation)\b/, 'aviation'],
  [/\b(?:telecom)/, 'telecom'],
  [/\b(?:media|entertainment|broadcasting|film)/, 'media'],
  [/\b(?:realty|real estate|construction - real estate|housing)\b/, 'real_estate'],
  [/\b(?:education|edtech)/, 'education'],
];

/** The group an industry name suggests, or null. */
export function inferGroup(industry) {
  const text = String(industry || '').toLowerCase();
  if (!text) return null;
  for (const [re, group] of INDUSTRY_HINTS) if (re.test(text)) return group;
  return null;
}
