#!/usr/bin/env node
// scripts/build-broker-reports.mjs — the broker reports behind AI Alerts, read out of the retained
// Telegram research channel capture and resolved to NSE symbols.
//
//   node scripts/build-broker-reports.mjs [telegram-posts.json] [out.json]
//
// The Telegram archive is ~10 MB and AI Alerts is the landing tab, so the browser is never asked to
// read it for this. The runner parses every post once (public/js/data/broker-reports-shared.js),
// keeps the reports of the last BROKER_WINDOW_DAYS, and attaches each broker's previous rated report
// on the same company from the WHOLE archive — that is what lets an alert say "BUY → HOLD".
//
// Names resolve through scripts/lib/company-index.mjs, the collision-guarded index the other
// imports use, or by an exact NSE symbol ("BHEL", "M&M"). A name that fits two companies, or none,
// stays UNRESOLVED and is counted in `unresolved`: a wrong symbol would put one company's broker
// view on another's alert, which is worse than a missing one.
//
// A capture that cannot be read, or that yields no report at all while the previous file had
// some, leaves the committed file untouched.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, resolveTicker, tokenise, matchStrength } from './lib/company-index.mjs';
import { parseBrokerPost, mergeReports, BROKER_WINDOW_DAYS } from '../public/js/data/broker-reports-shared.js';
import { telegramReadHealth } from '../public/js/data/telegram-health.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = (file) => resolve(root, 'public/data', file);
const readJson = (path, fallback = undefined) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (fallback !== undefined) return fallback; throw error; }
};

const input = process.argv[2] ? resolve(process.argv[2]) : data('telegram-posts.json');
const output = process.argv[3] ? resolve(process.argv[3]) : data('broker-reports.json');
const now = Number(process.env.BROKER_NOW_MS) || Date.now();

const capture = readJson(input);
if (!Array.isArray(capture?.posts) || !capture.posts.length) throw new Error(`${input} carries no Telegram posts`);

const tech = readJson(data('technicals.json'));
const mc = readJson(data('mc-ticker-map.json'));
const book = readJson(data('portfolio-companies.json'));
// SATTVA: the exchange directory's legal names ("Bharat Heavy Electricals Ltd") for symbols the
// feeds above already carry. Moneycontrol and the technicals capture print some companies only by
// a short form ("BHEL", "B H E L"), which left a broker's full-name title unresolved. Only Active
// listings whose symbol is already a dashboard ticker are added, so no new symbol can appear.
const known = new Set([...Object.values(mc?.map || {}).map((e) => String(e?.ticker || '').toUpperCase()),
  ...(tech?.companies || []).map((c) => String(c?.ticker || '').toUpperCase())].filter(Boolean));
const directory = readJson(data('announcement-identities.json'), null);
const directoryNames = (directory?.entries || [])
  .filter((e) => e?.status === 'Active' && e.name && known.has(String(e.ticker || '').toUpperCase()))
  .map((e) => ({ name: e.name, ticker: String(e.ticker).toUpperCase(), from: 'the exchange directory' }));
const index = buildIndex({ mc, tech, book, names: directoryNames });

// Display names: the book's own, else the technicals capture's, else Moneycontrol's full name.
const names = new Map();
for (const e of Object.values(mc?.map || {})) if (e?.ticker && e.fullName) names.set(String(e.ticker).toUpperCase(), e.fullName);
for (const c of tech?.companies || []) if (c?.ticker && c.name) names.set(String(c.ticker).toUpperCase(), c.name);
for (const h of book?.holdings || []) if (h?.ticker && h.name) names.set(String(h.ticker).toUpperCase(), h.name);
const symbols = new Set(names.keys());

// A SHORTER INDEX NAME IS NOT THE SAME COMPANY WHEN THE BROKER'S NAME GOES ON TO NAME A GROUP
// COMPANY. The index accepts "Mahindra & Mahindra" for a longer query because Moneycontrol cuts
// names short — and so, with no M&M Financial in the index, "Mahindra & Mahindra Financial
// Services" resolved to M&M. A trailing word that names a distinct group business refuses it.
const GROUP_SUFFIX = new Set(['financial', 'finance', 'fin', 'services', 'hotels', 'hotel', 'realty', 'lifespace', 'holidays',
  'logistics', 'ventures', 'capital', 'securities', 'insurance', 'life', 'housing', 'amc', 'asset', 'ports', 'sez', 'energy',
  'power', 'renewables', 'green', 'infra', 'infrastructure', 'consumer', 'motors', 'steel', 'cement', 'chemicals', 'textiles',
  'telecom', 'media', 'digital', 'investments', 'credit']);
function groupCompanyGuard(named, ticker) {
  const tokens = tokenise(named);
  const best = index.entries.filter((e) => e.ticker === ticker).map((e) => ({ e, s: matchStrength(e, tokens) })).sort((a, b) => b.s - a.s)[0]?.e;
  if (!best || best.tokens.length >= tokens.length) return null;
  const extra = tokens.slice(best.tokens.length).filter((t) => GROUP_SUFFIX.has(t));
  return extra.length ? `"${named}" names more than ${ticker} (${extra.join(', ')}); left unresolved rather than guessed` : null;
}
const resolved = new Map();
function resolveName(named) {
  const key = String(named || '').trim().toLowerCase();
  if (resolved.has(key)) return resolved.get(key);
  let bare = String(named || '').replace(/\b(?:ltd|limited)\.?$/i, '').replace(/[.\s]+$/, '').trim().toUpperCase();
  if (/^(?:[A-Z&] )+[A-Z&]$/.test(bare)) bare = bare.replace(/ /g, ''); // "B P C L"
  let out = symbols.has(bare) ? { ticker: bare, reason: null } : resolveTicker(index, named);
  if (out.ticker && !symbols.has(bare)) {
    const refusal = groupCompanyGuard(named, out.ticker);
    if (refusal) out = { ticker: null, reason: refusal };
  }
  resolved.set(key, out);
  return out;
}

const all = [];
let parsedPosts = 0;
for (const post of capture.posts) {
  const reports = parseBrokerPost(post);
  if (reports.length) parsedPosts += 1;
  for (const r of reports) {
    const { ticker } = resolveName(r.named);
    all.push({ ...r, ticker: ticker || null, company: ticker ? names.get(ticker) || r.named : r.named });
  }
}
const merged = mergeReports(all);

// Each broker's previous RATED report on the same company, from the whole archive.
const byPair = new Map();
for (const r of merged) {
  if (!r.ticker) continue;
  const key = `${r.broker.toLowerCase()}|${r.ticker}`;
  if (!byPair.has(key)) byPair.set(key, []);
  byPair.get(key).push(r);
}
for (const list of byPair.values()) {
  list.sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));
  let prior = null;
  for (const r of list) {
    if (prior) r.previous = { rating: prior.rating, target: prior.target, publishedAt: prior.publishedAt, url: prior.url };
    if (r.rating) prior = r;
  }
}

// The window starts at an IST midnight, so the file's own bounds move once a day, not every run.
const istMidnight = (ms) => Date.parse(`${new Date(ms + 19800000).toISOString().slice(0, 10)}T00:00:00+05:30`);
const from = new Date(istMidnight(now) - (BROKER_WINDOW_DAYS - 1) * 864e5).toISOString();
const recent = merged.filter((r) => r.publishedAt && r.publishedAt >= from && Date.parse(r.publishedAt) <= now + 3600e3)
  .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)) || b.postId - a.postId);
const unresolved = new Map();
for (const r of recent) if (!r.ticker) unresolved.set(r.named, (unresolved.get(r.named) || 0) + 1);

const previousFile = existsSync(output) ? readJson(output, null) : null;
if (!recent.length && previousFile?.reports?.length) {
  console.log(`No broker report in the last ${BROKER_WINDOW_DAYS} days of ${input}; the previous file is kept.`);
  process.exit(0);
}

const compact = (r) => Object.fromEntries(Object.entries({
  id: `${r.postId}:${r.ticker || r.named}`.replace(/\s+/g, ' '), broker: r.broker, ticker: r.ticker, company: r.company, named: r.named,
  kind: r.kind, upsidePct: r.upsidePct, rating: r.rating, stance: r.stance, target: r.target, points: r.points, reportTitle: r.reportTitle,
  targetRevision: r.targetRevision || undefined, ratingChangeWords: r.ratingChangeWords || undefined,
  publishedAt: r.publishedAt, url: r.url, urls: r.urls.length > 1 ? r.urls : undefined,
  previous: r.previous?.rating ? r.previous : undefined,
}).filter(([, v]) => v !== undefined && v !== null));

const out = {
  schemaVersion: 1,
  source: `Telegram public channel @${capture.channel || 'researchreportss'}`,
  channel: capture.channel || 'researchreportss',
  generatedAt: new Date(now).toISOString(),
  // The capture's own check time, kept apart from when this file was built.
  captureCheckedAt: capture.lastCheckedAt || capture.capturedAt || null,
  // THE COLLECTOR'S OWN HEALTH, CARRIED THROUGH. A retained checkpoint can say the latest run
  // failed; reading this file successfully must not turn that into complete broker coverage. The
  // reports stay — they are the last good read — and the feed reports the failure beside them.
  captureHealth: (({ state, failed, partial, paused }) => ({ state, failed, partial, paused,
    lastRunStatus: capture.lastRun?.status || null, lastRunAt: capture.lastRun?.at || null,
    error: capture.lastRun?.error || capture.reason || null }))(telegramReadHealth(capture, now)),
  windowDays: BROKER_WINDOW_DAYS,
  from,
  counts: { archivedPosts: capture.posts.length, brokerPosts: parsedPosts, reports: recent.length,
    resolved: recent.filter((r) => r.ticker).length, unresolved: recent.filter((r) => !r.ticker).length },
  unresolvedNames: [...unresolved].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, count]) => ({ name, count })),
  note: 'Report titles, ratings and targets as the channel printed them. PDF contents are not read; a stance exists only where a rating word was printed, and no target is derived from an upside.',
  reports: recent.map(compact),
};

const json = `${JSON.stringify(out)}\n`;
// COMMIT WHEN THE REPORTS MOVE, AND KEEP THE CHECK TIME HONEST WITHIN AN HOUR OTHERWISE. The
// collector checks the channel every ten minutes; rewriting the file for each new check time would
// be a commit per check. An unchanged file is still rewritten once its check time is an hour old,
// so a quiet weekend never reads as a channel nobody looked at.
const strip = (f) => JSON.stringify({ ...f, generatedAt: null, captureCheckedAt: null });
const sameReports = previousFile && strip(previousFile) === strip(out);
const checkAge = previousFile?.captureCheckedAt && out.captureCheckedAt ? Date.parse(out.captureCheckedAt) - Date.parse(previousFile.captureCheckedAt) : Infinity;
if (sameReports && checkAge < 3600e3) console.log('Broker reports unchanged; the check time moved less than an hour.');
else writeFileSync(output, json);
console.log(`${out.counts.reports} broker reports in ${BROKER_WINDOW_DAYS} days (${out.counts.resolved} resolved, ${out.counts.unresolved} unresolved) from ${out.counts.brokerPosts} of ${out.counts.archivedPosts} posts · ${(json.length / 1024).toFixed(0)} KB`);
