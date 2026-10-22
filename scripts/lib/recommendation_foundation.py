"""Public evidence only. No model, broker, commercial API or application runtime dependency."""
import datetime as dt
import decimal
import hashlib
import json
import re
import sqlite3
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

VERSION = 1
MAX_DATABASE = 4 * 1024 * 1024 * 1024
XBRLI = "http://www.xbrl.org/2003/instance"
MONTHS = {m.lower(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
METRICS = {
    "RevenueFromOperations": "revenue", "OtherIncome": "other_income", "Income": "total_income",
    "Expenses": "total_expenses", "FinanceCosts": "finance_costs",
    "DepreciationDepletionAndAmortisationExpense": "depreciation",
    "ProfitBeforeExceptionalItemsAndTax": "pbt_before_exceptional",
    "ExceptionalItemsBeforeTax": "exceptional_before_tax", "ProfitBeforeTax": "pbt",
    "TaxExpense": "tax_expense", "ProfitLossForPeriod": "net_profit",
    "ProfitLossForPeriodFromContinuingOperations": "profit_continuing",
    "ProfitLossAttributableToOwnersOfParent": "pat_owners",
    "DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations": "eps_diluted_total",
    "DilutedEarningsLossPerShareFromContinuingOperations": "eps_diluted_continuing",
    "BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations": "eps_basic_total",
    "PaidUpValueOfEquityShareCapital": "paid_up_equity", "EquityShareCapital": "equity_capital",
    "FaceValueOfEquityShareCapital": "face_value", "Assets": "assets",
    "CashAndCashEquivalents": "cash_equivalents", "Inventories": "inventories",
    "CurrentBorrowings": "current_borrowings", "NoncurrentBorrowings": "noncurrent_borrowings",
    "BorrowingsCurrent": "current_borrowings", "BorrowingsNonCurrent": "noncurrent_borrowings",
    "TradeReceivablesCurrent": "current_receivables", "TradeReceivablesNonCurrent": "noncurrent_receivables",
    "CashFlowsFromUsedInOperatingActivities": "operating_cash_flow",
    "NetCashFlowsFromUsedInOperatingActivities": "operating_cash_flow",
    "PurchaseOfPropertyPlantAndEquipment": "purchase_ppe",
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def iso_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def day(value):
    text = str(value or "").strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            return dt.date.fromisoformat(text).isoformat()
        for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%B %d, %Y", "%b %d, %Y", "%d %B %Y", "%d %b %Y"):
            try:
                return dt.datetime.strptime(text, fmt).date().isoformat()
            except ValueError:
                pass
    except ValueError:
        pass
    return None


def exchange_time(value):
    """Only an exchange index supplies this clock; never a PDF filename or a board meeting."""
    try:
        return dt.datetime.strptime(str(value), "%d-%b-%Y %H:%M:%S").replace(
            tzinfo=dt.timezone(dt.timedelta(minutes=330))).astimezone(dt.timezone.utc).isoformat()
    except ValueError:
        return None


def document_url(value):
    try:
        u = urlsplit(str(value or ""))
        allowed = {"nsearchives.nseindia.com", "archives.nseindia.com", "www.bseindia.com"}
        if (u.scheme != "https" or u.hostname not in allowed or u.username or u.password or
                u.port or ".." in u.path or not re.search(r"\.(?:xml|html|pdf)$", u.path, re.I)):
            return None
        return urlunsplit((u.scheme, u.netloc, u.path, u.query, ""))
    except ValueError:
        return None


def document_key(url):
    """BSE moves immutable attachment UUIDs between Live/His; NSE names remain identities, not dates."""
    u = document_url(url)
    if not u:
        raise ValueError("Unsupported original document URL")
    match = re.search(r"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.pdf", u, re.I)
    return digest("bse:" + match[1].lower() if match and urlsplit(u).hostname == "www.bseindia.com" else u)


def identities(data_dir):
    """Public exchange directories only; never import portfolio membership into this public store."""
    p = Path(data_dir)
    bse = json.loads((p / "announcement-identities.json").read_text())["entries"]
    nse = json.loads((p / "filing-capture/nse-identities.json").read_text())["directories"]
    by_isin = {}
    for market, entry in [(None, e) for e in bse] + [(market, e) for market, d in nse.items() for e in d.get("entries", [])]:
        isin = entry.get("isin", "")
        if not re.fullmatch(r"IN[A-Z0-9]{10}", isin):
            continue
        c = by_isin.setdefault(isin, {"isin": isin, "name": entry.get("name"), "symbols": [], "bseCodes": [],
            "nseSymbols": [], "nseSME": False})
        if market is not None and entry.get("ticker"):
            if entry["ticker"] not in c["nseSymbols"]: c["nseSymbols"].append(entry["ticker"])
            if market == "sme": c["nseSME"] = True
        for symbol in [entry.get("ticker"), entry.get("bseSymbol"), *entry.get("aliases", [])]:
            if symbol and symbol not in c["symbols"]:
                c["symbols"].append(symbol)
        for code in [entry.get("bseCode"), *entry.get("bseCodes", [])]:
            if code and code not in c["bseCodes"]:
                c["bseCodes"].append(str(code))
    lookup = {}
    for c in by_isin.values():
        for key in [c["isin"], *c["symbols"], *c["bseCodes"]]:
            if key in lookup and lookup[key] != c:
                lookup[key] = None  # Symbol reuse is ambiguous, never last-row-wins.
            else:
                lookup[key] = c
    return by_isin, lookup


def local(tag):
    return tag.split("}")[-1].split(":")[-1]


def decimal_value(text):
    try:
        if len(text) > 100:
            return None
        value = decimal.Decimal(text.strip())
        return format(value, "f") if value.is_finite() and abs(value.adjusted()) <= 40 and value.as_tuple().exponent >= -20 else None
    except decimal.InvalidOperation:
        return None


def parse_financial_xml(body, expected):
    """Keep original contexts and units. decimals is precision, NEVER a multiplier."""
    if len(body) > 4 * 1024 * 1024 or re.search(br"<!DOCTYPE|<!ENTITY", body, re.I):
        raise ValueError("Unsafe or oversized XML")
    root = ET.fromstring(body)
    if root.tag != "{" + XBRLI + "}xbrl":
        raise ValueError("Not an XBRL instance")
    contexts, units, grouped, raw = {}, {}, {}, []
    for n in root:
        if local(n.tag) == "context":
            parts = {local(x.tag): (x.text or "").strip() for x in n.iter()}
            contexts[n.attrib["id"]] = {"start": day(parts.get("startDate")), "end": day(parts.get("endDate")),
                "instant": day(parts.get("instant")), "dimensional": any(local(x.tag) in
                {"explicitMember", "typedMember"} for x in n.iter())}
        elif local(n.tag) == "unit":
            units[n.attrib["id"]] = ET.tostring(n, encoding="unicode")
        elif n.attrib.get("contextRef"):
            fact = {"tag": local(n.tag), "qualifiedTag": n.tag, "context": n.attrib["contextRef"],
                "text": "".join(n.itertext()).strip(), "unitRef": n.attrib.get("unitRef"),
                "decimals": n.attrib.get("decimals"), "nil": n.attrib.get("{http://www.w3.org/2001/XMLSchema-instance}nil") in {"true", "1"}}
            raw.append(fact)
            grouped.setdefault(fact["context"], []).append(fact)
    text_values = {}
    for f in raw:
        if not contexts.get(f["context"], {}).get("dimensional"):
            text_values.setdefault(f["tag"], set()).add(f["text"])
    claims = {k: sorted(text_values.get(k, set())) for k in ["ISIN", "Symbol", "NSESymbol", "ScripCode"]}
    isin_match = claims["ISIN"] == [expected["isin"]]
    symbol_match = any(s in expected["symbols"] for s in claims["Symbol"] + claims["NSESymbol"])
    code_match = any(s in expected["bseCodes"] for s in claims["ScripCode"])
    mismatch = (bool(claims["ISIN"]) and not isin_match) or (bool(expected["bseCodes"]) and
        bool(claims["ScripCode"]) and not code_match)
    matches = not mismatch and (isin_match or code_match or symbol_match)
    normalized, issues = [], []
    for ref, facts in grouped.items():
        ctx = contexts.get(ref)
        if not ctx or ctx["dimensional"]:
            continue  # Segment facts stay in raw evidence, never in company totals.
        values = {}
        for f in facts:
            values.setdefault(f["tag"], set()).add(f["text"])
        def only(tag):
            items = values.get(tag, set())
            return next(iter(items)) if len(items) == 1 else None
        start = day(only("DateOfStartOfReportingPeriod")) or ctx["start"]
        end = day(only("DateOfEndOfReportingPeriod")) or ctx["end"] or ctx["instant"]
        basis = only("NatureOfReportStandaloneConsolidated")
        if not basis:
            options = text_values.get("NatureOfReportStandaloneConsolidated", set())
            basis = next(iter(options)) if len(options) == 1 else None
        problems = []
        if any(len(values.get(k, set())) > 1 for k in ["DateOfStartOfReportingPeriod", "DateOfEndOfReportingPeriod"]):
            problems.append("conflicting-reporting-periods")
        if ((ctx["start"] and start != ctx["start"]) or (ctx["end"] and end != ctx["end"])):
            problems.append("period-context-conflict")
        if not end or start and start > end:
            problems.append("invalid-period")
        if end and end > dt.datetime.now(dt.timezone.utc).date().isoformat():
            problems.append("future-reporting-period")
        if basis not in {"Standalone", "Consolidated"}:
            problems.append("unknown-basis")
        if not matches:
            problems.append("issuer-mismatch")
        for f in facts:
            metric = METRICS.get(f["tag"])
            namespace = f["qualifiedTag"].split("}")[0].lstrip("{")
            known = re.fullmatch(r"http://www\.(?:bseindia\.com/xbrl/fin/\d{4}-\d{2}-\d{2}/in-bse-fin|sebi\.gov\.in/xbrl/\d{4}-\d{2}-\d{2}/in-capmkt)", namespace)
            if not metric or not known or f["nil"] or f["unitRef"] not in units:
                continue
            value = decimal_value(f["text"])
            if value is None:
                continue
            duplicate = len(values[f["tag"]]) != 1
            unit_node = ET.fromstring(units[f["unitRef"]])
            measures = [x.text or "" for x in unit_node.iter() if local(x.tag) == "measure"]
            per_share = metric.startswith("eps_") or metric == "face_value"
            unit_ok = (len(measures) == (2 if per_share else 1) and
                bool(re.fullmatch(r"[A-Za-z0-9_]+:[A-Z]{3}", measures[0])) and
                (not per_share or measures[1].endswith(":shares")))
            normalized.append({"metric": metric, "value": value, "unitRef": f["unitRef"],
                "unitDefinition": units[f["unitRef"]], "start": start, "end": end, "basis": basis,
                "context": ref, "sourceTag": f["qualifiedTag"], "decimals": f["decimals"],
                "eligible": not problems and not duplicate and unit_ok, "issues": problems +
                (["conflicting-facts"] if duplicate else []) + ([] if unit_ok else ["unsupported-financial-unit"])})
        issues.extend({"context": ref, "reason": issue} for issue in problems)
    aliases = {}
    for fact in normalized:
        key = (fact["context"], fact["metric"])
        aliases.setdefault(key, set()).add((decimal.Decimal(fact["value"]), fact["unitDefinition"]))
    for fact in normalized:
        if len(aliases[(fact["context"], fact["metric"])]) > 1:
            fact["eligible"] = False
            fact["issues"].append("conflicting-metric-aliases")
    board_dates = {day(value) for value in text_values.get("DateOfBoardMeetingWhenFinancialResultsWereApproved", [])} - {None}
    return {"issuerMatches": matches, "claims": claims, "rawFacts": raw, "contexts": contexts,
        "units": units, "facts": normalized, "issues": issues,
        "documentDate": next(iter(board_dates)) if len(board_dates) == 1 else None,
        "dateIssues": ["ambiguous-document-dates"] if len(board_dates) > 1 else []}


DATE_RE = (r"(?:\d{1,2}[ -](?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
           r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[ -,]+\d{4}"
           r"|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
           r"Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[ ]+\d{1,2},?[ ]+\d{4}"
           r"|\d{4}-\d{2}-\d{2})")


def document_date(text):
    """A letter/board date is supporting evidence, not proof of exchange publication."""
    lines = [" ".join(line.split()) for line in text.splitlines() if line.strip()][:35]
    candidates = []
    for i, line in enumerate(lines):
        anchored = re.search(r"\bDate\s*[:.-]\s*(" + DATE_RE + ")", line, re.I)
        header = re.fullmatch(DATE_RE, line, re.I) if i < 10 else None
        found = anchored or header
        if found:
            literal = found[1] if anchored else found[0]
            parsed = day(literal)
            if parsed:
                candidates.append({"date": parsed, "quote": line, "location": "page 1"})
    unique = {x["date"] for x in candidates}
    return {"date": next(iter(unique)) if len(unique) == 1 else None, "evidence": candidates,
        "status": "document-date-found" if len(unique) == 1 else "ambiguous" if unique else "unavailable"}


class Store:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA max_page_count=" + str(MAX_DATABASE // self.db.execute("PRAGMA page_size").fetchone()[0]))
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS companies(key TEXT PRIMARY KEY,identity TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,url TEXT NOT NULL,company TEXT,
            kind TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,checked_at TEXT,
            status TEXT NOT NULL DEFAULT 'pending',next_retry TEXT,error TEXT);
          CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY,document TEXT NOT NULL REFERENCES documents(id),
            observed_at TEXT NOT NULL,source TEXT NOT NULL,reported_date TEXT,published_at TEXT,raw TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,document TEXT NOT NULL REFERENCES documents(id),
            content_hash TEXT NOT NULL,first_observed TEXT NOT NULL,format TEXT NOT NULL,body BLOB NOT NULL,
            parsed TEXT NOT NULL,UNIQUE(document,content_hash));
          CREATE TABLE IF NOT EXISTS facts(version TEXT NOT NULL REFERENCES versions(id),ordinal INTEGER NOT NULL,
            company TEXT NOT NULL,metric TEXT NOT NULL,start TEXT,end TEXT,basis TEXT,value TEXT NOT NULL,
            unit TEXT NOT NULL,eligible INTEGER NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(version,ordinal));
          CREATE TABLE IF NOT EXISTS checks(key TEXT PRIMARY KEY,attempted_at TEXT NOT NULL,success_at TEXT,
            error TEXT,cooldown_until TEXT,detail TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS event_dates(document TEXT PRIMARY KEY REFERENCES documents(id),assessment TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS catalogue(id TEXT PRIMARY KEY,source TEXT NOT NULL,first_seen TEXT NOT NULL,raw TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS document_urls(document TEXT NOT NULL REFERENCES documents(id),url TEXT NOT NULL,
            last_seen TEXT NOT NULL,PRIMARY KEY(document,url));
          CREATE INDEX IF NOT EXISTS document_queue ON documents(status,next_retry,checked_at);
          CREATE INDEX IF NOT EXISTS company_facts ON facts(company,metric,end);
          CREATE INDEX IF NOT EXISTS observation_document ON observations(document);
        """)
        previous = self.get("schemaVersion")
        if previous not in (None, VERSION):
            raise ValueError("Unsupported retained schema; refusing reset")
        self.set("schemaVersion", VERSION)
        if self.db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("Retained database failed integrity check")
        self.db.commit()

    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def has_capacity(self):
        size = self.db.execute("PRAGMA page_count").fetchone()[0] * self.db.execute("PRAGMA page_size").fetchone()[0]
        return size < MAX_DATABASE - 64 * 1024 * 1024

    def set(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, canonical(value)))

    def observe(self, url, company, kind, source, raw, at, published_at=None):
        url = document_url(url)
        if not url:
            return None
        key = document_key(url)
        identity = company["isin"] if company else None
        old = self.db.execute("SELECT company FROM documents WHERE id=?", (key,)).fetchone()
        conflicts = set(self.get("identityConflict:" + key, []))
        if old and old[0] and identity and old[0] != identity:
            conflicts.update([old[0], identity])
        if company:
            self.db.execute("INSERT OR REPLACE INTO companies VALUES(?,?)", (identity, canonical(company)))
        if conflicts:
            if identity:
                conflicts.add(identity)
            self.set("identityConflict:" + key, sorted(conflicts))
            # One filing may be shared by several securities. Retain every observation without
            # assigning ambiguous facts to one security or stopping the rest of the source walk.
            identity = None
            self.db.execute("UPDATE documents SET company=NULL,status='identity-conflict' WHERE id=?", (key,))
            self.db.execute("UPDATE facts SET eligible=0 WHERE version IN (SELECT id FROM versions WHERE document=?)", (key,))
        self.db.execute("""INSERT INTO documents(id,url,company,kind,first_seen,last_seen) VALUES(?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,company=coalesce(documents.company,excluded.company),
            kind=CASE WHEN excluded.kind='financial' THEN 'financial'
              WHEN excluded.kind='catalyst' AND documents.kind='event' THEN 'catalyst' ELSE documents.kind END""",
            (key, url, identity, kind, at, at))
        self.db.execute("INSERT OR REPLACE INTO document_urls VALUES(?,?,?)", (key, url, at))
        # Identical metadata observed again is not a new event or a new historical timestamp.
        oid = digest(canonical([key, source, raw, published_at]))
        inserted = self.db.execute("INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?,?)",
            (oid, key, at, source, day(raw.get("date")), published_at, canonical(raw)))
        if inserted.rowcount or conflicts:
            self.refresh_date(key)
        return key

    def catalogue(self, source, raw, at):
        self.db.execute("INSERT OR IGNORE INTO catalogue VALUES(?,?,?,?)",
            (digest(canonical([source, raw])), source, at, canonical(raw)))

    def save_version(self, doc, body, fmt, parsed, at):
        hashed = digest(body)
        key = digest(doc["id"] + hashed)
        self.db.execute("INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?,?)",
            (key, doc["id"], hashed, at, fmt, zlib.compress(body), canonical(parsed)))
        for ordinal, fact in enumerate(parsed.get("facts", [])):
            self.db.execute("INSERT OR IGNORE INTO facts VALUES(?,?,?,?,?,?,?,?,?,?,?)", (key, ordinal,
                doc["company"], fact["metric"], fact["start"], fact["end"], fact["basis"], fact["value"],
                fact["unitRef"], int(fact["eligible"]), canonical(fact)))
        self.db.execute("UPDATE documents SET checked_at=?,status=?,error=NULL,next_retry=NULL WHERE id=?",
            (at, "read" if parsed.get("issuerMatches") else "issuer-unverified", doc["id"]))
        self.refresh_date(doc["id"])
        self.db.commit()

    def date_assessment(self, doc_id):
        observations = self.db.execute("SELECT * FROM observations WHERE document=?", (doc_id,)).fetchall()
        versions = self.db.execute("SELECT parsed FROM versions WHERE document=?", (doc_id,)).fetchall()
        reported = sorted({r["reported_date"] for r in observations if r["reported_date"]})
        publications = sorted({r["published_at"] for r in observations if r["published_at"]})
        dates = sorted({day(json.loads(r[0]).get("documentDate")) for r in versions} - {None})
        verified_issuer = bool(versions) and all(json.loads(r[0]).get("issuerMatches") for r in versions)
        issues = sorted({issue for r in versions for issue in json.loads(r[0]).get("dateIssues", [])})
        if len(reported) > 1:
            issues.append("same-document-multiple-reported-dates")
        if dates and any(d not in dates for d in reported):
            issues.append("reported-date-differs-from-document-date")
        if len(dates) > 1:
            issues.append("document-date-changed")
        for row in versions:
            parsed = json.loads(row[0])
            if not day(parsed.get("documentDate")):
                status = parsed.get("dateEvidence", {}).get("status")
                issues.append("document-date-ambiguous" if status == "ambiguous" else "document-date-unavailable")
        if not dates:
            issues.append("document-date-unverified")
        if self.get("identityConflict:" + doc_id):
            issues.append("document-issuer-conflict")
        indian_days = {dt.datetime.fromisoformat(p.replace("Z", "+00:00")).astimezone(
            dt.timezone(dt.timedelta(minutes=330))).date().isoformat() for p in publications}
        if len(indian_days) > 1:
            issues.append("same-document-multiple-publication-days")
        if not publications:
            issues.append("exchange-publication-unverified")
        if not verified_issuer:
            issues.append("document-issuer-unverified")
        return {"reportedDates": reported, "documentDates": dates, "exchangePublicationTimes": publications,
            "issues": sorted(set(issues)), "eligibleForNewCatalyst": not issues,
            "firstObservedAt": min((r["observed_at"] for r in observations), default=None)}

    def check(self, key, at, error=None, detail=None, cooldown=None):
        old = self.db.execute("SELECT success_at FROM checks WHERE key=?", (key,)).fetchone()
        self.db.execute("INSERT OR REPLACE INTO checks VALUES(?,?,?,?,?,?)",
            (key, at, (old[0] if old else None) if error else at, error, cooldown, canonical(detail or {})))
        self.db.commit()

    def refresh_date(self, doc_id):
        self.db.execute("INSERT OR REPLACE INTO event_dates VALUES(?,?)", (doc_id, canonical(self.date_assessment(doc_id))))

    def financial_history(self, company, observed_by):
        # Return all evidenced versions. A consumer must reconcile restatements, never silently
        # choose between conflicting filings or use a later-observed correction in an earlier test.
        return [dict(r) for r in self.db.execute("""SELECT f.*,v.first_observed,v.document,v.content_hash
            FROM facts f JOIN versions v ON f.version=v.id WHERE f.company=? AND f.eligible=1
            AND v.first_observed<=? ORDER BY f.end,v.first_observed,f.version,f.ordinal""", (company, observed_by))]

    def summary(self, at):
        counts = {t: self.db.execute("SELECT count(*) FROM " + t).fetchone()[0]
            for t in ["companies", "documents", "observations", "versions", "facts", "catalogue"]}
        checks = [dict(r) for r in self.db.execute("SELECT * FROM checks ORDER BY key")]
        coverage = []
        for row in self.db.execute("""SELECT company,basis,count(DISTINCT start||'/'||end) AS durationPeriods,
            count(DISTINCT CASE WHEN julianday(end)-julianday(start) BETWEEN 75 AND 105 THEN start||'/'||end END) AS quarterlyPeriods,
            min(start) AS firstPeriod,max(end) AS lastPeriod FROM facts
            WHERE eligible=1 AND metric='revenue' AND start IS NOT NULL
            GROUP BY company,basis"""):
            coverage.append(dict(row))
        return {"version": VERSION, "checkedAt": at, "counts": counts, "sourceChecks": checks,
            "financialCoverage": coverage, "lastWalk": self.get("lastWalk"), "status": "partial",
            "dateChecks": {"assessedDocuments": self.db.execute("SELECT count(*) FROM event_dates").fetchone()[0],
                "eligibleForNewCatalyst": self.db.execute("SELECT count(*) FROM event_dates WHERE json_extract(assessment,'$.eligibleForNewCatalyst')=1").fetchone()[0]},
            "limits": ["Background evidence foundation; no recommendation or return score.",
                "NSE XBRL and supported BSE-only Inline XBRL history are collected. PDF tables, unsupported taxonomies, bank/insurance adapters and unverified BSE archive completeness remain gaps.",
                "Periods, statement completeness, issuer identity and event dates require separate eligibility checks.",
                "First observation is this collector's actual observation; historical publication does not establish prior capture."]}
