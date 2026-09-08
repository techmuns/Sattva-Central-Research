// Open-vocabulary retrieval for portfolio implications. Ranking discovers source
// passages; it does not declare a peer, supplier, beneficiary or causal relation.
// No model planning round-trip, ticker taxonomy, new source or persisted book.
import { companyPassages, holdingForBusinessRow, datedPerformance } from './business-context.js';
import { eventDay } from './query-context.js';
const identity = h => h?.isin || h?.ticker || h?.name;
const clip = (s, n = 420) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const STOP = new Set(`a an the and or of to in on at for from by with without as is are was were be been being this that these those it its they their them i my our your we you me us if then what which who how why when where can could would should will do does did have has had not no may might any all other same similar comparable portfolio holding holdings stock stocks company companies limited ltd news latest recent today yesterday tomorrow benefit benefits benefited impact impacts affect affects risk risks exposure exposures perform performance compare comparison question evidence source report reported reporting says said crore million billion percent per cent business businesses price prices share shares market markets fall falls falling fell rise rises rising rose higher lower increase increases decrease decreases stronger weaker weak strong upside downside positive positively negative negatively exposed hurt lose losses win improve improving improved result results growth best clearest clear offset everything together common same make makes today updates update recently limited ltd financial financials quarter quarterly annual informed exchange regulation disclosure securities board meeting requirements listing obligations corporate buy sell hold target recommended recommend rating price bullish bearish bse nse icici brokerage research report share stock dated september august july june january february march april may october november december`.split(' '));
export function reasoningTerms(text) {
  const words = (String(text || '').toLowerCase().replace(/\b(?:million|billion|crore|lakh|thousand)\s+(?:rupees?|dollars?)\b/g, ' ').match(/[a-z][a-z-]{2,}/g) || []).flatMap(w => w.split('-'));
  return [...new Set(words.filter(w => !STOP.has(w)).map(w => w.replace(/ies$/, 'y').replace(/(?<!s)s$/, '')))];
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function semanticText(text, companies) {
  return companies.reduce((out, h) => [h.name, h.bookName, h.ticker].filter(Boolean).reduce((v, name) =>
    v.replace(new RegExp(`\\b${escape(String(name).replace(/\b(?:limited|ltd)\.?$/i, '').trim())}\\b`, name === h.ticker ? 'g' : 'gi'), ' '), out), text);
}

export function reasoningReadings(rows, plan) {
  const holdings = [...plan.businessHoldings, ...plan.companies];
  const terms = new Set(reasoningTerms(semanticText(plan.reasoningQuery || plan.tokens.join(' '), plan.companies)));
  const byCompany = new Map();
  const issuerName = name => String(name || '').toLowerCase().replace(/\b(?:limited|ltd)\.?$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const names = holdings.map(h => ({ key: identity(h), name: issuerName(h.name) }));
  const longerIdentities = new Map(names.map(h => [h.key, names.filter(other => other.key !== h.key && other.name.startsWith(`${h.name} `)).map(other => other.name)]));
  for (const row of rows) {
    if (row.recordType === 'reference-page' || /(?:share price.*stock price|stock price.*share price)/i.test(row.title || row.headline || '')) continue;
    const holding = holdingForBusinessRow(row, holdings);
    if (!holding) continue;
    // A longer, separately held legal identity must not donate its former
    // division's business to the shorter name after a demerger/rename.
    const collisions = longerIdentities.get(identity(holding)) || [];
    if (collisions.length) {
      const content = ` ${issuerName([row.title, row.headline, row.summary, row.text, row.detail].filter(Boolean).join(' '))} `;
      if (collisions.some(name => content.includes(` ${name} `))) continue;
    }
    // Preserve issuer-local clauses of round-ups. An explicitly attributed
    // standalone record can also have a title with no company name (filings).
    if (/^\s*\[[^\]]+\]\s*$/.test(row.title || row.headline || '')) continue;
    const text = clip(companyPassages(row) || (row.attribution === 'confirmed' && !/telegram|chatter|social|twitter/i.test(row.feed || '') ? [row.title, row.headline, row.summary, row.text, row.detail].filter(Boolean).join('. ') : ''), 700);
    if (/^\s*\[[^\]]+\]\s*$/.test(text)) continue;
    const industry = clip(row.industry || row.sector || holding.sector, 100);
    if (!text && !industry) continue;
    const tokens = reasoningTerms(semanticText(`${text} ${industry}`, [holding]));
    const hit = tokens.filter(t => terms.has(t)).length;
    const key = identity(holding);
    if (!byCompany.has(key)) byCompany.set(key, new Map());
    const seen = byCompany.get(key);
    const fingerprint = `${eventDay(row)}:${text || industry}`;
    if (seen.has(fingerprint)) continue;
    seen.set(fingerprint, { row, ticker: holding.ticker || null, isin: holding.isin || null, company: holding.name,
      date: eventDay(row), text: text || industry, industry, tokens, hit, discussion: /telegram|chatter|twitter|social/i.test(row.feed || ''), basis: text ? 'company-linked source text' : 'industry label only',
      url: row.url || row.documents?.[0]?.url || null });
  }
  // An unsplit roundup may be assigned to several issuers. Preserve it as shared
  // context, but do not let identical multi-company text outrank an issuer's own
  // evidence just because its other clauses repeat the question's words.
  const all = [...byCompany.values()].flatMap(readings => [...readings.values()]);
  const owners = new Map();
  const passageKey = r => r.text.toLowerCase().replace(/\W+/g, ' ').trim();
  for (const reading of all) {
    const key = passageKey(reading);
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(identity(reading));
  }
  for (const reading of all) {
    reading.sharedPassage = owners.get(passageKey(reading)).size > 1;
    if (reading.sharedPassage) reading.basis = 'shared multi-company passage; individual exposure not established';
  }
  // Query ranking happens before this per-company/per-source sample. A tiny or
  // tickerless holding has the same opportunity as the largest position.
  return [...byCompany.values()].flatMap(readings => [...readings.values()]
    .sort((a, b) => b.hit * (b.sharedPassage ? 0.2 : 1) - a.hit * (a.sharedPassage ? 0.2 : 1) || String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 12));
}

function corpus(packets, plan) {
  const readings = packets.flatMap(p => (p.reasoningReadings || []).map(r => ({ ...r, sourceId: p.id, tab: p.tab,
    sourceStatus: p.dataQuality === 'partial' ? 'partial' : p.status,
    verification: r.discussion || ['telegram', 'chatter-posts', 'public-chatter'].includes(p.id) ? 'unverified discussion' : 'source-reported' })));
  const byCompany = new Map();
  for (const reading of readings) {
    const key = identity(reading);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(reading);
  }
  // Term rarity is measured by companies, not duplicated headlines/alert feeds.
  const frequency = new Map();
  for (const rows of byCompany.values()) for (const token of new Set(rows.flatMap(r => r.tokens))) frequency.set(token, (frequency.get(token) || 0) + 1);
  const idf = token => Math.log(1 + (byCompany.size + 1) / (1 + (frequency.get(token) || 0)));
  const query = new Map(reasoningTerms(semanticText(plan.reasoningQuery || plan.tokens.join(' '), plan.companies)).map(t => [t, 3]));
  const direct = r => r.tokens.reduce((sum, t) => sum + (query.has(t) ? idf(t) : 0), 0);
  const operatingRank = r => r.row.sourceTags?.length ? 3 : r.industry && r.sourceId === 'technicals' ? 2 : r.basis === 'industry label only' ? 1 : 0;
  const referenceRows = plan.companies.flatMap(c => {
    const own = readings.filter(r => c.isin && r.isin ? c.isin === r.isin : c.ticker && c.ticker === r.ticker);
    const operating = own.filter(r => operatingRank(r) > 0);
    return (operating.length ? operating : own).sort((a, b) => direct(b) - direct(a) || operatingRank(b) - operatingRank(a) || String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 3);
  });
  // Expand from the requested reference's own dated evidence, using arbitrary
  // products, inputs or markets present there, not a fixed sector vocabulary.
  const expansion = [...new Set(referenceRows.flatMap(r => r.tokens))].sort((a, b) => idf(b) - idf(a)).slice(0, 32);
  for (const token of expansion) if (!query.has(token)) query.set(token, 1);
  const score = r => r.tokens.reduce((sum, t) => sum + (query.get(t) || 0) * idf(t), 0) / Math.sqrt(1 + r.tokens.length / 35) * (r.sharedPassage ? 0.2 : 1);
  readings.forEach(r => { r.rank = score(r); });
  return { readings, referenceRows, byCompany };
}
const proof = r => ({ tab: r.tab, date: r.date, text: clip(r.text, 350), basis: r.basis,
  sourceStatus: r.sourceStatus, verification: r.verification,
  ...(r.url && r.url.length <= 180 ? { url: r.url } : {}) });
function diverse(rows, max = 3) {
  const selected = [], seen = new Set(), sources = new Set();
  const ranked = [...rows].sort((a, b) => b.rank - a.rank || String(b.date || '').localeCompare(String(a.date || '')));
  for (const newSource of [true, false]) for (const row of ranked) {
    // Identical syndicated content is not independent corroboration.
    if (seen.has(row.text) || newSource && sources.has(row.sourceId)) continue;
    selected.push(row); seen.add(row.text); sources.add(row.sourceId);
    if (selected.length === max) return selected;
  }
  return selected;
}
export function portfolioReasoningContext({ plan, packets, technicalRows = [] }) {
  const { readings, referenceRows } = corpus(packets, plan);
  // Let the model consider businesses that have no lexical hit. This compact
  // map covers every supplied holding before any detailed candidate sampling.
  // Prefer company analysis and actual industry over incidental news vocabulary.
  const profileTerms = new Set(reasoningTerms(plan.reasoningQuery || plan.tokens.join(' ')));
  const profiles = plan.businessHoldings.map(holding => {
    const own = readings.filter(r => holding.isin && r.isin ? holding.isin === r.isin : holding.ticker && holding.ticker === r.ticker);
    const operating = own.filter(r => r.sourceId === 'concall' && r.row.sourceTags?.length)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
    const sector = own.find(r => r.sourceId === 'technicals' && r.industry) || own.find(r => r.industry);
    const tags = [...(operating?.row.sourceTags || [])].sort((a, b) => reasoningTerms(b).filter(t => profileTerms.has(t)).length - reasoningTerms(a).filter(t => profileTerms.has(t)).length);
    return [holding.ticker || holding.isin, holding.name, sector?.industry || holding.sector || null,
      sector?.tab || 'Ask Sattva', operating?.date || null,
      tags[0] || null];
  });
  const references = plan.companies.map(company => ({ ticker: company.ticker, isin: company.isin, name: company.name,
    evidence: diverse(referenceRows.filter(r => company.isin && r.isin ? company.isin === r.isin : company.ticker === r.ticker)).map(proof) }));
  const industrySources = [...new Set(profiles.map(row => row[3]))];
  const excluded = new Set(plan.companies.map(c => identity(holdingForBusinessRow(c, plan.businessHoldings) || c)));
  const candidates = [];
  for (const holding of plan.businessHoldings) {
    if (excluded.has(identity(holding))) continue;
    const rows = readings.filter(r => holding.isin && r.isin ? holding.isin === r.isin : holding.ticker && holding.ticker === r.ticker);
    const relevant = rows.filter(r => r.rank > 0);
    if (!relevant.length) continue;
    const evidence = diverse(relevant);
    candidates.push({ ticker: holding.ticker || null, isin: holding.isin, name: holding.name,
      weightPct: plan.businessHoldingsVerified && plan.businessWeightsComplete && Number.isFinite(holding.weightPct) ? holding.weightPct : null,
      overlapScore: Math.max(...relevant.map(r => r.rank)), relationship: 'Question-relevant evidence candidate; business relationship and direction require interpretation',
      evidence: evidence.map(proof),
      ...(plan.business.comparePerformance || plan.business.afterEvent ? { performance: datedPerformance(technicalRows.find(r => r.ticker && r.ticker === holding.ticker)) } : {}),
    });
  }
  candidates.sort((a, b) => b.overlapScore - a.overlapScore || a.name.localeCompare(b.name));
  const referenceHoldingsExcluded = plan.businessHoldings.filter(h => excluded.has(identity(h))).length;
  return { kind: 'portfolio-reasoning', theme: plan.business.label,
    definition: 'Open-vocabulary retrieval, not a relationship classification. Explain mechanisms from supplied facts; distinguish direct peers, suppliers/customers, opposing exposures and indirect effects only when supported. Conditional economic reasoning is allowed; company exposures, links and realised benefits cannot be invented.',
    holdingsBasis: plan.businessHoldingsVerified ? 'complete authenticated positions' : 'dashboard scope/coverage only; ownership and weights not established',
    holdingsExamined: plan.businessHoldings.length, candidatesFound: candidates.length, referenceHoldingsExcluded,
    otherHoldingsWithoutMatchingEvidence: plan.businessHoldings.length - referenceHoldingsExcluded - candidates.length,
    sourceCoverage: 'Loaded source text ranked before per-company samples (up to 12 per source). Synonyms or implicit links may be missed. No match or omitted candidate does not establish no exposure. Industry labels and unread documents are not proof of a business link.',
    eventBasis: plan.business.afterEvent ? 'No single event has been resolved by this retrieval. Do not substitute a latest-session move for a since-event return; use explicitly supplied matching endpoints or say it is unmeasured.' : undefined,
    businessProfiles: { columns: ['identity', 'name', 'industry', 'industrySourceIndex'], industrySources,
      rows: profiles.map(row => [...row.slice(0, 3), industrySources.indexOf(row[3])]),
      total: profiles.length, omitted: 0,
      analyses: { tab: 'Con-call', columns: ['identity', 'publicationDate', 'analysisExcerpt'],
        rows: profiles.filter(row => row[5]).map(row => [row[0], row[4], row[5]]), omitted: 0 },
      definition: 'Industry labels cite industrySources[industrySourceIndex]; analysis records ALL cite Con-call. Analysis is the provider summary, not a transcript quotation. These are not certified exposure or relationship tags. Industry alone supports conditional candidates. Null means unavailable. Ownership follows holdingsBasis.' },
    references, candidates, candidatesOmitted: 0 };
}

export function reasoningSourceSamples(packets, context, plan) {
  if (!context?.candidates?.length) return packets;
  const { readings } = corpus(packets, plan);
  const allowed = [...context.candidates, ...context.references];
  return packets.map(packet => {
    const rows = [], seen = new Set();
    const material = value => {
      if (Array.isArray(value)) return value.map(material).filter(v => v !== undefined);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([k, v]) => k !== 'periodMatch' && v !== null && v !== undefined && v !== '')
        .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, material(v)])
        .filter(([, v]) => !Array.isArray(v) || v.length));
      return value ?? undefined;
    };
    const add = row => { const key = JSON.stringify(material(row)); if (!seen.has(key)) { seen.add(key); rows.push(row); } };
    for (const company of allowed) {
      const matches = readings.filter(r => r.sourceId === packet.id && (company.isin && r.isin ? company.isin === r.isin : company.ticker && company.ticker === r.ticker));
      diverse(matches, 2).forEach(r => add(r.row));
    }
    // Retain original numeric/period rows too; textual dossiers cannot replace
    // earnings, operating metrics or price facts that have little prose.
    for (const row of packet.rows || []) if (holdingForBusinessRow(row, allowed)) add(row);
    return { ...packet, rows, rowTiers: rows.map(() => 0), rowPriorities: rows.map((_, i) => i) };
  });
}
