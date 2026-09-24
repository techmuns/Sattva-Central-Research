// worker/filing-page.mjs — one NSE XBRL announcement as a page a human can read.
//
// WHY A PAGE AND NOT THE PANEL. `js/ui/xbrl-filing.js` already renders these filings inside the
// dashboard, and that is where a reader who is on the dashboard meets one. The team brief reaches
// people who are NOT on the dashboard: an email lands on a phone, and every filing in it that NSE
// published as XBRL sent the reader to `nsearchives.nseindia.com/...WebXMLFile....xml`, which a
// browser shows as "This XML file does not appear to have any style information associated with
// it" above a tree of SEBI namespaces. The filing was there the whole time and nothing was
// rendering it — the same gap the panel closed on the dashboard, one surface further out.
//
// SO IT IS SERVER-RENDERED, AND DELIBERATELY: a link out of an email must open the document, not
// an application that then fetches it. No script, no stylesheet, no font, no request of its own —
// the page arrives finished, which is also the only version of this that works on a slow phone.
//
// IT REPRODUCES AND ADDS NOTHING. Every label is the exchange's own tag spaced into words and
// every value is the company's own, unchanged — `parseXbrlFiling`'s output, rendered. Nothing is
// summed, scored, re-banded or re-worded. The raw source is available under Source file details
// with an explicit XML label.

import { isXbrlFilingUrl, readableFilingUrl } from '../public/js/data/nse-xbrl-shared.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const INK = '#0f172a';
const BODY = '#334155';
const META = '#64748b';
const RULE = '#e2e8f0';
const ACCENT = '#4f46e5';
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

const page = (title, inner) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;color:${INK};-webkit-text-size-adjust:100%;">
<div style="max-width:760px;margin:0 auto;padding:28px 20px 56px;">${inner}</div>
</body></html>`;

const sourceLink = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:${ACCENT};font-family:${SANS};font-size:13px;font-weight:bold;text-decoration:none;">${esc(label)} &#8599;</a>`;

const sourceDetails = (url) => isXbrlFilingUrl(url) ? `<details style="margin-top:18px;font-family:${SANS};font-size:12px;line-height:1.6;color:${META};">
  <summary style="cursor:pointer;">Source file details</summary>
  <p>NSE published this filing as an XML data file. The readable view reproduces its fields without changing their values.</p>
  ${sourceLink(url, 'View raw XML on NSE (technical file)')}
</details>` : '';

const masthead = (brand) => `<div style="font-family:${SANS};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${META};">${esc(brand)}</div>`;

/** The identification line: the row's own subject and time, then the ids the filing carries. */
function metaLine(filing, { subject, when }) {
  return [subject, when, filing?.isin ? `ISIN ${filing.isin}` : null, filing?.scripCode ? `BSE ${filing.scripCode}` : null]
    .filter(Boolean).map(esc).join(' &middot; ');
}

const factRow = (fact) => `<tr>
  <td valign="top" style="padding:9px 14px 9px 0;border-top:1px solid ${RULE};font-family:${SANS};font-size:12px;line-height:1.5;color:${META};width:38%;">${esc(fact.label || fact.tag)}</td>
  <td valign="top" style="padding:9px 0;border-top:1px solid ${RULE};font-family:${SANS};font-size:14px;line-height:1.55;color:${INK};white-space:pre-line;">${esc(fact.value)}${fact.unit ? ` <span style="font-size:11px;font-weight:bold;text-transform:uppercase;color:${META};">${esc(fact.unit)}</span>` : ''}</td>
</tr>`;

const blockHtml = (block) => `<section style="margin-top:22px;">
  ${block.title ? `<h2 style="margin:0 0 2px;font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${ACCENT};">${esc(block.title)}</h2>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${(block.facts || []).map(factRow).join('')}</table>
</section>`;

/**
 * The filing, rendered. `context` is what the ROW that linked here already knew — company, ticker,
 * subject, filed time — and it titles the page where the document itself carries no name, so a
 * reader is never shown a blank heading or, worse, a guessed one.
 */
export function renderFilingPage({ filing, url, context = {}, brand = 'Sattva Ventures', dashboardUrl = null }) {
  const title = filing?.company || context.company || context.ticker || 'NSE filing';
  const symbol = filing?.symbol || context.ticker || null;
  return page(title, `
    ${masthead(brand)}
    <h1 style="margin:6px 0 2px;font-family:${SERIF};font-size:27px;line-height:1.2;color:${INK};">${esc(title)}</h1>
    ${symbol ? `<div style="font-family:${SANS};font-size:13px;font-weight:bold;color:${BODY};">${esc(symbol)}</div>` : ''}
    <div style="margin-top:4px;font-family:${SANS};font-size:12px;line-height:1.6;color:${META};">${metaLine(filing, context)}</div>
    <div style="margin-top:16px;padding:12px 14px;background:#f1f5f9;border-radius:10px;font-family:${SANS};font-size:12px;line-height:1.65;color:${BODY};">
      Reproduced from the company&rsquo;s own XBRL filing to NSE. Every field below is the exchange&rsquo;s label and the
      company&rsquo;s value, unchanged &mdash; nothing here is summarised, scored or re-worded.
    </div>
    ${(filing?.blocks || []).map(blockHtml).join('')}
    <div style="margin-top:26px;padding-top:12px;border-top:2px solid ${INK};font-family:${SANS};font-size:12px;color:${META};">
      ${filing?.factCount || 0} field${filing?.factCount === 1 ? '' : 's'} as filed
      ${dashboardUrl ? ` &middot; <a href="${esc(dashboardUrl)}" target="_blank" rel="noopener noreferrer" style="color:${ACCENT};font-weight:bold;text-decoration:none;">Research Central</a>` : ''}
    </div>
    ${sourceDetails(url)}`);
}

/**
 * The state where the filing could not be read.
 *
 * IT NAMES THE FAILURE AND KEEPS THE DOCUMENT REACHABLE — the panel's rule, for the same reason.
 * "Could not be rendered" and "the filing is gone" are different claims and only the first is ever
 * true here: the file is still on NSE's archive and the link below goes to it, which is exactly
 * where the click used to land. A failure here costs a reader one extra click; it can never cost
 * them the filing.
 */
export function renderFilingFailure({ url, reason, error, context = {}, brand = 'Sattva Ventures' }) {
  const words = reason === 'unsupported'
    ? 'This address is not one of NSE’s XBRL announcement files, so there is nothing here to lay out.'
    : 'NSE could not be read for this filing just now. Please try again shortly.';
  const title = context.company || context.ticker || 'NSE filing';
  return page(title, `
    ${masthead(brand)}
    <h1 style="margin:6px 0 2px;font-family:${SERIF};font-size:27px;line-height:1.2;color:${INK};">${esc(title)}</h1>
    <div style="margin-top:4px;font-family:${SANS};font-size:12px;line-height:1.6;color:${META};">Filed to NSE as an XBRL data file</div>
    <p style="margin-top:16px;font-family:${SANS};font-size:14px;line-height:1.6;color:${BODY};">${esc(words)}</p>
    ${error ? `<p style="margin-top:4px;font-family:${SANS};font-size:11px;line-height:1.6;color:${META};">${esc(error)}</p>` : ''}
    ${isXbrlFilingUrl(url) ? `<p style="margin-top:18px;">${sourceLink(readableFilingUrl(url), 'Try readable filing again')}</p>` : ''}
    ${sourceDetails(url)}`);
}
