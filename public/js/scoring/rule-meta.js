// scoring/rule-meta.js — per-rule provenance for the drill-down cards.
//
// Structure: META[tabId][ruleKey] = {
//   source:      (company) => { url, label, section }   // mandatory
//   calculation: string | null                          // null = no calc, just fetched
//   clientLogic: string                                 // verbatim from the client's sheet
//   ourLogic:    string | null                          // null = same as client
// }
//
// `ourLogic` being non-null is what turns the Implementation chip amber in the drill
// panel — it means our computation deviates from the client's stated logic. Leave it null
// when we implement the rule exactly as written; never use it for restating the rule.
//
// One entry per scoring model, keyed by tab id. `technicals` is ported verbatim from the
// reference dashboard; `earnings` is this project's own. Any drill panel reads its slice as
// META[tabId], so adding a third model means adding a third key and nothing else.

// ---------- source helpers ----------

const SCREENER = (c) => ({
  url: c?.screenerUrl || c?.['Screener URL'] || 'https://www.screener.in/',
  label: 'Screener.in',
  section: 'Company page · Top Ratios',
});
const SCREENER_SHAREHOLD = (c) => ({ ...SCREENER(c), section: 'Company page · Shareholding Pattern' });

// For rules whose final value is COMPUTED in our pipeline (not pulled from a public
// page), still point at the OHLCV source so the inputs can be sanity-checked — but
// label it so the computed nature is obvious.
const COMPUTED_FROM_YAHOO = (c) => {
  const ticker = c?.ticker || String(c?.screenerUrl || '').match(/\/company\/([^/]+)/)?.[1] || '';
  return {
    url: ticker ? `https://finance.yahoo.com/quote/${ticker}.NS/history` : 'https://finance.yahoo.com',
    label: 'Calculated (from Yahoo OHLCV)',
    section: 'Daily closes — see input source on Yahoo Finance',
  };
};

// TradingView is the source of truth for an indicator WHEN technicals-source.json
// carries a scraped value for it (the data layer sets row._source_tech_fields).
// Without one, the rule falls back to the Yahoo-computed path so the Source button
// always reflects where the value actually came from.
const TRADINGVIEW = (c) => {
  const ticker = c?.ticker || '';
  return {
    url: ticker ? `https://in.tradingview.com/symbols/NSE-${ticker}/technicals/` : 'https://in.tradingview.com',
    label: 'TradingView · Technical Analysis',
    section: 'Live indicator value read from /technicals/ page',
  };
};

// Factory: picks TradingView when the named field was externally sourced for this
// company, else the Yahoo-calc path.
const techSource = (fieldName) => (c) => (c?._source_tech_fields?.has(fieldName) ? TRADINGVIEW(c) : COMPUTED_FROM_YAHOO(c));

const NSE_BHAVCOPY = () => ({ url: 'https://www.nseindia.com/all-reports', label: 'NSE archives', section: 'sec_bhavdata_full daily CSV' });

// Screener's Quarters table is where a reader checks a reported quarterly number fastest.
const SCREENER_QUARTERS = (c) => ({ ...SCREENER(c), section: 'Company page · Quarterly Results' });

// The filing itself is the authoritative source for lines Screener's summary table omits —
// other income, exceptional items, the tax line.
const EXCHANGE_FILING = (c) => ({
  url: c?.screenerUrl || 'https://www.bseindia.com/corporates/Comp_Resultsnew.aspx',
  label: 'Exchange filing (quarterly result)',
  section: 'Standalone / consolidated statement of profit and loss',
});

// Street estimates come from a consensus provider rather than the company.
const CONSENSUS = (c) => ({
  url: c?.screenerUrl || 'https://www.screener.in/',
  label: 'Street consensus',
  section: 'Analyst EPS and revenue estimates for the quarter',
});

// ---------- the rule maps, one per scoring model ----------

export const META = {
  // ---------- technicals ----------
  technicals: {

    ema50: {
      source: techSource("ema50"),
      calculation: "Standard 50-day EMA. When we have a TradingView scrape for this ticker, the value is read directly from the moving-averages table. Otherwise we compute it locally from Yahoo daily closes (EMA today = price × (2/51) + EMA yesterday × (49/51), seeded with first 50-day SMA). PASS if today's close > 50 EMA.",
      clientLogic: "PASS if CMP > 50 EMA on daily timeframe; 2 pts. Below 50 EMA = 0 pts. Confirms short-to-medium term uptrend.",
      ourLogic: null,
    },
    dma200: {
      source: techSource("sma200"),
      calculation: "200-day SMA. When we have a TradingView scrape for this ticker, the value is read directly from the moving-averages table. Otherwise computed locally as the simple average of the last 200 Yahoo daily closes. PASS if today's close > 200 DMA. Returns N/A for companies with < 200 trading days of history.",
      clientLogic: "PASS if CMP > 200 DMA on daily timeframe; 2 pts. Fail = stock exits pipeline (primary trend filter).",
      ourLogic: null,
    },
    gold: {
      source: (c) => (c?._source_tech_fields?.has("sma50") || c?._source_tech_fields?.has("sma200")) ? TRADINGVIEW(c) : COMPUTED_FROM_YAHOO(c),
      calculation: "50-day SMA and 200-day SMA — read from TradingView when scraped, computed locally from Yahoo closes otherwise. Golden Cross active if 50 SMA > 200 SMA. Death Cross if 50 SMA < 200 SMA.",
      clientLogic: "PASS if 50 DMA > 200 DMA (Golden Cross active); 1 pt. Death Cross (50 < 200) = 0 pts.",
      ourLogic: null,
    },
    hhhl: {
      source: COMPUTED_FROM_YAHOO,
      calculation: "Aggregate daily Yahoo OHLCV into weekly bars (max high + min low per 5-day group). Take 26 weekly bars ≈ 6 months. Split into recent 13-week window vs prior 13-week window. Pattern present if recent max(high) > prior max(high) AND recent min(low) > prior min(low).",
      clientLogic: "PASS if HH-HL visible on weekly chart over 6+ months; 1 pt. Lower-lows pattern = 0 pts.",
      ourLogic: null,
    },
    rsi: {
      source: techSource("rsi14"),
      calculation: "RSI(14). When we have a TradingView scrape for this ticker, the value is read directly from the oscillators table. Otherwise computed locally from Yahoo closes: RSI = 100 − 100 / (1 + RS) where RS = average gain / average loss over last 14 daily closes, Wilder smoothing for subsequent updates.",
      clientLogic: "PASS if RSI 55–75 (ideal momentum zone); 2 pts. RSI > 80 = overbought = 1 pt. RSI < 40 = weak/failing = 0 pts.",
      ourLogic: null,
    },
    macd: {
      source: COMPUTED_FROM_YAHOO,
      calculation: "MACD line = EMA(12) − EMA(26). Signal = EMA(9) of MACD line. Computed locally from Yahoo closes (TradingView shows MACD Level but not Signal separately, so we keep the local computation). PASS if MACD line > signal AND MACD line > 0. Positive crossover detected if MACD crossed above signal in last day.",
      clientLogic: "PASS if MACD line > signal line and above zero (positive crossover); 2 pts. Negative crossover = 0 pts.",
      ourLogic: null,
    },
    adx: {
      source: techSource("adx14"),
      calculation: "ADX(14). When we have a TradingView scrape for this ticker, the value is read directly from the oscillators table. Otherwise computed locally from Yahoo OHLCV using Wilder smoothing: True Range / +DM / −DM each day → +DI / −DI → DX = 100 × |+DI − −DI| / (+DI + −DI) → ADX = 14-period Wilder smoothing of DX. Scoring: > 25 = 1 pt, 20–25 = 0.5 pt (per client framework), < 20 = 0.",
      clientLogic: "PASS if ADX > 25 (strong trend); 1 pt. ADX 20–25 = 0.5 pts (developing). ADX < 20 = choppy/no trend = 0 pts.",
      ourLogic: null,
    },
    rs: {
      source: COMPUTED_FROM_YAHOO,
      calculation: "Compute 6-month return for stock and for Nifty 500 index (^CRSLDX). Relative Strength = stock_return − index_return.",
      clientLogic: "PASS if 6M price return > Nifty 500 index return; 2 pts. Underperforming benchmark = 1 pt.",
      ourLogic: null,
    },
    volbo: {
      source: COMPUTED_FROM_YAHOO,
      calculation: "Compare today's volume against the average of the prior 20 trading days' volume. Volume ratio = today / 20-day avg. PASS if ratio ≥ 1.5×.",
      clientLogic: "PASS if breakout-day volume ≥ 1.5× 20-day avg; 2 pts. Low volume breakout = suspect = 1 pt.",
      ourLogic: null,
    },
    delivery: {
      source: NSE_BHAVCOPY,
      calculation: "Fetch NSE sec_bhavdata_full daily CSV for the last ~30 trading days. Extract DELIV_PER per ticker per day. Compute recent-half average vs older-half average. PASS if recent average > older average by > 1 pp.",
      clientLogic: "PASS if delivery % trending up over last 30 trading days; 1 pt. Declining delivery % = 0 pts.",
      ourLogic: null,
    },
    instact: {
      source: SCREENER_SHAREHOLD,
      calculation: "Pull 'Chg in FII Hold' + 'Chg in DII Hold' from each company's Screener Top Ratios. Sum > 0 = PASS. PARTIAL if sum positive but FII alone falling > 2%.",
      clientLogic: "PASS if FII + DII cumulative buying in last 2 quarters; 1 pt. Net institutional selling = 0 pts.",
      ourLogic: null,
    },
    near52w: {
      source: COMPUTED_FROM_YAHOO,
      calculation: "Compute 52-week high from last 250 daily closes. Proximity ratio = today's close / 52W high. Distance from high = (1 − ratio) × 100%.",
      clientLogic: "PASS if within 10% of 52-week high; 2 pts. > 20% below 52W high = weak structure = 0 pts.",
      ourLogic: null,
    },
    consolidation: {
      source: COMPUTED_FROM_YAHOO,
      calculation: "Look at the last 30 trading days = 6 weeks. Base range % = (max(high) − min(low)) / avg(close) × 100. Tight base = range < 12%. Breakout = today's close > prior 6-week high. Volume confirm = today's volume > 1.5× base avg volume. Strong = all three; mixed outcomes are documented in the note.",
      clientLogic: "PASS if breaking out of at least 6-week base on strong volume; 2 pts. No base = 0 pts.",
      ourLogic: null,
    },
    base: {
      source: COMPUTED_FROM_YAHOO,
      calculation: "Take last 60 daily closes. Drawdown % = (max − min) / max × 100. Closing-range tightness = standard deviation of closes ÷ mean of closes, expressed as %. Healthy = drawdown < 15% AND tightness < 4%.",
      clientLogic: "PASS if base formed with controlled drawdown < 15% and tight closing range; 1 pt.",
      ourLogic: null,
    },
    beta: {
      source: COMPUTED_FROM_YAHOO,
      calculation: "Beta = covariance(stock_daily_returns, index_daily_returns) / variance(index_daily_returns). Inputs are 1-year (up to 252 trading days) of daily closes from Yahoo Chart v8 for the stock and Nifty 500 (^CRSLDX). Stock and index series are intersected by calendar DATE before returns are computed — earlier versions used slice(-252) on each series independently, which silently misaligned dates whenever the stock and index histories had different lengths (e.g. recent IPOs with shorter histories). That bug compressed beta toward 0 across the universe; this fix restores it.",
      clientLogic: "PASS if Beta 0.7–1.3 (moderate); 1 pt. Beta > 1.5 = high risk, weight penalty. Beta < 0.5 = drag risk.",
      ourLogic: null,
    },
    atr: {
      source: COMPUTED_FROM_YAHOO,
      calculation: "ATR(14) using Wilder smoothing over True Range values. ATR % = ATR ÷ latest close × 100. Trend assessed from atr_history.json accumulator (≥10 daily snapshots needed for trend): recent-half avg vs older-half avg. Scoring combines absolute level (<2.5% / 2.5–4% / >4%) AND trend direction (declining boosts to PASS, rising produces a mixed result). Accumulator builds 1 snapshot per daily Technicals scrape, so the trend signal strengthens over ~2 weeks.",
      clientLogic: "PASS if 14-day ATR % declining or stable (< 2.5% for large cap); 1 pt. Rising ATR = position-size flag.",
      ourLogic: null,
    },
  },

  // ---------- earnings ----------
  // Every figure here comes from the company's reported quarterly numbers. `source` points at
  // the two places a reader can verify them: the Screener Quarters table (fast to scan) and
  // the exchange filing itself (authoritative). `calculation` is the formula we apply.
  earnings: {
    rev_yoy: {
      source: SCREENER_QUARTERS,
      calculation: 'Revenue for the latest reported quarter versus the same quarter one year earlier (four quarters back in the series): (latest − year-ago) ÷ |year-ago| × 100.',
      clientLogic: 'PASS if revenue YoY > 15%; 2 pts. 8–15% = 1 pt (mixed). Below 8% = 0 pts.',
      ourLogic: null,
    },
    pat_yoy: {
      source: SCREENER_QUARTERS,
      calculation: 'Net profit for the latest quarter versus the same quarter a year earlier. Checked for a negative PAT first — a loss short-circuits the rule to a hard fail before any growth rate is computed.',
      clientLogic: 'PASS if PAT YoY > 15%; 2 pts. 5–15% = 1 pt. Below 5% = 0 pts. A loss-making quarter is an immediate fail — the company exits the quality pipeline.',
      ourLogic: null,
    },
    rev_accel: {
      source: SCREENER_QUARTERS,
      calculation: 'Compute revenue YoY growth for every quarter that has a year-ago comparator — with eight quarters of history that is four readings. Compare the latest against the mean of the three before it. Accelerating if the latest is more than 1pp above that mean; decelerating if more than 1pp below.',
      clientLogic: 'PASS if latest revenue YoY exceeds the trailing four-quarter average; 2 pts. Within 1pp either way = 1 pt. Below = 0 pts.',
      ourLogic: 'The client says "trailing four-quarter average", but eight quarters of reported data only produce four YoY readings in total — one of which is the latest. The baseline is therefore the three quarters preceding the latest, not four. Widening the data to nine quarters would let us match the stated window exactly.',
    },
    rev_qoq: {
      source: SCREENER_QUARTERS,
      calculation: 'Latest quarter revenue versus the immediately preceding quarter. No seasonal adjustment is applied.',
      clientLogic: 'PASS if revenue grew sequentially; 1 pt.',
      ourLogic: 'The client framework does not adjust for seasonality and neither do we, so a genuinely seasonal business (jewellery in Q1, cement in the monsoon) can fail this rule on a perfectly healthy quarter. The note on the rule card says so; read it alongside Revenue YoY rather than on its own.',
    },

    opm_exp: {
      source: SCREENER_QUARTERS,
      calculation: 'Operating profit margin (operating profit ÷ revenue) for the latest quarter minus the same figure a year earlier, expressed in basis points.',
      clientLogic: 'PASS if OPM expanded by 100bps or more year on year; 2 pts. Flat to +100bps = 1 pt. Contraction = 0 pts.',
      ourLogic: null,
    },
    opm_level: {
      source: SCREENER_QUARTERS,
      calculation: 'Latest OPM against the simple average of all eight quarters in the series. Requires the full eight quarters — otherwise N/A.',
      clientLogic: 'PASS if the current OPM is above the eight-quarter average; 1 pt.',
      ourLogic: null,
    },
    npm_exp: {
      source: SCREENER_QUARTERS,
      calculation: 'Net profit margin (net profit ÷ revenue) for the latest quarter minus the same figure a year earlier.',
      clientLogic: 'PASS if net margin improved year on year; 1 pt.',
      ourLogic: null,
    },

    op_vs_pat: {
      source: SCREENER_QUARTERS,
      calculation: 'Year-on-year growth of operating profit compared with year-on-year growth of net profit. The gap (OP growth − PAT growth) is the score driver: zero or positive means the operating line is doing the work. Returns N/A when operating profit is zero or negative in either quarter, where the two growth rates are not comparable.',
      clientLogic: 'PASS if operating profit growth is at least as fast as PAT growth; 2 pts. PAT outrunning OP means other income or one-offs are carrying the print.',
      ourLogic:
        'Two deviations. (1) The client states a binary test; we add a mixed band, a gap between 0 and −5pp scoring 1 point rather than 0, because a small non-operating contribution is common and not by itself a quality problem. (2) We return N/A on an operating loss on either side. Taken literally the test rewards it: an operating profit collapsing from +466 Cr to −268 Cr reads as −157% growth, which "beats" a PAT that fell −208%, and the company would collect full earnings-quality marks for a quarter with no operating profit at all. The same guard already applies to Other Income Share and Effective Tax Rate on a negative PBT.',
    },
    other_inc: {
      source: EXCHANGE_FILING,
      calculation: 'Other income as a percentage of profit before tax. Returns N/A when PBT is zero or negative, where the ratio has no meaning.',
      clientLogic: 'PASS if other income is under 15% of PBT; 1 pt. At or above 15%, a material part of profit is non-operating.',
      ourLogic: null,
    },
    exceptional: {
      source: EXCHANGE_FILING,
      calculation: 'Reads the exceptional-items line for the latest quarter. Any non-zero value — gain or charge — fails, and the rule reports it as a share of PBT so the size is visible.',
      clientLogic: 'PASS if there are no exceptional items in the quarter; 1 pt.',
      ourLogic: null,
    },
    tax_rate: {
      source: EXCHANGE_FILING,
      calculation: 'Effective tax rate = tax expense ÷ profit before tax × 100. N/A when PBT is zero or negative.',
      clientLogic: 'PASS if the effective tax rate is between 20% and 30%; 1 pt. Outside that band scores mixed, with the reason flagged.',
      ourLogic: 'The client uses one mixed band without splitting the reasons. We score both directions at 0.5 but write different notes: below 20% points at a credit, exemption or deferred-tax reversal flattering PAT; above 30% at a one-off charge or prior-period adjustment depressing it.',
    },

    eps_surp: {
      source: CONSENSUS,
      calculation: 'Reported EPS against the street consensus estimate for the quarter: (actual − estimate) ÷ |estimate| × 100.',
      clientLogic: 'PASS if reported EPS beat consensus; 2 pts. Within ±1% = in line = 1 pt. Below = 0 pts.',
      ourLogic: null,
    },
    rev_surp: {
      source: CONSENSUS,
      calculation: 'Reported revenue against the street consensus revenue estimate, same formula as the EPS surprise.',
      clientLogic: 'PASS if revenue beat consensus; 1 pt.',
      ourLogic: 'The client specifies no in-line band for revenue, only for EPS. We mirror the EPS treatment and award 0.5 for a print within ±1% of consensus, so a company that lands exactly on its number is not scored the same as one that missed.',
    },

    rev_streak: {
      source: SCREENER_QUARTERS,
      calculation: 'Counts how many of the last four quarters grew revenue year on year. Needs four quarters each with a year-ago comparator, so eight quarters of history in total.',
      clientLogic: 'PASS if revenue YoY was positive in all four of the last quarters; 1 pt.',
      ourLogic: null,
    },
    pat_streak: {
      source: SCREENER_QUARTERS,
      calculation: 'Counts how many of the last four quarters were profitable. A single loss-making quarter fails the rule.',
      clientLogic: 'PASS if the company was profitable in all four of the last quarters; 1 pt.',
      ourLogic: null,
    },
  },

};

// Back-compat alias: the technicals drill imported RULE_META before this file grew a second
// model. Kept so nothing has to change at that call site.
export const RULE_META = META.technicals;
