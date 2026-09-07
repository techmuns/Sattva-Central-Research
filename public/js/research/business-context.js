// Query-time business comparisons from the dashboard's own readings. This is
// evidence discovery, not a maintained list of "AI stocks" or a benefit forecast.
import { eventDay } from './query-context.js';

const CONCEPTS = [
  ['fibre-cabling', 'Optical fibre / telecom cabling', /\b(?:optical fib(?:er|re)|fib(?:er|re)[- ]optic|ofc|cables?[- ,]+telecom|fib(?:er|re)[^.]{0,35}\b(?:cabl\w*|count|network))\b/i, 5],
  ['telecom-networks', 'Telecom / network equipment', /\b(?:telecom\w*|networking equipment|optical network\w*|5g|broadband|ran equipment)\b/i, 3],
  ['data-centres', 'Data centres / cloud infrastructure', /\b(?:data[- ]cent(?:er|re)s?|hyperscal\w*|cloud infrastructure|gpu servers?)\b/i, 4],
  ['semiconductors', 'Semiconductors / electronics manufacturing', /\b(?:semiconductor\w*|chip packaging|osat|printed circuit|pcb|electronics manufacturing|electronic manufacturing|consumer electronics[- ,]+ems)\b/i, 4],
  ['power-equipment', 'Power / electrical equipment', /\b(?:(?:power|distribution|electrical) transformers?|switchgear|transmission equipment|electrical equipment|power systems)\b/i, 3],
  ['ai', 'AI products, services or adoption', /\b(?:ai|gen[- ]?ai|artificial intelligence|machine learning|large language models?)\b/i, 1],
  ['it-services', 'Software / IT services', /\b(?:it[- ,]+(?:software|services|er&d)|information technology|software services|digital engineering|enterprise modernization)\b/i, 2],
  ['renewables', 'Renewable energy / solar', /\b(?:solar|photovoltaic|renewable\w*|wind turbine\w*)\b/i, 3],
  ['defence', 'Defence / aerospace', /\b(?:defen[cs]e|aerospace|military|missile\w*|radar)\b/i, 3],
  ['ev', 'Electric vehicles / batteries', /\b(?:electric vehicles?|evs?|battery|batteries|charging infrastructure)\b/i, 3],
];
const byId = new Map(CONCEPTS.map(([id, label, pattern, weight]) => [id, { label, pattern, weight }]));
const THEMES = [
  ['ai', 'AI', /\b(?:ai|gen[- ]?ai|artificial intelligence|machine learning)\b/i, ['ai', 'data-centres', 'semiconductors', 'fibre-cabling', 'telecom-networks']],
  ['renewables', 'Renewable energy', /\b(?:solar|renewables?|renewable energy)\b/i, ['renewables', 'power-equipment']],
  ['defence', 'Defence', /\bdefen[cs]e\b/i, ['defence']],
  ['ev', 'Electric vehicles', /\b(?:evs?|electric vehicles?)\b/i, ['ev']],
  ['data-centres', 'Data centres', /\bdata[- ]cent(?:er|re)s?\b/i, ['data-centres', 'fibre-cabling', 'telecom-networks', 'power-equipment']],
];
const key = row => row?.isin || row?.ticker || '';
const symbol = value => String(value || '').toUpperCase();
const normalizedName = value => String(value || '').toLowerCase().replace(/\b(?:limited|ltd)\b/g, '').replace(/[^a-z0-9]/g, '');
const textLimit = (value, limit = 360) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function companyPassages(row) {
  const names = [row.ticker, String(row.company || row.name || '').replace(/\b(?:limited|ltd)\.?$/i, '').trim()].filter(Boolean);
  const patterns = names.map(name => new RegExp(`\\b${escapePattern(name)}\\b`, 'i'));
  const content = [row.title, row.headline, row.summary, row.text, row.detail].filter(Boolean).join('. ');
  // A round-up attributed to several issuers must not give Sterlite another
  // company's transformer orders. Only issuer-local clauses are evidence.
  const passages = content.split(/(?:[.!?](?:\s|$)|[\n\r|;]|\p{Extended_Pictographic}|(?=\*[^*]{3,70}\*:))/u)
    .filter(part => patterns.some(pattern => pattern.test(part)));
  return [...passages, ...(row.sourceTags || []), row.metric].filter(Boolean).join(' ');
}

export function businessIntent(question, history = []) {
  const q = String(question || '');
  const group = /\b(?:portfolio|holdings|positions|stocks|companies|peers|comparables)\b/i.test(q);
  const peers = /\b(?:comparable|similar|same business|same development|same trend|peers?|benefit\w*|spillover|read[- ]across|other|rest)\b/i.test(q);
  let theme = THEMES.find(([, , pattern]) => pattern.test(q));
  let inherited = false;
  if (!theme && /\b(?:they|their|them|those|these)\b/i.test(q)) {
    const prior = history.filter(m => m.role === 'user').slice(-6).reverse().find(m => businessIntent(m.text));
    if (prior) { theme = THEMES.find(([id]) => id === businessIntent(prior.text)?.theme); inherited = true; }
  }
  const analytical = /\b(?:if|scenario|expos\w*|affect\w*|impact\w*|implic\w*|sensitiv\w*|depend\w*|beneficiar\w*|losers?|winners?|supply|demand|risk\w*|contradict\w*|trade[- ]?offs?|second[- ]order|value[- ]chain|drivers?|hurt\w*|linked|manufactur\w*|produce\w*|suppliers?|customers?|sector\w*|industr\w*)\b/i.test(q);
  const followAnalysis = /\b(?:they|their|them|those|these|that|this|opposite|reverse)\b/i.test(q) &&
    history.filter(m => m.role === 'user').slice(-6).some(m => businessIntent(m.text));
  if (group && (analytical || !theme && /\brelated\b/i.test(q)) || followAnalysis && !theme) return { mode: 'portfolio-reasoning',
    label: 'Portfolio implications', concepts: [], comparePerformance: /\b(?:perform\w*|returns?|moves?|gains?)\b/i.test(q),
    afterEvent: /\b(?:after|since|following)\b/i.test(q) };
  if (!(group && (peers || theme) || inherited)) return null;
  return { mode: peers ? 'business-peers' : 'portfolio-theme', theme: theme?.[0] || null,
    label: theme?.[1] || 'Comparable businesses', concepts: theme?.[3] || [],
    comparePerformance: /\b(?:perform\w*|benefit\w*|moves?|returns?|rall\w*|gains?|after|since)\b/i.test(q),
    afterEvent: /\b(?:after|since|following)\b/i.test(q) };
}

// Never infer a holding from a search-query identity, a related-company article,
// a ticker substring, or its name containing "AI".
export function holdingForBusinessRow(row, holdings = []) {
  if (row.attribution && row.attribution !== 'confirmed') return null;
  if (row.isin) return holdings.find(h => h.isin === row.isin) || null;
  if (row.ticker) return holdings.find(h => symbol(h.ticker) === symbol(row.ticker)) || null;
  const name = normalizedName(row.company || row.name);
  if (!name) return null;
  const matches = holdings.filter(h => [h.name, h.bookName].some(n => normalizedName(n) === name));
  return matches.length === 1 ? matches[0] : null;
}

export function businessSignals(row) {
  // Deliberately exclude our source labels ("AI Alerts"), identifiers, URLs,
  // sentiment scores and generic company names from semantic matching.
  const text = companyPassages(row);
  const names = [row.company, row.name].filter(Boolean).map(name => String(name).replace(/\b(?:limited|ltd)\.?$/i, '').trim()).filter(name => name.length > 3);
  const withoutNames = value => names.reduce((result, name) => result.replace(new RegExp(`\\b${escapePattern(name)}\\b`, 'gi'), match => ' '.repeat(match.length)), value);
  // Preserve original quote offsets while stopping "Solar Industries" or
  // "AI Finance" in a headline from creating a business classification.
  const semanticText = withoutNames(text);
  const industry = [row.industry, row.sector].filter(Boolean).join(' ');
  return CONCEPTS.flatMap(([id, label, pattern]) => {
    const match = pattern.exec(semanticText) || pattern.exec(industry);
    if (!match) return [];
    const inText = pattern.test(semanticText), value = inText ? text : industry;
    const index = pattern.exec(inText ? semanticText : industry)?.index || 0;
    const from = Math.max(0, index - 100);
    const local = value.slice(Math.max(0, index - 90), index + 90);
    const denied = /\b(?:does not|doesn't|do not|not|no longer)\s+(?:\w+\s+){0,3}(?:manufacture|make|sell|provide|operate|produce|exposed|exposure|involved|linked)\b/i.test(local);
    return [{ id, label, industryMatch: pattern.test(industry), basis: inText
      ? (row.sourceTags?.some(tag => pattern.test(withoutNames(tag))) ? 'company analysis tags' : 'company-linked source text') : 'industry label only',
      stance: denied ? 'denied-or-limited' : 'mentioned',
      excerpt: `${from ? '…' : ''}${textLimit(value.slice(from), 360)}${value.length > from + 360 ? '…' : ''}` }];
  });
}

// A bounded set per company AND concept survives source row sampling. The
// returned evidence still spends the same overall provider character budget.
export function businessReadings(rows, plan) {
  if (!plan.business) return [];
  const allowed = [...plan.businessHoldings, ...plan.companies];
  const seen = new Set(), out = [];
  for (const row of rows) {
    if (row.recordType === 'reference-page') continue;
    const company = holdingForBusinessRow(row, allowed);
    if (!company) continue;
    for (const signal of businessSignals(row)) {
      const identity = `${key(company)}:${signal.id}:${signal.basis}:${signal.stance}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push({ ...signal, ticker: company.ticker || null, isin: company.isin || null,
        // Internal reference to the original mapped row, used to select peer
        // source samples after all sources establish the business candidates.
        row,
        company: company.name, date: eventDay(row), url: row.url || row.documents?.[0]?.url || null,
        verification: /telegram|chatter|twitter|social/i.test(row.feed || '') ? 'unverified discussion' : 'reported; not independently verified',
        title: textLimit(row.title || row.headline || row.sourceTags?.join('; ') || row.industry, 200) });
    }
  }
  return out;
}

export function datedPerformance(row, eventDate = null) {
  if (!row) return { status: 'unavailable', reason: 'No dated technical price reading for this holding.' };
  const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const date = validDay(row.bar_date) ? row.bar_date : null;
  const verified = ['confirmed', 'corrected'].includes(row.move_check);
  const prior = verified ? row.move_prev_date : row.prev_bar_date;
  const previous = validDay(prior) ? prior : null;
  const out = { status: date ? 'dated-snapshot' : 'undated', priceDate: date,
    closeRupees: Number.isFinite(verified ? row.move_close : row.cmp) ? (verified ? row.move_close : row.cmp) : null,
    latestSession: date && previous && previous < date && Date.parse(date) - Date.parse(previous) <= 4 * 86_400_000 && Number.isFinite(row.pct_change_today)
      ? { from: previous, to: date, changePct: row.pct_change_today, verification: row.move_check || 'single-source' } : null,
    source: 'Breakouts / Technical' };
  if (!eventDate) return out;
  out.afterEvent = { status: 'unavailable', eventDate,
    reason: date && date <= eventDate ? 'No captured post-publication close.' : 'Matching pre-event adjusted close unavailable.' };
  const series = row.closeHistory;
  if (series?.basis !== 'adjusted-close' || series.retainedAfterFailure || !Array.isArray(series.rows)) return out;
  if (!validDay(eventDate)) return out;
  const bars = series.rows.filter(b => Array.isArray(b) && validDay(b[0]) && Number.isFinite(b[1]) && b[1] > 0).sort((a, b) => a[0].localeCompare(b[0]));
  if (new Set(bars.map(b => b[0])).size !== bars.length) return out;
  const baseline = bars.filter(b => b[0] < eventDate).at(-1), end = bars.at(-1);
  if (!baseline || !end || end[0] <= eventDate || !date || end[0] !== date) return out;
  // A long missing interval cannot be labelled the close immediately before an event.
  if (Date.parse(eventDate) - Date.parse(baseline[0]) > 4 * 86_400_000) return out;
  out.afterEvent = { status: 'available', eventDate, from: baseline[0], to: end[0],
    changePct: Math.round((end[1] / baseline[1] - 1) * 10000) / 100,
    basis: 'Adjusted-close change from the last captured close before the publication day; includes that entire session. Publication time is not established. Not proof of causation or portfolio P&L.' };
  return out;
}

export function portfolioBusinessContext({ plan, packets, technicalRows = [] }) {
  if (!plan.business) return undefined;
  const readings = packets.flatMap(source => (source.businessReadings || []).map(r => ({ ...r,
    verification: ['telegram', 'chatter-posts'].includes(source.id) ? 'unverified discussion' : r.verification,
    tab: source.tab, sourceId: source.id, sourceStatus: source.status, quality: source.dataQuality || 'source-reported' })));
  const of = company => readings.filter(r => company.isin && r.isin ? r.isin === company.isin : company.ticker && r.ticker === company.ticker);
  const proof = r => ({ tab: r.tab, date: r.date, basis: r.basis, ...(r.stance === 'denied-or-limited' ? { stance: r.stance } : {}),
    text: textLimit(r.excerpt, 220), verification: r.verification,
    sourceStatus: r.quality === 'partial' ? 'partial' : r.sourceStatus,
    ...(r.url && r.url.length <= 180 ? { url: r.url } : {}) });
  const references = plan.companies.map(company => {
    const rows = of(company);
    const concepts = [...new Set(rows.filter(r => r.stance !== 'denied-or-limited').map(r => r.id))];
    const primaryActivities = [...new Set(rows.filter(r => r.industryMatch && r.stance !== 'denied-or-limited').map(r => r.id))];
    const development = r => /\b(?:target\w*|capex|capacity|launch\w*|contract\w*|order\w*|demand|guidance|plan\w*|expan\w*)\b/i.test(r.title || r.excerpt) ? 1 : 0;
    const dated = rows.filter(r => r.date && r.basis !== 'industry label only').sort((a, b) => development(b) - development(a) || b.date.localeCompare(a.date));
    const unique = new Set();
    const evidence = rows.filter(r => development(r) || r.basis !== 'company-linked source text')
      .sort((a, b) => development(b) - development(a) || Number(a.basis === 'industry label only') - Number(b.basis === 'industry label only'))
      .filter(r => !unique.has(r.id) && unique.add(r.id)).slice(0, 2).map(proof);
    return { ticker: company.ticker, isin: company.isin, name: company.name,
      concepts, primaryActivities, referencePublication: dated[0] ? { date: dated[0].date, title: textLimit(dated[0].title, 200), tab: dated[0].tab } : null, evidence };
  });
  const anchorConcepts = [...new Set(references.flatMap(r => r.concepts))];
  const concepts = anchorConcepts.length ? anchorConcepts : plan.business.concepts;
  const primary = new Set(references.flatMap(r => r.primaryActivities));
  const candidates = [];
  let referenceHoldingsExcluded = 0;
  for (const holding of plan.businessHoldings) {
    if (references.some(r => holding.isin && r.isin ? holding.isin === r.isin : holding.ticker && holding.ticker === r.ticker)) {
      referenceHoldingsExcluded++; continue;
    }
    const rows = of(holding);
    const matched = [...new Set(rows.filter(r => r.stance !== 'denied-or-limited').map(r => r.id).filter(id => concepts.includes(id)))];
    if (!matched.length) continue;
    const contradictions = rows.filter(r => r.stance === 'denied-or-limited' && matched.includes(r.id));
    const evidence = matched.map(id => rows.filter(r => r.id === id && r.stance !== 'denied-or-limited').sort((a, b) => Number(a.basis === 'industry label only') - Number(b.basis === 'industry label only') || String(b.date || '').localeCompare(String(a.date || '')))[0])
      .sort((a, b) => Number(primary.has(b.id)) - Number(primary.has(a.id)) || byId.get(b.id).weight - byId.get(a.id).weight);
    const industryOnly = evidence.every(r => r.basis === 'industry label only');
    const overlap = matched.reduce((sum, id) => sum + byId.get(id).weight, 0);
    const coreOverlap = evidence.filter(r => primary.has(r.id)).reduce((sum, r) => sum + byId.get(r.id).weight * (r.basis === 'industry label only' ? 1 : 2), 0);
    const raw = technicalRows.find(r => symbol(r.ticker) === symbol(holding.ticker) && holding.ticker);
    candidates.push({ ticker: holding.ticker || null, isin: holding.isin, name: holding.name,
      weightPct: plan.businessHoldingsVerified && plan.businessWeightsComplete && Number.isFinite(holding.weightPct) ? holding.weightPct : null,
      overlapScore: coreOverlap * 100 + overlap, relationship: contradictions.length ? 'Conflicting or limited business exposure; verify the supplied counter-evidence'
        : industryOnly ? 'Industry candidate; business overlap unconfirmed'
        : primary.size && !coreOverlap ? 'Adjacent/shared theme; not established as a product peer'
        : matched.every(id => ['ai', 'it-services'].includes(id)) ? 'Shared broad theme; not established as the same business'
        : 'Comparable activity found in company-linked readings; benefit is not established',
      sharedActivities: evidence.slice(0, 2).map(r => byId.get(r.id).label), evidence: evidence.slice(0, 2).map(proof),
      ...(contradictions.length ? { counterEvidence: contradictions.slice(0, 2).map(proof) } : {}),
      performance: datedPerformance(raw, plan.business.afterEvent ? references[0]?.referencePublication?.date : null) });
  }
  candidates.sort((a, b) => b.overlapScore - a.overlapScore || (b.weightPct || 0) - (a.weightPct || 0) || a.name.localeCompare(b.name));
  return { kind: 'source-backed-business-comparison', theme: plan.business.label,
    definition: 'Source-linked comparable activities, not a definitive classification. Overlap does not prove a customer link, exposure magnitude, benefit or price causation. Cite original evidence tabs. The named publication is an explicit comparison anchor, not a proven catalyst.',
    holdingsBasis: plan.businessHoldingsVerified ? 'complete authenticated positions' : 'dashboard scope/coverage only; ownership and weights not established',
    holdingsExamined: plan.businessHoldings.length, candidatesFound: candidates.length,
    referenceHoldingsExcluded,
    otherHoldingsWithoutMatchingEvidence: plan.businessHoldings.length - referenceHoldingsExcluded - candidates.length,
    sourceCoverage: 'Loaded source readings only. Unavailable sources, unread documents and bounded discussion topics remain gaps; no match is not proof of no business exposure.',
    pricePolicy: 'Scheduled EOD snapshots, not live. Latest-session moves are not since-news returns. After-event changes require dated adjusted closes; shared moves do not establish causation.',
    references, candidates, candidatesOmitted: 0 };
}

// The ordinary named-company sample would refill the prompt with the anchor's
// price headlines and unrelated financials. For a peer question, retain actual
// original peer rows instead; the reference development already lives above.
export function businessPeerSamples(packets, context) {
  if (!context?.candidates?.length) return packets;
  return packets.map(packet => {
    const readings = (packet.businessReadings || []).filter(r => r.row);
    const rows = [], used = new Set();
    for (const candidate of context.candidates) {
      const matches = readings.filter(r => candidate.isin && r.isin ? candidate.isin === r.isin : candidate.ticker && candidate.ticker === r.ticker);
      for (const reading of matches) {
        if (used.has(reading.row)) continue;
        used.add(reading.row); rows.push(reading.row);
        break; // One representative per peer per source before extra readings.
      }
    }
    return { ...packet, rows, rowTiers: rows.map(() => 0), rowPriorities: rows.map((_, i) => i) };
  });
}

export function fitBusinessContext(context, limit) {
  if (!context) return undefined;
  const result = structuredClone(context);
  result.candidates.forEach(candidate => { delete candidate.overlapScore; });
  if (result.businessProfiles) {
    const profiles = result.businessProfiles;
    // Industry identities and analysis have separate provenance. Remove whole
    // excerpts under pressure so a cut number, unit or negation cannot become a fact.
    while (JSON.stringify(profiles).length > limit * 0.75 && profiles.analyses.rows.length) {
      profiles.analyses.rows.pop(); profiles.analyses.omitted++;
    }
    while (JSON.stringify(profiles).length > limit * 0.75 && profiles.rows.length) { profiles.rows.pop(); profiles.omitted++; }
  }
  // Bound multiple anchors as well as candidates. Never let supplementary
  // comparison metadata crowd every original source row out of the packet.
  result.referencesOmitted = 0;
  while (JSON.stringify(result.references).length > limit * 0.3 && result.references.length > 1) {
    result.references.pop(); result.referencesOmitted++;
  }
  while (JSON.stringify(result).length > limit && result.candidates.length) {
    result.candidates.pop(); result.candidatesOmitted++;
  }
  if (JSON.stringify(result).length <= limit) return result;
  // Very small custom budgets still need an explicit omission, never an
  // oversized empty comparison that leaves no room for source evidence.
  const omitted = { kind: result.kind, status: 'omitted-for-budget', holdingsExamined: result.holdingsExamined,
    candidatesFound: result.candidatesFound, candidatesOmitted: result.candidatesFound };
  return JSON.stringify(omitted).length <= limit ? omitted : undefined;
}
