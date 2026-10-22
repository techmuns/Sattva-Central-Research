"""Exact financial coverage and paced, company-specific original filing backfill.

This collects evidence, never changes the frozen catalyst rules or substitutes older profits
for a known loss. Mutable queue/coverage rows are derived state; source versions and decisions
remain immutable, and every published SQLite generation retains its coverage snapshot.
"""
import datetime as dt
import json
import subprocess
import time
from decimal import Decimal
from xml.etree.ElementTree import ParseError

from recommendation_foundation import canonical, day, iso_now
from recommendation_models import financials, score_models, evidence_date, MODEL_VERSION, POLICY, indian_day
from recommendation_sources import FAMILIES, BudgetExceeded, SourceFailure, capture_window, capture_bse_company, read_document

POSITIVE = ("revenue", "net_profit", "pbt_before_exceptional", "eps_diluted_total")
QUALITY = ("other_income", "exceptional_before_tax")

# Only collection priority uses these names. Eligibility remains exclusively in the frozen models.
FINANCIAL_REQUIREMENTS = {
    "Comparable quarterly financial history", "Recent quarterly financials",
    "Positive same-basis revenue, profit, pre-exceptional PBT and diluted EPS for the quarter and year-earlier quarter",
    "Verified limited exceptional items and other income", "Verified TTM or annual revenue baseline",
    "Positive reported operating cash flow requires verification",
    "Positive verified TTM/annual diluted EPS and P/E no greater than 40",
}


def schema(store):
    store.db.executescript("""
      CREATE TABLE IF NOT EXISTS financial_gap_state(company TEXT PRIMARY KEY,at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS financial_gap_walks(company TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS financial_gap_audits(at TEXT PRIMARY KEY,summary TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gap_documents_company ON documents(company,kind);
    """)
    if store.db.execute("SELECT 1 FROM sqlite_master WHERE name='recommendation_assessments'").fetchone():
        store.db.execute("CREATE INDEX IF NOT EXISTS gap_assessment_time ON recommendation_assessments(at)")


def previous_year(value):
    date = dt.date.fromisoformat(value)
    try:
        return date.replace(year=date.year-1).isoformat()
    except ValueError:
        return date.replace(year=date.year-1, day=28).isoformat()


def company_gap(store, company, identity, at, known=True):
    fin = financials(store, company, at) if known else {"facts": {}, "conflicts": [], "quarter": None, "basis": None}
    quarter, prior = fin.get("quarter"), fin.get("prior")
    expected_prior = tuple([previous_year(quarter[0]), previous_year(quarter[1]), quarter[2]]) if quarter else None
    conflicts = {tuple(c) for c in fin["conflicts"]}
    fields = []
    for label, period, metrics in [("current", quarter, POSITIVE+QUALITY), ("year-earlier", prior or expected_prior, POSITIVE)]:
        for metric in metrics:
            key = (metric, *period) if period else None
            fact = fin["facts"].get(key)
            state = "conflicting" if key in conflicts else "missing" if fact is None else (
                "nonpositive" if metric in POSITIVE and fact["value"] <= 0 else "available")
            fields.append({"periodRole": label, "metric": metric, "period": period, "state": state,
                "value": str(fact["value"]) if fact else None, "versions": fact["versions"] if fact else []})
    cash = sorted([(end, start, f) for (metric, start, end, basis), f in fin["facts"].items()
        if quarter and metric == "operating_cash_flow" and start and basis == fin["basis"]
        and 150 <= (dt.date.fromisoformat(end)-dt.date.fromisoformat(start)).days <= 380
        and end >= (dt.date.fromisoformat(quarter[1])-dt.timedelta(days=400)).isoformat()], key=lambda x: x[0], reverse=True)
    latest_cash = [c for c in cash if c[0] == cash[0][0]] if cash else []
    cash_state = "missing" if not cash else "available" if all(c[2]["value"] > 0 for c in latest_cash) else "nonpositive"
    valuation, baseline = fin.get("valuationEPS"), fin.get("baselineRevenue")
    baseline_conflicts = [c for c in conflicts if quarter and c[3] == fin["basis"] and c[1]
        and c[0] in ("revenue", "eps_diluted_total") and
        (330 <= (dt.date.fromisoformat(c[2])-dt.date.fromisoformat(c[1])).days <= 380 or c[1:4] in fin.get("quarters", [])[-4:])]
    valuation_state = "conflicting" if valuation is None and baseline_conflicts else "missing" if valuation is None else "nonpositive" if valuation <= 0 else "available"
    baseline_state = "conflicting" if baseline is None and any(c[0] == "revenue" for c in baseline_conflicts) else "missing" if baseline is None else "nonpositive" if baseline <= 0 else "available"
    if any(c[0] == "operating_cash_flow" and quarter and c[3] == fin["basis"] and c[1]
            and 150 <= (dt.date.fromisoformat(c[2])-dt.date.fromisoformat(c[1])).days <= 380
            and c[2] >= (cash[0][0] if cash else (dt.date.fromisoformat(quarter[1])-dt.timedelta(days=400)).isoformat()) for c in conflicts):
        cash_state = "conflicting"
    missing = [f["periodRole"]+":"+f["metric"] for f in fields if f["state"] == "missing"]
    known_ends = []
    if quarter:
        for observation in store.db.execute("""SELECT o.raw FROM documents d JOIN observations o ON o.document=d.id
                WHERE d.company=? AND d.kind='financial' AND o.observed_at<=?""", (company,at)):
            raw=json.loads(observation[0]);end=day(raw.get("qe_Date") or raw.get("toDate") or raw.get("bseReportingEndHint"))
            if end and end <= indian_day(at):known_ends.append(end)
        if (dt.date.fromisoformat(indian_day(at))-dt.date.fromisoformat(quarter[1])).days > POLICY["maximumFinancialAgeDays"]:
            missing.append("current:recent-quarter")
        if known_ends and max(known_ends)>quarter[1]:
            missing.append("current:newer-known-period")
    if valuation_state == "missing":
        missing.append("annual-or-TTM:diluted-EPS")
    if baseline_state == "missing":
        missing.append("annual-or-TTM:revenue")
    if cash_state == "missing":
        missing.append("annual-or-half-year:operating-cash-flow")
    # BSE tickers and historical aliases are useful identities, but are not proof of an NSE listing.
    symbols = {s for s in identity.get("nseSymbols", []) if isinstance(s,str) and s}
    symbol = next(iter(symbols)) if len(symbols) == 1 else None
    codes = {c for c in identity.get("bseCodes", []) if isinstance(c,str) and len(c) == 6 and c.isascii() and c.isdigit()}
    bse_code = next(iter(codes)) if len(codes) == 1 and not symbols and "nseSymbols" in identity else None
    return {"company": company, "name": identity.get("name"), "at": at, "basis": fin["basis"], "quarter": quarter,
        "yearEarlierQuarter": prior, "expectedYearEarlierQuarter": expected_prior,
        "annualPeriod": fin.get("annual"), "reportedQuarters": fin.get("quarters", []), "fields": fields,
        "latestKnownReportingEnd": max(known_ends) if known_ends else None,
        "valuation": {"state": valuation_state,
            "dilutedEPS": str(valuation) if valuation is not None else None, "period": fin.get("valuationPeriod")},
        "revenueBaseline": {"state": baseline_state,
            "period": fin.get("baselinePeriod")},
        "cashFlow": {"state": cash_state, "statements": [{"start": c[1], "end": c[0], "value": str(c[2]["value"]),
            "versions": c[2]["versions"]} for c in latest_cash]}, "conflicts": fin["conflicts"],
        "missing": missing, "needsBackfill": bool(missing), "symbol": symbol, "bseCode": bse_code,
        "sourceSupport": "nse-company-index" if symbol else "ambiguous-symbol" if symbols else
            "exchange-provenance-unavailable" if "nseSymbols" not in identity else
            "bse-company-index" if bse_code else "ambiguous-bse-code" if codes else
            "bse-only-adapter-unavailable" if "nseSymbols" in identity else "exchange-provenance-unavailable",
        "sme": bool(identity.get("nseSME"))}


def audit_financial_gaps(store, at, persist=True):
    known = {r[0] for r in store.db.execute("SELECT DISTINCT company FROM facts WHERE eligible=1")}
    rows = [company_gap(store, c["key"], json.loads(c["identity"]), at, c["key"] in known)
        for c in store.db.execute("SELECT * FROM companies ORDER BY key")]
    def counts(group):
        return {"companies": len(group), "withQuarter": sum(bool(r["quarter"]) for r in group),
            "withYearEarlierQuarter": sum(bool(r["yearEarlierQuarter"]) for r in group),
            "withValuationEPS": sum(r["valuation"]["dilutedEPS"] is not None for r in group),
            "withPositiveCashFlow": sum(r["cashFlow"]["state"] == "available" for r in group),
            "missingValuationEPS": sum(r["valuation"]["state"] == "missing" for r in group),
            "missingCashFlow": sum(r["cashFlow"]["state"] == "missing" for r in group),
            "knownNonpositiveCashFlow": sum(r["cashFlow"]["state"] == "nonpositive" for r in group),
            "conflictingCompanies": sum(bool(r["conflicts"]) for r in group),
            "needsBackfill": sum(r["needsBackfill"] for r in group)}
    summary = {"version": 1, "at": at, "universe": counts(rows),
        "currentQuarterCompanies": counts([r for r in rows if r["quarter"] and
            (dt.date.fromisoformat(indian_day(at))-dt.date.fromisoformat(r["quarter"][1])).days <= POLICY["maximumFinancialAgeDays"]]),
        "unsupportedBSEOnly": sum(r["sourceSupport"] == "bse-only-adapter-unavailable" for r in rows),
        "supportedBSEOnly": sum(r["sourceSupport"] == "bse-company-index" for r in rows),
        "ambiguousBSECodes": sum(r["sourceSupport"] == "ambiguous-bse-code" for r in rows),
        "unverifiedExchangeIdentity": sum(r["sourceSupport"] == "exchange-provenance-unavailable" for r in rows),
        "ambiguousSymbols": sum(r["sourceSupport"] == "ambiguous-symbol" for r in rows),
        "modelRulesChanged": False, "status": "partial", "details": "Exact field/period/value/provenance rows are retained in financial_gap_state; missing differs from nonpositive and conflicting."}
    states = {}
    if store.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='financial_gap_walks'").fetchone():
        for (value,) in store.db.execute("SELECT state FROM financial_gap_walks"):
            status=json.loads(value).get("status","pending")
            states[status]=states.get(status,0)+1
    summary["targetedCollection"]={"states":states,"lastWalk":store.get("financialGapLastWalk"),
        "failedSourceChecks":store.db.execute("SELECT count(*) FROM checks WHERE key LIKE 'gap-source:%' AND error IS NOT NULL").fetchone()[0]}
    if persist:
        schema(store)
        store.db.executemany("INSERT OR REPLACE INTO financial_gap_state VALUES(?,?,?)", [(r["company"], at, canonical(r)) for r in rows])
        store.db.execute("INSERT OR IGNORE INTO financial_gap_audits VALUES(?,?)", (at, canonical(summary)))
        store.set("financialGapSummary", summary)
        store.db.commit()
    return {"summary": summary, "companies": rows}


def relevant_documents(store, gap):
    """Read every known filing/revision for required periods, without selecting favourable values."""
    required = {p[1] for p in [gap["quarter"], gap["expectedYearEarlierQuarter"], gap["annualPeriod"]] if p}
    selected = []
    for doc in store.db.execute("SELECT * FROM documents WHERE company=? AND kind='financial'", (gap["company"],)):
        if doc["status"] == "read" or doc["next_retry"] and doc["next_retry"] > gap["at"]:
            continue
        observations = store.db.execute("SELECT raw FROM observations WHERE document=?", (doc["id"],)).fetchall()
        metadata = [json.loads(r[0]) for r in observations]
        ends = {day(m.get("qe_Date") or m.get("toDate") or m.get("bseReportingEndHint")) for m in metadata}
        audited = any(str(m.get("audited", "")).strip().lower() == "audited" or m.get("period") == "Annual" for m in metadata)
        fresh_ends = {e for e in ends if e and e >= (dt.date.fromisoformat(indian_day(gap["at"]))-dt.timedelta(days=550)).isoformat()}
        if any(m.get("bseReportingEndHint") for m in metadata) and not fresh_ends and not ends & required:
            continue  # Older original links remain retained; targeted reads serve required periods first.
        if (not gap["quarter"] or ends & required or audited and fresh_ends or
                any(e >= gap["quarter"][1] for e in ends if e) or not any(ends)):
            # New/current revisions come first; all required revisions still get read, even
            # after an earlier document fills the gap. Metadata ranks reads, never supplies facts.
            role = 0 if gap["quarter"] and any(e >= gap["quarter"][1] for e in ends if e) else (
                1 if gap["expectedYearEarlierQuarter"] and gap["expectedYearEarlierQuarter"][1] in ends else
                2 if audited and fresh_ends else 3)
            selected.append((role, max((e for e in ends if e), default=""), doc))
    return [d for _, _, d in sorted(selected, key=lambda item: (item[2]["status"] == "issuer-unverified", item[0],
        -dt.date.fromisoformat(item[1]).toordinal() if item[1] else 0,
        item[2]["url"].endswith(".xml") and "/XBRLFILES/" in item[2]["url"], item[2]["status"] == "failed",
        item[2]["first_seen"], item[2]["id"]))]


def collection_profiles(store, gaps, at):
    """Rank current evidence gaps without creating decisions or consulting future outcomes."""
    if not store.db.execute("SELECT 1 FROM sqlite_master WHERE name='recommendation_assessments'").fetchone():
        return {}
    latest = store.db.execute("SELECT max(at) FROM recommendation_assessments WHERE at<=?", (at,)).fetchone()[0]
    assessments = {}
    for row in store.db.execute("SELECT payload FROM recommendation_assessments WHERE at=?", (latest,)):
        result = json.loads(row[0])
        company, model = result["company"], result["model"]
        if company not in gaps or result.get("modelVersion") != MODEL_VERSION:
            continue
        # Use the newest disclosure per model, including failures; never revive an older pass.
        key = (company, model)
        rank = (result["timing"]["publishedAt"], result["version"])
        if key not in assessments or rank > assessments[key][0]:
            assessments[key] = (rank, result)
    profiles, financial_cache = {}, {}
    for (company, model), (_, previous) in assessments.items():
        if not evidence_date(store, previous["document"], at):
            continue
        version = store.db.execute("SELECT first_observed FROM versions WHERE id=? AND document=? AND first_observed<=?",
            (previous["version"],previous["document"],at)).fetchone()
        if not version or store.db.execute("SELECT 1 FROM versions WHERE document=? AND first_observed>? AND first_observed<=?",
                (previous["document"],version[0],at)).fetchone():
            continue  # A changed original needs a new assessment before its old extracted terms rank work.
        gap = gaps[company]
        if company not in financial_cache:
            financial_cache[company] = financials(store, company, at)
        fin = financial_cache[company]
        result = score_models(fin, previous.get("fieldEvidence"))[model]
        combined = "Unambiguous INR order value and revenue baseline"
        missing = set(result["missing"]) | (set(previous["missing"]) - FINANCIAL_REQUIREMENTS -
            {combined, "Conflicting financial filings require reconciliation"})
        if gap["valuation"]["state"] == "missing":
            missing.add("Positive verified TTM/annual diluted EPS and P/E no greater than 40")
        if not gap["quarter"] or (dt.date.fromisoformat(indian_day(at))-dt.date.fromisoformat(gap["quarter"][1])).days > POLICY["maximumFinancialAgeDays"]:
            missing.add("Recent quarterly financials")
        financial = missing & FINANCIAL_REQUIREMENTS
        # The combined order requirement is financial only when the primary order value exists.
        if combined in missing and previous.get("fieldEvidence", {}).get("orderValue", {}).get("value"):
            financial.add(combined)
        if not financial:
            continue
        blockers = []
        if gap["conflicts"]: blockers.append("Conflicting financial filings")
        if gap["cashFlow"]["state"] in ("nonpositive", "conflicting"): blockers.append("Reported operating cash flow")
        if gap["valuation"]["state"] in ("nonpositive", "conflicting"): blockers.append("Reported diluted EPS")
        if model == "earnings" and any(f["state"] == "nonpositive" for f in gap["fields"]):
            blockers.append("Reported quarterly loss/nonpositive metric")
        if model == "earnings" and "Verified limited exceptional items and other income" in result["missing"] and all(
                f["state"] == "available" for f in gap["fields"] if f["periodRole"] == "current" and f["metric"] in QUALITY):
            blockers.append("Reported earnings quality exceeds policy limits")
        if model in ("orders", "capacity") and gap["revenueBaseline"]["state"] in ("nonpositive", "conflicting"):
            blockers.append("Reported revenue baseline")
        features = result.get("features", {})
        if model == "earnings" and features and any(Decimal(features[k]) < threshold for k, threshold in (
                ("revenueGrowthPct",15),("profitGrowthPct",20),("underlyingPBTGrowthPct",20),("dilutedEPSGrowthPct",15))):
            blockers.append("Reported growth below the frozen model thresholds")
        # A known failed valuation is not repairable by looking for an older, better EPS.
        eps, price = fin.get("valuationEPS"), previous.get("priceAtAssessment", {})
        if eps and eps > 0 and price.get("close"):
            if Decimal(price["close"]) / eps > POLICY["maximumPE"]: blockers.append("Verified P/E exceeds policy")
        profile = {"model": model, "verifiedScore": result["score"], "financialRequirements": sorted(financial),
            "otherRequirements": sorted(missing-financial), "knownBlockers": blockers,
            "assessmentAt": previous["at"], "document": previous["document"]}
        rank = (bool(blockers), len(profile["otherRequirements"]), -result["score"], len(financial))
        if company not in profiles or rank < profiles[company][0]: profiles[company] = (rank, profile)
    return {company: profile for company, (_, profile) in profiles.items()}


def collection_queue(store, audit, walks, at):
    recent = (dt.date.fromisoformat(indian_day(at))-dt.timedelta(days=45)).isoformat()
    attention = {r[0] for r in store.db.execute("""SELECT DISTINCT d.company FROM documents d JOIN observations o ON o.document=d.id
        WHERE d.kind='catalyst' AND o.published_at>=? AND o.published_at<=? AND o.observed_at<=?""", (recent,at,at))}
    known_pending = {r[0] for r in store.db.execute("""SELECT DISTINCT company FROM documents
        WHERE kind='financial' AND status!='read' AND (next_retry IS NULL OR next_retry<=?)""", (at,))}
    new_bse = {r["company"] for r in store.db.execute("""SELECT d.company,max(d.first_seen) AS observed FROM documents d
        JOIN observations o ON o.document=d.id WHERE d.kind='financial' AND o.source='bse:financial-results:recent'
        AND d.first_seen<=? AND d.first_seen>=? AND d.status!='read' AND (d.next_retry IS NULL OR d.next_retry<=?)
        GROUP BY d.company""", (at,recent,at)) if r["observed"] > walks.get(r["company"],{}).get("lastAttempt", "")}
    attention.update(new_bse)
    refresh_before = (dt.datetime.fromisoformat(at)-dt.timedelta(days=7)).isoformat(timespec="seconds")
    candidates = {r["company"]: r for r in audit["companies"] if (r["needsBackfill"] or r.get("bseCode") and
        walks.get(r["company"],{}).get("lastSuccess", "") <= refresh_before) and
        (r["symbol"] or r.get("bseCode") or r["company"] in known_pending) and
        (walks.get(r["company"],{}).get("nextRetry", "") <= at or r["company"] in new_bse and
            walks.get(r["company"],{}).get("status") in {"required-data-present", "bse-response-read-gaps-remain", "source-conflicts-remain"})}
    profiles = collection_profiles(store, candidates, at)
    def priority(company):
        gap, p = candidates[company], profiles.get(company)
        current = gap["quarter"] and (dt.date.fromisoformat(indian_day(at))-dt.date.fromisoformat(gap["quarter"][1])).days <= POLICY["maximumFinancialAgeDays"]
        bad = bool(gap["conflicts"]) or gap["cashFlow"]["state"] == "nonpositive"
        tier = (4 if p["knownBlockers"] else 0 if not p["otherRequirements"] else 1) if p else (2 if current or company in attention else 3)
        return (tier, bool(p["knownBlockers"]) if p else bad, len(p["otherRequirements"]) if p else 0,
            not bool(current), -p["verifiedScore"] if p else 0, len(gap["missing"]), walks.get(company,{}).get("lastAttempt", ""), company)
    ranked = sorted(candidates, key=priority)
    bse = iter(c for c in ranked if candidates[c].get("bseCode"))
    oldest = iter(sorted(candidates, key=lambda c: (walks.get(c,{}).get("lastAttempt", ""), c)))
    queue, selected = [], set()
    for company in ranked:
        if company in selected: continue
        queue.append((candidates[company], profiles.get(company), "priority"));selected.add(company)
        if len(queue) % 4 == 1:
            # Reserve one company turn per four for supported BSE-only issuers, closest first.
            # This does not raise the shared request ceiling or displace the oldest-waiting turn.
            next_bse = next((c for c in bse if c not in selected), None)
            if next_bse:
                queue.append((candidates[next_bse], profiles.get(next_bse), "bse-priority")); selected.add(next_bse)
        if len(queue) % 4 == 3:
            fair = next((c for c in oldest if c not in selected), None)
            if fair:
                queue.append((candidates[fair], profiles.get(fair), "oldest-waiting"));selected.add(fair)
    return queue


def fill_financial_gaps(store, reader, lookup, scratch, audit, maximum=100, seconds=240, company_maximum=12):
    schema(store)
    at = iso_now()
    walks = {r["company"]: json.loads(r["state"]) for r in store.db.execute("SELECT * FROM financial_gap_walks")}
    candidates = collection_queue(store, audit, walks, at)
    original_max, original_deadline = reader.maximum, getattr(reader,"deadline",None)
    reader.maximum = min(original_max, reader.used+maximum)
    phase_deadline = min(original_deadline if original_deadline is not None else float("inf"), time.monotonic()+seconds)
    if original_deadline is not None:
        reader.deadline = phase_deadline
    phase_maximum = reader.maximum
    attempted, used_start = 0, reader.used
    lanes, document_reads, index_requests = {}, 0, 0
    try:
        # Bound CPU even during a host cooldown; actual source work stays inside the shared slice.
        for gap, profile, lane in candidates[:maximum]:
            if reader.used >= phase_maximum or time.monotonic() >= phase_deadline: break
            company_start = reader.used
            reader.maximum = min(phase_maximum, reader.used+company_maximum)
            company, identity = gap["company"], json.loads(store.db.execute("SELECT identity FROM companies WHERE key=?",(gap["company"],)).fetchone()[0])
            walk = walks.get(company,{})
            if not walk.get("inProgress"):
                walk = {"from": max(store.get("historyStart") or "1900-01-01", (dt.date.fromisoformat(indian_day(at))-dt.timedelta(days=2*366)).isoformat()),
                    "to": indian_day(at), "family": 0, "inProgress": True}
            walk["lastAttempt"] = at
            walk["collectionPriority"] = profile
            walk["lane"] = lane
            order = [FAMILIES[1],FAMILIES[0],*FAMILIES[5:],*FAMILIES[2:5]] if gap["sme"] else FAMILIES
            walk.setdefault("familyOrder", [f[0] for f in order])
            families = [next(f for f in FAMILIES if f[0] == name) for name in walk["familyOrder"]]
            attempted += 1
            lanes[lane] = lanes.get(lane,0)+1
            interrupted = False
            attempted_docs = set()
            try:
                while True:
                    # Spend on already-discovered evidence before rediscovering the same index.
                    current = company_gap(store,company,identity,iso_now())
                    pending = [d for d in relevant_documents(store,current) if d["id"] not in attempted_docs]
                    while pending:
                        for doc in pending:
                            attempted_docs.add(doc["id"])
                            try:
                                document_reads += 1
                                read_document(store,reader,doc,iso_now(),scratch)
                            except (SourceFailure,ValueError,ParseError,subprocess.SubprocessError,FileNotFoundError) as error:
                                retry=(dt.datetime.fromisoformat(at)+dt.timedelta(days=1)).isoformat(timespec="seconds")
                                store.db.execute("UPDATE documents SET checked_at=?,status='failed',next_retry=?,error=? WHERE id=?",
                                    (iso_now(),retry,type(error).__name__+": "+str(error)[:300],doc["id"]))
                                store.db.commit()
                        current = company_gap(store,company,identity,iso_now())
                        pending = [d for d in relevant_documents(store,current) if d["id"] not in attempted_docs]
                    if gap.get("bseCode") and not walk.get("bseIndexRead") and (current["needsBackfill"] or not gap["needsBackfill"]):
                        before_index = reader.used
                        try:
                            complete = capture_bse_company(store,reader,gap["bseCode"],company,lookup)
                        finally:
                            index_requests += reader.used-before_index
                        if not complete:
                            walk.update(status="source-failed", nextRetry=(dt.datetime.fromisoformat(at)+dt.timedelta(days=1)).isoformat(timespec="seconds"))
                            break
                        walk["bseIndexRead"] = True
                        store.db.execute("INSERT OR REPLACE INTO financial_gap_walks VALUES(?,?)",(company,canonical(walk)))
                        store.db.commit()  # Resume original reads without re-spending the index request.
                        continue
                    if not current["needsBackfill"]:
                        walk.update(inProgress=False,nextRetry=(dt.datetime.fromisoformat(at)+dt.timedelta(days=7)).isoformat(timespec="seconds") if gap.get("bseCode") else "",
                            status="source-conflicts-remain" if current["conflicts"] else "required-data-present",lastSuccess=iso_now())
                        break
                    if gap.get("bseCode"):
                        walk.update(inProgress=False,status="bse-response-read-gaps-remain",lastSuccess=iso_now(),
                            nextRetry=(dt.datetime.fromisoformat(at)+dt.timedelta(days=7)).isoformat(timespec="seconds"))
                        break
                    if not gap["symbol"]:
                        walk.update(inProgress=False,status="source-adapter-unavailable",nextRetry="")
                        break  # Known original filings remain usable; an exchange ticker is never guessed.
                    if walk["family"] == len(families):
                        walk.update(inProgress=False,status="source-windows-read-gaps-remain",nextRetry=(dt.datetime.fromisoformat(at)+dt.timedelta(days=7)).isoformat(timespec="seconds"))
                        break
                    family = families[walk["family"]]
                    before_index = reader.used
                    try:
                        complete = capture_window(store,reader,family,walk["from"],walk["to"],lookup,
                            phase="financial-gap",symbol=gap["symbol"],expected_isin=company)
                    finally:
                        index_requests += reader.used-before_index
                    if not complete:
                        walk["status"] = "source-failed"
                        walk["nextRetry"] = (dt.datetime.fromisoformat(at)+dt.timedelta(days=1)).isoformat(timespec="seconds")
                        break
                    # Advance before document reads. A document interruption cannot re-spend
                    # a completed family request; unfinished pages keep capture_window's cursor.
                    walk["family"] += 1
            except BudgetExceeded:
                interrupted = True
                walk.update(status="budget-pending",nextRetry="")
            finally:
                walk["requestsLastAttempt"] = reader.used-company_start
                store.db.execute("INSERT OR REPLACE INTO financial_gap_walks VALUES(?,?)",(company,canonical(walk)))
                store.db.commit()
                reader.maximum = phase_maximum
            if interrupted and (reader.used >= phase_maximum or time.monotonic() >= phase_deadline or not store.has_capacity()):
                break
    finally:
        reader.maximum = original_max
        if original_deadline is not None:
            reader.deadline = original_deadline
        store.set("financialGapLastWalk",{"at":at,"finishedAt":iso_now(),"companiesAttempted":attempted,
            "requests":reader.used-used_start,"requestCeiling":maximum,"secondsCeiling":seconds,
            "collectionOrderVersion":3,"companyRequestCeiling":company_maximum,"lanes":lanes,
            "documentReadAttempts":document_reads,"indexRequests":index_requests})
        store.db.commit()
