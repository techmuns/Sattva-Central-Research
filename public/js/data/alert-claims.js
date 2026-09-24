// data/alert-claims.js — WHAT A FILING SAYS, IN THE SOURCE'S OWN WORDS.
//
// These helpers were born in data/ai-alerts.js, where the card's one-sentence claim is chosen. They
// live here now because All Alerts needs the SAME choice for its rows: a development folded out of a
// BSE filing, its NSE twin and forty publisher reports has to read identically on both surfaces, and
// a second copy of "which of the exchange's words is the claim" would be a second answer to one
// question. Nothing here imports the ranking, so the All Alerts tab can use it without loading it.
// data/ai-alerts.js re-exports every name, so existing callers and tests are unchanged.

/** The longest claim a card's sentence or a row carries before it is clipped on a word boundary. */
export const CLAIM_MAX = 150;

/** A claim too long for the line, cut where a word ends. The untouched text stays in the tooltip. */
export function clip(text, max = CLAIM_MAX) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/**
 * A filing subject that names the filing TYPE rather than the event.
 *
 * This is the whole reason a card could announce "Press Release" over a ten-year supply contract.
 * Measured on the retained NSE window: 1,995 of 15,506 rows carry one of these as their subject —
 * 1,025 "General Updates", 707 "Updates", 251 "Press Release" — and 1,911 of those 1,995 carry a
 * description that says what the filing actually is. BSE's side of it is the pointer subjects:
 * "PFA", "Please refer the enclosed file.", "As per attachment".
 *
 * It is deliberately an EXACT-MATCH list of type words, not a length or a keyword heuristic.
 * "Investor Presentation", "Record Date" and "Resignation of Director/KMP/SMP" are short and are
 * real answers; the test is whether the subject names an event, and a pattern loose enough to
 * catch a bad subject by its shape would discard those too.
 */
const TYPE_ONLY_SUBJECT = new RegExp(
  '^(?:'
  + 'updates?|general\\s+updates?|company\\s+updates?|press\\s+releases?|announcements?|'
  + 'corporate\\s+announcements?|disclosures?|disclosure\\s+attached|intimations?|intimation\\s+of\\s+disclosure|'
  + 'others?|news|filing|nse\\s+filing|pfa|na|n\\.?a\\.?|nil|none|attached|enclosed|media\\s+releases?|'
  // THE POINTER PHRASES ARE BOUNDED TO POINTER WORDS, not left open with `.*`. Written greedily
  // they swallowed a subject that says something: "Please find enclosed herewith the disclosure
  // pertaining to incorporation of two Wholly-Owned Subsidiaries" is the whole event, and the card
  // replaced it with BSE's one-word sub-category, "Acquisition". A pointer subject is a pointer
  // and nothing else, so every word after "please find" has to be one of these to qualify.
  + '(?:please|kindly)\\s+(?:refer|find|see)'
  + '(?:\\s+(?:to|the|our|enclosed|attached|attachment|enclosure|annexure|file|document|herewith|below|copy))*|'
  + 'as\\s+per\\s+(?:the\\s+)?attachments?|refer\\s+(?:the\\s+)?attach\\w*|-{1,2}|\\.'
  + ')[\\s.]*$',
  'i'
);

/**
 * EVERY SEGMENT HAS TO BE A TYPE WORD, because the exchanges publish these as alternatives.
 * "Press Release / Media Release" is BSE's sub-category for a press release and says no more than
 * either half of it does, and an exact-match list of single words let it through — one card led
 * with it while the filing beneath said what the release was. A subject with one real segment
 * ("Record Date / Book Closure") still names an event and is kept.
 */
export const isTypeOnly = (text) => {
  const value = String(text || '').trim();
  if (!value) return true;
  return value.split(/\s*[/|]\s*/).filter(Boolean).every((part) => TYPE_ONLY_SUBJECT.test(part));
};

/**
 * A clause the prefix strip exposed, opened as a sentence.
 *
 * "…has informed the exchange about the approval of Board of Directors for withdrawal of
 * application of reclassification" is one sentence whose subject is the company, so removing that
 * subject leaves the rest starting "the" — a line that reads as a rendering bug. Capitalising a
 * letter is typography and not a change of claim.
 *
 * IT LEAVES A WORD THAT CAPITALISES ITSELF ALONE. The test is that the first word has no capital
 * of its own, so "the approval…" opens and "iPhone launch" or "eSIM rollout" are untouched — a
 * brand recapitalised would be this dashboard editing somebody's name, which the clip and the
 * prefix strip both exist to avoid.
 */
const openingCase = (text) => {
  const value = String(text || '');
  const first = value.match(/^([a-z])([^\s]*)/);
  if (!first || /[A-Z]/.test(first[2])) return value;
  return value[0].toUpperCase() + value.slice(1);
};

const unquote = (text) => {
  const value = String(text || '').trim().replace(/[.\s]+$/, '').trim();
  const wrapped = value.match(/^["'‘“]([\s\S]+)["'’”]$/);
  return (wrapped ? wrapped[1] : value).trim();
};

/**
 * What a filing says, in the source's own words.
 *
 * Two mechanical removals and one selection, and none of them is a paraphrase:
 *
 *  * `|SUBJECT: …` is the feed's own duplicate of the subject, appended to every NSE description.
 *  * `<Company> has informed the Exchange about/regarding` is an exchange-generated lead-in —
 *    9,622 of 15,506 retained rows carry it — and what follows it is the filing's own text.
 *  * Where they quote the company's own title for the filing ("…titled \"X\""), that quotation is
 *    the claim. Choosing which of their sentences to print is not writing one.
 */
export function sourceStatement(text) {
  const raw = String(text || '').replace(/\s*\|\s*SUBJECT\s*:[\s\S]*$/i, '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // NSE sometimes doubles the quotes around the title it quotes (titled ""Puravankara Enters …""), so
  // one or more opening quotes are accepted — with a single one the title went unselected and the
  // whole mechanical sentence became the claim.
  const titled = raw.match(/\btitled\s*["'‘“]+([^"'’”]{12,})["'’”]/i);
  if (titled) return titled[1].trim();
  const body = raw
    .replace(/^.{0,90}?\bhas\s+informed\s+the\s+Exchanges?\b[\s,]*(?:about|regarding|that)?\s*/i, '')
    // BSE's own lead-in on a disclosure it received, the mirror of the one above.
    .replace(/^the\s+Exchanges?\s+(?:has|have)\s+received\s*/i, '')
    .trim();
  return openingCase(unquote(body || raw));
}

/**
 * A filing's claim: its own subject where that names an event, the source's own description where
 * the subject only names a type, and the exchange's own sub-category as the floor.
 *
 * The order is what makes it honest. A subject that says something is never replaced — it is the
 * shortest true answer and it is theirs. A description is used only where it says something the
 * subject does not, because NSE repeats the subject as the description on some rows and sends
 * `''.` on others, and "General Updates: General Updates" is not an improvement on either.
 */
export function filingClaim(event) {
  const subject = String(event?.filingSubject || event?.headline || '').trim();
  // THE SAME MECHANICAL LEAD-IN TURNS UP IN SUBJECTS, and there it costs the reader the answer.
  // BSE carries no description, so the whole statement arrives as the subject: "Star Health and
  // Allied Insurance Company Limited has informed the exchange about the approval of Board of
  // Directors for withdrawal of application of…" spent 71 of 150 characters on a company name the
  // card prints as its own heading, and clipped away the withdrawal. Removing a prefix the
  // exchange generated is the same removal `sourceStatement` justifies, not a rewording of what
  // follows it — and where the subject carries none, it comes back unchanged.
  if (!isTypeOnly(subject)) return clip(sourceStatement(subject) || subject);
  const stated = sourceStatement(event?.filingDescription);
  if (stated.length >= 12 && stated.toLowerCase() !== subject.toLowerCase()) return clip(stated);
  // BSE's own sub-category is their answer to "what kind of filing is this?" — "Award of Order /
  // Receipt of Order", "Resignation of Director", "Credit Rating" — so it is a real claim where
  // the subject was not. NSE publishes none, which is why this is a floor and not the first look.
  return clip(event?.filingSubCategory || subject || 'Filing');
}
