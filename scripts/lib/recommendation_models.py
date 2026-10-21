"""Versioned catalyst hypotheses, conservative eligibility and immutable forward observations.

Scores rank research evidence. They are not calibrated probabilities or predicted returns.
All financial computations use exact decimals and only evidence observed by the decision time.
"""
import datetime as dt
import json
import re
import statistics
import subprocess
import tempfile
import zlib
from decimal import Decimal as D
from pathlib import Path

from recommendation_foundation import canonical, digest, iso_now
from recommendation_market import schema as market_schema

MODEL_VERSION = "catalysts-1"
MODEL_NAMES = {"earnings": "Improving earnings", "orders": "Material new business", "capacity": "Productive new capacity"}
POLICY = {"minimumScore": 70, "minimumMedianTurnoverINR": 10000000, "minimumLiquiditySessions": 20,
    "maximumEvidenceAgeDays": 45, "maximumFinancialAgeDays": 150, "maximumPriceAgeDays": 5,
    "maximumPE": 40, "maximumPostDisclosureRisePct": 20, "caseCooldownDays": 186, "roundTripCostBps": 50, "horizons": [63, 126]}


def schema(store):
    market_schema(store)
    store.db.executescript("""
      CREATE TABLE IF NOT EXISTS catalyst_extractions(version TEXT,extractor TEXT,observed_at TEXT,payload TEXT,
        PRIMARY KEY(version,extractor));
      CREATE TABLE IF NOT EXISTS recommendation_assessments(id TEXT PRIMARY KEY,company TEXT,model TEXT,at TEXT,payload TEXT);
      CREATE TABLE IF NOT EXISTS recommendation_signals(id TEXT PRIMARY KEY,company TEXT,model TEXT,catalyst TEXT,
        model_version TEXT,issued_at TEXT,payload TEXT,UNIQUE(company,model,catalyst,model_version));
      CREATE TABLE IF NOT EXISTS recommendation_reviews(signal TEXT,at TEXT,payload TEXT,PRIMARY KEY(signal,at));
      CREATE TABLE IF NOT EXISTS recommendation_outcomes(signal TEXT,horizon INTEGER,at TEXT,payload TEXT,
        PRIMARY KEY(signal,horizon,at));
      CREATE INDEX IF NOT EXISTS recommendation_documents ON documents(company,kind);
    """)
    store.db.commit()


def stamp(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("An observed or published instant requires a timezone")
    return parsed.astimezone(dt.timezone.utc)


def indian_day(at):
    return stamp(at).astimezone(dt.timezone(dt.timedelta(minutes=330))).date().isoformat()


def age(at, date):
    return (dt.date.fromisoformat(indian_day(at)) - dt.date.fromisoformat(date[:10])).days


def financials(store, company, at):
    """Reconcile same-document revisions as of now; conflicting independent filings stay unknown."""
    history = store.financial_history(company, at)
    latest = {}
    for f in history:
        latest[f["document"]] = max(latest.get(f["document"], ""), f["first_observed"])
    grouped = {}
    for f in history:
        if f["first_observed"] != latest[f["document"]] or f["end"] > indian_day(at):
            continue
        evidence = json.loads(f["evidence"])
        if not re.search(r":INR\s*</", evidence.get("unitDefinition", "")):
            continue
        grouped.setdefault((f["metric"], f["start"], f["end"], f["basis"]), []).append(f)
    facts, conflicts = {}, []
    for key, values in grouped.items():
        if len({D(f["value"]) for f in values}) > 1:
            conflicts.append(list(key))
        else:
            facts[key] = {"value": D(values[0]["value"]), "versions": sorted({f["version"] for f in values})}
    quarters = sorted({(start, end, basis) for (metric, start, end, basis) in facts if metric == "revenue" and start
        and 75 <= (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days <= 105}, key=lambda x: (x[1], x[2] == "Consolidated"))
    if not quarters:
        return {"facts": facts, "conflicts": conflicts, "basis": None, "quarter": None}
    start, end, basis = quarters[-1]
    same = [(s, e, b) for s, e, b in quarters if b == basis]
    def get(metric, period=None):
        s, e, b = period or (start, end, basis)
        return facts.get((metric, s, e, b), {}).get("value")
    prior = next((q for q in reversed(same) if dt.date.fromisoformat(q[1]).year == dt.date.fromisoformat(end).year - 1
        and q[1][5:7] == end[5:7] and abs(int(q[1][8:10]) - int(end[8:10])) <= 7), None)
    # A TTM is four actually reported, adjacent quarters; never annual minus incomplete YTD.
    four = same[-4:]
    ttm = len(four) == 4 and all((dt.date.fromisoformat(four[i][0]) - dt.date.fromisoformat(four[i-1][1])).days == 1 for i in range(1, 4))
    annual = sorted([(s, e, b) for (m, s, e, b) in facts if m == "revenue" and b == basis and s
        and 330 <= (dt.date.fromisoformat(e) - dt.date.fromisoformat(s)).days <= 380 and age(at, e) <= 550], key=lambda x: x[1])
    baseline = sum(get("revenue", q) for q in four) if ttm else get("revenue", annual[-1]) if annual else None
    eps_ttm = sum(get("eps_diluted_total", q) for q in four) if ttm and all(get("eps_diluted_total", q) is not None for q in four) else None
    annual_eps = get("eps_diluted_total", annual[-1]) if annual else None
    return {"facts": facts, "conflicts": conflicts, "basis": basis, "quarter": (start, end, basis), "prior": prior,
        "get": get, "baselineRevenue": baseline, "baselinePeriod": "TTM" if ttm else annual[-1][1] if annual else None,
        "valuationEPS": eps_ttm if eps_ttm is not None else annual_eps, "valuationPeriod": "TTM" if eps_ttm is not None else "annual",
        "annual": annual[-1] if annual else None, "quarters": same}


def evidence_date(store, document, at):
    # No retrospective replay of today's aggregate date assessment into an older decision.
    observations = store.db.execute("SELECT * FROM observations WHERE document=? AND observed_at<=?", (document, at)).fetchall()
    versions = store.db.execute("SELECT * FROM versions WHERE document=? AND first_observed<=?", (document, at)).fetchall()
    parsed = [json.loads(v["parsed"]) for v in versions]
    dates = {p.get("documentDate") for p in parsed}
    reports = {o["reported_date"] for o in observations if o["reported_date"]}
    pubs = set()
    for o in observations:
        try:
            if o["published_at"] and stamp(o["published_at"]) <= stamp(at):
                pubs.add(stamp(o["published_at"]).isoformat(timespec="seconds"))
        except (ValueError, TypeError):
            return None
    if len(dates) != 1 or None in dates or not pubs or not parsed or not all(p.get("issuerMatches") and not p.get("dateIssues") for p in parsed):
        return None
    date = next(iter(dates))
    if len(reports) > 1 or any(d != date for d in reports) or store.get("identityConflict:" + document):
        return None
    local_days = {stamp(p).astimezone(dt.timezone(dt.timedelta(minutes=330))).date().isoformat() for p in pubs}
    if len(local_days) != 1 or date > indian_day(at) or not 0 <= age(at, date) <= POLICY["maximumEvidenceAgeDays"]:
        return None
    return {"documentDate": date, "publishedAt": min(pubs), "observedAt": max(v["first_observed"] for v in versions)}


def market_snapshot(store, company, at):
    rows = [dict(r) for r in store.db.execute("SELECT * FROM market_prices WHERE isin=? AND observed_at<=? AND session<=? ORDER BY session,observed_at",
        (company, at, at[:10]))]
    latest = {}
    for row in rows:
        latest[(row["session"], row["series"])] = row
    by_session = {}
    for row in latest.values():
        by_session.setdefault(row["session"], []).append(row)
    # Multiple equity series for an ISIN are ambiguous; never select whichever price is highest.
    prices = [v[0] for _, v in sorted(by_session.items()) if len(v) == 1]
    quotes = [p for p in prices if D(p["volume"]) > 0 and D(p["close"]) > 0]
    if not quotes:
        return {"price": None, "liquid": False, "prices": []}
    sessions = [r[0] for r in store.db.execute("SELECT DISTINCT session FROM market_indices WHERE name='Nifty 500' AND observed_at<=? AND session<=? ORDER BY session DESC LIMIT 20", (at, at[:10]))][::-1]
    recent = [by_session[d][0] for d in sessions if len(by_session.get(d, [])) == 1]
    median = statistics.median(D(p["turnover"]) for p in recent) if recent else D(0)
    liquid = len(sessions) == len(recent) == 20 and age(at, recent[0]["session"]) <= 45 and quotes[-1]["session"] == sessions[-1] and median >= POLICY["minimumMedianTurnoverINR"]
    return {"price": quotes[-1], "liquid": liquid, "prices": prices, "medianTurnover": str(median)}


def extract_catalyst(text):
    """Narrow, auditable English annexure adapter. Every accepted field retains a page and literal quote.

    Ambiguity, multi-project aggregates, LOIs, proposed capacity and undisclosed terms stay unqualified.
    This adapter never guesses a margin, customer share, financing plan or execution duration.
    """
    pages = text.split("\f")
    fields = {}
    def capture(key, pattern, transform=lambda m: m[0], asserted=False):
        found, contradicted = [], False
        for page, value in enumerate(pages, 1):
            for match in re.finditer(pattern, value, re.I | re.S):
                prefix = re.split(r"[.!?]", value[max(0,match.start()-90):match.start()])[-1]
                if asserted and re.search(r"\b(?:not|no|never|nor|will|would|may|might|propos(?:e[ds]?|al)|plan(?:ned|s)?|expect(?:ed|s)?|intend(?:ed|s)?|scheduled?|target(?:ed|s)?|pending|conditional)\b|subject\s+to|to\s+be", prefix, re.I):
                    contradicted = True
                    continue
                found.append({"value": transform(match), "page": page, "offset": match.start(), "quote": match[0][:650]})
        unique = {canonical(x["value"]) for x in found}
        if len(unique) == 1 and not contradicted:
            fields[key] = found[0]
    amount = r"(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)\s*(crores?|cr\.?|lakhs?|lacs?|millions?)\b"
    scale = lambda m: str(D(m[1].replace(",", "")) * (10000000 if m[2].lower().startswith("cr") else 100000 if m[2].lower().startswith(("lac", "lak")) else 1000000))
    capture("orderValue", r"(?:order|contract)\s*(?:value|size|amount|worth)[^\n]{0,90}?" + amount, scale)
    capture("executionMonths", r"(?:execut(?:ed|ion)|deliver(?:y|ed)|complet(?:ed|ion))[^\n]{0,100}?\b(\d{1,2})\s*months?", lambda m: int(m[1]))
    capture("firmOrder", r"\b(?:received|secured|awarded|signed)\b[^\n]{0,90}\b(?:firm\s+order|purchase\s+order|contract)\b", lambda m: True, asserted=True)
    capture("notFirm", r"\b(?:letter\s+of\s+intent|memorandum\s+of\s+understanding|framework\s+agreement|lowest\s+bidder|L1\s+bidder)\b", lambda m: True)
    capture("cancelled", r"\b(?:cancelled|terminated|withdrawn|revoked|delayed|postponed)\b", lambda m: True)
    capture("adverse", r"\b(?:auditor[^\n]{0,50}resign(?:ed|ation)|defaulted\s+on\s+(?:loan|debt|payment)|admitted\s+(?:to|into)\s+(?:insolvency|CIRP)|fraudulent\s+transactions?)\b", lambda m: True)
    capture("attributionUnclear", r"\b(?:consortium|joint\s+venture|JV\s+share|including\s+GST|inclusive\s+of\s+(?:tax|GST))\b", lambda m: True)
    capture("commissioned", r"\b(?:commenced\s+commercial\s+production|commercial\s+production\s+(?:has\s+)?commenced|successfully\s+commissioned)\b", lambda m: True, asserted=True)
    capture("existingUtilisation", r"(?:existing|current)\s+(?:capacity\s+)?utili[sz]ation[^\n]{0,50}?(\d{1,3}(?:\.\d+)?)\s*%", lambda m: str(D(m[1])))
    capture("funded", r"\b(?:fully\s+funded|funded\s+(?:entirely\s+)?(?:through|by|from)\s+internal\s+accruals)\b", lambda m: True, asserted=True)
    capture("demand", r"\b(?:firm\s+(?:customer\s+)?(?:orders|offtake)|signed\s+offtake\s+agreement|binding\s+offtake\s+agreement)\b", lambda m: True, asserted=True)
    capture("multipleProjects", r"\b(?:multiple|two|three|four|several)\s+(?:new\s+)?(?:projects|plants|facilities|units|contracts|orders)\b", lambda m: True)
    capture("capacityAdditionPct", r"(?:capacity\s+(?:addition|increase|expansion))[^\n]{0,65}?(\d{1,3}(?:\.\d+)?)\s*%", lambda m: str(D(m[1])))
    return fields


def extract_documents(store, scratch, maximum=40):
    rows = store.db.execute("""SELECT v.* FROM versions v JOIN documents d ON d.id=v.document
      LEFT JOIN catalyst_extractions e ON e.version=v.id AND e.extractor=?
      WHERE d.kind IN ('catalyst','event') AND v.format='pdf' AND e.version IS NULL
      AND d.company IS NOT NULL ORDER BY d.kind='catalyst' DESC,v.first_observed LIMIT ?""", (MODEL_VERSION, maximum)).fetchall()
    for row in rows:
        payload = {"fields": {}, "status": "unsupported"}
        try:
            with tempfile.TemporaryDirectory(dir=scratch) as folder:
                file = Path(folder) / "evidence.pdf"
                file.write_bytes(zlib.decompress(row["body"]))
                result = subprocess.run(["pdftotext", "-f", "1", "-l", "12", "-layout", str(file), "-"], capture_output=True, check=True, timeout=20)
            text = result.stdout.decode("utf-8", errors="replace")
            payload = {"fields": extract_catalyst(text), "status": "parsed", "pagesReadLimit": 12,
                "completeDocumentRead": False, "textHash": digest(text)}
        except (subprocess.SubprocessError, OSError, zlib.error) as error:
            payload["error"] = type(error).__name__
        store.db.execute("INSERT OR IGNORE INTO catalyst_extractions VALUES(?,?,?,?)", (row["id"], MODEL_VERSION, iso_now(), canonical(payload)))
        store.db.commit()


def score_models(fin, fields=None):
    """Pure versioned rules. Missing values cannot earn points or satisfy eligibility."""
    fields = fields or {}
    get_field = lambda key: fields.get(key, {}).get("value")
    results = {m: {"model": m, "score": 0, "reasons": [], "missing": [], "qualified": False} for m in MODEL_NAMES}
    if not fin.get("quarter"):
        for r in results.values():
            r["missing"].append("Comparable quarterly financial history")
        return results
    get, prior = fin["get"], fin["prior"]
    r = results["earnings"]
    revenue, profit, pbt, eps = [get(k) for k in ["revenue", "net_profit", "pbt_before_exceptional", "eps_diluted_total"]]
    old = [get(k, prior) if prior else None for k in ["revenue", "net_profit", "pbt_before_exceptional", "eps_diluted_total"]]
    if any(v is None or v <= 0 for v in [revenue, profit, pbt, eps, *old]):
        r["missing"].append("Positive same-basis revenue, profit, pre-exceptional PBT and diluted EPS for the quarter and year-earlier quarter")
    else:
        sales_growth, profit_growth, underlying_growth, eps_growth = [(a / b - 1) * 100 for a, b in zip([revenue, profit, pbt, eps], old)]
        margin_gain = (pbt / revenue - old[2] / old[0]) * 100
        r["features"] = {"revenueGrowthPct": str(sales_growth), "profitGrowthPct": str(profit_growth), "underlyingPBTGrowthPct": str(underlying_growth), "dilutedEPSGrowthPct": str(eps_growth), "preExceptionalMarginChangePP": str(margin_gain)}
        if sales_growth >= 15:
            r["score"] += 25; r["reasons"].append("Revenue increased " + str(round(sales_growth, 1)) + "% year on year")
        if underlying_growth >= 20 and profit_growth >= 20:
            r["score"] += 25; r["reasons"].append("Pre-exceptional PBT and reported profit both increased at least 20%")
        if eps_growth >= 15:
            r["score"] += 20; r["reasons"].append("Diluted EPS increased at least 15%")
        if margin_gain >= D("0.5"):
            r["score"] += 10; r["reasons"].append("Pre-exceptional PBT margin improved at least 0.5 percentage points")
        other, exc = get("other_income"), get("exceptional_before_tax")
        clean = other is not None and exc is not None and abs(exc) <= abs(pbt) * D("0.1") and other <= abs(pbt) * D("0.25")
        if clean:
            r["score"] += 10; r["reasons"].append("Other income and exceptional items remain within the stated quality limits")
        else:
            r["missing"].append("Verified limited exceptional items and other income")
        r["qualified"] = clean and sales_growth >= 15 and profit_growth >= 20 and underlying_growth >= 20 and eps_growth >= 15
    baseline = fin.get("baselineRevenue")
    for model in ["orders", "capacity"]:
        r = results[model]
        if not baseline or baseline <= 0:
            r["missing"].append("Verified TTM or annual revenue baseline")
        if get_field("cancelled"):
            r["missing"].append("Source mentions cancellation, delay or termination")
        if get_field("attributionUnclear"):
            r["missing"].append("Attributable share or tax-exclusive amount requires review")
        keys = ["firmOrder","orderValue","executionMonths"] if model == "orders" else ["commissioned","funded","demand","existingUtilisation","capacityAdditionPct"]
        linked = [fields.get(k) for k in keys]
        if get_field("multipleProjects") or all(linked) and (len({f["page"] for f in linked}) != 1 or
                any("offset" not in f for f in linked) or max(f["offset"] for f in linked)-min(f["offset"] for f in linked)>2000):
            r["missing"].append("Linked terms for one contract/project require verification")
    r = results["orders"]
    value, months = get_field("orderValue"), get_field("executionMonths")
    if get_field("firmOrder") and not get_field("notFirm"):
        r["score"] += 30; r["reasons"].append("Source identifies a received purchase order or signed contract")
    else:
        r["missing"].append("Unambiguous firm order; LOIs and framework agreements excluded")
    if value and baseline and baseline > 0:
        materiality = D(value) / baseline * 100
        r["features"] = {"orderValueINR": value, "revenueMaterialityPct": str(materiality), "revenueBaseline": fin["baselinePeriod"]}
        if materiality >= 10:
            r["score"] += 30; r["reasons"].append("Disclosed order value is at least 10% of the verified revenue baseline")
        else:
            r["missing"].append("Order value below 10% materiality threshold")
    else:
        r["missing"].append("Unambiguous INR order value and revenue baseline")
    if months and 1 <= months <= 12:
        r["score"] += 20; r["reasons"].append("Disclosed execution period is within twelve months")
    else:
        r["missing"].append("Disclosed execution period of one to twelve months")
    r["qualified"] = not r["missing"]
    r = results["capacity"]
    for key, label, points in [("commissioned", "Commercial production has commenced", 25), ("funded", "Funding is explicitly secured", 20), ("demand", "Firm demand/offtake is disclosed", 20)]:
        if get_field(key):
            r["score"] += points; r["reasons"].append(label)
        else:
            r["missing"].append(label + " requires primary evidence")
    utilisation, addition = get_field("existingUtilisation"), get_field("capacityAdditionPct")
    if utilisation is not None and 70 <= D(utilisation) <= 100:
        r["score"] += 15; r["reasons"].append("Existing capacity utilisation is at least 70%")
    else:
        r["missing"].append("Verified existing utilisation of 70–100%")
    if addition is not None and D(addition) >= 10:
        r["score"] += 10; r["reasons"].append("Capacity addition is at least 10%")
    else:
        r["missing"].append("Verified comparable capacity addition of at least 10%")
    r["qualified"] = not r["missing"]
    # Common cash quality: use an actual annual/half-year cash statement, never invented quarterly CFO.
    cash = sorted([(e, f["value"]) for (m, s, e, b), f in fin["facts"].items() if m == "operating_cash_flow" and b == fin["basis"] and s
        and 150 <= (dt.date.fromisoformat(e) - dt.date.fromisoformat(s)).days <= 380
        and e >= (dt.date.fromisoformat(fin["quarter"][1]) - dt.timedelta(days=400)).isoformat()], reverse=True)
    for r in results.values():
        if cash and all(value > 0 for end, value in cash if end == cash[0][0]):
            r["score"] += 10; r["reasons"].append("Latest reported half-year/annual operating cash flow is positive")
        else:
            r["missing"].append("Positive reported operating cash flow requires verification")
            r["qualified"] = False
        r["score"] = min(100, r["score"])
        r["qualified"] = r["qualified"] and r["score"] >= POLICY["minimumScore"] and not fin["conflicts"]
        if fin["conflicts"]:
            r["missing"].append("Conflicting financial filings require reconciliation")
    return results


def assess(store, at):
    schema(store)
    store.set("recommendationCaptureStart", store.get("recommendationCaptureStart") or at)
    rows, assessed, missing_counts = [], 0, {}
    companies = store.db.execute("SELECT DISTINCT company FROM facts WHERE eligible=1 UNION SELECT company FROM documents WHERE kind='catalyst' AND company IS NOT NULL").fetchall()
    for (company,) in companies:
        if not company:
            continue
        fin, market = financials(store, company, at), market_snapshot(store, company, at)
        docs = store.db.execute("SELECT * FROM documents WHERE company=? AND status='read' ORDER BY last_seen DESC", (company,)).fetchall()
        adverse = []
        for risk in store.db.execute("SELECT v.document,e.payload FROM catalyst_extractions e JOIN versions v ON e.version=v.id JOIN documents d ON v.document=d.id WHERE d.company=? AND e.extractor=? AND e.observed_at<=?", (company,MODEL_VERSION,at)):
            fields = json.loads(risk["payload"]).get("fields",{})
            if fields.get("adverse") and evidence_date(store,risk["document"],at):
                adverse.append({"document":risk["document"],"evidence":fields["adverse"]})
        latest_candidates = {}
        for doc in docs:
            timing = evidence_date(store, doc["id"], at)
            if not timing:
                continue
            versions = store.db.execute("SELECT * FROM versions WHERE document=? AND first_observed<=? ORDER BY first_observed DESC", (doc["id"], at)).fetchall()
            if not versions:
                continue
            version = versions[0]
            extract = store.db.execute("SELECT payload FROM catalyst_extractions WHERE version=? AND extractor=? AND observed_at<=?", (version["id"], MODEL_VERSION, at)).fetchone()
            fields = json.loads(extract[0])["fields"] if extract else {}
            for model, result in score_models(fin, fields).items():
                if model == "earnings" and (doc["kind"] != "financial" or not fin.get("quarter") or json.loads(version["parsed"]).get("documentDate") < fin["quarter"][1]):
                    continue
                if model == "earnings" and not store.db.execute("SELECT 1 FROM facts WHERE version=? AND metric='revenue' AND start=? AND end=? AND basis=? AND eligible=1", (version["id"], *fin["quarter"])).fetchone():
                    continue
                if model != "earnings" and not fields:
                    continue
                result.update({"company": company, "at": at, "modelVersion": MODEL_VERSION, "document": doc["id"], "version": version["id"], "sourceUrl": doc["url"], "timing": timing,
                    "basis": fin["basis"], "quarter": fin.get("quarter"), "fieldEvidence": fields, "policy": POLICY,
                    "financialVersions": sorted({v for f in fin["facts"].values() for v in f["versions"]})})
                gates = []
                if adverse:
                    gates.append("Verified adverse disclosure requires research before inclusion")
                    result["adverseEvidence"] = adverse
                if not market["liquid"]:
                    gates.append("Twenty recent trading sessions with median daily turnover of at least ₹1 crore")
                price = market["price"]
                if not price or age(at, price["session"]) > POLICY["maximumPriceAgeDays"]:
                    gates.append("Recent verified exchange price")
                if not fin.get("quarter") or age(at, fin["quarter"][1]) > POLICY["maximumFinancialAgeDays"]:
                    gates.append("Recent quarterly financials")
                eps = fin.get("valuationEPS")
                pe = D(price["close"]) / eps if price and eps and eps > 0 else None
                if pe is None or pe > POLICY["maximumPE"]:
                    gates.append("Positive verified TTM/annual diluted EPS and P/E no greater than 40")
                action_check = store.db.execute("SELECT * FROM checks WHERE key='market:actions'").fetchone()
                coverage = json.loads(action_check["detail"]) if action_check else {}
                eps_period = fin["quarter"][1] if fin.get("valuationPeriod") == "TTM" else fin["annual"][1] if fin.get("annual") else at[:10]
                if not action_check or action_check["error"] or coverage.get("from", "9999") > eps_period or coverage.get("to", "") < (price["session"] if price else at[:10]):
                    gates.append("Corporate-action coverage for the valuation period")
                elif store.db.execute("SELECT 1 FROM market_actions WHERE isin=? AND ex_date>? AND ex_date<=? AND (lower(subject) LIKE '%split%' OR lower(subject) LIKE '%bonus%' OR lower(subject) LIKE '%right%' OR lower(subject) LIKE '%merger%' OR lower(subject) LIKE '%consolidation%') LIMIT 1", (company, eps_period, price["session"] if price else at[:10])).fetchone():
                    gates.append("Capital action requires a verified EPS adjustment")
                if price:
                    result["priceAtAssessment"] = price
                    publication_day = stamp(timing["publishedAt"]).astimezone(dt.timezone(dt.timedelta(minutes=330))).date().isoformat()
                    anchors = [p for p in market["prices"] if p["session"]<publication_day and D(p["close"])>0 and D(p["volume"])>0]
                    if not anchors:
                        gates.append("Verified pre-disclosure price comparison")
                    else:
                        reaction = (D(price["close"])/D(anchors[-1]["close"])-1)*100
                        result["priceReaction"] = {"beforeSession":anchors[-1]["session"],"comparisonSession":price["session"],"changePct":str(reaction)}
                        if reaction > POLICY["maximumPostDisclosureRisePct"]:
                            gates.append("Price has risen more than 20% from the verified pre-disclosure close")
                result["valuation"] = {"pe": str(pe) if pe is not None else None, "period": fin.get("valuationPeriod")}
                result["missing"].extend(gates)
                result["qualified"] = result["qualified"] and not gates
                key = digest(canonical([company, model, at, doc["id"], MODEL_VERSION]))
                store.db.execute("INSERT OR IGNORE INTO recommendation_assessments VALUES(?,?,?,?,?)", (key, company, model, at, canonical(result)))
                assessed += 1
                for reason in result["missing"]:
                    missing_counts[reason] = missing_counts.get(reason, 0) + 1
                # One candidate per company/model; a newer failing development can withdraw an older case.
                rank = (timing["publishedAt"], version["first_observed"])
                if model not in latest_candidates or rank > latest_candidates[model][0]:
                    latest_candidates[model] = (rank, result)
        for model, (_, result) in latest_candidates.items():
            signal = store.db.execute("SELECT * FROM recommendation_signals WHERE company=? AND model=? AND catalyst=? AND model_version=?", (company, model, result["document"], MODEL_VERSION)).fetchone()
            if not signal:
                beginning = (stamp(at) - dt.timedelta(days=POLICY["caseCooldownDays"])).isoformat(timespec="seconds")
                signal = store.db.execute("SELECT * FROM recommendation_signals WHERE company=? AND model=? AND model_version=? AND issued_at>=? ORDER BY issued_at DESC LIMIT 1", (company, model, MODEL_VERSION, beginning)).fetchone()
            for previous in store.db.execute("SELECT id,catalyst FROM recommendation_signals WHERE company=? AND model=? AND model_version=?", (company, model, MODEL_VERSION)).fetchall():
                if not signal or previous["id"] != signal["id"]:
                    store.db.execute("INSERT OR IGNORE INTO recommendation_reviews VALUES(?,?,?)", (previous["id"], at, canonical({"qualified": False, "status": "superseded", "newDocument": result["document"], "latestAssessment": result})))
            if result["qualified"] and not signal:
                sid = digest(canonical([company, model, result["document"], MODEL_VERSION]))
                store.db.execute("INSERT OR IGNORE INTO recommendation_signals VALUES(?,?,?,?,?,?,?)", (sid, company, model, result["document"], MODEL_VERSION, at, canonical(result)))
                signal = store.db.execute("SELECT * FROM recommendation_signals WHERE id=?", (sid,)).fetchone()
            if signal:
                store.db.execute("INSERT OR IGNORE INTO recommendation_reviews VALUES(?,?,?)", (signal["id"], at, canonical(result)))
            if result["qualified"]:
                identity = json.loads(store.db.execute("SELECT identity FROM companies WHERE key=?", (company,)).fetchone()[0])
                rows.append({"id": signal["id"], "isin": company, "ticker": market["price"]["symbol"], "company": identity.get("name") or market["price"]["symbol"],
                    "model": model, "modelName": MODEL_NAMES[model], "score": result["score"], "catalyst": "; ".join(result["reasons"][:2]) + ".",
                    "price": market["price"]["close"], "priceAsOf": market["price"]["session"], "priceCheckedAt": market["price"]["observed_at"], "issuedAt": signal["issued_at"],
                    "sourceUrl": result["sourceUrl"], "evidenceDate": result["timing"]["documentDate"], "details": result})
        store.db.commit()
    # A company appears once; retain every model and signal in the durable ledger.
    unique = {}
    for row in sorted(rows, key=lambda r: (-r["score"], r["model"], r["id"])):
        unique.setdefault(row["isin"], row)
    return {"rows": list(unique.values()), "assessments": assessed, "missing": missing_counts}
