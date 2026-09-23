#!/usr/bin/env node
// scripts/build-sector-kpis.mjs — the sector → KPI ontology, and every classified company resolved
// into it, as one small file the browser can read.
//
//   in:  scripts/fixtures/sector-kpi-ontology.yaml    (the ontology Munshot's /sector-kpis/seed reads)
//        public/data/company-classification.json      (scripts/classify-companies.mjs)
//   out: public/data/sector-kpis.json
//
// THE ONTOLOGY IS REPRODUCED, NOT EDITED. Every KPI name, alias and group, and every (sector,
// industry) → group assignment, comes from the YAML unchanged; the one place this dashboard departs
// from its answer is `GROUP_OVERRIDES` in public/js/data/sector-kpis-shared.js, and the output
// prints each override with its reason.
//
// IT REFUSES TO WRITE A FILE IT CANNOT RECONCILE:
//   • every KPI a group lists must be defined, and every group a pair names must exist;
//   • two strings that normalise onto one (sector, industry) pair must agree on its group;
//   • the table the ontology seeds is recomputed — one row per pair per distinct KPI name, globals
//     included, exactly as the seed dedupes them — and, when SECTOR_KPIS_CSV points at an export of
//     that table, every pair's KPI set must match the export's. The 23 September 2026 export held
//     29,465 rows over 644 pairs and matches this file exactly.
// A reader that half-understood the YAML would otherwise ship a map with a branch missing, and
// every company under it would silently lose its KPIs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseYamlLite } from './lib/yaml-lite.mjs';
import { buildSectorIndex, resolveGroup, GROUP_OVERRIDES, normaliseLabel } from '../public/js/data/sector-kpis-shared.js';

const ONTOLOGY = process.env.SECTOR_KPIS_ONTOLOGY || 'scripts/fixtures/sector-kpi-ontology.yaml';
const CLASSIFICATION = process.env.SECTOR_KPIS_CLASSIFICATION || 'public/data/company-classification.json';
const OUT = process.env.SECTOR_KPIS_OUT || 'public/data/sector-kpis.json';

/** Reader-facing names for the ontology's group ids. The ids themselves are the ontology's. */
const GROUP_LABELS = {
  aerospace_defense: 'Aerospace & Defence', auto: 'Automobiles', auto_components: 'Auto Components',
  aviation: 'Aviation', banks: 'Banks', business_services: 'Business Services', capital_goods: 'Capital Goods',
  capital_markets: 'Capital Markets', cement: 'Cement', chemicals: 'Chemicals', consumer_durables: 'Consumer Durables',
  consumer_staples: 'Consumer Staples', diagnostics: 'Diagnostics', diversified_holding: 'Diversified & Holding',
  education: 'Education', hardware: 'Hardware', hospitals: 'Hospitals', hotels: 'Hotels', infrastructure: 'Infrastructure',
  insurance: 'Insurance', investment_vehicles: 'Funds & Trusts', it_services: 'IT Services', logistics: 'Logistics',
  media: 'Media', medical_devices: 'Medical Devices', metals: 'Metals', mining: 'Mining', nbfc: 'NBFC',
  oil_gas: 'Oil & Gas', packaging: 'Packaging', paper: 'Paper', pharma: 'Pharma', power: 'Power',
  real_estate: 'Real Estate', reit: 'REIT', restaurants: 'Restaurants', retail: 'Retail', semiconductors: 'Semiconductors',
  telecom: 'Telecom', textiles: 'Textiles', utilities: 'Utilities',
};

const fail = (message) => { throw new Error(`build-sector-kpis: ${message}`); };

function readOntology() {
  const text = readFileSync(ONTOLOGY, 'utf8');
  const yaml = parseYamlLite(text);
  if (yaml?.version !== 2) fail(`expected ontology version 2, found ${yaml?.version}`);
  for (const key of ['global_kpis', 'kpi_definitions', 'kpi_groups', 'sector_industry_map']) {
    if (!yaml[key] || typeof yaml[key] !== 'object') fail(`ontology has no ${key}`);
  }
  return { yaml, sha256: createHash('sha256').update(text).digest('hex') };
}

function kpiEntry(key, def) {
  if (!def || typeof def.display_name !== 'string' || !def.display_name.trim()) fail(`KPI ${key} has no display_name`);
  if (!Array.isArray(def.aliases) || !def.aliases.every((a) => typeof a === 'string')) fail(`KPI ${key} has no alias list`);
  if (typeof def.value_type !== 'string') fail(`KPI ${key} has no value_type`);
  return { name: def.display_name.trim(), aliases: [...new Set(def.aliases.map((a) => a.trim()).filter(Boolean))], type: def.value_type };
}

/** One row per (pair, distinct KPI name), as the seed writes the table. */
function seededRows(yaml, kpis, globals) {
  const globalNames = globals.map((key) => kpis[key].name);
  const rows = new Map(); // lower "sector|industry" -> Set(lower names)
  for (const [sector, industries] of Object.entries(yaml.sector_industry_map)) {
    for (const [industry, group] of Object.entries(industries)) {
      const names = new Set([...globalNames, ...yaml.kpi_groups[group].map((key) => kpis[key].name)].map((n) => n.toLowerCase()));
      const key = `${sector.toLowerCase()}|${industry.toLowerCase()}`;
      rows.set(key, new Set([...(rows.get(key) || []), ...names]));
    }
  }
  return rows;
}

/** Reconcile against an export of the seeded table, when one is supplied. */
function reconcileCsv(rows) {
  const path = process.env.SECTOR_KPIS_CSV;
  if (!path) return null;
  const table = new Map();
  let count = 0;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines.shift();
  if (!/^"?sector_name"?,"?industry_name"?,"?kpi_name"?/.test(header)) fail(`${path} is not a sector_kpis export`);
  for (const line of lines) {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"|([^,]+)/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/""/g, '"'));
    const [sector, industry, kpi] = cells;
    const key = `${sector}|${industry}`;
    if (!table.has(key)) table.set(key, new Set());
    table.get(key).add(String(kpi).toLowerCase());
    count += 1;
  }
  for (const [key, names] of rows) {
    const exported = table.get(key);
    if (!exported) fail(`the export has no rows for ${key}`);
    const missing = [...names].filter((n) => !exported.has(n));
    const extra = [...exported].filter((n) => !names.has(n));
    if (missing.length || extra.length) fail(`${key}: export differs (missing ${missing.join(', ') || '—'}; extra ${extra.join(', ') || '—'})`);
  }
  for (const key of table.keys()) if (!rows.has(key)) fail(`the export has a pair the ontology does not: ${key}`);
  return { rows: count, pairs: table.size };
}

function main() {
  const { yaml, sha256 } = readOntology();
  const kpis = {};
  const globals = Object.keys(yaml.global_kpis);
  for (const [key, def] of Object.entries(yaml.global_kpis)) kpis[key] = { ...kpiEntry(key, def), global: true };
  for (const [key, def] of Object.entries(yaml.kpi_definitions)) {
    if (kpis[key]) fail(`KPI ${key} is defined both globally and per group`);
    kpis[key] = kpiEntry(key, def);
  }

  const groups = {};
  for (const [group, keys] of Object.entries(yaml.kpi_groups)) {
    if (!Array.isArray(keys) || !keys.length) fail(`group ${group} lists no KPIs`);
    for (const key of keys) if (!yaml.kpi_definitions[key]) fail(`group ${group} lists undefined KPI ${key}`);
    if (!GROUP_LABELS[group]) fail(`group ${group} has no reader-facing label in GROUP_LABELS`);
    groups[group] = { label: GROUP_LABELS[group], kpis: keys };
  }
  let pairs = 0;
  for (const [sector, industries] of Object.entries(yaml.sector_industry_map)) {
    for (const [industry, group] of Object.entries(industries || {})) {
      if (!groups[group]) fail(`${sector} / ${industry} names unknown group ${group}`);
      pairs += 1;
    }
  }
  for (const override of GROUP_OVERRIDES) if (!groups[override.group]) fail(`override ${override.id} names unknown group ${override.group}`);

  const index = buildSectorIndex(yaml.sector_industry_map);
  const rows = seededRows(yaml, kpis, globals);
  const tableRows = [...rows.values()].reduce((sum, names) => sum + names.size, 0);
  const reconciled = reconcileCsv(rows);

  const classification = existsSync(CLASSIFICATION) ? JSON.parse(readFileSync(CLASSIFICATION, 'utf8')) : { companies: {} };
  const companies = {};
  const unresolved = {};
  const byGroup = {};
  const byVia = {};
  for (const [ticker, entry] of Object.entries(classification.companies || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const resolved = resolveGroup(index, entry);
    if (!resolved) {
      unresolved[ticker] = { sector: entry.sector || null, industry: entry.industry || null };
      continue;
    }
    companies[ticker] = { group: resolved.group, sector: entry.sector, industry: entry.industry, via: resolved.via };
    byGroup[resolved.group] = (byGroup[resolved.group] || 0) + 1;
    byVia[resolved.via] = (byVia[resolved.via] || 0) + 1;
  }

  const payload = {
    _provenance: 'The sector → KPI ontology (scripts/fixtures/sector-kpi-ontology.yaml, reproduced unchanged) and every classified company resolved into it. Built by scripts/build-sector-kpis.mjs; read by public/js/data/kpi-impact.js. See docs/DATA-CONTRACTS.md → Sector KPIs.',
    source: {
      ontology: ONTOLOGY,
      version: yaml.version,
      sha256,
      pairs,
      tableRows,
      classification: CLASSIFICATION,
      classificationCapturedAt: classification.capturedAt || null,
    },
    globals,
    kpis,
    groups,
    overrides: GROUP_OVERRIDES.map(({ id, group, reason }) => ({ id, group, reason })),
    companies,
    unresolved,
    counts: {
      companies: Object.keys(companies).length + Object.keys(unresolved).length,
      resolved: Object.keys(companies).length,
      unresolved: Object.keys(unresolved).length,
      byVia,
      byGroup: Object.fromEntries(Object.entries(byGroup).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
  writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
  console.log(`build-sector-kpis: ${pairs} pairs, ${Object.keys(groups).length} groups, ${Object.keys(kpis).length} KPIs, ${tableRows} seeded rows${reconciled ? ` (export matched: ${reconciled.rows} rows, ${reconciled.pairs} pairs)` : ''}.`);
  console.log(`build-sector-kpis: ${payload.counts.resolved} of ${payload.counts.companies} companies resolved (${JSON.stringify(byVia)}); ${payload.counts.unresolved} unresolved.`);
  if (payload.counts.unresolved) {
    const sample = Object.entries(unresolved).slice(0, 12).map(([t, e]) => `${t} (${e.sector} › ${e.industry})`).join('; ');
    console.log(`build-sector-kpis: unresolved — ${sample}${payload.counts.unresolved > 12 ? '; …' : ''}`);
  }
  return payload;
}

/**
 * Every listed holding the built file cannot place, with the reason — for the scheduled job, which
 * publishes what it read and then fails naming these. A holding with no KPI group looks, on a card,
 * exactly like evidence that names no KPI, so the gap has to be a failed run rather than a quiet one.
 */
export function missingBook({ out = OUT, book = 'public/data/portfolio-companies.json' } = {}) {
  const built = JSON.parse(readFileSync(out, 'utf8'));
  const failed = existsSync(CLASSIFICATION) ? JSON.parse(readFileSync(CLASSIFICATION, 'utf8')).failed || {} : {};
  const holdings = existsSync(book) ? JSON.parse(readFileSync(book, 'utf8')).holdings || [] : [];
  return holdings
    .map((holding) => String(holding.ticker || '').toUpperCase())
    .filter((ticker) => ticker && !built.companies?.[ticker])
    .map((ticker) => {
      const unresolved = built.unresolved?.[ticker];
      return { ticker, reason: unresolved ? `classified ${unresolved.sector} › ${unresolved.industry}, which the ontology maps to no group`
        : failed[ticker]?.reason ? `page not read (${failed[ticker].reason})` : 'never classified' };
    });
}

// Exported for the offline verifier, which rebuilds from the fixture and compares.
export { main as buildSectorKpis, normaliseLabel };

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv.includes('--check-book')) {
      const missing = missingBook();
      if (missing.length) {
        console.error(`build-sector-kpis: ${missing.length} listed holding(s) carry no KPI group — ${missing.map((m) => `${m.ticker}: ${m.reason}`).join('; ')}`);
        process.exit(1);
      }
      console.log('build-sector-kpis: every listed holding resolves to a KPI group.');
    } else main();
  } catch (err) { console.error(err.message || err); process.exit(1); }
}
