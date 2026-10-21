"""Point-in-time forward event study. No fabricated historical signals, fills or corporate-action adjustments."""
import datetime as dt
import json
import math
import statistics
from decimal import Decimal as D

from recommendation_foundation import canonical
from recommendation_models import MODEL_NAMES, MODEL_VERSION, POLICY, schema, stamp


def latest_rows(rows, key):
    values = {}
    for row in rows:
        values[key(row)] = dict(row)
    return values


def outcome(store, signal, horizon, at):
    issued = stamp(signal["issued_at"]).astimezone(dt.timezone(dt.timedelta(minutes=330))).date().isoformat()
    # Benchmark reports define observed exchange sessions. Missing reports cannot shorten a horizon.
    indices = latest_rows(store.db.execute("SELECT * FROM market_indices WHERE name='Nifty 500' AND observed_at<=? ORDER BY session,observed_at", (at,)), lambda r: r["session"])
    sessions = sorted(d for d in indices if d > issued and d <= at[:10])
    base = {"status": "pending", "reason": "Horizon has not matured", "horizonSessions": horizon, "signalIssuedAt": signal["issued_at"],
        "costBps": POLICY["roundTripCostBps"], "basis": "unadjusted price return; any corporate action blocks measurement", "benchmark": "Nifty 500 price index"}
    if not sessions:
        return base
    # A missing index report on any weekday is a calendar gap until explicitly verified. Weekends
    # and missing files are not asserted to be holidays. This conservative check may hold holiday spans.
    first, last = dt.date.fromisoformat(issued) + dt.timedelta(days=1), dt.date.fromisoformat(sessions[min(horizon-1, len(sessions)-1)])
    calendar_gaps = []
    holidays = {r[0] for r in store.db.execute("SELECT day FROM market_holidays WHERE observed_at<=?", (at,))}
    while first <= last:
        if first.weekday() < 5 and first.isoformat() not in indices and first.isoformat() not in holidays:
            calendar_gaps.append(first.isoformat())
        first += dt.timedelta(days=1)
    if calendar_gaps:
        return {**base, "status": "calendar-unverified", "reason": "Missing exchange session/holiday evidence", "gaps": calendar_gaps}
    if len(sessions) < horizon:
        return base
    entry_day, exit_day = sessions[0], sessions[horizon - 1]
    prices = latest_rows(store.db.execute("SELECT * FROM market_prices WHERE isin=? AND observed_at<=? AND session>=? AND session<=? ORDER BY session,observed_at",
        (signal["company"], at, entry_day, exit_day)), lambda r: (r["session"], r["series"]))
    by_day = {}
    for row in prices.values():
        by_day.setdefault(row["session"], []).append(row)
    missing = [d for d in sessions[:horizon] if len(by_day.get(d, [])) != 1 or D(by_day[d][0]["volume"]) <= 0]
    if missing:
        return {**base, "status": "unpriced", "reason": "Missing, suspended, delisted or ambiguous sessions retained; no synthetic fill", "missingSessions": missing}
    actions_check = store.db.execute("SELECT * FROM checks WHERE key='market:actions'").fetchone()
    coverage = json.loads(actions_check["detail"]) if actions_check else {}
    if not actions_check or actions_check["error"] or coverage.get("from", "9999") > entry_day or coverage.get("to", "") < exit_day:
        return {**base, "status": "actions-unverified", "reason": "Corporate-action coverage does not establish this holding interval"}
    actions = store.db.execute("SELECT ex_date,subject FROM market_actions WHERE isin=? AND ex_date>=? AND ex_date<=? AND observed_at<=?",
        (signal["company"], entry_day, exit_day, at)).fetchall()
    if actions:
        return {**base, "status": "corporate-action", "reason": "No certified split, rights, dividend, merger or delisting adjustment", "actions": [dict(r) for r in actions]}
    entry, exit = D(by_day[entry_day][0]["open"]), D(by_day[exit_day][0]["close"])
    if entry <= 0 or exit <= 0:
        return {**base, "status": "unpriced", "reason": "No executable positive entry/exit"}
    gross = exit / entry - 1
    net = gross - D(POLICY["roundTripCostBps"]) / 10000
    benchmark = D(indices[exit_day]["close"]) / D(indices[entry_day]["open"]) - 1
    high_water, drawdown = entry, D(0)
    for day in sessions[:horizon]:
        close = D(by_day[day][0]["close"])
        high_water = max(high_water, close)
        drawdown = min(drawdown, close / high_water - 1)
    return {**base, "status": "measured", "reason": None, "entrySession": entry_day, "exitSession": exit_day, "entryPrice": str(entry), "exitPrice": str(exit),
        "grossReturnPct": str(gross * 100), "netReturnPct": str(net * 100), "benchmarkReturnPct": str(benchmark * 100),
        "excessReturnPct": str((net - benchmark) * 100), "maxCloseDrawdownPct": str(drawdown * 100)}


def summarize(items):
    counts = {}
    for x in items:
        counts[x["status"]] = counts.get(x["status"], 0) + 1
    measured = [x for x in items if x["status"] == "measured"]
    n = len(measured)
    result = {"signals": len(items), "measured": n, "statuses": counts, "validation": "insufficient-history", "winRate": None,
        "winRateWilson95": None, "meanNetReturnPct": None, "medianNetReturnPct": None, "meanExcessReturnPct": None, "worstReturnPct": None}
    if not measured:
        return result
    returns = [float(x["netReturnPct"]) for x in measured]
    rate, z = sum(r > 0 for r in returns) / n, 1.96
    centre = (rate + z*z/(2*n))/(1+z*z/n)
    spread = z*math.sqrt(rate*(1-rate)/n+z*z/(4*n*n))/(1+z*z/n)
    result.update(winRate=rate, winRateWilson95=[max(0, centre-spread), min(1, centre+spread)], meanNetReturnPct=statistics.mean(returns),
        medianNetReturnPct=statistics.median(returns), meanExcessReturnPct=statistics.mean(float(x["excessReturnPct"]) for x in measured), worstReturnPct=min(returns))
    # Overlapping stock/event returns are not independent. Even many observations do not certify edge.
    result["validation"] = "forward-observations" if n >= 30 else "insufficient-history"
    return result


def backtest(store, at):
    schema(store)
    signals = store.db.execute("SELECT * FROM recommendation_signals WHERE issued_at<=? AND model_version=? ORDER BY issued_at,id", (at, MODEL_VERSION)).fetchall()
    report = {}
    for model in MODEL_NAMES:
        report[model] = {}
        for horizon in POLICY["horizons"]:
            measured = []
            for signal in signals:
                if signal["model"] != model:
                    continue
                value = outcome(store, signal, horizon, at)
                store.db.execute("INSERT OR IGNORE INTO recommendation_outcomes VALUES(?,?,?,?)", (signal["id"], horizon, at, canonical(value)))
                measured.append(value)
            report[model][str(horizon)] = summarize(measured)
    store.db.commit()
    return {"asOf": at, "modelVersion": MODEL_VERSION, "method": "immutable forward signals; next-session open; 63/126 observed sessions; 50 bps round-trip assumption",
        "historicalReconstruction": "unavailable: earlier publication dates do not prove earlier observation",
        "strategyValidation": "not-established", "models": report,
        "limitations": ["Not a portfolio simulation: overlapping signals, capital limits and dependence remain explicit.",
            "Unpriced and corporate-action affected observations stay in the denominator as unresolved, rather than being discarded.",
            "No rule search, fitted return probability or post-outcome parameter tuning. A later frozen-version evaluation is needed.",
            "Closing drawdown is not an intraday drawdown; no guaranteed fill or specific investment-size capacity is implied."]}
