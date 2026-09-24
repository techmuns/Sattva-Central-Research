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
export function renderBriefEmails(brief, options = {}, { maxBytes = EMAIL_HTML_BYTES } = {}) {
  const companies = briefStats(brief).companies;
  const full = renderBriefHtml(brief, options);
  if (emailBytes(full) <= maxBytes) return [{ html: full, subject: briefSubject(brief, options), bytes: emailBytes(full), keys: keysFor(companies), part: null }];

  const pages = [];
  const empty = () => ({ companies: [], sections: {} });
  let current = empty();
  const hasContent = page => page.companies.length || Object.keys(page.sections).length;
  const fits = page => emailBytes(renderBriefHtml(brief, {
    ...options, part: { ...page, index: MAX_PARTS, total: MAX_PARTS },
  })) <= maxBytes - PACKING_RESERVE;
  const flush = () => { if (hasContent(current)) pages.push(current); current = empty(); };
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
  if (pages.length > MAX_PARTS || !pages.length) throw tooLarge();
  // Gmail can clip a combined same-subject conversation even when each body fits.
  // Keep numbered subjects, as Sattva does; the PDF remains the single complete document.
  return pages.map((page, i) => {
    const part = { ...page, index: i + 1, total: pages.length };
    const html = renderBriefHtml(brief, { ...options, part });
    const bytes = emailBytes(html);
    if (bytes > maxBytes) throw tooLarge();
    return { html, bytes, subject: briefSubject(brief, { ...options, part }), keys: keysFor(page.companies), part };
  });
}
