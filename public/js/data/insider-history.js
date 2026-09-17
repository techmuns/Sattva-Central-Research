// Insider disclosures are events: a later response may omit an event we already captured.
// Share the same additive, duplicate-free merge between scheduled captures and the browser.

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};

const foldText = (value) => String(value ?? '')
  .normalize('NFKD')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
// A pure string-to-string function asked the same questions millions of times: every column
// heading of every row, on every identity, on every cumulative archive merge. Profiled at 628ms
// self time on one cold open of Insider Trades. Bounded FIFO on the raw string, the same shape as
// `matchKeywords`; the bound keeps a long history from retaining folded text for ever.
const FOLD_CACHE_MAX = 65_536;
const foldCache = new Map();
const foldKeys = new Array(FOLD_CACHE_MAX);
let nextFoldKey = 0;
const folded = (value) => {
  const key = typeof value === 'string' ? value : String(value ?? '');
  const hit = foldCache.get(key);
  if (hit !== undefined) return hit;
  const out = foldText(key);
  foldCache.delete(foldKeys[nextFoldKey]);
  foldKeys[nextFoldKey] = key;
  nextFoldKey = (nextFoldKey + 1) % FOLD_CACHE_MAX;
  foldCache.set(key, out);
  return out;
};

const compactNumber = (value) => {
  const match = String(value ?? '').match(/[+-]?[\d,]+(?:\.\d+)?/);
  if (!match) return '';
  const number = Number(match[0].replaceAll(',', ''));
  return Number.isFinite(number) ? String(number) : '';
};

// The folded name set is a property of the names list, so the lists below are module constants
// rather than literals rebuilt (and re-folded) on every call.
const wantedNames = new WeakMap();
const field = (cells, names) => {
  let wanted = wantedNames.get(names);
  if (!wanted) { wanted = new Set(names.map(folded)); wantedNames.set(names, wanted); }
  for (const [key, value] of Object.entries(cells || {})) {
    if (wanted.has(folded(key)) && value != null && String(value).trim()) return String(value).trim();
  }
  return '';
};
const TRADE_CATEGORY_FIELDS = ['Trade Category', 'Disclosure Type'];
const PERSON_FIELDS = ['Insider', 'Person', 'Person Name', 'Name of Insider', 'Acquirer', 'Holder'];
const TRANSACTION_FIELDS = ['Transaction', 'Transaction Type', 'Acq/Disp', 'Acquisition/Disposal'];
const SHARES_FIELDS = ['Trade Shares', 'Shares', 'Quantity', 'Qty'];

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
// A row that already carries its category is returned AS IS rather than copied. Every merge used
// to copy every row it kept, so the output of one archive month's merge was a fresh object for
// the next month's merge — and nothing keyed on a row could ever hit twice. Rows are replaced,
// never edited, so sharing the object is exactly what the memoised identity below needs.
// And a row that needs the category is promoted ONCE: the promoted copy is kept on the legacy row,
// so a merge that runs again over the same retained rows hands out the same objects, and a reading
// kept on the promoted row (the alerts collector's insider event) survives the next merge.
const promoted = new WeakMap();
export function withTradeCategory(row) {
  if (row && typeof row === 'object' && field(row.cells, TRADE_CATEGORY_FIELDS)) return row;
  const cacheable = row && typeof row === 'object';
  const hit = cacheable ? promoted.get(row) : undefined;
  if (hit) return hit;
  const copy = { ...row, cells: { ...(row?.cells || {}) } };
  copy.cells['Trade Category'] = INSIDER_TRADE_CATEGORY;
  if (cacheable) promoted.set(row, copy);
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
// ONE IDENTITY PER ROW OBJECT. The identity is a pure function of the row's content and rows are
// immutable, so the object is the key; a cumulative merge of twelve archive months no longer
// re-derives every retained row's identity twelve times. The entry dies with the row.
const identities = new WeakMap();
export function insiderTradeIdentity(input) {
  const cacheable = input !== null && typeof input === 'object';
  if (cacheable) {
    const hit = identities.get(input);
    if (hit !== undefined) return hit;
  }
  const value = deriveIdentity(input);
  if (cacheable) identities.set(input, value);
  return value;
}
function deriveIdentity(input) {
  const row = withTradeCategory(input);
  const cells = row.cells;
  // Official exchange reports retain venue, report type and price. They are reconciled
  // against secondary coverage before reaching this additive archive layer.
  if (/^(nse|bse)-(bulk|block)$/.test(row.sourceId || '')) {
    return JSON.stringify(['exchange', row.sourceId, row.date, row.exchangeSecurity || row.ticker,
      folded(cells.Insider), direction(cells.Transaction), compactNumber(cells['Trade Shares']), compactNumber(cells.Price)]);
  }
  const category = folded(field(cells, TRADE_CATEGORY_FIELDS) || INSIDER_TRADE_CATEGORY);
  const person = folded(field(cells, PERSON_FIELDS));
  const transaction = direction(field(cells, TRANSACTION_FIELDS));
  const shares = compactNumber(field(cells, SHARES_FIELDS));
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
