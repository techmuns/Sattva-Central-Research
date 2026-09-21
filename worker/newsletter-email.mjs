import { briefStats, briefSubject, renderBriefHtml } from './newsletter-brief.mjs';

// Gmail clips around 102 KB of HTML, including markup and URLs. Count encoded bytes, not
// characters, and leave space for the sending service/client's additions. Every final outgoing
// body is checked again at the transport boundary. No text, evidence or AI notes are truncated.
// https://mailchimp.com/help/gmail-is-clipping-my-email/
export const EMAIL_HTML_BYTES = 90_000;
export const emailBytes = html => new TextEncoder().encode(html).byteLength;
const PACKING_RESERVE = 1024;
const MAX_PARTS = 99;
const tooLarge = () => Object.assign(new Error('Newsletter content cannot fit safely'), { code: 'email-too-large' });

const sliceCompany = (company, clusters, continued = false) => {
  const stories = clusters.flatMap(k => [k.main, ...k.others]);
  return { ...company, clusters, stories, continued,
    good: stories.filter(s => s.mood.id === 'good').length,
    watch: stories.filter(s => s.mood.id === 'watch').length };
};
const keysFor = companies => [...new Set(companies.flatMap(c => c.stories.flatMap(s => s.keys || [])))];

/** Plan once per edition, using the largest recipient footer. Company order and cluster IDs
 * remain unchanged, so AI notes and the sent-story ledger still refer to the original evidence.
 * Whole companies stay together unless one company cannot fit by itself. The market scan is
 * placed only in the final email. Extra parts are safer than silently dropping a busy day's news.
 */
export function renderBriefEmails(brief, options = {}, { maxBytes = EMAIL_HTML_BYTES } = {}) {
  const companies = briefStats(brief).companies;
  const full = renderBriefHtml(brief, options);
  if (emailBytes(full) <= maxBytes) return [{ html: full, subject: briefSubject(brief, options), bytes: emailBytes(full), keys: keysFor(companies), part: null }];

  const pages = [];
  let current = [];
  // Reserve for the real numbering, continuation text, final coverage notice and footer.
  const fits = (selection, includeMarkets = false) => emailBytes(renderBriefHtml(brief, {
    ...options, part: { companies: selection, includeMarkets, index: MAX_PARTS, total: MAX_PARTS },
  })) <= maxBytes - PACKING_RESERVE;
  const flush = () => { if (current.length) pages.push({ companies: current, includeMarkets: false }); current = []; };
  for (const company of companies) {
    if (fits([...current, company])) { current.push(company); continue; }
    flush();
    if (fits([company])) { current.push(company); continue; }
    // A single prolific company may cross an email boundary, but an update and all of its
    // related sources stay together. Pathological source content fails visibly before sending.
    let clusters = [], continued = false;
    for (const cluster of company.clusters) {
      const next = [...clusters, cluster];
      if (fits([sliceCompany(company, next, continued)])) { clusters = next; continue; }
      if (!clusters.length) throw tooLarge();
      pages.push({ companies: [sliceCompany(company, clusters, continued)], includeMarkets: false });
      continued = true;
      clusters = [cluster];
      if (!fits([sliceCompany(company, clusters, continued)])) throw tooLarge();
    }
    current = [sliceCompany(company, clusters, continued)];
  }
  if (!fits(current, true)) flush();
  if (!fits(current, true)) throw tooLarge();
  pages.push({ companies: current, includeMarkets: true });
  if (pages.length > MAX_PARTS) throw tooLarge();
  return pages.map((page, i) => {
    const part = { ...page, index: i + 1, total: pages.length };
    const html = renderBriefHtml(brief, { ...options, part });
    const bytes = emailBytes(html);
    if (bytes > maxBytes) throw tooLarge();
    return { html, bytes, subject: briefSubject(brief, { ...options, part }), keys: keysFor(page.companies), part };
  });
}
