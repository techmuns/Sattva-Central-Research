// Independent evaluation matcher: presentation whitespace/explicit truncation may change,
// but the confirmed attribution, publication day and captured article must still agree.
const titleText = value => String(value || '').replace(/\s+/g, ' ').trim();
const sourceUrl = row => {
  const value = row?.url || row?.link;
  return /^https?:\/\//i.test(value || '') && value.length <= 2048 ? value : null;
};

export function matchesCapturedNews(row, captured) {
  if (row?.attribution !== 'confirmed' || row.date !== captured?.date) return false;
  if (captured.ticker ? row.ticker !== captured.ticker : captured.isin ? row.isin !== captured.isin :
    !captured.company || titleText(row.company) !== titleText(captured.company)) return false;
  const expectedUrl = sourceUrl(captured);
  if (expectedUrl && sourceUrl(row) !== expectedUrl) return false;
  const expected = titleText(captured.title), actual = titleText(row.title);
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  // A stable URL cannot excuse a mostly missing headline: evaluate the actual projection.
  // The company-news adapter's actual title budget is 420 characters, including ellipsis.
  return expected.length > 420 && actual.endsWith('…') && actual.length === 420 &&
    expected.startsWith(actual.slice(0, -1));
}
