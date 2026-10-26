// The inbox is a reading layer over the complete immutable edition. Classification never
// deletes a captured row, changes an edition window or certifies an unread document.
import { scheduledBoardMeetingSummary } from './newsletter-filing-events.mjs';
import { investorSourceFacts, investorSourceSummary, xbrlBoardMeetingNote, votingResultNote, readNoticeNote, consolidatedBoardReading, hasSourceChange } from './newsletter-source-notes.mjs';
import { newsletterSourceUrl } from './newsletter-source-links.mjs';
import { scheduledEarningsCall, consolidatedEarningsCallNote } from './newsletter-notice-events.mjs';
import { investmentReading } from './newsletter-investment-events.mjs';
export const EDITORIAL_VERSION = 1;
export const EDITORIAL_EMAIL_PARTS = 3;
const text = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const normal = value => text(value).toLowerCase();

/** Narrow, explainable exclusions. Unknown announcements remain eligible for review. */
export function referenceReason(item) {
  const title = text(item.headline || item.title), ticker = String(item.ticker || '').toUpperCase();
  if (['issuer-mismatch','company-evidence-unconfirmed'].includes(item.content?.reason)) return 'Issuer connection not established by the source reading';
  if (item.kind === 'news' || !item.kind) {
    if(/^(?:Q[1-4]\s+)?results (?:this|next) week\s*:/i.test(title)&&!/\b(?:profit|revenue|margin|EBITDA|EPS|growth|loss)\b|%/i.test(title))return 'Results-calendar roundup; no company results disclosed';
    if(/\bstock price, news, quote and history(?:\s*[-–—]\s*Yahoo Finance)?[.!]?$|\bshare price\s*[-:]\s*live\b|\bstock price live NSE\/BSE updates[.!]?$/i.test(title)) return 'Quote/reference page; no business development stated';
    if((/\bis rated (?:sell|buy|hold)[.!]?$/i.test(title)||/\b(?:(?:upgraded|downgraded) to (?:sell|buy|hold) amid (?:technical|valuation|mixed|bearish)|forms death cross|faces mildly bearish technical shift)\b/i.test(title)) &&
      !/\b(?:CRISIL|ICRA|CARE Ratings|Moody|Fitch|S&P|credit rating|guidance|profit warning|default|fraud|FDA|earnings|results|contract|merger|acquisition|dividend)\b|\bby (?!MarketsMojo\b)[A-Z]/i.test(title))return 'Automated technical/opinion template; no attributed fundamental change';
    if (/\b(?:slides|slips|climbs|rises|falls|gains|drops|jumps) (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),? (?:outperforms|underperforms) competitors[.!]?$/i.test(title)) return 'Automated daily price comparison; no business development stated';
    if (/\bestimates\s*[-–:]\s*(?:NSE|BSE)\s*:|\boption chain\b/i.test(title) &&
        !/\b(?:raised|lowered|revised|revision|upgrade|downgrade|changed|cut|increased|decreased)\b/i.test(title)) return 'Reference page; no estimate revision stated';
    if (/\bstocks to watch|\bupcoming IPOs?\b|\bIPOs? (?:this|next) week\b|\bIPO (?:GMP|review)\b|\brated (?:buy|sell|hold) by marketsmojo\b/i.test(title)) return 'Roundup, offer guide or unchanged opinion';
    if (ticker === 'LUPIN' && /\b(?:netflix|season|series|releases|episodes)\b/i.test(title) && !/\b(?:pharma|drug|FDA|lupin limited|lupin ltd)\b/i.test(title)) return 'Different entity: entertainment title';
    if (ticker === 'INDIANB') {
      const remaining = title.replace(/\bsouth indian bank\b/gi, '').replace(/\b(?:largest|leading|an|a) indian bank\b/gi, '');
      if (!/\bindian bank\b|\bINDIANB\b/i.test(remaining)) return 'Different bank or generic description';
    }
    if (ticker === 'CUB' && /\btown[ -]city union\b/i.test(title) && !/\bcity union bank\b/i.test(title)) return 'Different entity: civic union';
    if (ticker === 'MOTILALOFS' && /\b(?:buy|sell|hold|neutral|target|sector report|upgrade|downgrade)\b/i.test(title)) {
      const subject = title.split(/\bby motilal oswal\b/i)[0];
      if (subject !== title && !/\bmotilal oswal\b/i.test(subject)) return 'Research author; report concerns another issuer';
    }
  }
  if(scheduledEarningsCall(item))return null;
  const calendarText = `${title} ${(item.content?.facts || []).filter(f => f.field === 'event').map(f => f.value).join(' ')}`;
  if(item.kind==='filing'&&hasSourceChange(`${calendarText} ${(item.content?.facts||[]).filter(f=>['date','status'].includes(f.field)).map(f=>f.value).join(' ')}`))return null;
  if (item.kind === 'filing' && /\b(?:schedule of meet|schedule.*(?:call|investor|analyst)|(?:intimation|will hold).*(?:conference call|earnings call|earnings conference)|audio recording|transcript.*(?:call|meeting))\b/i.test(calendarText) && !item.content?.facts?.some(f=>['amount','ownership','conditions'].includes(f.field))) return 'Calendar or supporting earnings document';
  return null;
}

export function editorialPriority(item) {
  if (referenceReason(item)) return 0;
  const facts = item.content?.facts || [];
  const value = `${item.headline || ''} ${facts.map(f => f.value).join(' ')}`;
  if (/\b(?:default|fraud|insolvency|bankrupt|resign|resignation|recall|warning letter|form[ -]?483|FDA|penalt|downgrad|pledge|encumbrance|litigation|regulatory|investigation)\w*/i.test(value)) return 100;
  if (/\b(?:results|profit|revenue|margin|guidance|earnings|acquisition|merger|divest|fund.?rais|preferential|QIP|rights issue|buyback|dividend|order|contract|capacity|commission|rating|management|director)\w*/i.test(value)) return 80;
  if (item.kind === 'filing' || item.kind === 'trade') return 60;
  if (item.kind === 'move') return 30;
  return 40;
}

export function editorialEvents(brief, companies) {
  const events = [], reference = [], repeated = [];
  for (const company of companies) for (const cluster of company.clusters) {
    const members = [cluster.main, ...cluster.others];
    const eligible = members.filter(item => !referenceReason(item));
    if (!eligible.length) { reference.push(cluster); continue; }
    let lead = eligible.includes(cluster.main)?cluster.main:[...eligible].sort((a,b) => Number(b.kind === 'filing') - Number(a.kind === 'filing') ||
      Number(b.content?.state === 'ready') - Number(a.content?.state === 'ready') || editorialPriority(b) - editorialPriority(a))[0];
    if (members.some(item => item.editorialReported)) { repeated.push(cluster); continue; }
    const note = brief.ai?.items?.[cluster.id] || (cluster.main.content?.state==='ready' ? cluster.main.content.note : null);
    const ready = eligible.filter(s => s.content?.state === 'ready');
    // Verified physical copies were already consolidated. Alternate extraction
    // wording on a mirror cannot veto its canonical document's source reading.
    const readingItems=cluster.documents?.length?cluster.documents.map(d=>d.main):members;
    const callCluster=readingItems.some(s=>scheduledEarningsCall(s));
    const board=callCluster?null:consolidatedBoardReading(readingItems);
    if(board?.lead)lead=board.lead;
    const investment=investmentReading(readingItems);
    if(investment?.lead)lead=investment.lead;
    const completeSourceSummary=investment?.note||(callCluster?consolidatedEarningsCallNote(readingItems):board?board.note||null:xbrlBoardMeetingNote(lead)||votingResultNote(lead)||readNoticeNote(lead));
    const sourceSummary=cluster.versionConflict?'Different versions of this document were captured; their chronology is unconfirmed. Read the retained versions before relying on the figures.':completeSourceSummary || investorSourceSummary(lead);
    events.push({ id: cluster.id, company: company.company, ticker: company.ticker, cluster,
      lead, note, rank: Math.max(...eligible.map(editorialPriority)), at: Math.max(...eligible.map(s => s.at)),
      sourceCount: members.length, read: ready.length, total: members.length,
      // A summary of a different lead cannot be relabelled as this filing's summary.
      summary: note && lead === cluster.main && !cluster.versionConflict && !completeSourceSummary ? note.summary : null,
      sourceSummary,
      completeSourceSummary:!!completeSourceSummary&&!cluster.versionConflict,
      description: scheduledBoardMeetingSummary(lead),
      facts: investorSourceFacts(lead),
      sources: [...new Set([lead,...members.filter(s=>s!==lead)].map(newsletterSourceUrl).filter(Boolean))],
      evidence: lead.content?.state === 'ready' ? sourceSummary?'Source read':'Source read; factual summary unavailable' : lead.content?.state==='partial'?'Partial source read':'Headline only',
    });
  }
  events.sort((a,b) => b.rank-a.rank || Number(b.lead.kind === 'filing')-Number(a.lead.kind === 'filing') || b.at-a.at || a.ticker.localeCompare(b.ticker));
  return { version: EDITORIAL_VERSION, events, reference, repeated, sources: companies.reduce((n,c)=>n+c.stories.length,0) };
}

// Fingerprints supplement (never replace) source identities in the existing acknowledged
// ledger. A changed document/fact set is a new version. Headlines cannot identify versions:
// two different approvals/orders may use the very same long, specific-looking title.
export async function annotateEditorialHistory(brief, companies, reported) {
  const groups = [...(brief.announcements?.groups || []), ...(brief.news?.groups || [])];
  const byKey = new Map(groups.flatMap(g=>g.items.flatMap(row=>(row.keys || []).map(key=>[`${g.ticker}|${key}`,row]))));
  for (const company of companies) for (const cluster of company.clusters) {
    const members=[cluster.main,...cluster.others],aliases=[];let identifiedMembers=0;
    for(const member of members) {
      if(!['filing','news'].includes(member.kind))continue;
      const content=member.content, facts=content?.state==='ready'?content.facts||[]:[];
      const substantive=facts.length?JSON.stringify(facts.map(f=>[f.field,normal(f.value)]).sort()):null;
      const identity=content?.state==='ready'&&content.hash?`document:${content.hash}`:substantive?`facts:${substantive}`:null;
      if(!identity)continue;
      identifiedMembers++;
      const input=JSON.stringify([EDITORIAL_VERSION,company.ticker,!!member.related,identity]);
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input)))].map(b=>b.toString(16).padStart(2,'0')).join('');
      const key=`newsletter-event:${digest}`;
      aliases.push({key,known:!!reported?.has(key)});
    }
    // A newly supplied version cannot be hidden by an older, already-covered member of
    // the group. Unknown new evidence keeps the event visible until it can be checked.
    const already=identifiedMembers===members.length&&aliases.length>0&&aliases.every(a=>a.known);
    for (const member of [cluster.main,...cluster.others]) for (const key of member.keys || []) {
      const row=byKey.get(`${company.ticker}|${key}`); if (!row) continue;
      row.editorialReported = already;
      row.keys = [...new Set([...(row.keys || []),...aliases.map(a=>a.key)])];
    }
  }
}

export const editorialText = text;
