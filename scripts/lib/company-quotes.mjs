import { readFileSync, writeFileSync } from 'node:fs';
import { projectCompanyQuotes } from '../../public/js/data/company-market-shared.js';

export function writeCompanyQuotes(payload, path) {
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(path, 'utf8'));
    if (previous?.version !== 1 || !Array.isArray(previous.rows)) throw Error('Previous company quotes are invalid; preserve the file for recovery');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const next = projectCompanyQuotes(payload, previous);
  writeFileSync(path, JSON.stringify(next) + '\n');
  return next;
}
