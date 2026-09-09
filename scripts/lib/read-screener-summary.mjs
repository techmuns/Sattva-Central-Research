import { summaryId, SUMMARY_WINDOW_MS, validateSummaryBody } from '../../public/js/data/concall-summaries-shared.js';

export const summaryReadError = (code, retryAt = null) => Object.assign(Error('Screener summary could not be read'), { summaryCode: code, retryAt });

// One source navigation per durable reservation, including redirects, meta refresh and CSS
// imports. A page remains open between claims; it cannot spend another request by itself.
export function summaryNavigationGate() {
  let allowed = null;
  return {
    arm(target) {
      if (summaryId(target?.url) !== target?.id) throw summaryReadError('identity');
      allowed = target.url;
    },
    accept(url, type, mainFrame) {
      if (!new URL(url).pathname.startsWith('/concalls/summary/')) return true;
      if (type !== 'document' || !mainFrame || url !== allowed) return false;
      allowed = null;
      return true;
    },
  };
}
export function summaryResponseError(status, text = '', retryAfter = null, now = Date.now()) {
  let retryAt = null;
  const failure = (code, until = null) => Object.assign(summaryReadError(code, until), { httpStatus: status });
  if (retryAfter) {
    const at = /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(at)) retryAt = new Date(Math.max(at, now + SUMMARY_WINDOW_MS)).toISOString();
  }
  if (status === 429 || /limit exceeded|(?:daily|summary|summaries) (?:limit|quota).{0,50}(?:exceed|reach)|try again tomorrow/i.test(text))
    return failure('rate-limited', retryAt);
  if (status === 401) return failure('session-expired');
  // The normal HTTP 200 login page advertises "Upgrade to Premium". Marketing copy alone is
  // not an access refusal. Unknown paywalls still fail the summary's identity/body validation.
  if (status === 403 || /access denied|verify you are human|captcha/i.test(text)) return failure('access-denied', retryAt);
  if (status === 404 || /summary (?:is )?(?:not available|not yet|being prepared)/i.test(text)) return failure('not-published');
  if (status < 200 || status >= 300) return failure('source-unavailable', retryAt);
  return null;
}

// Executed against the rendered, JavaScript-disabled source page; returns text structures only.
// No source HTML, scripts, account chrome or request headers are stored or sent to the reader.
export function extractSummaryDocument(target) {
  const heading = document.querySelector('h1');
  const title = heading?.innerText?.trim() || '';
  if (!/^Concall Summary\s*[-–—]/i.test(title)) return null;
  const companyPath = url => {
    try { return new URL(url, location.href).pathname.replace(/\/consolidated\/$/, '/'); } catch { return null; }
  };
  const root = heading.closest('main, article, section') || heading.parentElement;
  if (!root || root === document.body) return null;
  const companyPaths = [...new Set([...root.querySelectorAll('a[href*="/company/"]')]
    .filter(a => !a.closest('nav,footer,header,[hidden],[aria-hidden="true"]')).map(a => companyPath(a.href)))];
  if (companyPaths.length !== 1 || companyPaths[0] !== companyPath(target.companyUrl)) return null;
  const excluded = 'nav,footer,header,form,button,script,style,[hidden],[aria-hidden="true"],.breadcrumb,.breadcrumbs';
  const selected = [...root.querySelectorAll('h2,h3,h4,p,ul,ol,table,blockquote')].filter(node =>
    !!(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) && !node.closest(excluded) &&
    node.getClientRects().length && !node.parentElement.closest('p,ul,ol,table,blockquote'));
  const blocks = selected.map(node => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') return { type: 'list', ordered: tag === 'ol',
      items: [...node.children].filter(item => item.tagName === 'LI').map(item => item.innerText.trim()).filter(Boolean) };
    if (tag === 'table') return { type: 'table', rows: [...node.querySelectorAll('tr')]
      .filter(row => row.closest('table') === node).map(row => [...row.children].filter(cell => ['TH', 'TD'].includes(cell.tagName)).map(cell => cell.innerText.trim())).filter(row => row.length) };
    return { type: /^h/.test(tag) ? 'heading' : tag === 'blockquote' ? 'quote' : 'paragraph', text: node.innerText.trim() };
  }).filter(block => block.text || block.items?.length || block.rows?.length);
  // A template change to non-semantic divs must not save just its few remaining headings as a
  // complete report. Compare every visible text node after the title with captured body text.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let sourceLength = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode, parent = node.parentElement;
    if (parent && !parent.closest(excluded) && parent.getClientRects().length && !heading.contains(node) &&
        (heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) sourceLength += node.textContent.replace(/\s/g, '').length;
  }
  const capturedLength = blocks.map(block => block.text || (block.items || block.rows.flat()).join(' ')).join(' ').replace(/\s/g, '').length;
  if (sourceLength && capturedLength / sourceLength < 0.85) return null;
  return { title, blocks };
}

export async function readScreenerSummary(page, target, { now = Date.now } = {}) {
  if (summaryId(target?.url) !== target?.id) throw summaryReadError('identity');
  let response;
  try { response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch { throw summaryReadError('source-unavailable'); }
  const text = await page.locator('body').innerText({ timeout: 5000 });
  const refusal = summaryResponseError(response?.status() || 0, text, response?.headers()['retry-after'], now());
  if (refusal) throw refusal;
  const failure = code => Object.assign(summaryReadError(code), { httpStatus: response?.status() || null });
  if (/\/(?:login|register)\//.test(new URL(page.url()).pathname)) throw failure('session-expired');
  if (summaryId(page.url()) !== target.id) throw failure('identity');
  if (text.length > 256 * 1024) throw failure('structure-changed');
  const extracted = await page.evaluate(extractSummaryDocument, target);
  try { return validateSummaryBody(extracted); } catch { throw failure('structure-changed'); }
}
