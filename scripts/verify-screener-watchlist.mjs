#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  additionsCsv,
  matchRemovalButtons,
  parseWatchlistExport,
  portfolioWatchlistTargets,
  reconcileWatchlist,
} from './lib/screener-watchlist.mjs';

const portfolio = {
  holdings: [
    { isin: 'INE000A01001', name: 'Alpha Ltd', listed: true, ticker: 'ALPHA' },
    { isin: 'INE000A01002', name: 'Beta Limited', listed: true, exchange: 'BSE' },
    { isin: 'INE000A01003', name: 'Private Company', listed: false },
  ],
};
const targets = portfolioWatchlistTargets(portfolio);
assert.deepEqual(targets.map(row => row.isin), ['INE000A01001', 'INE000A01002'], 'NSE and BSE listed holdings should be included');

const exported = parseWatchlistExport(Buffer.from([
  'Name,NSE Code,BSE Code,ISIN Code',
  'Alpha Ltd,ALPHA,500001,INE000A01001',
  '"Gamma, Industries Ltd",GAMMA,500003,INE000A01004',
].join('\r\n')));
assert.equal(exported.length, 2, 'CSV exports should retain every ISIN row');
assert.equal(exported[1].name, 'Gamma, Industries Ltd', 'quoted CSV company names should parse');

const plan = reconcileWatchlist(exported, targets);
assert.deepEqual(plan.additions.map(row => row.isin), ['INE000A01002']);
assert.deepEqual(plan.removals.map(row => row.isin), ['INE000A01004']);
assert.deepEqual(matchRemovalButtons(plan.removals, [
  { companyId: '11', name: 'Alpha Limited', href: '/company/ALPHA/' },
  { companyId: '12', name: 'Gamma Industries Limited', href: '/company/GAMMA/' },
]).map(row => row.companyId), ['12']);
assert.throws(() => matchRemovalButtons(plan.removals, [
  { companyId: '12', name: 'Gamma Industries Limited', href: '' },
  { companyId: '13', name: 'Gamma Industries Ltd', href: '' },
]), /unambiguously/, 'ambiguous removals must fail before mutation');
assert.equal(additionsCsv(plan.additions), 'ISIN Code\nINE000A01002\n');

const source = await readFile(new URL('./sync-screener-watchlist.mjs', import.meta.url), 'utf8');
assert.match(source, /const WATCHLIST_ID = '10850427'/, 'the existing watchlist ID must be fixed');
assert.match(source, /const WATCHLIST_NAME = 'S Screen'/, 'the existing watchlist name must be verified');
assert.doesNotMatch(source, /watchlist\/(?:add|create|new)/i, 'the mirror must not create watchlists');
assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:\.isin|\.name|bookName)/, 'logs must not expose portfolio identifiers');

console.log('Screener watchlist reconciliation and destructive-safety checks passed.');
