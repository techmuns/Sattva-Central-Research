// Broker research posts from the monitored public Telegram channel, read into one record per
// (broker, company) report. PURE: no fetch, no storage. `scripts/build-broker-reports.mjs` and the
// browser share every rule here, so the file the runner writes and the alerts the page draws cannot
// disagree about what a post said.
//
// THE POST'S OWN WORDS ARE THE DATA. The channel publishes a report's title — "Motilal Oswal sees
// 33% UPSIDE in Jindal Stainless- Strong NSR and volume recovery drive earnings" — and, in digest
// posts, the broker's own rating and target ("ICICI Bank: BUY | TP 1,755 | Margins in-line…").
// Each field below is read out of that text and nothing is inferred:
//
// - a STANCE exists only where the broker printed a rating word. "sees 6% upside" can sit with a
//   HOLD, so an upside figure never becomes "bullish";
// - a TARGET exists only where the post printed one. It is never derived from an upside and a
//   price, because the price the broker measured from is not in the post;
// - the cited POINTS are the post's own words after the company name, reproduced unchanged.
//
// The PDF behind a post is not read — the capture holds its file name, not its contents.

export const BROKER_FEED = 'broker-reports';
export const BROKER_WINDOW_DAYS = 30;

/** The broker's own rating word, and the stance it states. Nothing else maps to a stance. */
export const STANCE_OF = {
  'STRONG BUY': 'bullish', BUY: 'bullish', ADD: 'bullish', ACCUMULATE: 'bullish', OUTPERFORM: 'bullish', OVERWEIGHT: 'bullish',
  HOLD: 'neutral', NEUTRAL: 'neutral', 'EQUAL WEIGHT': 'neutral', 'MARKET PERFORM': 'neutral',
  REDUCE: 'bearish', SELL: 'bearish', UNDERPERFORM: 'bearish', UNDERWEIGHT: 'bearish',
};
const RATING_WORDS = 'STRONG BUY|BUY|ADD|ACCUMULATE|OUTPERFORM|OVERWEIGHT|HOLD|NEUTRAL|EQUAL[- ]WEIGHT|MARKET PERFORM|REDUCE|SELL|UNDERPERFORM|UNDERWEIGHT';
// Upper case only: a digest prints the rating in capitals, and "neutral" in a sentence is prose.
const RATING_CELL = new RegExp(`^(?:${RATING_WORDS})$`);
const RATING_IN_POINTS = new RegExp(`\\b(?:initiate|maintain|reiterate|retain|upgrade(?:d)? to|downgrade(?:d)? to)\\s+(?:with\\s+|a\\s+|an\\s+)?["'“]?(${RATING_WORDS})\\b`, 'i');
const UPSIDE = /(-?\d+(?:\.\d+)?)\s*%\s*(UPSIDE|DOWNSIDE)/i;
// A target revision the broker states in its own title ("cut TP on slow ramp-up").
const TARGET_REVISION = /\b(?:cut|cuts|raise[sd]?|hike[sd]?|lower(?:s|ed)?|revise[sd]?|trim(?:s|med)?)\s+(?:our\s+|the\s+)?(?:TP|target(?:\s+price)?)\b|\b(?:TP|target(?:\s+price)?)\s+(?:cut|raised|hiked|lowered|revised|trimmed)\b/i;
const RATING_CHANGE = /\b(?:upgrade[sd]?|downgrade[sd]?)\b/i;

const clean = (value) => String(value || '').replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();
const normRating = (value) => {
  const word = clean(value).toUpperCase().replace('EQUAL-WEIGHT', 'EQUAL WEIGHT');
  return STANCE_OF[word] ? word : null;
};
const number = (value) => {
  const n = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
// One firm, several names on the channel: a retail brand or a shortened house name. Counting them
// apart would report two brokers where one published twice.
const BROKER_ALIAS = new Map([['joindre capital services', 'Joindre Capital'], ['bobcaps', 'BOB Capital'],
  ['axis direct', 'Axis Securities'], ['icici direct', 'ICICI Securities'], ['sharekhan', 'Mirae Asset Sharekhan'],
  ['antqiue', 'Antique']]);
/** A broker name the header carries, or null when the header names nobody. */
function brokerName(value) {
  // "Yes Securities on Expert Interaction Update" and "Systematix on Indian Cement Sector" name the
  // broker before " on "; what follows is the report's subject, not part of the broker's name.
  const name = clean(value).replace(/\s+on\s+.*$/i, '').replace(/[’']s$/i, '').replace(/[:\-–|]+$/, '').trim();
  if (!name || name.length > 60 || /\d%|https?:/i.test(name) || /^(?:initiating|today|the|our)\b/i.test(name)) return null;
  return BROKER_ALIAS.get(name.toLowerCase()) || name;
}
/** "Jindal Stainless Ltd- Volume guidance…" → the company, and the broker's own words after it. */
function companyAndPoints(rest) {
  const text = clean(rest);
  // The title separates the company from its words with "- " and now and then with ": ".
  const cut = text.search(/\s*(?:[-–]|:)\s+(?=\S)/);
  const company = (cut > 0 ? text.slice(0, cut) : text).replace(/[.,;:\s]+$/, '').replace(/,\s*with\s*$/i, '').trim();
  const points = cut > 0 ? text.slice(cut).replace(/^\s*(?:[-–]|:)\s+/, '').trim() : null;
  return { company: company || null, points: points || null };
}
const signedUpside = (match) => (match ? Number(match[1]) * (/down/i.test(match[2]) ? -1 : 1) : null);

function report(post, fields) {
  const rating = fields.rating ? normRating(fields.rating) : null;
  const points = fields.points ? clean(fields.points) : null;
  const pointsRating = !rating && points ? normRating(points.match(RATING_IN_POINTS)?.[1]) : null;
  const finalRating = rating || pointsRating;
  return {
    broker: fields.broker,
    named: clean(fields.company),
    kind: fields.initiation ? 'initiation' : 'view',
    upsidePct: fields.upsidePct ?? null,
    rating: finalRating,
    stance: finalRating ? STANCE_OF[finalRating] : null,
    target: fields.target ?? null,
    points,
    reportTitle: fields.reportTitle ? clean(fields.reportTitle) : null,
    targetRevision: TARGET_REVISION.test(`${points || ''} ${fields.reportTitle || ''}`),
    ratingChangeWords: RATING_CHANGE.test(points || ''),
    postId: Number(post.id),
    url: post.url,
    publishedAt: post.publishedAt || null,
  };
}

/** One digest line — "ICICI Bank: BUY | TP 1,755 | …", "Bajaj Auto | ADD | TP 11,935 |", "APNT | TP 3,285 | BUY |". */
function digestLine(line) {
  const text = clean(line);
  const initiation = /^initiating coverage on\s+/i.test(text);
  const body = text.replace(/^initiating coverage on\s+/i, '');
  const colon = body.match(new RegExp(`^([^:|]+?)\\s*:\\s*(${RATING_WORDS})\\s*\\|\\s*TP\\s*[:₹]?\\s*(?:Rs\\.?\\s*)?([\\d,]+(?:\\.\\d+)?)\\s*\\|?\\s*(.*)$`));
  if (colon) return { company: colon[1], rating: colon[2], target: number(colon[3]), points: colon[4] || null, initiation };
  const cells = body.split('|').map((cell) => cell.trim()).filter(Boolean);
  if (cells.length < 2 || cells.length > 4 || /[:]/.test(cells[0])) return null;
  const rating = cells.slice(1).find((cell) => RATING_CELL.test(cell.toUpperCase().replace('EQUAL-WEIGHT', 'EQUAL WEIGHT')));
  const tp = cells.slice(1).map((cell) => cell.match(/^TP\s*[:₹]?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)$/i)).find(Boolean);
  if (!rating && !tp) return null;
  return { company: cells[0], rating: rating || null, target: tp ? number(tp[1]) : null, points: null, initiation };
}

/**
 * Every broker report one post carries. An empty array means the post names no broker report this
 * reader recognises — an IPO note, a strategy note, a greeting — never that the post was unread.
 */
export function parseBrokerPost(post) {
  const text = String(post?.text || '');
  if (!text.trim() || !post?.url) return [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const header = clean(lines[0]);
  if (/\bIPO\s+No\w*\b/i.test(header)) return [];

  // "<Broker> sees 33% UPSIDE in <Company>- <points>"
  const sees = header.match(/^(.+?)\s+sees\s+(-?\d+(?:\.\d+)?)\s*%\s*(UPSIDE|DOWNSIDE)\s+in\s+(.+)$/i);
  if (sees) {
    const broker = brokerName(sees[1]);
    const { company, points } = companyAndPoints(sees[4]);
    return broker && company ? [report(post, { broker, company, points, upsidePct: signedUpside([null, sees[2], sees[3]]) })] : [];
  }
  // "<Broker> Initiating Coverage on <Company>, with 83% UPSIDE- <points>"
  const init = header.match(/^(.+?)\s+initiat(?:ing|es|ed)\s+coverage\s+on\s+(.+)$/i);
  if (init && !/^initiating\b/i.test(header)) {
    const broker = brokerName(init[1]);
    const upside = init[2].match(UPSIDE);
    const { company, points } = companyAndPoints(init[2].replace(/,?\s*with\s+-?\d+(?:\.\d+)?\s*%\s*(?:UPSIDE|DOWNSIDE)/i, ''));
    return broker && company ? [report(post, { broker, company, points, upsidePct: signedUpside(upside), initiation: true })] : [];
  }

  // A digest: a header naming the broker, then one line per company.
  const morning = header.match(/^(.+?)[’']s\s+Morning India\b/i);
  const digest = header.match(/^(.+?)\s+on(?:\s*\([^)]*\))?\s*$/i)
    || header.match(/^(.+?)\s+(?:update|result preview|pick|picks|top picks|diwali|mahurat|channel check)\b/i);
  const broker = brokerName((morning || digest)?.[1]);
  if (!broker) return [];
  const title = (header.match(/[-–]\s+(.+)$/) || [])[1] || null;
  const out = [];
  for (const line of lines.slice(1)) {
    const row = digestLine(line);
    if (row) {
      out.push(report(post, { broker, company: row.company, rating: row.rating, target: row.target, points: row.points,
        initiation: row.initiation, reportTitle: row.points ? null : title }));
      continue;
    }
    // Morning India's top ideas: "<Company>, with 25% UPSIDE- <points>" or "<Company>- <points>".
    if (!morning) continue;
    const idea = clean(line).match(/^(initiating coverage on\s+)?([^,|:]+?),\s*with\s+(-?\d+(?:\.\d+)?)\s*%\s*(UPSIDE|DOWNSIDE)(?:\s*[-–]\s*(.*))?$/i);
    if (idea) { out.push(report(post, { broker, company: idea[2], upsidePct: signedUpside([null, idea[3], idea[4]]), points: idea[5] || null, initiation: !!idea[1] })); continue; }
    const plain = companyAndPoints(line);
    if (plain.company && plain.points && plain.company.split(' ').length <= 6) out.push(report(post, { broker, company: plain.company, points: plain.points }));
  }
  return out;
}

const istDay = (iso) => {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? new Date(ms + 19800000).toISOString().slice(0, 10) : null;
};
const broker = (value) => clean(value).toLowerCase();

/**
 * One report per broker, company and day. The channel often posts a report on its own and again in
 * the broker's daily digest ("Antique Initiating Coverage on Transrail Lighting, with 83% UPSIDE"
 * and "Initiating Coverage on Transrail Lighting: BUY | TP 851" in "Antique on"). Those are one
 * report: the fields are combined, every post's link is kept, and the earliest post leads.
 */
export function mergeReports(reports, key = (r) => r.ticker || `name:${broker(r.named)}`) {
  const byKey = new Map();
  for (const r of [...reports].sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)) || a.postId - b.postId)) {
    const id = `${broker(r.broker)}|${key(r)}|${istDay(r.publishedAt)}`;
    const held = byKey.get(id);
    if (!held) { byKey.set(id, { ...r, urls: [r.url] }); continue; }
    if (!held.urls.includes(r.url)) held.urls.push(r.url);
    for (const field of ['rating', 'stance', 'target', 'upsidePct', 'points', 'reportTitle']) if (held[field] == null && r[field] != null) held[field] = r[field];
    if (r.kind === 'initiation') held.kind = 'initiation';
    held.targetRevision ||= r.targetRevision;
    held.ratingChangeWords ||= r.ratingChangeWords;
  }
  return [...byKey.values()];
}

/**
 * Whether one report MATTERS, with the reason in words. Material: a coverage initiation; a bearish
 * rating or a downside call; a rating different from the same broker's previous rated report; a
 * target revision the broker states; or two or more brokers publishing on the company inside the
 * alert window. Anything else is retained as context at low importance.
 */
export function brokerImportance(r, brokersInWindow = 1) {
  if (r.kind === 'initiation') return { high: true, reason: `${r.broker} initiated coverage.` };
  if (r.stance === 'bearish' || (r.upsidePct != null && r.upsidePct < 0)) return { high: true, reason: `${r.broker}'s own call points down.` };
  // Any change of the broker's own word counts — BUY → ADD is a revision even inside one stance.
  if (r.previous?.rating && r.rating && r.previous.rating !== r.rating) return { high: true, reason: `${r.broker} moved from ${r.previous.rating} to ${r.rating}.` };
  if (r.targetRevision || r.ratingChangeWords) return { high: true, reason: `${r.broker}'s report title states a rating or target revision.` };
  if (brokersInWindow >= 2) return { high: true, reason: `${brokersInWindow} brokers published on this company within the alert window.` };
  return { high: false, reason: 'A single broker view; retained as context.' };
}

/** The broker's call in its own terms: "BUY · TP ₹1,755", "33% upside", "8% downside". */
export function brokerCall(r) {
  const parts = [];
  if (r.rating) parts.push(r.rating);
  if (r.target != null) parts.push(`TP ₹${r.target.toLocaleString('en-IN')}`);
  if (r.upsidePct != null) parts.push(`${Math.abs(r.upsidePct)}% ${r.upsidePct < 0 ? 'downside' : 'upside'}`);
  return parts.join(' · ');
}

/** The dashboard's own one-line statement of a report, built from the fields above. */
export function brokerHeadline(r) {
  const call = brokerCall(r);
  if (r.kind === 'initiation') return `${r.broker} initiated coverage${call ? `: ${call}` : ''}`;
  if (r.previous?.rating && r.rating && r.previous.rating !== r.rating) return `${r.broker}: ${r.previous.rating} → ${call}`;
  if (r.rating) return `${r.broker}: ${call}`;
  if (r.upsidePct != null) return `${r.broker} sees ${Math.abs(r.upsidePct)}% ${r.upsidePct < 0 ? 'downside' : 'upside'}`;
  return `${r.broker} published a report`;
}

export function brokerDirection(r) {
  if (r.stance === 'bullish') return 'positive';
  if (r.stance === 'bearish') return 'negative';
  if (r.stance === 'neutral') return 'neutral';
  if (r.upsidePct != null) return r.upsidePct < 0 ? 'negative' : r.upsidePct > 0 ? 'positive' : 'neutral';
  return 'neutral';
}
