// AI Alerts' Compact view — the Detailed alerts, filtered. PURE: cards in, rows out.
//
// The desk asked (28 October 2026) for one line per company — company, CMP, market cap, what
// happened in at most sixty words, and the source one click away — and named what the line must
// leave out and what it must never do twice. Every rule below is one of theirs:
//
// 1. NO TRADING INDICATORS. RSI, volume multiples, base breakouts and day moves (the `technicals`
//    feed) are day- and swing-trading readings, not this desk's style. The row's CMP column already
//    carries the day's move. The family's own price levels are NOT indicators and stay.
// 2. NO SCHEDULE NOTICES. "The earnings call is on Tuesday" is useful to know and not analytical:
//    con-call and earnings-call intimations, "call is live" and "recording available" notices,
//    analyst/investor-meet notices and board-meeting intimations are left out. A transcript, a
//    presentation and a board OUTCOME are content and stay.
// 3. NO REPETITION. One row per company, and one event per row: a filing's exchange copies and the
//    reports of it are the development fold's one item, a quarterly result's data, its filing and
//    every publisher's write-up of it are one result, and a story already leading one row never
//    leads a second.
// 4. NOTHING NEW IS SAID. The text is the same claim the Detailed card leads with (or, for broker
//    views, the brokers' own calls listed), clipped to sixty words with the whole of it on the
//    title. "Sources disagree — check both directions below" is not carried: it points at a card
//    this view does not draw, and the Reconcile badge says the same thing.
//
// A company whose only material evidence is something rules 1–2 remove is not drawn here; the
// count is reported so the tab can say so. Detailed is unchanged and still shows everything.
import * as alerts from './ai-alerts.js';
import { aiEventTypes } from './ai-alert-types.js';
import { developmentOfRow } from './alert-developments.js';
import { brokerCall } from './broker-reports-shared.js';
import { isThemeExposureContext } from './theme-exposures.js';

export const COMPACT_WORD_LIMIT = 60;

const FILINGS = new Set(['announcements', 'nse-filings']);
const NEWS = new Set(['news', 'market-news']);
// A call or meeting, and the words that make a notice about one something more than its date.
const CALL_OR_MEET = /\b(?:con(?:ference)?[\s.-]*calls?|earnings?\s+(?:conference\s+)?calls?|analysts?(?:\s*\/\s*(?:institutional\s+)?investors?)?\s+(?:meet|meeting|call)s?|(?:institutional\s+)?investors?\s+(?:meet|meeting|call|conference)s?|investor\s+day)\b/i;
const CONTENT = /\b(?:transcript|presentation|press\s+release|highlights?|guidance|says|said|commentary|takeaways?)\b/i;
// A headline is a schedule notice only when it says so: a date, "scheduled", "live", "recording".
// "Activist investor calls for CEO removal" names an investor and a call and is news.
const SCHEDULED = /\b(?:scheduled?|set\s+for|to\s+be\s+held|will\s+(?:host|hold|conduct)|to\s+host|hosts?|is\s+live|goes\s+live|recording|replay|webcast|invit(?:e|ation)|intimation|dial[- ]?in|(?:on|for)\s+(?:\d{1,2}(?:st|nd|rd|th)?\b|(?:mon|tues|wednes|thurs|fri|satur|sun)day|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b)/i;
// A board meeting announced ahead of itself. The exchange files these under results as often as
// under board meetings ("Board Meeting Intimation for Consideration And Approval Of Unaudited …
// Financial Results"), so the words decide, not the type; an OUTCOME is the meeting's content.
const MEETING_AHEAD = /\bboard\s+meeting\s+intimation\b|\bintimation\s+of\s+(?:the\s+)?(?:board\s+)?meeting\b|\bprior\s+intimation\b|\bmeeting\s+of\s+the\s+board\s+of\s+directors\b[^.]{0,80}\b(?:is|was|will\s+be)\s+(?:scheduled|to\s+be\s+held|held\s+on)\b|\bboard\s+meeting\s+(?:to\s+be\s+held|on\s+\d|scheduled)\b/i;

/** A notice that a call or meeting is scheduled, live or recorded — a date, not an analysis. */
export function isScheduleNotice(event = {}) {
  const subject = event.filingSubject || event.headline || '';
  if (FILINGS.has(event.feed)) {
    const text = [subject, event.filingSubCategory, event.filingDescription].filter(Boolean).join(' ');
    const types = aiEventTypes(event);
    if ((types.includes('board-meeting') || MEETING_AHEAD.test(text)) && !/\boutcome\b/i.test(text)) return true;
    return types.includes('investor-meet') && CALL_OR_MEET.test(text) && !CONTENT.test(subject);
  }
  if (NEWS.has(event.feed)) { const h = event.headline || ''; return CALL_OR_MEET.test(h) && SCHEDULED.test(h) && !CONTENT.test(h); }
  return event.kind === 'scheduled';
}

/** Why an event is left out of Compact, or null when it stays. */
export function compactExclusion(event = {}) {
  if (event.feed === 'technicals') return 'price-volume';
  if (isScheduleNotice(event)) return 'schedule';
  return null;
}

const material = (event) => event.importance === 'high' || (!!event.storyId && event.storyChange !== 'new');

/**
 * The cards as Compact sees them: each recomputed over the events it keeps, so a "Reconcile"
 * that only a volume reading caused goes with it. Cards with nothing material left are counted.
 */
export function compactCards(cards = []) {
  const kept = [];
  const hidden = [];
  for (const card of cards) {
    const events = (card.events || []).filter((event) => !compactExclusion(event));
    const view = events.some(material) ? alerts.cardWithEvents(card, events) : null;
    if (view) kept.push(view);
    else hidden.push({ key: card.key || card.ticker || card.entityId, company: card.company,
      reasons: [...new Set((card.events || []).filter(material).map(compactExclusion).filter(Boolean))] });
  }
  return { cards: kept, hidden };
}

/** At most `limit` words, cut on a word boundary with an ellipsis. */
export function clipWords(text, limit = COMPACT_WORD_LIMIT) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.length <= limit ? words.join(' ') : `${words.slice(0, limit).join(' ')}…`;
}

const asSentence = (text) => { const t = String(text || '').trim(); return !t || /[.!?…”"]$/.test(t) ? t : `${t}.`; };
const byNewest = (a, b) => String(b.day || '').localeCompare(String(a.day || '')) || String(b.time || '').localeCompare(String(a.time || ''));
const dayGap = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5;
const isResult = (event) => event.feed === 'earnings' || (FILINGS.has(event.feed) && aiEventTypes(event).includes('results'));
// Another company's results story reaching this card through a theme is not this company's result.
const resultCoverage = (event) => !isThemeExposureContext(event) && (isResult(event) || (NEWS.has(event.feed) && /\b(?:results?|net\s+profit|revenue|pat|ebitda|q[1-4]\s*fy\s*\d{2}|q[1-4]fy\d{2})\b/i.test(event.headline || '')));
const canonical = (url) => { try { const u = new URL(url); u.hash = ''; return u.href.replace(/\/$/, ''); } catch { return String(url || ''); } };

/** A list in prose: "A", "A and B", "A, B and C". */
const listed = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const range = (values) => {
  const lo = Math.min(...values), hi = Math.max(...values);
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
};

/**
 * The brokers' latest view of a company, one per broker, newest first. Each broker counts once:
 * a broker that published twice in the window has said its current view in the later report.
 */
export function brokerViews(events = []) {
  const byBroker = new Map();
  for (const event of [...events].filter((e) => e.feed === 'broker-reports' && e.brokerReport).sort(byNewest)) {
    const key = event.brokerReport.broker.toLowerCase();
    if (!byBroker.has(key)) byBroker.set(key, event);
  }
  return [...byBroker.values()];
}

/** "4 broker reports in 14 days. Antique rates it BUY with a ₹1,755 target; Axis … see 25–34% upside." */
export function brokerSummary(views, windowDays = alerts.WINDOW_DAYS) {
  if (!views.length) return '';
  const reports = views.map((event) => event.brokerReport);
  const target = (r) => (r.target != null ? `₹${r.target.toLocaleString('en-IN')} target` : null);
  const move = (r) => (r.upsidePct != null ? `${Math.abs(r.upsidePct)}% ${r.upsidePct < 0 ? 'downside' : 'upside'}` : null);
  if (reports.length === 1) {
    const r = reports[0];
    const terms = [r.rating ? `a ${r.rating} rating` : null, target(r) ? `a ${target(r)}` : null].filter(Boolean).join(' and ');
    const tail = [target(r) && !terms.includes('target') ? `a ${target(r)}` : null, move(r)].filter(Boolean).join(', ');
    let lead;
    if (r.kind === 'initiation') lead = `${r.broker} initiated coverage${terms ? ` with ${terms}` : ''}${move(r) ? `, ${move(r)}` : ''}`;
    else if (r.previous?.rating && r.rating && r.previous.rating !== r.rating) lead = `${r.broker} moved from ${r.previous.rating} to ${r.rating}${tail ? `, ${tail}` : ''}`;
    else if (r.rating) lead = `${r.broker} rates it ${r.rating}${target(r) ? ` with a ${target(r)}` : ''}${move(r) ? `, ${move(r)}` : ''}`;
    else if (target(r)) lead = `${r.broker} sets a ${target(r)}${move(r) ? `, ${move(r)}` : ''}`;
    else if (move(r)) lead = `${r.broker} sees ${move(r)}`;
    else lead = `${r.broker} published a report`;
    const words = r.points || r.reportTitle;
    return asSentence(words ? `${lead}: “${words.replace(/[.\s]+$/, '')}”` : lead);
  }
  const clauses = [];
  for (const r of reports.filter((x) => x.kind === 'initiation')) clauses.push(`${r.broker} initiated coverage${brokerCall(r) ? ` (${brokerCall(r)})` : ''}`);
  const rest = reports.filter((x) => x.kind !== 'initiation');
  for (const r of rest.filter((x) => x.rating)) {
    clauses.push(r.previous?.rating && r.previous.rating !== r.rating
      ? `${r.broker} moved from ${r.previous.rating} to ${r.rating}${target(r) ? ` with a ${target(r)}` : ''}`
      : `${r.broker} rates it ${r.rating}${target(r) ? ` with a ${target(r)}` : ''}`);
  }
  const up = rest.filter((x) => !x.rating && x.upsidePct != null && x.upsidePct >= 0);
  const down = rest.filter((x) => !x.rating && x.upsidePct != null && x.upsidePct < 0);
  if (up.length) clauses.push(`${listed(up.map((x) => x.broker))} ${up.length === 1 ? 'sees' : 'see'} ${range(up.map((x) => x.upsidePct))} upside`);
  if (down.length) clauses.push(`${listed(down.map((x) => x.broker))} ${down.length === 1 ? 'sees' : 'see'} ${range(down.map((x) => -x.upsidePct))} downside`);
  const quiet = rest.filter((x) => !x.rating && x.upsidePct == null);
  if (quiet.length) clauses.push(`${listed(quiet.map((x) => x.broker))} ${quiet.length === 1 ? 'published a report' : 'published reports'}`);
  return `${reports.length} broker reports in ${windowDays} days. ${asSentence(clauses.join('; '))}`;
}

/** The kind tag a row carries — the source's kind, in the desk's words. */
export function kindOf(event, { brokerLed = false, views = [] } = {}) {
  if (brokerLed) return views.some((e) => e.brokerReport.kind === 'initiation') && views.length === 1
    ? { id: 'coverage', label: 'New coverage' } : { id: 'broker', label: 'Broker views' };
  // Somebody else's story on this company's row says so before anything else (theme-exposures.js).
  if (isThemeExposureContext(event)) return { id: 'indirect', label: `Indirect · ${event.themeExposure.short}` };
  if (isResult(event)) return { id: 'result', label: 'Result' };
  if (event.feed === 'announcements') return { id: 'filing', label: 'Filing · BSE' };
  if (event.feed === 'nse-filings') return { id: 'filing', label: 'Filing · NSE' };
  if (NEWS.has(event.feed)) return { id: 'news', label: 'News' };
  if (event.feed === 'insider') {
    const category = String(event.tradeCategory || '').trim();
    return { id: 'deal', label: /deal\b/i.test(category) ? category.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/Deal$/, 'deal') : 'Insider / deal' };
  }
  if (event.feed === 'investors') return { id: 'holding', label: 'Investor holding' };
  if (event.feed === 'concalls') return { id: 'call', label: 'Con-call' };
  if (event.feed === 'chatter') return { id: 'chatter', label: 'Public chatter' };
  if (event.feed === 'price-levels') return { id: 'level', label: 'Price level' };
  if (event.feed === 'screener-insights') return { id: 'insight', label: 'Insight' };
  return { id: 'other', label: event.feedLabel || event.feed || 'Update' };
}

// A PUBLIC-CHATTER SNAPSHOT LEADS ONLY WHEN NOTHING ELSE CAN. It is a 30-day count of forum and
// news mentions, so a company with a result, a filing, a deal or four broker reports is told by
// that instead; the card's score order decides everything else.
const LAST_RESORT = new Set(['chatter', 'chatter-posts']);
// "As attached." and "Please find enclosed." say nothing on a line of their own.
const POINTER_ONLY = /^(?:as\s+attached|attached(?:\s+herewith)?|please\s+(?:find|see|refer)(?:\s+the)?\s+(?:attached|enclosed)(?:\s+(?:file|document|herewith))?|pfa|enclosed(?:\s+herewith)?)\.?$/i;
const readableClaim = (event) => {
  const claim = String(alerts.plainHeadline(event) || '').trim();
  return !!claim && !alerts.isTypeOnly(claim) && !POINTER_ONLY.test(claim);
};
function leadCandidates(card) {
  const candidates = (card.events || []).filter(material);
  const readable = candidates.filter(readableClaim);
  const ordered = readable.length ? [...readable, ...candidates.filter((e) => !readable.includes(e))] : candidates;
  // THE COMPANY'S OWN EVIDENCE LEADS ITS ROW. An indirect theme story leads only a company with
  // nothing material of its own, and then ahead of a chatter snapshot.
  const own = (e) => !LAST_RESORT.has(e.feed) && !isThemeExposureContext(e);
  return [...ordered.filter(own), ...ordered.filter(isThemeExposureContext), ...ordered.filter((e) => LAST_RESORT.has(e.feed))];
}

function sourceWording(lead, text) {
  const own = [lead.filingDescription, lead.headline].filter(Boolean).map(String).sort((a, b) => b.length - a.length)[0];
  return own && own.length > text.length ? own : text;
}

/** The row for one lead event of one card, or null when the lead is unusable. */
function rowFor(card, lead, views, destination) {
  const brokerLed = lead.feed === 'broker-reports';
  let text, href = null, external = false, opens = '', folded = 0, when = lead;
  if (brokerLed) {
    text = brokerSummary(views);
    when = views[0] || lead;
  } else if (resultCoverage(lead) && (card.events || []).some(isResult)) {
    // ONE QUARTERLY RESULT, ONE ROW: the results feed's figures, the company's own filing as the
    // link, and the write-ups of the same result counted as folded into it. ANCHORED ON ONE RESULT
    // DATE: a delayed quarter and the current one filed within a week are two results, so each
    // event joins the result date nearest to it, and only the lead's own result is folded here.
    const resultDays = [...new Set((card.events || []).filter((e) => e.feed === 'earnings' && e.day).map((e) => e.day))];
    const nearest = (day) => resultDays.reduce((best, d) => (best == null || dayGap(d, day) < dayGap(best, day) ? d : best), null);
    const closest = nearest(lead.day);
    const anchor = closest != null && dayGap(closest, lead.day) <= 3 ? closest : lead.day;
    // An event belongs to this result unless another result date is nearer to it.
    const belongs = (e) => dayGap(e.day, anchor) <= 3 && !resultDays.some((d) => d !== anchor && dayGap(d, e.day) < dayGap(anchor, e.day));
    const family = (card.events || []).filter((e) => resultCoverage(e) && belongs(e));
    const figures = family.find((e) => e.feed === 'earnings' && e.day === anchor) || lead;
    const filing = family.filter((e) => FILINGS.has(e.feed) && isResult(e) && e.url)
      .sort((a, b) => dayGap(a.day, anchor) - dayGap(b.day, anchor) || byNewest(a, b))[0];
    const link = filing || figures;
    text = alerts.plainHeadline(figures);
    const dest = destination(link);
    href = dest.href; external = dest.external; opens = filing ? `${filing.feed === 'nse-filings' ? 'NSE' : 'BSE'} result filing` : dest.label;
    folded = Math.max(0, family.length - 1);
    when = filing || figures;
  } else if (isThemeExposureContext(lead)) {
    // The story, then how it bears on this company — the reviewed read-across. The kind tag says
    // Indirect, so the headline is never read as this company's own news.
    text = `${asSentence(alerts.plainHeadline(lead))} ${lead.themeExposure.readAcross}`;
    const dest = destination(lead);
    href = dest.href; external = dest.external; opens = dest.ariaLabel || dest.label;
  } else {
    const dev = developmentOfRow(lead);
    text = dev ? alerts.developmentClaim(dev) : alerts.plainHeadline(lead);
    const dest = destination(lead);
    href = dest.href; external = dest.external; opens = dest.ariaLabel || dest.label;
    folded = dev?.others?.length || 0;
  }
  // A filing filed only as "As attached." says nothing on a line; say that, and that the document
  // behind the row is where its content is.
  if (FILINGS.has(lead.feed) && POINTER_ONLY.test(String(text || '').trim())) text = 'Filed without a description; open the document to read it.';
  text = asSentence(text);
  if (!text) return null;
  const kind = kindOf(lead, { brokerLed, views });
  return {
    key: String(card.key || card.ticker || card.entityId), ticker: card.ticker || null, entityId: card.entityId || null,
    company: card.company, priority: card.priority, badge: card.badge, holding: !!card.holding,
    // The title carries the source's own whole wording where the claim is a clipped selection of it.
    kind: kind.id, kindLabel: kind.label, text: clipWords(text), fullText: brokerLed ? text : sourceWording(lead, text),
    day: when.day || null, time: when.time || null, href, external, opens, folded,
    lead, brokerLed, brokers: views, card,
  };
}

/**
 * The rows, in the order the cards arrive (the tab sorts them). `destination(event)` is the tab's
 * own evidence link, so a row opens exactly what the Detailed card's link opens.
 */
export function compactRows(cards = [], { destination }) {
  const rows = [];
  const usedLinks = new Set();
  const repeated = [];
  for (const card of cards) {
    const views = brokerViews(card.events);
    let row = null;
    for (const lead of leadCandidates(card)) {
      const candidate = rowFor(card, lead, views, destination);
      if (!candidate) continue;
      // A STORY LEADS ONE ROW. Tagged to two companies, it is used by the first (higher-ranked)
      // and the second company leads with its own next item instead.
      const link = candidate.brokerLed ? null : candidate.href && canonical(candidate.href);
      if (link && usedLinks.has(link)) continue;
      if (link) usedLinks.add(link);
      row = candidate;
      break;
    }
    if (row) rows.push(row);
    else repeated.push({ key: String(card.key || card.ticker || card.entityId), company: card.company });
  }
  return { rows, repeated };
}
