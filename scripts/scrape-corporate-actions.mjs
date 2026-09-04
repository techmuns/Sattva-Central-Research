#!/usr/bin/env node

// Capture NSE's exchange-wide corporate-actions calendar. The output is replaced only after a
// complete, valid response has been parsed, so a refusal or format change cannot erase the last
// useful file.

import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafeCorporateActionReplacement, normaliseNseCorporateActions } from '../public/js/data/corporate-actions-shared.js';

const OUTPUT = path.resolve('public/data/corporate-actions.json');
const ENDPOINT = 'https://www.nseindia.com/api/corporates-corporateActions';
const DAY = 86_400_000;
const now = new Date();
const from = new Date(now.getTime() - 3 * 365 * DAY);
const to = new Date(now.getTime() + 365 * DAY);
const queryDate = (date) => `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
const isoDate = (date) => date.toISOString().slice(0, 10);

const url = new URL(ENDPOINT);
url.searchParams.set('index', 'equities');
url.searchParams.set('from_date', queryDate(from));
url.searchParams.set('to_date', queryDate(to));

const response = await fetch(url, {
  headers: {
    accept: 'application/json,text/plain,*/*',
    referer: 'https://www.nseindia.com/companies-listing/corporate-filings-actions',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36 SattvaResearch/1.0',
  },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`NSE corporate actions answered HTTP ${response.status}.`);
const text = await response.text();
if (text.length > 8 * 1024 * 1024) throw new Error('NSE corporate actions response exceeded 8 MiB.');
let raw;
try { raw = JSON.parse(text); } catch { throw new Error('NSE corporate actions response was not JSON.'); }
const parsed = normaliseNseCorporateActions(raw);
if (!parsed.rows.length) throw new Error('NSE corporate actions response contained no usable rows; previous capture retained.');

let previous = null;
try { previous = JSON.parse(await fs.readFile(OUTPUT, 'utf8')); } catch {}
assertSafeCorporateActionReplacement(parsed, previous);

const typeCounts = Object.fromEntries([...new Set(parsed.rows.map((row) => row.actionType))].sort().map((type) => [type, parsed.rows.filter((row) => row.actionType === type).length]));
const body = {
  version: 1,
  capturedAt: new Date().toISOString(),
  source: 'NSE corporate actions',
  requestedFrom: isoDate(from),
  requestedTo: isoDate(to),
  rowCount: parsed.rows.length,
  companyCount: new Set(parsed.rows.map((row) => row.ticker)).size,
  typeCounts,
  skipped: parsed.skipped,
  excludedMeetings: parsed.excludedMeetings,
  duplicates: parsed.duplicates,
  rows: parsed.rows,
};

await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
const temporary = `${OUTPUT}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(body)}\n`);
await fs.rename(temporary, OUTPUT);
console.log(`Captured ${body.rowCount} NSE corporate actions for ${body.companyCount} companies (${body.requestedFrom} to ${body.requestedTo}).`);
