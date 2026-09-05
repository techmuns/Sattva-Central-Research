// Pure normalisation and snapshot assembly for Screener.in's four market-wide trade lists.

import { isoDate } from '../../public/js/data/filings-shared.js';
import {
  insiderTradeIdentity,
  mergeInsiderHeaders,
  mergeInsiderTrades,
} from '../../public/js/data/insider-history.js';

export const SCREENER_TRADE_SOURCES = [
  { id: 'bulk', label: 'Bulk deal', title: 'Bulk Deals', path: '/trades/bulk/' },
  { id: 'block', label: 'Block deal', title: 'Block Deals', path: '/trades/block/' },
  { id: 'sast', label: 'SAST', title: 'SAST Trades', path: '/trades/sast/' },
  { id: 'insiders', label: 'Insider trade', title: 'Insider Trades', path: '/trades/insiders/' },
];

export const SCREENER_TRADE_CATEGORIES = SCREENER_TRADE_SOURCES.map((source) => source.label);

export const SCREENER_TRADE_HEADERS = [
  'Trade Category',
  'Company',
  'Insider',
  'Category',
  'Security Type',
  'Transaction',
  'Trade Shares',
  'Trade %',
  'Trade Value',
  'Price',
  'Mode',
  'Broadcast Date',
  'Source',
];

/** Whether this listing page has reached an exact event retained from its prior capture. */
export function hasScreenerTradeOverlap(previousIdentities, rows) {
  return previousIdentities instanceof Set
    && previousIdentities.size > 0
    && (Array.isArray(rows) ? rows : []).some((row) => previousIdentities.has(insiderTradeIdentity(row)));
}

/** Index retained Screener events once so each incremental source can stop at an exact overlap. */
export function indexPriorScreenerTradeIdentities(rows) {
  const bySource = new Map(SCREENER_TRADE_SOURCES.map((source) => [source.id, new Set()]));
  for (const row of Array.isArray(rows) ? rows : []) {
    const identities = bySource.get(row?.sourceId);
    if (identities) identities.add(insiderTradeIdentity(row));
  }
  return bySource;
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const compact = (value) => clean(value).replaceAll(',', '');
const nonempty = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value != null && clean(value) !== ''));

const cellLines = (cell) => {
  if (Array.isArray(cell?.lines)) return cell.lines.map(clean).filter(Boolean);
  return String(cell?.text || '').split(/\r?\n/).map(clean).filter(Boolean);
};

const cellLink = (cell, pattern) => (cell?.links || []).find((link) => pattern.test(link?.href || '')) || null;

const tickerFromCompanyUrl = (value) => {
  try {
    const match = /\/company\/([^/]+)/i.exec(new URL(value).pathname);
    return match ? decodeURIComponent(match[1]).trim().toUpperCase() : null;
  } catch {
    return null;
  }
};

const istDay = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const shiftDay = (day, amount) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + amount));
  return date.toISOString().slice(0, 10);
};

/** Parse Screener's absolute dates and its `today` / `yesterday` / `N days ago` summaries. */
export function screenerTradeDate(values, capturedAt = new Date().toISOString()) {
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = clean(value);
    if (!text) continue;
    const absolute = isoDate(text);
    if (absolute) return absolute;
    const base = istDay(capturedAt);
    if (!base) continue;
    if (/^today$/i.test(text)) return base;
    if (/^yesterday$/i.test(text)) return shiftDay(base, -1);
    const ago = /^(\d+)\s+days?\s+ago$/i.exec(text);
    if (ago) return shiftDay(base, -Number(ago[1]));
  }
  return null;
}

const dateCandidates = (cell) => [
  ...(cell?.dates || []),
  cell?.datetime,
  cell?.title,
  cell?.text,
].filter(Boolean);

const quantityAndPrice = (lines) => {
  for (const line of lines) {
    const match = /([\d,]+(?:\.\d+)?)\s*@\s*([\d,]+(?:\.\d+)?)/.exec(line);
    if (match) return { quantity: compact(match[1]), price: compact(match[2]) };
  }
  return { quantity: null, price: null };
};

const quantity = (lines) => {
  for (const line of lines) {
    const labelled = /\bqty\.?\s*([\d,]+(?:\.\d+)?)/i.exec(line);
    if (labelled) return compact(labelled[1]);
  }
  return null;
};

const transaction = (value) => {
  const text = clean(value);
  if (/^b$/i.test(text)) return 'Buy';
  if (/^s$/i.test(text)) return 'Sell';
  if (/^acq$/i.test(text)) return 'Acquisition';
  return text || null;
};

const insiderParts = (lines) => {
  const relation = /\b(promoter|director|employee|relative|designated|managerial|trust|group)\b/i;
  if (lines.length > 1 && relation.test(lines[0]) && /\(\d+\)/.test(lines[0])) {
    return { person: lines.slice(1).join(', '), category: lines[0] };
  }
  return { person: lines[0] || null, category: lines.slice(1).join(', ') || null };
};

const insiderQuantity = (lines) => {
  const detail = lines.slice(1).join(' ');
  const match = /([\d,]+(?:\.\d+)?)\s+(.+)/.exec(detail);
  return match
    ? { quantity: compact(match[1]), security: clean(match[2]) }
    : { quantity: quantity(lines), security: null };
};

/** Turn one five-cell listing row into the dashboard's flexible insider-row contract. */
export function normaliseScreenerTrade(source, raw, { capturedAt = new Date().toISOString() } = {}) {
  if (!source || !SCREENER_TRADE_CATEGORIES.includes(source.label)) throw new Error('Unknown Screener trade source.');
  const cells = Array.isArray(raw?.cells) ? raw.cells : [];
  if (cells.length < 5) return null;

  const companyLink = cellLink(cells[0], /\/company\//i);
  const companyLines = cellLines(cells[0]);
  const ticker = tickerFromCompanyUrl(companyLink?.href);
  const company = clean(companyLink?.text || companyLines[0]);
  const personLines = cellLines(cells[1]);
  const typeLines = cellLines(cells[3]);
  const valueLines = cellLines(cells[4]);
  const date = screenerTradeDate(dateCandidates(cells[2]), capturedAt);
  if (!ticker || !company || !date || !personLines.length || !typeLines.length) return null;

  let person = personLines.join(', ');
  let personCategory = null;
  let security = null;
  let tradeShares = null;
  let tradePct = null;
  let tradeValue = null;
  let price = null;
  let mode = null;
  let action = transaction(typeLines[0]);

  if (source.id === 'bulk' || source.id === 'block') {
    ({ quantity: tradeShares, price } = quantityAndPrice(valueLines));
    tradeValue = valueLines[0] || null;
    security = 'Equity';
  } else if (source.id === 'sast') {
    mode = typeLines.slice(1).join(' · ') || null;
    tradePct = valueLines[0] && valueLines[0] !== '--%' ? valueLines[0].replace(/%$/, '') : null;
    tradeShares = quantity(valueLines);
  } else {
    ({ person, category: personCategory } = insiderParts(personLines));
    ({ quantity: tradeShares, security } = insiderQuantity(typeLines));
    tradeValue = valueLines[0] && valueLines[0] !== '--' ? valueLines[0] : null;
  }

  return {
    ticker,
    date,
    url: raw.pageUrl || `https://www.screener.in${source.path}?o=-2`,
    sourceId: source.id,
    cells: nonempty({
      'Trade Category': source.label,
      Company: company,
      Insider: person,
      Category: personCategory,
      'Security Type': security,
      Transaction: action,
      'Trade Shares': tradeShares,
      'Trade %': tradePct,
      'Trade Value': tradeValue,
      Price: price,
      Mode: mode,
      'Broadcast Date': date,
      Source: 'Screener.in',
    }),
  };
}

const flatten = (capture) => Object.entries(capture?.byTicker || {}).flatMap(([ticker, rows]) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, ticker: row?.ticker || ticker }))
);

/** Assemble an exchange-wide, retained, four-category snapshot. */
export function buildScreenerTradesSnapshot(previous, captures, { capturedAt = new Date().toISOString(), windowDays = 365 } = {}) {
  const ids = new Set((captures || []).map((capture) => capture?.id));
  const missing = SCREENER_TRADE_SOURCES.filter((source) => !ids.has(source.id));
  if (missing.length || ids.size !== SCREENER_TRADE_SOURCES.length) {
    throw new Error(`All four Screener trade categories are required; missing: ${missing.map((source) => source.id).join(', ') || 'duplicate source'}.`);
  }
  if (captures.some((capture) => capture.ok === false || !Array.isArray(capture.rows))) {
    throw new Error('Every Screener trade category must be readable before the snapshot is changed.');
  }

  const to = istDay(capturedAt);
  const from = shiftDay(to, -windowDays);
  const incoming = captures.flatMap((capture) => capture.rows);
  const rows = mergeInsiderTrades(flatten(previous), incoming, { from, to });
  const byTicker = {};
  for (const row of rows) {
    if (!row.ticker) continue;
    (byTicker[row.ticker] ||= []).push(row);
  }
  for (const list of Object.values(byTicker)) {
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || insiderTradeIdentity(a).localeCompare(insiderTradeIdentity(b)));
  }

  const previousSources = new Map((previous?.sources || []).map((source) => [source.id, source]));
  const sourceMeta = captures.map(({ rows: sourceRows, ...capture }) => {
    const earlier = previousSources.get(capture.id);
    return {
      ...capture,
      ok: true,
      rowCount: sourceRows.length,
      capturedAt,
      // Incremental runs reread only the newest overlap. The first complete bootstrap boundary is
      // the durable claim about how far back all rows have been captured, so do not replace it with
      // the oldest row in this much smaller refresh batch.
      coverageFrom: earlier?.coverageFrom || capture.oldestDate,
    };
  });
  const coverageFrom = sourceMeta.map((source) => source.coverageFrom).filter(Boolean).sort().at(-1) || from;
  const rowCount = Object.values(byTicker).reduce((sum, list) => sum + list.length, 0);
  const headers = mergeInsiderHeaders(
    ['Trade Category'],
    previous?.headers || [],
    SCREENER_TRADE_HEADERS,
    rows.flatMap((row) => Object.keys(row.cells || {})),
  );

  return {
    _provenance:
      `REAL DATA, NOT OURS. Market-wide ${SCREENER_TRADE_CATEGORIES.join(', ')} listings are read from Screener.in in newest-first order. ` +
      `All four categories must succeed before this file changes. Exact repeat captures and cross-provider representations of the same ticker/date/person/direction/quantity event are merged once; distinct categories remain distinct. ` +
      `Rows are retained for ${windowDays} days; verified four-list coverage starts ${coverageFrom}. Portfolio and Watchlist are exact ticker filters over this same exchange-wide capture; Universe shows the whole retained feed.`,
    kind: 'insider',
    source: 'Screener.in market-wide trade listings, supplemented by retained Muns insider disclosures',
    generator: 'scripts/scrape-screener-trades.mjs',
    capturedAt,
    oldestDataAt: capturedAt,
    from,
    to,
    windowDays,
    coverageFrom,
    scope: 'exchange',
    coversUniverse: true,
    categories: SCREENER_TRADE_CATEGORIES,
    sources: sourceMeta,
    asked: SCREENER_TRADE_SOURCES.length,
    covered: SCREENER_TRADE_SOURCES.length,
    withRows: Object.keys(byTicker).length,
    emptyCount: 0,
    rowCount,
    failedCount: 0,
    fallbackCount: 0,
    headers,
    byTicker,
    empty: [],
    failed: {},
    fallback: {},
  };
}
