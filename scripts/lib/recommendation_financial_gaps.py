"""Exact financial coverage and paced, company-specific original filing backfill.

This collects evidence, never changes the frozen catalyst rules or substitutes older profits
for a known loss. Mutable queue/coverage rows are derived state; source versions and decisions
remain immutable, and every published SQLite generation retains its coverage snapshot.
"""
import datetime as dt
import json
import subprocess
import time
from xml.etree.ElementTree import ParseError

from recommendation_foundation import canonical, day, iso_now
from recommendation_models import financials, POLICY, indian_day
from recommendation_sources import FAMILIES, BudgetExceeded, SourceFailure, capture_window, read_document

POSITIVE = ("revenue", "net_profit", "pbt_before_exceptional", "eps_diluted_total")
QUALITY = ("other_income", "exceptional_before_tax")


def schema(store):
    store.db.executescript("""
      CREATE TABLE IF NOT EXISTS financial_gap_state(company TEXT PRIMARY KEY,at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS financial_gap_walks(company TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS financial_gap_audits(at TEXT PRIMARY KEY,summary TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gap_documents_company ON documents(company,kind);
    """)


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
            raw=json.loads(observation[0]);end=day(raw.get("qe_Date") or raw.get("toDate"))
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
    symbols = {s[:-3] if s.endswith("-SM") else s for s in identity.get("symbols", []) if isinstance(s,str) and s}
    symbol = next(iter(symbols)) if len(symbols) == 1 else None
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
        "missing": missing, "needsBackfill": bool(missing), "symbol": symbol,
        "sourceSupport": "nse-company-index" if symbol else "ambiguous-symbol" if symbols else "bse-only-adapter-unavailable",
        "sme": any(s.endswith("-SM") for s in identity.get("symbols", []))}


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
        ends = {day(m.get("qe_Date") or m.get("toDate")) for m in metadata}
        audited = any(str(m.get("audited", "")).strip().lower() == "audited" or m.get("period") == "Annual" for m in metadata)
        fresh_ends = {e for e in ends if e and e >= (dt.date.fromisoformat(indian_day(gap["at"]))-dt.timedelta(days=550)).isoformat()}
        if (not gap["quarter"] or ends & required or audited and fresh_ends or
                any(e >= gap["quarter"][1] for e in ends if e) or not any(ends)):
            selected.append(doc)
    return sorted(selected, key=lambda d: (d["status"] == "failed", d["first_seen"], d["id"]))


def fill_financial_gaps(store, reader, lookup, scratch, audit, maximum=100, seconds=240):
    schema(store)
    at = iso_now()
    recent = (dt.date.fromisoformat(indian_day(at))-dt.timedelta(days=45)).isoformat()
    attention = {r[0] for r in store.db.execute("""SELECT DISTINCT d.company FROM documents d JOIN observations o ON o.document=d.id
        WHERE d.kind='catalyst' AND o.published_at>=? AND o.published_at<=?""", (recent,at))}
    walks = {r["company"]: json.loads(r["state"]) for r in store.db.execute("SELECT * FROM financial_gap_walks")}
    candidates = [r for r in audit["companies"] if r["needsBackfill"] and r["symbol"] and
        walks.get(r["company"],{}).get("nextRetry", "") <= at]
    def priority(r):
        w=walks.get(r["company"], {})
        current = r["quarter"] and (dt.date.fromisoformat(indian_day(at))-dt.date.fromisoformat(r["quarter"][1])).days <= POLICY["maximumFinancialAgeDays"]
        known_failure = bool(r["conflicts"]) or r["cashFlow"]["state"] == "nonpositive" or any(
            f["periodRole"] == "current" and f["state"] == "nonpositive" for f in r["fields"])
        return (not w.get("inProgress",False), not (current or r["company"] in attention), known_failure, w.get("lastAttempt", ""), r["company"])
    candidates.sort(key=priority)
    original_max, original_deadline = reader.maximum, getattr(reader,"deadline",None)
    reader.maximum = min(original_max, reader.used+maximum)
    if original_deadline is not None:
        reader.deadline = min(original_deadline,time.monotonic()+seconds)
    attempted, used_start = 0, reader.used
    try:
        for gap in candidates[:12]:
            company, identity = gap["company"], json.loads(store.db.execute("SELECT identity FROM companies WHERE key=?",(gap["company"],)).fetchone()[0])
            walk = walks.get(company,{})
            if not walk.get("inProgress"):
                walk = {"from": max(store.get("historyStart") or "1900-01-01", (dt.date.fromisoformat(indian_day(at))-dt.timedelta(days=2*366)).isoformat()),
                    "to": indian_day(at), "family": 0, "inProgress": True}
            walk["lastAttempt"] = at
            order = [FAMILIES[1],FAMILIES[0],*FAMILIES[5:],*FAMILIES[2:5]] if gap["sme"] else FAMILIES
            walk.setdefault("familyOrder", [f[0] for f in order])
            families = [next(f for f in FAMILIES if f[0] == name) for name in walk["familyOrder"]]
            attempted += 1
            interrupted = False
            attempted_docs = set()
            try:
                while walk["family"] < len(families):
                    family = families[walk["family"]]
                    if not capture_window(store,reader,family,walk["from"],walk["to"],lookup,phase="financial-gap",symbol=gap["symbol"],expected_isin=company):
                        walk["status"] = "source-failed"
                        walk["nextRetry"] = (dt.datetime.fromisoformat(at)+dt.timedelta(days=1)).isoformat(timespec="seconds")
                        break
                    # Recompute after each source family; absent data and known losses remain different.
                    current = company_gap(store,company,identity,iso_now())
                    pending = [d for d in relevant_documents(store,current) if d["id"] not in attempted_docs]
                    while pending:
                        for doc in pending:
                            attempted_docs.add(doc["id"])
                            try:
                                read_document(store,reader,doc,iso_now(),scratch)
                            except (SourceFailure,ValueError,ParseError,subprocess.SubprocessError,FileNotFoundError) as error:
                                retry=(dt.datetime.fromisoformat(at)+dt.timedelta(days=1)).isoformat(timespec="seconds")
                                store.db.execute("UPDATE documents SET checked_at=?,status='failed',next_retry=?,error=? WHERE id=?",
                                    (iso_now(),retry,type(error).__name__+": "+str(error)[:300],doc["id"]))
                                store.db.commit()
                        current = company_gap(store,company,identity,iso_now())
                        pending = [d for d in relevant_documents(store,current) if d["id"] not in attempted_docs]
                    if not current["needsBackfill"]:
                        walk.update(inProgress=False,nextRetry="",status="source-conflicts-remain" if current["conflicts"] else "required-data-present",lastSuccess=iso_now())
                        break
                    walk["family"] += 1
                    if walk["family"] == len(families):
                        walk.update(inProgress=False,status="source-windows-read-gaps-remain",nextRetry=(dt.datetime.fromisoformat(at)+dt.timedelta(days=7)).isoformat(timespec="seconds"))
            except BudgetExceeded:
                interrupted = True
                walk.update(status="budget-pending",nextRetry="")
            finally:
                store.db.execute("INSERT OR REPLACE INTO financial_gap_walks VALUES(?,?)",(company,canonical(walk)))
                store.db.commit()
            if interrupted:
                break
    finally:
        reader.maximum = original_max
        if original_deadline is not None:
            reader.deadline = original_deadline
        store.set("financialGapLastWalk",{"at":at,"finishedAt":iso_now(),"companiesAttempted":attempted,
            "requests":reader.used-used_start,"requestCeiling":maximum,"secondsCeiling":seconds})
        store.db.commit()
