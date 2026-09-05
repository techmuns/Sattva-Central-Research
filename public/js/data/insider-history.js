// Insider disclosures are events: a later response may omit an event we already captured.
// Share the same additive, duplicate-free merge between scheduled captures and the browser.

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};

const folded = (value) => String(value ?? '')
  .normalize('NFKD')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const compactNumber = (value) => {
  const match = String(value ?? '').match(/[+-]?[\d,]+(?:\.\d+)?/);
  if (!match) return '';
  const number = Number(match[0].replaceAll(',', ''));
  return Number.isFinite(number) ? String(number) : '';
};

const field = (cells, names) => {
  const wanted = new Set(names.map(folded));
  for (const [key, value] of Object.entries(cells || {})) {
    if (wanted.has(folded(key)) && value != null && String(value).trim()) return String(value).trim();
  }
  return '';
};

const direction = (value) => {
  const text = folded(value);
  if (/\b(acq|acquisition|acquire|bought|buy|purchase|purchased)\b/.test(text)) return 'buy';
  if (/\b(disp|disposal|dispose|sold|sell|sale)\b/.test(text)) return 'sell';
  if (/\bpledge\b/.test(text) && /\b(release|released|revoke|revocation)\b/.test(text)) return 'pledge-release';
  if (/\bpledge\b/.test(text)) return 'pledge';
  return text;
};

export const INSIDER_TRADE_CATEGORY = 'Insider trade';

/** Give older Muns rows the category that was implicit before the Screener market-wide feeds. */
export function withTradeCategory(row) {
  const copy = { ...row, cells: { ...(row?.cells || {}) } };
  if (!field(copy.cells, ['Trade Category', 'Disclosure Type'])) {
    copy.cells['Trade Category'] = INSIDER_TRADE_CATEGORY;
  }
  return copy;
}

/**
 * The economic event identity shared by Muns and Screener.
 *
 * Provider labels, URLs, formatting and descriptive columns deliberately do not participate. The
 * same exchange disclosure can arrive as `Acquisition / 120000 / BSE` from Muns and as
 * `Bought / 1,20,000 Equity / Screener.in`; treating the whole row as its identity displays that
 * event twice. Ticker + date + person + direction + shares is the narrow common denominator.
 * Trade category remains part of the key so a bulk deal and a separately reported SAST event are
 * not collapsed merely because they describe the same transfer.
 *
 * Rows without enough shared identity fall back to their complete, sorted content. We never guess
 * two anonymous or undated rows are the same event.
 */
export function insiderTradeIdentity(input) {
  const row = withTradeCategory(input);
  const cells = row.cells;
  const category = folded(field(cells, ['Trade Category', 'Disclosure Type']) || INSIDER_TRADE_CATEGORY);
  const person = folded(field(cells, ['Insider', 'Person', 'Person Name', 'Name of Insider', 'Acquirer', 'Holder']));
  const transaction = direction(field(cells, ['Transaction', 'Transaction Type', 'Acq/Disp', 'Acquisition/Disposal']));
  const shares = compactNumber(field(cells, ['Trade Shares', 'Shares', 'Quantity', 'Qty']));
  const ticker = folded(row.ticker);
  const date = String(row.date || '').slice(0, 10);
  if (ticker && date && person && transaction && shares) {
    return `event|${category}|${ticker}|${date}|${person}|${transaction}|${shares}`;
  }
  const { raw, url, ...rest } = row;
  const cleanCells = Object.fromEntries(Object.entries(rest.cells || {}).filter(([key]) => !/^(source|.*url|.*link)$/i.test(key)));
  return `row|${JSON.stringify(canonical({ ...rest, cells: cleanCells }))}`;
}

const directUrl = (row) => /^https?:\/\//i.test(String(row?.url || '')) ? row.url : null;

/** Merge two representations of one event, keeping richer fields and a direct evidence URL. */
function combine(left, right) {
  const a = withTradeCategory(left);
  const b = withTradeCategory(right);
  const cells = { ...b.cells, ...a.cells };
  return {
    ...b,
    ...a,
    ticker: a.ticker || b.ticker,
    date: a.date || b.date,
    cells,
    ...(directUrl(a) || directUrl(b) ? { url: directUrl(a) || directUrl(b) } : {}),
  };
}

/**
 * Retain distinct disclosures inside the requested window and return each economic event once.
 * Empty or smaller responses never retract history; readable dates outside the window expire.
 */
export function mergeInsiderTrades(previous = [], incoming = [], { from = null, to = null } = {}) {
  const inWindow = (row) => {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(row?.date || '')?.[0];
    return !date || ((!from || date >= from) && (!to || date <= to));
  };
  const positions = new Map();
  const rows = [];
  for (const candidate of [...previous, ...incoming]) {
    if (!candidate || !inWindow(candidate)) continue;
    const row = withTradeCategory(candidate);
    const key = insiderTradeIdentity(row);
    const at = positions.get(key);
    if (at == null) {
      positions.set(key, rows.length);
      rows.push(row);
    } else {
      rows[at] = combine(rows[at], row);
    }
  }
  return rows;
}

/** Keep the source's headings and order, appending columns supplied by other responses. */
export const mergeInsiderHeaders = (...lists) => [...new Set(lists.flat())];
