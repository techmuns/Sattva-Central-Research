// Shared materiality for exchange-authored BSE and NSE disclosures. No inferred sentiment
// from presentations: the source document is worth reading, not proof of a completed event.
import { classifyStory } from './news-keywords.js';
export const BSE_CRITICAL_IS_MATERIAL = false; // Exchange calendar flags alone are not materiality.
const DIRECTION = { POSITIVE: 'positive', NEGATIVE: 'negative', NEUTRAL: 'neutral' };
const IMPORTANCE = { HIGH: 'high', LOW: 'low' };
const signal = (direction, importance, signalReason, importanceReason) => ({
  direction, importance, signalReason, importanceReason,
  severity: direction === 'negative' ? 'alert' : 'update', reason: signalReason,
});

const textOf = (...parts) => parts.filter(Boolean).join(' ').toLowerCase();

/** Shared rules over the exchanges' own subject/taxonomy. Neutral is the fallback. */
export function announcementSignal(row = {}) {
  const text = textOf(row.category, row.subCategory, row.title, row.headline, row.description);
  const negative = [
    ['rating downgrade', /\b(?:rating\s+)?downgrad(?:e|ed|ing)\b/],
    ['default or insolvency', /\bdefault(?:ed)?\b|\binsolvenc\w*\b|\bbankrupt\w*\b|\bliquidat\w*\b|\bwinding[ -]?up\b/],
    ['fraud or enforcement action', /\bfraud\w*\b|\bpenalt(?:y|ies)\b|\bfine\b|\bshow[ -]?cause\b|\btax demand\b|\bdemand notice\b/],
    ['contract cancellation or suspension', /\b(?:order|contract)\s+(?:cancel\w*|terminat\w*)\b|\bsuspension\b/],
    ['auditor resignation', /\bauditor\w*.{0,80}\bresign\w*\b|\bresign\w*.{0,80}\bauditor\w*\b/],
  ].find(([, re]) => re.test(text));
  // An approval is directional only when the filing also names a regulator or exchange. A client
  // approving a drawing or an internal proposal is not the same event. BSE titles commonly put
  // the noun first ("Receipt of In-Principle Approval from the Stock Exchanges"), so the action
  // accepts both word orders while the context guard keeps the rule narrow.
  const regulatoryApproval =
    /\b(?:approval (?:received|granted)|approved by|receipt of.{0,80}\bapproval)\b/.test(text) &&
    /\b(?:bse|nse|stock exchanges?|sebi|rbi|government|ministr(?:y|ies)|authorit(?:y|ies)|regulator\w*|nclt|courts?|drug controller|usfda|fda)\b/.test(text);
  const positive = [
    ['rating upgrade', /\b(?:rating\s+)?upgrad(?:e|ed|ing)\b/.test(text)],
    ['shareholder distribution', /\bdividend\b|\bbonus (?:issue|share)\b|\bbuyback\b/.test(text)],
    // A bare "order received" is also how adjudication, court and regulator notices are titled.
    // Commercial context is required before that phrase can be called business won.
    ['order or contract award', /\bcontract\s+(?:award\w*|won|received|secured)\b|\b(?:purchase|work|supply|export)\s+order\s+(?:award\w*|won|received|secured)\b|\border\s+(?:award\w*|won|secured)\b|\bawarded (?:an? )?(?:order|contract)\b/.test(text)],
    ['regulatory approval or patent grant', regulatoryApproval || /\bpatent (?:granted|received)\b/.test(text)],
    ['commercial production start', /\bcommercial production (?:commenc(?:ed|ement)|started|began)\b|\b(?:start|commencement) of (?:the )?commercial production\b/.test(text)],
  ].find(([, matched]) => matched);
  const matched = negative || positive;
  const direction = negative ? DIRECTION.NEGATIVE : positive ? DIRECTION.POSITIVE : DIRECTION.NEUTRAL;

  // THE SAME THIRTY KEYWORDS THE NEWS SURFACES FILTER BY, over the filing's own subject and BSE's
  // own sub-category — "Award of Order / Receipt of Order", "Resignation of Director", "Credit
  // Rating" are the exchange's words for exactly the things this desk tracks.
  //
  // NO `inTitle` GATE HERE, and that is deliberate rather than an oversight. That gate exists on
  // the news feed because several publishers fill the standfirst with a related-links strip, so a
  // match there is not evidence about the story. A filing has no such field: the subject and the
  // sub-category are both the exchange's own description OF THIS FILING. Nor is there a
  // `namesCompany` question — a BSE filing IS the company's own statement, so the company is
  // certain in a way a name-matched search result never is.
  const reading = classifyStory({ title: row.title || row.headline, summary: textOf(row.subCategory, row.description) });

  // Explicit research disclosures extend the topic/directional rules. Generic meeting
  // intimations and exchange calendar flags alone remain routine.
  const researchDisclosure = /\b(?:analysts?|investors?|capital markets?)[ -]+day\b/.test(text)
    ? 'analyst or investor day disclosure'
    : /\b(?:investors?|analysts?|investor relations|corporate)[ -]+presentation\b|\b(?:analysts?|investors?)\b[^.!?]{0,60}\bpresentation\b|\bpresentation\b[^.!?]{0,40}\b(?:analysts?|investors?)\b/.test(text)
      ? 'investor presentation' : null;
  const critical = row.critical === true;
  const high = reading.tracked || !!matched || !!researchDisclosure || (BSE_CRITICAL_IS_MATERIAL && critical);
  return {
    ...signal(
      direction,
      high ? IMPORTANCE.HIGH : IMPORTANCE.LOW,
      matched ? `Rule-derived from the filing text: ${matched[0]}.` : 'No directional announcement rule matched; shown as neutral.',
      high
        ? `High: ${[
            reading.tracked ? `matched the tracked ${reading.labels.length === 1 ? 'keyword' : 'keywords'} ${reading.labels.join(', ')}` : null,
            matched ? 'a stated material announcement rule matched' : null,
            researchDisclosure ? `published ${researchDisclosure}; not confirmation the event has occurred` : null,
          ]
            .filter(Boolean)
            .join('; ')}.`
        : `Low: no tracked keyword and no material rule matched.${critical ? " BSE marked this filing critical and that marker is reproduced on the row, but it covers routine calendar filings — AGM notices and board-meeting intimations — so it is not this dashboard's materiality gate." : ''}`
    ),
    filingTopic: researchDisclosure,
    keywords: reading.labels,
    keywordIds: reading.ids,
    keywordGroups: reading.groups,
    critical,
  };
}
