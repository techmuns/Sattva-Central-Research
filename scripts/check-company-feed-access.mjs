// Read-only host qualification. No credentials, browser session or capture files are written.
import { captureCompanies } from './lib/company-capture.mjs';
import { createScreenerCompanyFallback } from './lib/screener-company-filings.mjs';
const targets = ['HEG', 'DHOOTTRANS', 'JBCHEPHARM', 'BAGMANE', 'VERTIS', '543225', 'INDIGRID', 'MINDSPACE', 'EMBASSY', 'BIRET', 'NHIT',
  'ALPEXSOLAR-SM', 'ASHIKA', 'FCONSUMER', 'FSC', 'JAYBEE-SM'];
const scope = captureCompanies(new URL('../public/data/', import.meta.url).pathname, { announcements: true });
const read = createScreenerCompanyFallback();
let failures = 0;
for (const ticker of targets) {
  const company = scope.companies.find(c => c.ticker === ticker);
  try {
    if (!company) throw Error('Company is absent from the current scope');
    const page = await read(company);
    if (page.skipped || page.announcementSkipped || !page.announcementReadable) throw Error('Partial or unrecognized page');
    console.log(`${ticker}: PASS ${page.documents.length} document links, ${page.announcements.length} recent notices; ${page.fetchedAt}`);
  } catch (error) { failures++; console.log(`${ticker}: FAIL ${error.message}`); }
  await new Promise(resolve => setTimeout(resolve, 2500));
}
console.log(`${targets.length - failures}/${targets.length} company pages readable. Recent notices do not establish complete history. No dashboard data was written.`);
process.exitCode = failures ? 1 : 0;
