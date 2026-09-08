// Display/filter identities only. Never rewrite an article's stored source, headline or URL:
// distinct names that are not explicitly reviewed here remain separate publishers.
const KNOWN_PUBLISHERS = new Map([
  ['Moneycontrol', ['moneycontrol', 'money control', 'moneycontrol.com', 'www.moneycontrol.com']],
  ['The Economic Times', ['economic times', 'the economic times', 'economictimes', 'economictimes.com', 'economictimes.indiatimes.com']],
  ['Mint', ['mint', 'livemint', 'live mint', 'mint / livemint', 'livemint.com', 'www.livemint.com']],
  ['Business Standard', ['business standard', 'business-standard', 'business-standard.com', 'www.business-standard.com']],
  ['Business Wire', ['business wire', 'businesswire', 'businesswire.com']],
  ['GlobeNewswire', ['globenewswire', 'globe newswire', 'globenewswire.com']],
  ['PR Newswire', ['pr newswire', 'prnewswire', 'prnewswire.com']],
  ['Dow Jones Newswires', ['dow jones newswires', 'dow jones newswire']],
  ['Reuters', ['reuters', 'reuters.com', 'www.reuters.com']],
  ['TradingView', ['tradingview', 'trading view', 'tradingview.com', 'in.tradingview.com']],
  ['Investing.com', ['investing.com', 'in.investing.com', 'www.investing.com']],
  ['London Stock Exchange', ['london stock exchange', 'londonstockexchange']],
  ['Quartr', ['quartr']],
  ['Invezz', ['invezz', 'invezz.com']],
  ['The Block', ['the block', 'theblock']],
].flatMap(([name, aliases]) => aliases.map(alias => [alias, name])));

export function canonicalPublisherName(value) {
  const source = String(value ?? '').trim().replace(/\s+/g, ' ');
  return KNOWN_PUBLISHERS.get(source.toLowerCase()) || source;
}

export function newsPublisherFilter(rows) {
  const outlets = [...new Set(rows.map(row => canonicalPublisherName(row.source)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  // Keep this filter present even on a one-source partial paint. Its position and selected value
  // must survive the next source arrival; the list is measured from every row, without a cap.
  return {
    label: 'Outlet',
    options: [{ value: 'all', label: 'All outlets' }, ...outlets.map(name => ({ value: name, label: name }))],
    match: (row, value) => canonicalPublisherName(row.source) === value,
  };
}
