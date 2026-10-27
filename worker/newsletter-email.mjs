import { briefStats, briefSubject, renderBriefHtml } from './newsletter-brief.mjs';
import { editorialEvents, EDITORIAL_EMAIL_PARTS } from './newsletter-editorial.mjs';
import { investorSubject } from './newsletter-investor-email.mjs';

// Gmail clips around 102 KB of HTML, including markup and URLs. Count encoded bytes, not
// characters, and leave space for the sending service/client's additions. Every final outgoing
// body is checked again at the transport boundary. No text, evidence or AI notes are truncated.
// https://mailchimp.com/help/gmail-is-clipping-my-email/
export const EMAIL_HTML_BYTES = 90_000;
// Stop before provider I/O if an edition exceeds the earlier normal delivery range.
// This is a delivery circuit breaker, never a source-record or rendering truncation.
export const MAX_DELIVERY_EMAIL_PARTS = 6;
export function newsletterDeliveryPolicy({ partCount, lateCount = 0 }) {
  if (lateCount > 0) return 'historical-backlog-stopped';
  if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > MAX_DELIVERY_EMAIL_PARTS) return 'email-part-limit';
  return null;
}
export const emailBytes = html => new TextEncoder().encode(html).byteLength;
const PACKING_RESERVE = 1024;
const MAX_PARTS = 99;
const tooLarge = () => Object.assign(new Error('Newsletter content cannot fit safely'), { code: 'email-too-large' });

const sliceCompany = (company, clusters, continued = false) => {
  const stories = clusters.flatMap(k => [k.main, ...k.others]);
  return { ...company, clusters, stories, continued,
    good: clusters.filter(k => k.main.mood.id === 'good').length,
    watch: clusters.filter(k => k.main.mood.id === 'watch').length };
};
const keysFor = companies => [...new Set(companies.flatMap(c => c.stories.flatMap(s => s.keys || [])))];

// A legacy fallback identity (for example a filing's text prefix) can belong to distinct
// updates in different parts. Do not let an accepted part's shared key hide an unsent update.
// Unique delivered URLs still suppress the updates the desk actually received.
export function acceptedStoryKeys(messages, acceptedParts) {
  const pending = new Set(messages.flatMap((m, i) => acceptedParts.has(i) ? [] : m.keys));
  return [...new Set(messages.flatMap((m, i) => acceptedParts.has(i) ? m.keys : []))].filter(key => !pending.has(key));
}

/** Plan once per edition, using the largest recipient footer. Company order and cluster IDs
 * remain unchanged, so AI notes and the sent-story ledger still refer to the original evidence.
 * Whole companies stay together unless one company cannot fit by itself. Calendar, corporate actions, holdings and market rows follow the news. Extra parts are safer than silently dropping a busy day's news.
 */
export function renderBriefEmails(brief, options = {}, { maxBytes = EMAIL_HTML_BYTES, maxParts = MAX_PARTS } = {}) {
  // Group the immutable edition once, rather than once per packing candidate/part.
  options = { ...options, stats: briefStats(brief) };
  const companies = options.stats.companies;
  const full = renderBriefHtml(brief, options);
  if (emailBytes(full) <= maxBytes) return [{ html: full, subject: briefSubject(brief, options), bytes: emailBytes(full), keys: keysFor(companies), part: null }];

  const pages = [];
  const empty = () => ({ companies: [], sections: {} });
  let current = empty();
  const hasContent = page => page.companies.length || Object.keys(page.sections).length;
  const fits = page => emailBytes(renderBriefHtml(brief, {
    ...options, part: { ...page, index: MAX_PARTS, total: MAX_PARTS },
  })) <= maxBytes - PACKING_RESERVE;
  const flush = () => {
    if (hasContent(current)) pages.push(current);
    if (pages.length > maxParts) throw Object.assign(tooLarge(), { requiredParts: pages.length, maxParts });
    current = empty();
  };
  const append = (merge) => {
    const next = merge(current);
    if (fits(next)) { current = next; return true; }
    flush();
    const alone = merge(current);
    if (!fits(alone)) return false;
    current = alone;
    return true;
  };
  for (const company of companies) {
    if (append(page => ({ ...page, companies: [...page.companies, company] }))) continue;
    let continued = false;
    for (const cluster of company.clusters) {
      const merge = page => {
        const last = page.companies.at(-1);
        const selection = last?.ticker === company.ticker
          ? [...page.companies.slice(0, -1), sliceCompany(company, [...last.clusters, cluster], last.continued)]
          : [...page.companies, sliceCompany(company, [cluster], continued)];
        return { ...page, companies: selection };
      };
      if (!append(merge)) throw tooLarge();
      continued = true;
    }
  }
  // A large portfolio of company price rows can be larger than an email on their own. Pack all additional
  // sections too, splitting at row boundaries without changing totals, values or coverage.
  const sections = [
    ['calendar', brief.calendar?.rows], ['actions', brief.actions?.rows],
    ['performance', brief.performance?.rows],
    ['india', brief.markets.rows.filter(r => r.group === 'india')],
    ['markets', brief.markets.rows.filter(r => r.group !== 'india')],
  ];
  for (const [name, rows] of sections) {
    if (!rows) continue;
    if (append(page => ({ ...page, sections: { ...page.sections, [name]: rows } }))) continue;
    for (const row of rows) {
      if (!append(page => ({ ...page, sections: { ...page.sections, [name]: [...(page.sections[name] || []), row] } }))) throw tooLarge();
    }
    if (!rows.length) throw tooLarge();
  }
  flush();
  if (pages.length > MAX_PARTS) throw Object.assign(tooLarge(), { requiredParts: pages.length, maxParts: MAX_PARTS });
  if (!pages.length) throw tooLarge();
  // Part labels stay in the body; one edition subject and transport reply headers form a thread.
  // The complete PDF remains available if a mail client clips the conversation.
  return pages.map((page, i) => {
    const part = { ...page, index: i + 1, total: pages.length };
    const html = renderBriefHtml(brief, { ...options, part });
    const bytes = emailBytes(html);
    if (bytes > maxBytes) throw tooLarge();
    return { html, bytes, subject: briefSubject(brief, options), keys: keysFor(page.companies), part };
  });
}

/** Delivery has a fixed inbox budget. A busy current edition travels as one clearly
 * labelled overview linking its complete immutable PDF, never a truncated inline plan.
 * The caller must publish and verify that exact PDF before any provider submission.
 * Full HTML/text/PDF readers retain every eligible source and supplemental row.
 */
export function renderBriefDeliveryEmails(brief, options = {}, { maxBytes = EMAIL_HTML_BYTES } = {}) {
  if (options.editorial) return renderInvestorEmails(brief,options,{maxBytes});
  const stats = briefStats(brief);
  const policy = newsletterDeliveryPolicy({ partCount: 1, lateCount: stats.late });
  if (policy) throw Object.assign(new Error('Newsletter delivery policy refused this edition'), { code: policy });
  try {
    return renderBriefEmails(brief, options, { maxBytes, maxParts: MAX_DELIVERY_EMAIL_PARTS });
  } catch (error) {
    if (error?.code !== 'email-too-large') throw error;
  }
  // A live send must have a saved edition URL. A moving preview/dashboard link is
  // not delivery evidence for the source keys carried by this message.
  const origin = (options.dashboardUrl || '').replace(/\/+$/, '');
  if (!origin || !options.pdfUrl?.startsWith(origin + '/api/newsletter/pdf/') ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.pdfUrl.slice((origin + '/api/newsletter/pdf/').length))) {
    throw Error('Complete-report delivery requires an immutable edition PDF');
  }
  for (const compact of [false, true]) {
    const part = { reportLink: true, compact, index: 1, total: 1 };
    const html = renderBriefHtml(brief, { ...options, stats, part });
    const bytes = emailBytes(html);
    if (bytes <= maxBytes) return [{ html, bytes, subject: briefSubject(brief, options), keys: keysFor(stats.companies), part }];
  }
  throw tooLarge();
}

/** Current GitHub deliveries use the investor reading layer; legacy frozen bodies are never
 * rewritten. Every accepted part links the same publication-verified complete evidence report. */
export function renderInvestorEmails(brief, options = {}, {maxBytes=EMAIL_HTML_BYTES,maxParts=EDITORIAL_EMAIL_PARTS}={}) {
  const stats=briefStats(brief), snapshot=editorialEvents(brief,stats.companies);
  const reading={...snapshot,byId:new Map(snapshot.events.map(event=>[event.id,event])),companyCount:new Set(snapshot.events.map(event=>event.ticker)).size};
  const origin=(options.dashboardUrl || '').replace(/\/$/,'');
  if (!options.preview && (!origin || !options.pdfUrl?.startsWith(origin+'/api/newsletter/pdf/') ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.pdfUrl.slice((origin+'/api/newsletter/pdf/').length)))) throw Error('Investor delivery requires an immutable edition PDF');
  // Preserve every item and exact URL on dense days. Shorten inbox excerpts
  // before reaching the same hard part limit; the complete report is unchanged.
  for (const [compact,summaryChars] of [[false,340],[true,220],[true,140],[true,100]]) for (const supplements of [true,false]) {
    const pages=[], selected=[];
    const measure=(ids,index)=>emailBytes(renderBriefHtml(brief,{...options,stats,reading,part:{investor:true,reportLink:true,eventIds:ids,compact,summaryChars,supplements,index,total:maxParts,packing:true}}));
    const firstOverhead=measure([],1),continuationOverhead=measure([],2);let used=firstOverhead;
    // Card markup is additive. Measure each card once instead of rendering the whole
    // growing edition for every candidate (quadratic date formatting/string allocation).
    if(firstOverhead>maxBytes-PACKING_RESERVE)continue;
    let failed=false;
    const blocks=[];
    for(const event of reading.events){
      if(blocks.at(-1)?.ticker!==event.ticker)blocks.push({ticker:event.ticker,events:[]});
      blocks.at(-1).events.push({event,cost:measure([event.id],2)-continuationOverhead});
    }
    for(const block of blocks){
      const blockCost=block.events.reduce((n,row)=>n+row.cost,0);
      // Keep a company intact whenever it fits in an empty continuation email.
      // Only an oversized company may continue across an adjacent part boundary.
      if(selected.length&&used+blockCost>maxBytes-PACKING_RESERVE&&continuationOverhead+blockCost<=maxBytes-PACKING_RESERVE){
        pages.push(selected.splice(0));used=continuationOverhead;
        if(pages.length>=maxParts){failed=true;break;}
      }
      for (const {event,cost} of block.events) {
        if (used+cost<=maxBytes-PACKING_RESERVE) {selected.push(event.id);used+=cost;continue;}
        if (!selected.length) {failed=true;break;}
        pages.push(selected.splice(0));
        if (pages.length>=maxParts || continuationOverhead+cost>maxBytes-PACKING_RESERVE) {failed=true;break;}
        selected.push(event.id);used=continuationOverhead+cost;
      }
      if(failed)break;
    }
    if(failed)continue;
    if(selected.length||!pages.length)pages.push(selected);
    if(pages.length>maxParts)continue;
    const messages=pages.map((eventIds,i)=>{
      const previousTicker=i>0?reading.byId.get(pages[i-1].at(-1))?.ticker:null;
      const continuedCompany=reading.byId.get(eventIds[0])?.ticker===previousTicker?previousTicker:null;
      const part={investor:true,reportLink:true,eventIds,compact,summaryChars,supplements,index:i+1,total:pages.length,continuedCompany};
      const html=renderBriefHtml(brief,{...options,stats,reading,part});
      return {html,bytes:emailBytes(html),part,subject:investorSubject(brief,options.brand||'Sattva Ventures',stats,reading),
        // The first accepted email delivers the verified full report. Later emails continue
        // its reading layer; they cannot acknowledge a source the report did not contain.
        keys:i===0?keysFor(stats.companies):[]};
    });
    if(messages.every(m=>m.bytes<=maxBytes))return messages;
  }
  throw Object.assign(tooLarge(),{maxParts});
}
