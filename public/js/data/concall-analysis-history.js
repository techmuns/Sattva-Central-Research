// Public published assessments only. Never private Screener summary bodies or inferred ratings.
export const analysisKey = row => `${row.companyKey}|${row.when}|${row.ssUrl || row.pptSsUrl || ''}`;

export function retainConcallAnalysis(incoming, saved = [], checkedAt = null, retainedDelivery = false) {
  const held = new Map(saved.map(row => [analysisKey(row), row]));
  const fresh = new Set();
  for (const row of incoming.filter(row => row.analysisTracked !== false)) {
    const key = analysisKey(row), previous = held.get(key);
    const date = row.analysisCheckedAt || checkedAt;
    const older = previous && Date.parse(previous.analysisCheckedAt || '') > Date.parse(date || '');
    const docs = [...new Map([...(previous?.documents || []), ...(row.documents || [])].map(d => [`${d.type}|${d.url}`, d])).values()];
    held.set(key, older ? { ...previous, documents: docs } : { ...row, documents: docs, analysisCheckedAt: date });
    if (!older && !retainedDelivery && row.analysisRetained !== true) fresh.add(key);
  }
  const analysisRows = [...held].map(([key, row]) => ({ ...row, analysisRetained: !fresh.has(key) }));
  // During an outage the new document catalogue can contain the same call whose assessment we
  // saved earlier. An exact common source document joins it; dates/company names alone never do.
  const owners = new Map();
  analysisRows.forEach((row, i) => {
    if (!row.ticker) return;
    for (const doc of row.documents || []) {
      const key = `${row.ticker}|${doc.url}`;
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(i);
    }
  });
  const documents = incoming.filter(row => {
    if (row.analysisTracked !== false) return false;
    const matches = new Set((row.documents || []).flatMap(doc => [...(owners.get(`${row.ticker}|${doc.url}`) || [])]));
    const calls = new Set([...matches].map(i => `${analysisRows[i].ticker}|${analysisRows[i].when}`));
    if (!row.ticker || calls.size !== 1) return true;
    for (const i of matches) analysisRows[i].documents = [...new Map([
      ...(analysisRows[i].documents || []), ...(row.documents || []),
    ].map(doc => [`${doc.type}|${doc.url}`, doc])).values()];
    return false;
  });
  return { rows: [...analysisRows, ...documents], analysisRows };
}
