// Local reading of the captured words, separate from the provider's keyword tags and the
// company-wide source-count summary. No model calls, extra source requests or invented prose.
const UP = '(?:rise|rises|rising|rose|risen|rall(?:y|ies|ied|ying)|jump(?:s|ed|ing)?|surge[sd]?|surging|soar(?:s|ed|ing)?|gain(?:s|ed|ing)?|climb(?:s|ed|ing)?|up|higher|increas(?:e|es|ed|ing)|grow(?:s|ing)?|grew|grown|improv(?:e|es|ed|ing)|expand(?:s|ed|ing)?|accelerat(?:e|es|ed|ing)|doubl(?:e|es|ed|ing)|tripl(?:e|es|ed|ing))';
const DOWN = '(?:fall(?:s|ing)?|fell|fallen|drop(?:s|ped|ping)?|declin(?:e|es|ed|ing)|slip(?:s|ped|ping)?|tumble[sd]?|tumbling|plunge[sd]?|plunging|slump(?:s|ed|ing)?|down|lower|decreas(?:e|es|ed|ing)|shrink(?:s|ing)?|shrank|contract(?:s|ed|ing)?|weaken(?:s|ed|ing)?|slow(?:s|ed|ing)?|halv(?:e|es|ed|ing))';
const PRICE = '(?:shares?|stocks?|scrip|share price|stock price|market cap(?:itali[sz]ation)?|market value|valuation|nifty|sensex)';
const GOOD = '(?:profits?|earnings|revenues?|sales|margins?|demand|cash flow|market share|order book)';
const BAD = '(?:loss(?:es)?|costs?|expenses?|debt|bad loans?|non.performing assets?|npas?|(?:share )?dilution|pledged shares|share pledges)';
const target = '(?:price target|target price|target)';
const modifiers = '(?:\\s+(?:are|is|was|were|have|has|had|been|now|also|still|already|sharply|significantly|substantially|steadily|further)){0,4}\\s+';
const badAfter = new RegExp(`^\\s+${BAD}\\b`, 'i');
const mayPredict = new RegExp(`\\bmay\\s+(?:(?:not|also|still|soon)\\s+){0,2}(?:be|have|see|${UP}|${DOWN})\\b`, 'i');
const forecast = new RegExp(`\\b(?:expect(?:s|ed|ing)?|forecast(?:s|ed|ing)?|predict(?:s|ed|ing)?|project(?:s|ed|ing)?|anticipat(?:es|ed|ing)|likely)(?:\\s+\\w+){0,5}\\s+(?:to|will|can|${UP}|${DOWN})\\b`, 'i');
const rule = (tone, pattern, kind = '') => ({ tone, pattern: new RegExp(pattern, 'gi'), kind });
const rules = [
  rule('positive', `\\b${BAD}\\b${modifiers}(?:narrow(?:s|ed|ing)?|fell|fall(?:s|ing)?|declin(?:e|es|ed|ing)|lower|down|shrank)\\b|\\b${BAD}\\b\\s+(?:(?:are|is|was|were|has been|have been)\\s+)(?:cut|reduced|lowered)\\b|\\b${BAD}\\b\\s+(?:cut|reduced|lowered)(?=\\s+(?:by|to|from)\\b|[.!?;,]|$)`),
  rule('negative', `\\b${BAD}\\b${modifiers}(?:widen(?:s|ed|ing)?|mount(?:s|ed|ing)?|rise|rises|rising|rose|up|higher|increas(?:e|es|ed|ing)|grow(?:s|ing)?|grew|doubl(?:e|es|ed|ing))\\b`),
  rule('negative', `\\b${BAD}\\b\\s+(?:(?:also|still|already|significantly|sharply)\\s+){0,2}(?:cut|cuts|reduced|eroded|hurt|dent(?:s|ed)?|hit)\\b[^.!?;]{0,25}?\\b(?:profits?|earnings|margins?|net worth|growth|returns?)\\b`),
  rule('positive', `\\b(?:lower|reduced|falling|declining) ${BAD}\\b`),
  rule('negative', `\\b(?:higher|increased|rising|mounting) ${BAD}\\b`),
  rule('positive', `\\b${PRICE}\\b[^.!?;]{0,65}?\\b${UP}\\b`, 'price'),
  rule('negative', `\\b${PRICE}\\b[^.!?;]{0,65}?\\b${DOWN}\\b`, 'price'),
  rule('positive', `\\b${GOOD}\\b[^.!?;]{0,65}?\\b${UP}\\b`, 'metric'),
  rule('negative', `\\b${GOOD}\\b[^.!?;]{0,65}?\\b${DOWN}\\b`, 'metric'),
  rule('positive', `\\b(?:rais(?:e|es|ed|ing)|hik(?:e|es|ed|ing)|lift(?:s|ed|ing)?|boost(?:s|ed|ing)?)\\b[^.!?;]{0,35}?\\b${target}\\b|\\b${target}\\b[^.!?;]{0,30}?\\b(?:rais(?:e|es|ed|ing)|hik(?:e|es|ed|ing)|higher|upgrad(?:e|es|ed|ing))\\b`),
  rule('negative', `\\b(?:cut|cuts|cutting|slash(?:es|ed|ing)?|lower(?:s|ed|ing)?|reduc(?:e|es|ed|ing))\\b[^.!?;]{0,35}?\\b${target}\\b|\\b${target}\\b[^.!?;]{0,35}?\\b(?:cut|cuts|slashed|lowered|reduced|downgraded)\\b`),
  rule('positive', '\\b(?:bullish|optimistic|outperform(?:s|ed|ing)?|strong upside|record profits?|record earnings|record sales|record revenues?)\\b|\\b(?:strong|robust|improving) (?:results|earnings|demand|outlook|quarter)\\b'),
  rule('negative', '\\b(?:bearish|pessimistic|underperform(?:s|ed|ing)?|disappointing (?:results|earnings|quarter)|weak(?:ening)? (?:demand|results|outlook)|signal(?:s|ling)? weakness|margin (?:pressure|compression))\\b'),
  rule('positive', '\\b(?:beat|beats|beating|exceed(?:s|ed|ing)?) (?:\\w+\\s+){0,2}(?:estimates|expectations|forecasts)\\b|\\b(?:wins?|won|bags?|bagged|secures?|secured)\\b[^.!?;]{0,45}?\\b(?:contracts?|orders?)\\b'),
  rule('negative', '\\b(?:miss(?:es|ed|ing)?|below) (?:\\w+\\s+){0,2}(?:estimates|expectations|forecasts)\\b|\\b(?:loses?|lost|cancel(?:s|led|ing)?)\\b[^.!?;]{0,45}?\\b(?:contracts?|orders?)\\b'),
  rule('positive', '\\b(?:rating|stock|shares?) (?:\\w+\\s+){0,3}upgraded\\b|\\bupgrade[sd]? (?:\\w+\\s+){0,3}(?:rating|stock|shares?)\\b|\\b(?:buy rating|rates? (?:\\w+\\s+){0,2}(?:a )?buy)\\b'),
  rule('negative', '\\b(?:rating|stock|shares?) (?:\\w+\\s+){0,3}downgraded\\b|\\bdowngrade[sd]? (?:\\w+\\s+){0,3}(?:rating|stock|shares?)\\b|\\b(?:sell rating|rates? (?:\\w+\\s+){0,2}(?:a )?sell)\\b'),
  rule('negative', '\\b(?:close[sd]?|closing|end(?:s|ed|ing)?) (?:\\w+\\s+){0,4}(?:lower|in the red)\\b|\\bpare[sd]? (?:early )?gains\\b'),
  rule('positive', '\\b(?:close[sd]?|closing|end(?:s|ed|ing)?) (?:\\w+\\s+){0,4}(?:higher|in the green)\\b'),
];

function statements(text) {
  return text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+|;\s*|\s+\b(?:but|while|whereas|and)\b\s+|[,:–—-]\s*(?=(?:will|would|can|could|should|is|are|why|how|what|whether)\b)/i).map(part => {
    // "Despite X, shares fell" owns its main clause; "shares fell despite X" does too.
    if (/^(?:despite|although|though|even though)\b/i.test(part)) part = part.replace(/^[^,]+,\s*/, '');
    return part.split(/\s+\b(?:despite|although|even though)\b\s+/i)[0].trim();
  }).filter(Boolean);
}

export function chatterHighlightReading(value) {
  const text = typeof value === 'string' ? value : '';
  const evidence = [];
  for (const statement of statements(text)) {
    // Questions and conditional guesses don't establish a directional statement.
    if (statement.endsWith('?') || /^(?:will|would|can|could|should|is|are|why|how|what|whether)\b/i.test(statement) ||
        /\b(?:if|might|could|would|will|can|shall|denies?|denied|refutes?|refuted)\b/i.test(statement) || mayPredict.test(statement) || forecast.test(statement)) continue;
    for (const { tone, pattern, kind } of rules) {
      pattern.lastIndex = 0;
      for (const match of statement.matchAll(pattern)) {
        const before = statement.slice(Math.max(0, match.index - 55), match.index).replace(/[‘’]/g, "'");
        const phrase = match[0];
        const after = statement.slice(match.index + phrase.length);
        // These uses describe share quantities, exchange rules or inventories, not price moves.
        if (kind === 'price' && (/\b(?:stock exchange|stock inventory|stock levels|shares outstanding|share count|shares issued|shares allotted|shares held|stock holdings|share holdings|buybacks?)\b/i.test(phrase) ||
            /\b(?:pledged shares|share pledges|(?:share )?dilution|share capital)\b/i.test(`${before.slice(-25)}${phrase}`))) continue;
        if (kind === 'metric' && /\bmargin requirements?\b/i.test(phrase)) continue;
        if (/\b(?:higher|lower|rising|falling|declining)\b$/i.test(phrase) && badAfter.test(after)) continue;
        if (tone === 'positive' && /\b(?:pare[sd]?|erase[sd]?|wiped? out|loses?|lost|gives? up|gave up)\b.*\bgains?\b/i.test(phrase)) continue;
        // Do not invert "not falling" into positive, or "no growth" into an invented decline.
        if (/\b(?:not(?!\s+only\b)|no|never|without|denies?|denied|isn't|aren't|wasn't|weren't|didn't|doesn't|don't|can't|cannot|won't|hasn't|haven't)\b(?:\W+\w+){0,4}\W*$/i.test(before) ||
            /\b(?:not(?!\s+only\b)|never|without|isn't|aren't|wasn't|weren't|didn't|doesn't|don't|can't|cannot|won't|hasn't|haven't)\b/i.test(phrase.replace(/[‘’]/g, "'")) ||
            (/\borders?\b/i.test(phrase) && /\b(?:court|judicial|legal)\b/i.test(statement))) continue;
        evidence.push({ tone, phrase, statement });
      }
    }
  }
  const positive = evidence.some(item => item.tone === 'positive'), negative = evidence.some(item => item.tone === 'negative');
  const tone = positive && negative ? 'mixed' : positive ? 'positive' : negative ? 'negative' : 'unclear';
  const label = { positive: 'Positive', negative: 'Negative', mixed: 'Mixed', unclear: 'Neutral / unclear' }[tone];
  return { tone, label, evidence, reason: evidence.length ? evidence.map(item => item.phrase).join('; ') : 'No clear directional statement in the captured text' };
}

export function shortChatterHighlight(value, reading = chatterHighlightReading(value)) {
  // Quote the actual directional sentence where possible; never write a generated claim.
  const source = reading.evidence[0]?.statement || String(value || '').replace(/\s+/g, ' ').trim();
  const words = source.split(' ').filter(Boolean);
  return `${words.slice(0, 16).join(' ')}${words.length > 16 ? '…' : ''}`;
}
