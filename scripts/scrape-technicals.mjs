#!/usr/bin/env node
import { loadActivePortfolio } from './lib/active-portfolio.mjs';
// Technicals scraper: pulls daily OHLC for every company we cover (and the Nifty
// 500 index) from Yahoo Finance, computes the technical indicators the client's
// scoring framework needs, and writes a single public/data/technicals.json that
// the dashboard reads.
//
// Ported verbatim from the reference pipeline. Only three changes:
//   - reads public/data/universe.json (our name for the screener export)
//   - ADDS THE BOOK to that list — see below
//   - honours TECH_LIMIT to cap how many companies are fetched, so a smoke
//     test doesn't need a full run. TECH_LIMIT=0 (default) = all.
//
// WHY THE BOOK IS PART OF THE INPUT, AND NOT JUST THE SCREENER EXPORT
//   The reference pipeline scrapes an NSE-500 screener export, so for a long time
//   this file WAS the Nifty 500 and nothing else. That silently capped the whole
//   dashboard: a holding outside the index had no row here, so it had no price,
//   no score, no Breakouts line and nothing in the global search — and, worse,
//   nothing on screen said the index was the reason. Only 55 of the 123 listed
//   companies in the book are Nifty 500 constituents, so nearly half the book was
//   invisible in Portfolio scope on the one tab that scores technicals.
//
//   The universe we cover is therefore the UNION of the screener export and the
//   book. A holding is scraped because it is held, whatever index it is or is not
//   in. Book-only rows carry `listSource: 'book'` and, having no screener row
//   behind them, no market cap and no FII/DII change — those render as an em dash
//   and the institutional-activity rule scores `na`, which is the honest answer.
//   It is NOT a zero: see `ruleInstitutionalActivity` in js/scoring/tech-scoring.js.
//
// Usage:  node scripts/scrape-technicals.mjs
//         TECH_LIMIT=15 node scripts/scrape-technicals.mjs

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fetchBars, dayMove } from './lib/yahoo.mjs';
import { verifyMoves, loadChecks, saveChecks, CHECKS_PATH } from './lib/muns-market-data.mjs';
import { marketBreadth, priceDateOf } from './lib/technicals-file.mjs';
import { researchPriceHistory, retainedPriceHistory } from './lib/research-price-history.mjs';
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { abdiRanaldoSpreadPct, amihudImpactPct, liquidityTier } from "./lib/liquidity-estimators.mjs";

const IMPACT_COST_ORDER_SIZE_RUPEES = 5e7;   // ₹5 crore — standardized institutional position

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPANIES_PATH = resolve(__dirname, "../public/data/universe.json");
const BOOK_PATH = resolve(__dirname, "../public/data/portfolio-companies.json");
const ATR_HISTORY_PATH = resolve(__dirname, "../public/data/atr-history.json");

const HISTORY_DAYS = 400;          // calendar days back; ~280 trading days
const INDEX_SYMBOL = "^CRSLDX";    // Nifty 500 on Yahoo Finance
const FETCH_DELAY_MS = 200;        // be polite — ~5 req/sec
const TECH_LIMIT = Number(process.env.TECH_LIMIT || 0) || 0;   // 0 = all companies

// TECH_FILL_GAPS=1 — scrape only the companies the committed file does not already carry, and
// merge them in. Adding names to the book should not cost a 600-company re-fetch of tickers that
// were priced hours ago, and a re-fetch is not free for the upstream either.
//
// The merged rows are NOT equivalent to a full run and the payload says so: `partial_refresh`
// records what was added and when, and the NSE delivery figures on carried rows are the ones the
// scheduled run collected, untouched. A gap-fill where NSE is unreachable leaves the new rows with
// no delivery history at all — the rule scores `na`, never a zero, and the next full run fills it.
const FILL_GAPS = process.env.TECH_FILL_GAPS === "1";

// A capped smoke run writes to a sibling file and leaves the ATR accumulator alone, so
// testing on 15 companies can never truncate the committed 535-company feed.
const OUT_PATH = TECH_LIMIT > 0
  ? resolve(__dirname, "../public/data/technicals.smoke.json")
  : resolve(__dirname, "../public/data/technicals.json");

const FNO_STOCKS_PATH = resolve(__dirname, "static/fno-stocks.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rows carried over from the committed file in a gap-fill run. Empty on a full run, which is what
// makes `flush()` behave identically in both modes.
let carried = [];

function readExistingRows() {
  try {
    const prev = JSON.parse(readFileSync(OUT_PATH, "utf8"));
    return Array.isArray(prev.companies) ? prev.companies : [];
  } catch {
    console.log("No existing technicals.json to fill gaps in — this will be a full run.");
    return [];
  }
}

run().catch((err) => {
  console.error("Fatal:", err.stack || err.message);
  process.exit(1);
});

// ---------- main ----------
async function run() {
  const previousHistory = new Map(readExistingRows().filter(row => row.closeHistory).map(row => [row.ticker, row.closeHistory]));
  const screenerRows = JSON.parse(readFileSync(COMPANIES_PATH, "utf8"));
  const bookRows = await bookCompaniesNotInScreener(screenerRows);
  const allCompanies = [...screenerRows, ...bookRows];
  console.log(`Loaded ${screenerRows.length} companies from universe.json`);
  console.log(`Added ${bookRows.length} held companies that are not in it — ${allCompanies.length} in the universe`);

  let companies = allCompanies;
  if (FILL_GAPS) {
    const existing = readExistingRows();
    // A row that carries an `error` is a gap too, not a result — it is a company with no usable
    // price series, and the reason is usually transient (a Yahoo stub, a symbol that has since
    // resolved). Retrying costs one fetch each and is the whole point of a fill.
    const have = new Set(existing.filter((r) => !r.error).map((r) => String(r.ticker).toUpperCase()));
    companies = allCompanies.filter((c) => {
      const t = extractTicker(c["Screener URL"]);
      return t && !have.has(t);
    });
    // Whatever we are about to re-attempt must not ALSO be carried over, or a successful retry
    // would land beside the stale failure it replaces and the file would hold the ticker twice.
    const retrying = new Set(companies.map((c) => extractTicker(c["Screener URL"])).filter(Boolean));
    carried = existing.filter((r) => !retrying.has(String(r.ticker).toUpperCase()));
    const retries = existing.length - carried.length;
    console.log(`TECH_FILL_GAPS=1 — ${carried.length} rows kept, scraping ${companies.length} (${companies.length - retries} new, ${retries} retried).`);
    if (!companies.length) { console.log("Nothing to fill. Exiting without rewriting the file."); return; }
  }
  if (TECH_LIMIT > 0) {
    companies = companies.slice(0, TECH_LIMIT);
    console.log(`TECH_LIMIT=${TECH_LIMIT} — smoke run over the first ${companies.length} only.`);
  }

  // F&O eligible list — used by the Sentiment & Liquidity tab's F&O rule.
  let fnoSet = new Set();
  try {
    const fno = JSON.parse(readFileSync(FNO_STOCKS_PATH, "utf8"));
    fnoSet = new Set((fno.tickers || []).map((s) => String(s).toUpperCase()));
    console.log(`Loaded ${fnoSet.size} F&O-eligible tickers from static list.`);
  } catch (err) {
    console.log("F&O static list not found — F&O flag will be false for all companies.");
  }

  const end = new Date();
  const start = new Date(end.getTime() - HISTORY_DAYS * 86400000);

  // Fetch the index first — needed for relative strength and beta.
  console.log(`\nFetching ${INDEX_SYMBOL} (Nifty 500)...`);
  const indexBars = await fetchBars(INDEX_SYMBOL, start, end);
  if (!indexBars.length) throw new Error("Could not load Nifty 500 index data — aborting.");
  console.log(`  ${indexBars.length} bars`);
  const indexReturns = dailyReturns(indexBars);
  const indexClose = indexBars.map((b) => b.close);

  // NSE bhavcopy delivery % trends. Best-effort: if NSE blocks our IP we
  // get an empty map and the rule falls back to N/A per company.
  console.log(`\nFetching NSE bhavcopy for delivery % (last ~30 trading days)...`);
  const deliveryTrends = await buildDeliveryTrends();
  console.log(`  Got delivery trends for ${Object.keys(deliveryTrends).length} tickers`);

  // NB: previously called Yahoo v7 /finance/quote here for bid/ask. Two
  // production runs confirmed Yahoo doesn't carry NSE Level-1 quote
  // data (0/506 coverage on both chart-meta and v7 endpoints). Bid-Ask
  // Spread is now marked deferred in sentiment-liquidity-scoring.js
  // until you wire in a paid market-data feed.
  const spreadByTicker = {};

  const results = [];
  let failures = 0;
  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    const ticker = extractTicker(c["Screener URL"]);
    if (!ticker) { failures++; continue; }
    // Numeric tickers (e.g. "504346") are BSE codes for stocks without
    // an NSE listing — go straight to .BO and skip the doomed .NS call.
    const tickerIsNumeric = /^\d+$/.test(ticker);
    const primarySym = tickerIsNumeric ? `${ticker}.BO` : `${ticker}.NS`;
    process.stdout.write(`[${i + 1}/${companies.length}] ${c.Company.padEnd(28).slice(0, 28)} ${primarySym.padEnd(16)} `);
    try {
      let bars = await fetchBars(primarySym, start, end);
      let usedSym = primarySym;
      // Yahoo sometimes returns a stub (1-2 bars) for live NSE tickers
      // whose history was migrated under a different symbol — fall back
      // to the BSE .BO ticker before giving up. Costs one extra HTTP
      // call only for the handful of NSE failures per run.
      //
      // The second fallback is the SME platform. NSE suffixes SME symbols with "-SM"
      // (ALPEXSOLAR-SM, SAHANA-SM) and Yahoo does not: it carries them under the bare symbol.
      // Left alone that returns a one-bar stub, which reads exactly like a delisting — the ticker
      // is right, the exchange is right, and the company simply appears to have no history. Both
      // of these have 270 bars under the bare symbol.
      if (!tickerIsNumeric && bars.length < 60) {
        const alts = [`${ticker}.BO`];
        if (/-SM$/.test(ticker)) alts.unshift(`${ticker.replace(/-SM$/, "")}.NS`, `${ticker.replace(/-SM$/, "")}.BO`);
        for (const altSym of alts) {
          const alt = await fetchBars(altSym, start, end).catch(() => []);
          if (alt.length > bars.length) {
            process.stdout.write(`(fallback ${altSym}) `);
            bars = alt;
            usedSym = altSym;
          }
          if (bars.length >= 60) break;
        }
      }
      if (bars.length < 60) throw new Error(`only ${bars.length} bars`);
      const indicators = computeIndicators(bars, indexBars, indexReturns, indexClose);
      const delivery = deliveryTrends[ticker] || null;
      results.push({
        ticker, name: c.Company, screenerUrl: c["Screener URL"],
        // 'nse500' from the screener export, 'book' from the holdings statement. A book row has no
        // market cap and no FII/DII change, and this is what lets the UI say so.
        listSource: c.listSource || "nse500",
        marketCap: c["Market Cap"] || null,
        sector: c["Sector"] || null,
        broadSector: c["Broad Sector"] || null,
        industry: c["Broad Industry"] || c["Industry"] || null,
        // Pass through FII/DII change from the fundamentals scrape. The
        // Technicals "Institutional Activity" rule reuses this signal.
        chg_fii_hold: parsePercentValue(c["Chg in FII Hold"]),
        chg_dii_hold: parsePercentValue(c["Chg in DII Hold"]),
        // Delivery % trend (last 30 trading days, recent half vs older half)
        delivery_avg_recent: delivery?.avg_recent ?? null,
        delivery_avg_older: delivery?.avg_older ?? null,
        delivery_trend_diff: delivery?.diff ?? null,
        delivery_days_count: delivery?.days_count ?? 0,
        // Sentiment & Liquidity tab data: 20-day ADTV in ₹ crores + F&O eligibility
        adtv_20d_cr: adtv20Cr(bars),
        fno_eligible: fnoSet.has(ticker),
        // Bid-Ask spread: prefer the batched v7 quote result (Yahoo has no
        // NSE Level-1 in practice — confirmed 0/506 — but we keep the
        // path open in case that changes). Fall back to the
        // Abdi-Ranaldo daily-OHLCV ESTIMATE so the rule always scores.
        bid_ask_spread_pct: spreadByTicker[ticker] ?? spreadFromMeta(bars.meta),
        bid_ask_spread_pct_est: abdiRanaldoSpreadPct(bars, 30),
        // Impact cost (% price move expected on a ₹5 crore order),
        // estimated from the Amihud illiquidity ratio over the last 30
        // trading days. ₹5 cr is the standardized institutional-position
        // size where the client's three-band scoring actually
        // discriminates across Nifty 500 (₹1 cr was too small — 98% pass).
        // NSE's official monthly Impact Cost CSV was discontinued
        // July 2024 (circular 62424).
        impact_cost_pct_est_5cr: amihudImpactPct(bars, 30, IMPACT_COST_ORDER_SIZE_RUPEES),
        liquidity_tier: liquidityTier(adtv20Cr(bars)),
        ...indicators,
        closeHistory: researchPriceHistory(bars, { sourceSymbol: usedSym }) || retainedPriceHistory(previousHistory.get(ticker)),
      });
      console.log(`OK  RSI ${indicators.rsi14}  MACD ${indicators.macd.line.toFixed(1)}  ADX ${indicators.adx14}`);
    } catch (err) {
      failures++;
      results.push({ ticker, name: c.Company, screenerUrl: c["Screener URL"], listSource: c.listSource || "nse500", error: err.message,
        closeHistory: retainedPriceHistory(previousHistory.get(ticker)) });
      console.log(`FAIL ${err.message}`);
    }
    await sleep(FETCH_DELAY_MS);
    if ((i + 1) % 25 === 0) flush(results, indexBars, failures);   // checkpoint
  }

  // Every move that reaches the check threshold is re-derived from the Muns market-data
  // endpoint's own closes before the file is written. MUNS_VERIFY=0 skips it; MUNS_TOKEN is sent
  // when present. A refusal or a missing day leaves Yahoo's figure and says it was not checked.
  if (process.env.MUNS_VERIFY !== "0") {
    console.log("\nVerifying flagged day moves against the Muns market-data endpoint...");
    // Every answer is remembered in the checks file, so a re-run — or the follow-up verifier that
    // keeps asking through the day — never spends the endpoint's quota on a name already answered.
    const checks = loadChecks(CHECKS_PATH);
    moveVerification = await verifyMoves(results, { checks, log: (line) => console.log(line), budgetMs: Number(process.env.MUNS_VERIFY_BUDGET_MS) || undefined });
    saveChecks(CHECKS_PATH, checks);
    console.log(`  flagged ${moveVerification.flagged} · from cache ${moveVerification.cached} · confirmed ${moveVerification.confirmed} · corrected ${moveVerification.corrected} · unavailable ${moveVerification.unavailable} · refusals ${moveVerification.refusals} in ${Math.round(moveVerification.elapsed_ms / 1000)}s`);
  } else {
    moveVerification = { skipped: true, reason: "MUNS_VERIFY=0" };
  }
  flush(results, indexBars, failures);

  // ATR Stability accumulator: append today's atr14_pct per ticker to a
  // rolling 30-day history. Used by the Sentiment & Liquidity ATR rule
  // to detect declining-vs-rising volatility trend (client framework).
  updateATRHistory(results);

  console.log(`\n=== Done ===`);
  console.log(`Companies: ${results.length - failures} OK, ${failures} failed`);
  console.log(`Delivery % coverage: ${Object.keys(deliveryTrends).length} tickers`);
  console.log(`Wrote: ${OUT_PATH}`);
}

function updateATRHistory(results) {
  if (TECH_LIMIT > 0) {
    console.log("TECH_LIMIT set — skipping ATR history update (a partial run would poison the accumulator).");
    return;
  }
  let history = {};
  try {
    history = JSON.parse(readFileSync(ATR_HISTORY_PATH, "utf8"));
    if (typeof history !== "object" || Array.isArray(history)) history = {};
  } catch { /* file doesn't exist yet — start fresh */ }
  const today = new Date().toISOString().slice(0, 10);
  for (const r of results) {
    if (r.error || r.atr14_pct == null || !r.ticker) continue;
    if (!history[r.ticker]) history[r.ticker] = [];
    // Dedupe by date — replace today's entry if it exists
    history[r.ticker] = history[r.ticker].filter((e) => e.date !== today);
    history[r.ticker].push({ date: today, atr_pct: r.atr14_pct });
    // Trim to last 30 days
    history[r.ticker].sort((a, b) => a.date.localeCompare(b.date));
    if (history[r.ticker].length > 30) history[r.ticker] = history[r.ticker].slice(-30);
  }
  writeFileSync(ATR_HISTORY_PATH, JSON.stringify(history) + "\n");
  console.log(`ATR history updated: ${Object.keys(history).length} tickers tracked, latest snapshot for today`);
}

function parsePercentValue(v) {
  // "Chg in FII Hold" comes from Screener as e.g. "-0.25 %" or "0.65 %"
  if (v == null) return null;
  const s = String(v).replace(/%/g, "").replace(/,/g, "").trim();
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

let moveVerification = null;

function flush(scraped, indexBars, failures) {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  // On a full run `carried` is empty and this is just `scraped`. On a gap-fill it is every row the
  // committed file already had, kept byte-for-byte — including the NSE delivery figures, which the
  // gap-fill has no way to re-collect for them and must not blank.
  const results = carried.length ? [...carried, ...scraped] : scraped;
  // Market-wide advances vs declines across the Nifty 500 universe, from the one shared rule
  // (lib/technicals-file.mjs) — the follow-up verifier recomputes it after correcting a move.
  const breadth = marketBreadth(results);
  const payload = {
    generated_at: new Date().toISOString(),
    source: "Yahoo Finance",
    // THE DATE THE CLOSES ARE FOR. `generated_at` is when the file was written; on a 07:00 IST
    // run that is the morning AFTER these closes, and a reader — or the alerts page — dating a
    // move by the capture stamps one day's session with the next day's label. The modal
    // `bar_date` across priced rows; `price_date_rows` says how many rows share it.
    price_date: priceDateOf(results),
    price_date_rows: results.filter((r) => r.bar_date === priceDateOf(results)).length,
    // What the Muns market-data endpoint said about every move that reached the check
    // threshold — see scripts/lib/muns-market-data.mjs. Null when the check did not run.
    move_verification: moveVerification,
    index_symbol: INDEX_SYMBOL,
    index_close: indexBars.at(-1)?.close ?? null,
    index_6m_return: indexBars.length >= 126
      ? (indexBars.at(-1).close / indexBars.at(-126).close) - 1
      : null,
    market_breadth: breadth,
    company_count: results.length,
    // How the coverage splits, so the UI never has to say "NSE 500" over a list that is more
    // than that. `book_count` is the holdings the index does not carry.
    nse500_count: results.filter((r) => r.listSource !== "book").length,
    book_count: results.filter((r) => r.listSource === "book").length,
    // Present only on a gap-fill, and the reason it is present is that `generated_at` above would
    // otherwise claim every row was priced at that moment. Most were not: they are the scheduled
    // run's rows, carried over. Say which, rather than let one timestamp stand for two runs.
    partial_refresh: carried.length ? {
      at: new Date().toISOString(),
      added: scraped.length,
      carried_over: carried.length,
      note: "Gap-fill run: only the companies missing from the previous file were fetched. Every other row — including its NSE delivery %, which a gap-fill cannot recollect — is the previous scheduled run's, unchanged.",
    } : null,
    failures,
    companies: results,
  };
  writeFileSync(OUT_PATH, JSON.stringify(payload) + "\n");
}

function extractTicker(url) {
  // /company/ICICIAMC/ or /company/ICICIAMC/consolidated/ → ICICIAMC
  const m = String(url || "").match(/\/company\/([^/]+)/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The held companies the screener export does not carry, shaped like screener rows so the scrape
 * loop below needs no special case.
 *
 * The export is the Nifty 500. The book is 142 companies chosen for other reasons entirely, and
 * only 55 of its 123 listed lines are index constituents — so reading the export alone left 68
 * holdings with no price series at all. They are held; that is the only qualification the scrape
 * needs.
 *
 * What a synthesised row CANNOT carry is anything that only exists in the screener export: market
 * cap, and the FII/DII holding changes. Those stay null rather than zero, and `listSource: 'book'`
 * travels with the row so the dashboard can say why the columns are empty instead of leaving the
 * reader to guess whether it means "no institutional buying" or "we never had the figure".
 */
async function bookCompaniesNotInScreener(screenerRows) {
  let book;
  try {
    book = await loadActivePortfolio(BOOK_PATH);
  } catch (error) {
    if (process.env.FAMILY_HOLDINGS_LIVE === 'true') throw error;
    console.log("portfolio-companies.json not found — scraping the screener export only.");
    return [];
  }
  const covered = new Set(screenerRows.map((r) => extractTicker(r["Screener URL"])).filter(Boolean));
  const seen = new Set();
  const rows = [];
  for (const h of book.holdings || []) {
    if (!h.ticker) continue;                       // unlisted, warrants, BSE-only — no NSE series to fetch
    const t = String(h.ticker).toUpperCase();
    if (covered.has(t) || seen.has(t)) continue;
    seen.add(t);
    rows.push({
      Company: h.name,
      "Screener URL": `https://www.screener.in/company/${t}/`,
      "Market Cap": null,
      "Broad Sector": h.sector || null,
      Sector: h.sector || null,
      "Broad Industry": null,
      Industry: null,
      "Chg in FII Hold": null,
      "Chg in DII Hold": null,
      listSource: "book",
    });
  }
  return rows;
}

// Bid-Ask spread helper. Kept around so the rule auto-recovers if
// Yahoo ever starts populating bid/ask for NSE tickers in chart-meta.
function spreadFromMeta(meta) {
  if (!meta) return null;
  const bid = Number(meta.bid);
  const ask = Number(meta.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid <= 0 || ask <= 0 || ask <= bid) return null;
  const mid = (bid + ask) / 2;
  const pct = ((ask - bid) / mid) * 100;
  return Math.round(pct * 1000) / 1000; // 3 decimal places
}

// ---------- indicators ----------
function computeIndicators(bars, indexBars, indexReturns, indexClose) {
  const close = bars.map((b) => b.close);
  const high  = bars.map((b) => b.high);
  const low   = bars.map((b) => b.low);
  const vol   = bars.map((b) => b.volume);
  const n = bars.length;
  const cmp = close.at(-1);

  const ema50 = ema(close, 50).at(-1);
  const sma50 = sma(close, 50).at(-1);
  const sma200 = n >= 200 ? sma(close, 200).at(-1) : null;
  const rsi14 = rsi(close, 14).at(-1);
  const macdSeries = macd(close, 12, 26, 9);
  const macdLine = macdSeries.line.at(-1);
  const macdSig = macdSeries.signal.at(-1);
  const macdLinePrev = macdSeries.line.at(-2);
  const macdSigPrev = macdSeries.signal.at(-2);
  const positiveCrossover = macdLinePrev <= macdSigPrev && macdLine > macdSig;
  const adx14 = adx(high, low, close, 14).at(-1);
  const atr14 = atr(high, low, close, 14).at(-1);
  const atrPct = (atr14 / cmp) * 100;

  // 52w high/low — use last 250 trading days
  const window52 = close.slice(-250);
  const high52 = Math.max(...window52);
  const low52 = Math.min(...window52);
  const highProximityPct = cmp / high52;          // 0.93 = 7% below 52W high

  // 20-day avg volume vs latest
  const avg20Vol = avg(vol.slice(-21, -1));        // prior 20 days, excluding today
  const volRatio = avg20Vol > 0 ? vol.at(-1) / avg20Vol : null;

  // 6M return + Relative Strength
  const sixMReturn = n >= 126 ? close.at(-1) / close.at(-126) - 1 : null;
  const indexSixM = indexClose.length >= 126 ? indexClose.at(-1) / indexClose.at(-126) - 1 : null;
  const relStrength6m = (sixMReturn != null && indexSixM != null) ? sixMReturn - indexSixM : null;

  // Beta — last ~252 trading-day pairs aligned by date with the index.
  // computeBeta does the date-matching internally; passing raw bars
  // instead of pre-computed returns so it can intersect calendar dates
  // (the previous slice(-252) approach silently misaligned dates when
  // stock and index histories were different lengths).
  const beta = computeBeta(bars, indexBars);

  // The day move — between the last two COMPLETED bars, and dated by both of them. `fetchBars`
  // has already dropped a session still in progress (see lib/yahoo.mjs), and `dayMove` refuses
  // a gap wider than a long weekend, so this can no longer be a mid-morning print against a
  // close from two sessions back. Feeds the Advances/Declines breadth and the ±5% price alert.
  const move = dayMove(bars);

  return {
    cmp,
    // The date of the close `cmp` IS, and the date of the close it is compared with. A close
    // without its date was how a 2 September file came to print 1 September's session under
    // 2 September's label.
    bar_date: move.date,
    prev_bar_date: move.prevDate,
    bar_gap_days: move.gapDays,
    pct_change_today: move.pct == null ? null : round(move.pct, 2),
    ema50: round(ema50),
    sma50: round(sma50),
    sma200: sma200 == null ? null : round(sma200),
    above_50ema: cmp > ema50,
    above_200dma: sma200 != null ? cmp > sma200 : null,
    golden_cross: (sma50 != null && sma200 != null) ? sma50 > sma200 : null,
    death_cross:  (sma50 != null && sma200 != null) ? sma50 < sma200 : null,
    rsi14: round(rsi14, 1),
    macd: {
      line: round(macdLine, 2),
      signal: round(macdSig, 2),
      above_zero: macdLine > 0,
      positive_crossover: positiveCrossover,
    },
    adx14: round(adx14, 1),
    atr14_pct: round(atrPct, 2),
    high_52w: round(high52),
    low_52w: round(low52),
    high_proximity_pct: round(highProximityPct, 4),   // 0.93 = within 7%
    avg_volume_20d: Math.round(avg20Vol),
    volume_ratio_today: volRatio == null ? null : round(volRatio, 2),
    return_6m: sixMReturn == null ? null : round(sixMReturn, 4),
    return_6m_index: indexSixM == null ? null : round(indexSixM, 4),
    relative_strength_6m: relStrength6m == null ? null : round(relStrength6m, 4),
    beta_1y: beta == null ? null : round(beta, 2),
    bars_count: n,
    // ----- Batch B: pattern detection -----
    higher_highs_lows: detectHHHL(high, low, close),
    consolidation_breakout: detectConsolidationBreakout(high, low, close, vol),
    base_formation: detectBaseFormation(close),
  };
}

function round(n, d = 0) {
  if (n == null || !Number.isFinite(n)) return null;
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev;
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1) continue;
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += arr[j];
      prev = s / n;
    } else {
      prev = arr[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function rsi(close, n) {
  const out = new Array(close.length).fill(null);
  if (close.length < n + 1) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i] - close[i - 1];
    if (d >= 0) gainSum += d; else lossSum -= d;
  }
  let avgG = gainSum / n, avgL = lossSum / n;
  out[n] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (n - 1) + g) / n;
    avgL = (avgL * (n - 1) + l) / n;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function macd(close, fast = 12, slow = 26, signalLen = 9) {
  const emaF = ema(close, fast);
  const emaS = ema(close, slow);
  const line = close.map((_, i) => (emaF[i] != null && emaS[i] != null) ? emaF[i] - emaS[i] : null);
  const lineDefined = line.filter((x) => x != null);
  const signalRaw = ema(lineDefined, signalLen);
  const offset = line.findIndex((x) => x != null);
  const signal = new Array(line.length).fill(null);
  for (let i = 0; i < signalRaw.length; i++) signal[i + offset] = signalRaw[i];
  return { line, signal };
}

function trueRange(high, low, close) {
  const out = new Array(high.length).fill(null);
  out[0] = high[0] - low[0];
  for (let i = 1; i < high.length; i++) {
    out[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1]),
    );
  }
  return out;
}

function wilderSmooth(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  out[n - 1] = sum / n;                     // simple seed
  for (let i = n; i < arr.length; i++) {
    out[i] = (out[i - 1] * (n - 1) + arr[i]) / n;
  }
  return out;
}

function atr(high, low, close, n) {
  return wilderSmooth(trueRange(high, low, close), n);
}

function adx(high, low, close, n) {
  const len = high.length;
  const tr = trueRange(high, low, close);
  const plusDM = new Array(len).fill(0), minusDM = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = high[i] - high[i - 1];
    const dn = low[i - 1] - low[i];
    plusDM[i]  = (up > dn && up > 0) ? up : 0;
    minusDM[i] = (dn > up && dn > 0) ? dn : 0;
  }
  const atrSmoothed   = wilderSmooth(tr, n);
  const plusDMSmooth  = wilderSmooth(plusDM, n);
  const minusDMSmooth = wilderSmooth(minusDM, n);
  const plusDI = atrSmoothed.map((a, i) => (a && a > 0) ? 100 * plusDMSmooth[i] / a : null);
  const minusDI = atrSmoothed.map((a, i) => (a && a > 0) ? 100 * minusDMSmooth[i] / a : null);
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p == null || m == null || (p + m) === 0) return null;
    return 100 * Math.abs(p - m) / (p + m);
  });
  // ADX = Wilder smoothing of DX, but skip leading nulls.
  const dxClean = dx.map((v) => v == null ? 0 : v);
  const adxRaw = wilderSmooth(dxClean, n);
  // Mask out positions before the first valid DX.
  const firstDX = dx.findIndex((v) => v != null);
  return adxRaw.map((v, i) => i >= firstDX + n - 1 ? v : null);
}

function dailyReturns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) out.push(bars[i].close / bars[i - 1].close - 1);
  return out;
}

// ---------- Pattern detection (Batch B) ----------

function detectHHHL(high, low, close, daysPerWeek = 5, weeksPerWindow = 13) {
  // Per client framework: HH-HL visible on the WEEKLY chart over 6+ months.
  // Aggregate daily bars into weekly bars (max high, min low per 5-day group),
  // then compare the recent 13-week window vs the prior 13-week window. The
  // pattern is "present" if both the recent max-high > prior max-high AND
  // recent min-low > prior min-low.
  const totalDailyNeeded = daysPerWeek * weeksPerWindow * 2;
  if (close.length < totalDailyNeeded) return null;
  // Build weekly bars from the end backward
  const weeklyHighs = [];
  const weeklyLows = [];
  for (let end = high.length; end >= daysPerWeek; end -= daysPerWeek) {
    weeklyHighs.unshift(Math.max(...high.slice(end - daysPerWeek, end)));
    weeklyLows.unshift(Math.min(...low.slice(end - daysPerWeek, end)));
    if (weeklyHighs.length >= weeksPerWindow * 2) break;
  }
  if (weeklyHighs.length < weeksPerWindow * 2) return null;
  const recHi = weeklyHighs.slice(-weeksPerWindow);
  const prevHi = weeklyHighs.slice(-weeksPerWindow * 2, -weeksPerWindow);
  const recLo = weeklyLows.slice(-weeksPerWindow);
  const prevLo = weeklyLows.slice(-weeksPerWindow * 2, -weeksPerWindow);
  const recentHigh = Math.max(...recHi);
  const recentLow  = Math.min(...recLo);
  const priorHigh  = Math.max(...prevHi);
  const priorLow   = Math.min(...prevLo);
  const higherHigh = recentHigh > priorHigh;
  const higherLow  = recentLow > priorLow;
  return {
    higher_high: higherHigh,
    higher_low: higherLow,
    pattern_present: higherHigh && higherLow,
    recent_high: round(recentHigh),
    recent_low: round(recentLow),
    prior_high: round(priorHigh),
    prior_low: round(priorLow),
    timeframe: "weekly",
    window_weeks: weeksPerWindow,
  };
}

function detectConsolidationBreakout(high, low, close, volume, baseDays = 30) {
  // Look at the last `baseDays + 1` bars. The base is the prior `baseDays`
  // bars (excluding today). Tight base = base range < 12% of avg price.
  // Breakout = today's close > prior base high, today's volume > 1.5×
  // base average. Volume confirmation upgrades the score.
  if (close.length < baseDays + 1) return null;
  const baseHi = high.slice(-baseDays - 1, -1);
  const baseLo = low.slice(-baseDays - 1, -1);
  const baseClose = close.slice(-baseDays - 1, -1);
  const baseVol = volume.slice(-baseDays - 1, -1);
  const baseMax = Math.max(...baseHi);
  const baseMin = Math.min(...baseLo);
  const baseAvg = baseClose.reduce((a, b) => a + b, 0) / baseClose.length;
  const baseAvgVol = baseVol.reduce((a, b) => a + b, 0) / baseVol.length;
  const rangePct = ((baseMax - baseMin) / baseAvg) * 100;
  const todayClose = close.at(-1);
  const todayVol = volume.at(-1);
  const tightBase = rangePct < 12;
  const breaksOut = todayClose > baseMax;
  const volumeConfirm = baseAvgVol > 0 && todayVol > 1.5 * baseAvgVol;
  return {
    base_range_pct: round(rangePct, 1),
    tight_base: tightBase,
    breaks_out: breaksOut,
    volume_confirm: volumeConfirm,
    today_close: round(todayClose),
    base_max: round(baseMax),
    today_volume_ratio: baseAvgVol > 0 ? round(todayVol / baseAvgVol, 2) : null,
    quality: tightBase && breaksOut && volumeConfirm ? "strong"
           : breaksOut && volumeConfirm ? "weak_base"
           : breaksOut ? "low_volume"
           : "no_breakout",
  };
}

function detectBaseFormation(close, baseDays = 60) {
  // Healthy base = drawdown < 15% over ~12 weeks AND tight closing range
  // (standard deviation of closes < 4% of mean).
  if (close.length < baseDays) return null;
  const window = close.slice(-baseDays);
  const max = Math.max(...window);
  const min = Math.min(...window);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((s, x) => s + (x - mean) ** 2, 0) / window.length;
  const sd = Math.sqrt(variance);
  const drawdownPct = ((max - min) / max) * 100;
  const tightnessPct = (sd / mean) * 100;
  const healthy = drawdownPct < 15 && tightnessPct < 4;
  return {
    drawdown_pct: round(drawdownPct, 1),
    tightness_pct: round(tightnessPct, 1),
    healthy_base: healthy,
  };
}

function adtv20Cr(bars) {
  // Average Daily Traded Value over the last 20 trading bars, expressed in
  // rupees-crore. Each bar contributes (close × volume) ÷ 1e7.
  const last20 = bars.slice(-20);
  if (last20.length < 5) return null;
  const totalRupees = last20.reduce((sum, b) => sum + b.close * b.volume, 0);
  const avgRupees = totalRupees / last20.length;
  return Math.round((avgRupees / 1e7) * 100) / 100;
}

function computeBeta(stockBars, indexBars) {
  // Properly align by DATE before computing returns — the previous
  // implementation took `slice(-252)` of each return array, which paired
  // up DIFFERENT calendar dates whenever the stock and index histories
  // had different lengths (e.g. recent IPOs like INOX India have ~270
  // bars vs Nifty 500's longer history). That misalignment produced
  // near-random correlation, dragging beta toward 0 across the universe
  // (median was 0.03, 41% of stocks negative — clearly wrong).
  if (!stockBars?.length || !indexBars?.length) return null;
  const indexByDate = new Map();
  for (const b of indexBars) indexByDate.set(b.date, b.close);
  // Walk the stock bars in order, building parallel close arrays only
  // for dates present in BOTH series. dailyReturns() then operates on
  // truly aligned data.
  const sClose = [];
  const iClose = [];
  for (const b of stockBars) {
    const ic = indexByDate.get(b.date);
    if (ic == null) continue;
    sClose.push(b.close);
    iClose.push(ic);
  }
  if (sClose.length < 60) return null;
  // Build aligned daily-return series from the matched closes.
  const sR = []; const iR = [];
  for (let i = 1; i < sClose.length; i++) {
    sR.push(sClose[i] / sClose[i - 1] - 1);
    iR.push(iClose[i] / iClose[i - 1] - 1);
  }
  // Cap to last 252 trading-day pairs (≈ 1 year) — consistent with the
  // "Beta — last ~252 daily returns" comment in computeIndicators().
  const m = Math.min(sR.length, 252);
  const sTail = sR.slice(-m);
  const iTail = iR.slice(-m);
  const sMean = avg(sTail);
  const iMean = avg(iTail);
  let cov = 0, varI = 0;
  for (let i = 0; i < m; i++) {
    cov  += (sTail[i] - sMean) * (iTail[i] - iMean);
    varI += (iTail[i] - iMean) ** 2;
  }
  if (varI === 0) return null;
  return cov / varI;
}

// ---------- NSE delivery % (sec_bhavdata_full) ----------

const NSE_HEADERS = {
  // NSE rejects requests without a believable browser identity.
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/csv, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/all-reports",
};

function ddmmyyyy(date) {
  const d = String(date.getUTCDate()).padStart(2, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${d}${m}${date.getUTCFullYear()}`;
}

async function fetchBhavDelivery(date) {
  // NSE moved this file around a few times; try the current then the legacy URL.
  const stamp = ddmmyyyy(date);
  const urls = [
    `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${stamp}.csv`,
    `https://archives.nseindia.com/products/content/sec_bhavdata_full_${stamp}.csv`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: NSE_HEADERS });
      if (r.status !== 200) continue;
      const text = await r.text();
      if (text.length < 500 || !/SYMBOL/i.test(text)) continue;
      return text;
    } catch { /* try next URL */ }
  }
  return null;
}

function parseDeliveryCSV(csv) {
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) return null;
  const headers = lines[0].split(",").map((h) => h.trim().toUpperCase());
  const symIdx = headers.indexOf("SYMBOL");
  const serIdx = headers.indexOf("SERIES");
  const dpIdx = headers.indexOf("DELIV_PER");
  if (symIdx < 0 || serIdx < 0 || dpIdx < 0) return null;
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length <= dpIdx) continue;
    if (cells[serIdx].trim() !== "EQ") continue;
    const sym = cells[symIdx].trim().toUpperCase();
    const dp = parseFloat(cells[dpIdx]);
    if (sym && Number.isFinite(dp)) out[sym] = dp;
  }
  return out;
}

async function buildDeliveryTrends() {
  const perTicker = {};                     // ticker → array of delivery %, newest first
  const today = new Date();
  let fetched = 0, attempted = 0;
  for (let daysBack = 1; daysBack <= 50 && fetched < 30; daysBack++) {
    const date = new Date(today.getTime() - daysBack * 86400000);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;       // skip weekends
    attempted++;
    const csv = await fetchBhavDelivery(date);
    if (!csv) {
      process.stdout.write(`  ${ddmmyyyy(date)} no file\n`);
      await sleep(150);
      continue;
    }
    const data = parseDeliveryCSV(csv);
    if (!data) {
      process.stdout.write(`  ${ddmmyyyy(date)} parse fail\n`);
      continue;
    }
    let count = 0;
    for (const [sym, dp] of Object.entries(data)) {
      (perTicker[sym] ||= []).push(dp);
      count++;
    }
    fetched++;
    process.stdout.write(`  ${ddmmyyyy(date)} ok (${count} symbols)\n`);
    await sleep(250);
  }
  console.log(`  Fetched ${fetched} bhavcopy files out of ${attempted} attempts.`);
  if (fetched === 0) return {};

  const result = {};
  for (const [sym, vals] of Object.entries(perTicker)) {
    if (vals.length < 6) continue;             // need at least a few days
    const half = Math.floor(vals.length / 2);
    const recent = vals.slice(0, half);
    const older  = vals.slice(half);
    const avgR = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgO = older.reduce((a, b) => a + b, 0) / older.length;
    result[sym] = {
      avg_recent: Math.round(avgR * 100) / 100,
      avg_older:  Math.round(avgO * 100) / 100,
      diff:       Math.round((avgR - avgO) * 100) / 100,
      days_count: vals.length,
    };
  }
  return result;
}
