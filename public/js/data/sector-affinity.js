// data/sector-affinity.js — WHICH SECTORS AN EVENT CATEGORY MOVES, READ FROM THE DESK'S OWN ONTOLOGY.
//
// DERIVED from `TRIGGERS` in kpi-impact.js (the sector → KPI ontology the AI Alerts "KPIs in play"
// line reads), and asserted equal to it by scripts/verify-relevance.mjs, so the two cannot drift.
// It lives in its own pure module because kpi-impact.js loads the browser's device store, while the
// relevance reading also runs on the runner that builds the announcement index and in the Worker.
//
//   plus         sectors whose KPIs this kind of event moves (an explicit KPI list in the ontology);
//   minus        sectors the ontology says it does not apply to (an explicit empty list);
//   conditional  sectors where it applies only when the text names the operator's asset.
// A sector in none of the three falls back to the ontology's generic reading and scores 0.

/** Which ontology triggers each master-list category corresponds to. */
export const CATEGORY_TRIGGERS = {
  'order-win': ['order-win', 'order-book'], 'order-loss': ['order-loss'], 'capacity-expansion': ['capacity', 'network'],
  'product-approval': ['launch', 'approval'], 'quality-inspection': ['fda-inspection'], 'operations-disruption': ['disruption'],
  acquisition: ['acquisition'], divestment: ['divestment'], 'capital-raise': ['equity-raise'], 'shareholder-returns': ['buyback', 'dividend'],
  'credit-rating': ['credit-rating'], distress: ['default'], 'business-update': ['business-update'],
};

export const SECTOR_AFFINITY = {
  "order-win": {
    plus: ["aerospace_defense","business_services","capital_goods","hardware","infrastructure","it_services","semiconductors","textiles"],
    minus: ["banks","capital_markets","insurance","investment_vehicles","nbfc","reit"],
    conditional: {  },
  },
  "order-loss": {
    plus: ["aerospace_defense","business_services","capital_goods","hardware","infrastructure","it_services","semiconductors","textiles"],
    minus: ["banks","capital_markets","insurance","investment_vehicles","nbfc","reit"],
    conditional: {  },
  },
  "capacity-expansion": {
    plus: ["auto","auto_components","capital_goods","cement","chemicals","consumer_durables","consumer_staples","diagnostics","education","hardware","hospitals","hotels","medical_devices","packaging","paper","restaurants","retail","semiconductors","textiles"],
    minus: ["banks","capital_markets","insurance","investment_vehicles","nbfc"],
    conditional: { metals: /\b(?:plant|smelter|furnace|mill|capacity|tpa|mtpa|ktpa|tonnes?|production|unit|line)\b/, mining: /\b(?:mine|mines|mining|coal|ore|block|washery|capacity|mtpa|production)\b/, power: /\b(?:mw|gw|mwp|mwac|mwh|plant|project|capacity|unit|station)\b/, oil_gas: /\brefiner(?:y|ies)\b/, hospitals: /\b(?:beds?|hospitals?)\b/, hotels: /\b(?:rooms?|keys|hotels?|resorts?)\b/, logistics: /\b(?:warehous\w*|terminals?|berths?|ports?|icds?|rakes?|vessels?|fleet|capacity|teu)\b/, aviation: /\b(?:aircraft|planes?|fleet|capacity|routes?|flights?)\b/, education: /\b(?:campus\w*|schools?|seats?|students?|capacity)\b/ },
  },
  "product-approval": {
    plus: ["auto","consumer_durables","consumer_staples","hardware","medical_devices"],
    minus: [],
    conditional: { telecom: /\b(?:plans?|tariffs?|prepaid|postpaid)\b/, media: /\b(?:ott|streaming|subscription|subscribers?)\b/, medical_devices: /\b(?:fda|510\s?\(?k\)?|ce mark\w*|cdsco|dcgi)\b/, power: /\b(?:cerc|serc|tariff (?:order|petition|adoption))\b/, utilities: /\b(?:cerc|serc|tariff (?:order|petition))\b/ },
  },
  "quality-inspection": {
    plus: ["medical_devices","pharma"],
    minus: [],
    conditional: {  },
  },
  "operations-disruption": {
    plus: ["auto","auto_components","capital_goods","cement","chemicals","consumer_durables","consumer_staples","hardware","medical_devices","packaging","paper","pharma","semiconductors","textiles"],
    minus: ["banks","capital_markets","insurance","investment_vehicles","nbfc"],
    conditional: { metals: /\b(?:plant|smelter|furnace|mill|capacity|tpa|mtpa|ktpa|tonnes?|production|unit|line)\b/, mining: /\b(?:mine|mines|mining|coal|ore|block|washery|capacity|mtpa|production)\b/, power: /\b(?:plant|unit|station|generation|mw)\b/, oil_gas: /\brefiner(?:y|ies)\b/, hospitals: /\b(?:hospitals?|beds?)\b/, hotels: /\b(?:hotels?|resorts?|property)\b/, logistics: /\b(?:warehous\w*|terminals?|berths?|ports?|icds?|rakes?|vessels?|fleet|capacity|teu)\b/, aviation: /\b(?:aircraft|planes?|fleet|capacity|routes?|flights?)\b/, education: /\b(?:campus\w*|schools?|seats?|students?|capacity)\b/ },
  },
  "acquisition": {
    plus: ["banks","capital_markets","diversified_holding","insurance","nbfc"],
    minus: ["investment_vehicles"],
    conditional: {  },
  },
  "divestment": {
    plus: [],
    minus: ["banks","capital_markets","insurance","investment_vehicles","nbfc"],
    conditional: {  },
  },
  "capital-raise": {
    plus: ["banks","insurance","nbfc","reit"],
    minus: ["investment_vehicles"],
    conditional: {  },
  },
  "shareholder-returns": {
    plus: ["reit"],
    minus: ["investment_vehicles"],
    conditional: {  },
  },
  "credit-rating": {
    plus: ["banks","nbfc"],
    minus: ["insurance","investment_vehicles"],
    conditional: {  },
  },
  "distress": {
    plus: [],
    minus: ["banks","capital_markets","insurance","investment_vehicles","nbfc"],
    conditional: {  },
  },
  "business-update": {
    plus: ["auto","aviation","banks","cement","insurance","nbfc","real_estate","retail"],
    minus: [],
    conditional: { metals: /\b(?:production|sales|dispatch\w*)\b/, mining: /\b(?:production|offtake|dispatch\w*|sales)\b/, power: /\b(?:generation|units?|mus?|bus?)\b/, logistics: /\b(?:cargo|volumes?|teu|tonnage|throughput)\b/, capital_markets: /\b(?:aum|assets under management)\b/, oil_gas: /\b(?:refiner\w*|throughput|crude processed)\b/ },
  },
};

/** +1 where the ontology names KPIs this event moves for the sector, −1 where it says it does not apply. */
export function sectorAffinity(ids = [], group = null, text = '') {
  if (!group) return 0;
  let best = 0, worst = 0;
  const lower = String(text || '').toLowerCase();
  for (const id of ids) {
    const entry = SECTOR_AFFINITY[id];
    if (!entry) continue;
    if (entry.plus.includes(group)) best = 1;
    else if (entry.conditional[group]) { if (entry.conditional[group].test(lower)) best = 1; }
    else if (entry.minus.includes(group)) worst = -1;
  }
  return best || worst;
}

/** The same table recomputed from the ontology's triggers — what the verification compares against. */
export function affinityFromTriggers(triggers = []) {
  const groups = new Map(triggers.map((t) => [t.id, t.groups || {}]));
  const out = {};
  for (const [cat, ids] of Object.entries(CATEGORY_TRIGGERS)) {
    const plus = new Set(), minus = new Set(), conditional = {};
    for (const id of ids) {
      for (const [group, value] of Object.entries(groups.get(id) || {})) {
        if (group === 'default') continue;
        if (Array.isArray(value)) { if (value.length) plus.add(group); else minus.add(group); }
        else if (value && Array.isArray(value.kpis) && value.kpis.length) { if (value.requires) conditional[group] = value.requires.source; else plus.add(group); }
      }
    }
    for (const group of plus) minus.delete(group);
    out[cat] = { plus: [...plus].sort(), minus: [...minus].sort(), conditional };
  }
  return out;
}
