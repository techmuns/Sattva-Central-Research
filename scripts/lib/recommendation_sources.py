"""Paced, bounded reads of free original exchange documents. Refusals stop that host."""
import datetime as dt
import http.client
import json
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urljoin

from recommendation_foundation import (canonical, day, document_date, document_url,
    exchange_time, iso_now, parse_financial_xml)

FAMILIES = [
    ("integrated-equity", "equities", None), ("integrated-sme", "sme", None),
    ("legacy-equity-quarterly", "equities", "Quarterly"),
    ("legacy-equity-half-yearly", "equities", "Half-Yearly"),
    ("legacy-equity-annual", "equities", "Annual"),
    ("legacy-sme-quarterly", "sme", "Quarterly"),
    ("legacy-sme-half-yearly", "sme", "Half-Yearly"),
    ("legacy-sme-annual", "sme", "Annual"),
]


class SourceFailure(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class BudgetExceeded(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PublicReader:
    def __init__(self, store, maximum=100, seconds=600, opener=None, sleep=time.sleep):
        self.store, self.maximum, self.used = store, maximum, 0
        self.deadline, self.last = time.monotonic() + seconds, 0
        self.opener = opener or urllib.request.build_opener(NoRedirect())
        self.sleep = sleep

    def read(self, url, limit=4 * 1024 * 1024, redirects=0):
        u = urlsplit(url)
        index = u.hostname == "www.nseindia.com" and u.path in {
            "/api/integrated-filing-results", "/api/corporates-financial-results",
            "/api/corporates-corporateActions", "/api/holiday-master"}
        market = u.hostname == "nsearchives.nseindia.com" and bool(re.fullmatch(
            r"/content/(?:cm/BhavCopy_NSE_CM_0_0_0_\d{8}_F_0000\.csv\.zip|indices/ind_close_all_\d{8}\.csv)", u.path))
        if not index and not market and not document_url(url):
            raise SourceFailure("Source is not an allowed free exchange endpoint")
        if u.scheme != "https" or u.username or u.password or u.port:
            raise SourceFailure("Invalid source destination")
        key, now = "host:" + u.hostname, iso_now()
        check = self.store.db.execute("SELECT cooldown_until FROM checks WHERE key=?", (key,)).fetchone()
        if check and check[0] and check[0] > now:
            raise SourceFailure("Source cooldown retained; no request attempted")
        if self.used >= self.maximum or time.monotonic() >= self.deadline or not self.store.has_capacity():
            raise BudgetExceeded("Bounded collection walk finished; remaining work retained")
        self.sleep(max(0, 2 - (time.monotonic() - self.last)))
        self.used += 1
        self.last = time.monotonic()
        request = urllib.request.Request(url, headers={
            "User-Agent": "SattvaResearchFinancialHistory/1.0 (public exchange evidence)",
            "Accept": "application/json, application/xml, application/pdf, text/html;q=0.8"})
        try:
            with self.opener.open(request, timeout=20) as response:
                # No credential, proxy, cookie rotation or alternative host on an access refusal.
                declared = response.headers.get("Content-Length")
                if int(declared or "0") > limit:
                    raise SourceFailure("Source exceeds document byte budget")
                body = response.read(limit + 1)
                if len(body) > limit:
                    raise SourceFailure("Source exceeds document byte budget")
                if declared is not None and len(body) != int(declared):
                    raise http.client.IncompleteRead(body, max(0, int(declared) - len(body)))
                if re.search(br"Access Denied|errors\.edgesuite\.net|Too Many Requests", body[:3000], re.I):
                    raise urllib.error.HTTPError(url, 403, "Source refusal", {}, None)
                self.store.check(key, iso_now(), detail={"httpStatus": getattr(response, "status", 200)})
                return body
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 303, 307, 308) and redirects < 3:
                target = urljoin(url, error.headers.get("Location", ""))
                if document_url(target):
                    return self.read(target, limit, redirects + 1)
            cooldown = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=24)).isoformat(timespec="seconds")
            if error.code in (401, 403, 429, 430):
                self.store.check(key, now, "access-refused", {"httpStatus": error.code}, cooldown)
            raise SourceFailure("Original source HTTP " + str(error.code), status=error.code) from error
        except (OSError, ValueError, http.client.HTTPException) as error:
            self.store.check(key, iso_now(), "source-response-incomplete" if isinstance(error, http.client.IncompleteRead)
                else "source-unavailable", {"error": type(error).__name__})
            raise SourceFailure("Original source unavailable: " + type(error).__name__) from error


def index_url(family, start, end, page=1, symbol=None):
    name, index, period = family
    args = {"index": index, "from_date": dt.date.fromisoformat(start).strftime("%d-%m-%Y"),
        "to_date": dt.date.fromisoformat(end).strftime("%d-%m-%Y")}
    if name.startswith("integrated"):
        args.update(type="Integrated Filing- Financials", page=page, size=100)
        endpoint = "integrated-filing-results"
    else:
        # fo_sec=true is NSE's optional F&O-only filter, not a completeness switch.
        args.update(period=period)
        endpoint = "corporates-financial-results"
    if symbol:
        args["symbol"] = symbol
    return "https://www.nseindia.com/api/" + endpoint + "?" + urlencode(args)


def index_page(body, family, page):
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError) as error:
        raise SourceFailure("Financial index is not JSON") from error
    if family[0].startswith("integrated"):
        if (not isinstance(data, dict) or not isinstance(data.get("data"), list) or
                type(data.get("totalCount")) is not int or data["totalCount"] < 0 or
                data.get("size") != 100 or data.get("page") != page - 1):
            raise SourceFailure("Financial index pagination contract changed")
        rows, total = data["data"], data["totalCount"]
        if len(rows) != min(100, max(0, total - (page - 1) * 100)):
            raise SourceFailure("Financial index returned an incomplete page")
        if any(r.get("type") != "Integrated Filing- Financials" for r in rows):
            raise SourceFailure("Financial index ignored its filing-type filter")
    else:
        if not isinstance(data, list) or len(data) >= 5000:
            raise SourceFailure("Legacy financial index is malformed or may be truncated")
        rows, total = data, len(data)
    if any(not isinstance(r, dict) or not r.get("symbol") for r in rows):
        raise SourceFailure("Financial index contains unresolved records")
    return rows, total


def capture_window(store, reader, family, start, end, lookup, phase="recent", symbol=None, expected_isin=None):
    if bool(symbol) != bool(expected_isin):
        raise ValueError("A company-filtered window requires its exact expected ISIN")
    key = "index:" + family[0] + ":" + start + ":" + end
    key += ":symbol:" + symbol if symbol else ""
    check_key = ("gap-source:" + expected_isin + ":" + family[0]) if symbol else "source:" + family[0] + ":" + phase
    progress = store.get(key, {"nextPage": 1, "seen": [], "total": None})
    # A completed recent interval is re-read. An interrupted interval resumes without discarding pages.
    if progress.get("complete"):
        progress = {"nextPage": 1, "seen": [], "total": None}
    while True:
        page, at = progress["nextPage"], iso_now()
        try:
            body = reader.read(index_url(family, start, end, page, symbol=symbol))
            at = iso_now()  # Observation is after receipt, never the start of a slow source request.
            rows, total = index_page(body, family, page)
            if progress["total"] is not None and total != progress["total"]:
                # Live totals moved between pages. Keep discovered documents, restart this window next run.
                store.set(key, {"nextPage": 1, "seen": [], "total": None})
                raise SourceFailure("Index total changed while reading; retained pages need reconciliation")
            seen = set(progress["seen"])
            for row in rows:
                store.catalogue("nse:" + family[0], row, at)
                if symbol and (row["symbol"] != symbol or row.get("isin") and row["isin"] != expected_isin):
                    raise SourceFailure("Financial index ignored company filter or returned a conflicting ISIN")
                url = next((document_url(row.get(k)) for k in ["xbrl", "ixbrl", "attachment", "pdf_attach"]
                    if document_url(row.get(k))), None)
                identity = str(row.get("seq_Id") or row.get("seqNumber") or url or canonical(row))
                if identity in seen:
                    raise SourceFailure("Financial index repeated a record across pages")
                seen.add(identity)
                published = next((exchange_time(row.get(k)) for k in
                    ["exchdisstime", "creation_Date", "broadcast_Date", "broadCastDate"] if exchange_time(row.get(k))), None)
                if not published:
                    raise SourceFailure("Financial index publication clock is unavailable; row retained for adapter review")
                if published and published > at:
                    raise SourceFailure("Financial index returned a future publication clock")
                reported = dt.datetime.fromisoformat(published).astimezone(dt.timezone(
                    dt.timedelta(minutes=330))).date().isoformat() if published else None
                if reported and not start <= reported <= end:
                    raise SourceFailure("Financial index ignored its requested publication interval")
                if url:
                    company = lookup.get(row["isin"]) if row.get("isin") else lookup.get(row["symbol"])
                    store.observe(url, company, "financial", "nse:" + family[0],
                        {**row, "date": reported}, at, published)
            progress = {"nextPage": page + 1, "seen": sorted(seen), "total": total,
                "complete": len(seen) == total, "checkedAt": at}
            store.set(key, progress)
            store.db.commit()  # An interrupted page walk retains both its documents and cursor.
            if progress["complete"]:
                store.check(check_key, at, detail={"from": start, "to": end, "records": total})
                return True
            if page >= 100:
                raise SourceFailure("Index window exceeds pagination budget; no complete-coverage claim")
        except SourceFailure as error:
            store.check(check_key, at, str(error), {"from": start, "to": end})
            return False
        except BudgetExceeded:
            store.check(check_key, at, "Source walk interrupted; window remains incomplete", {"from": start, "to": end})
            raise


def ingest_captured_events(store, data_dir, lookup, at):
    """Retain input metadata as observations, not verified event dates. No original rows are edited."""
    p = Path(data_dir)
    sources = [("filing-capture/announcements-recent.json", "captured-announcements", False),
        ("nse-announcements.json", "nse-rss", True), ("corp-announcements.json", "bse-date-index", True)]
    for file, source, trusted in sources:
        path = p / file
        if not path.exists():
            store.check("input:" + source, at, "input-unavailable")
            continue
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise SourceFailure("Captured event input is malformed")
        if source == "bse-date-index":
            groups = data.get("byTicker")
            if not isinstance(groups, dict) or any(not isinstance(group, list) for group in groups.values()):
                raise SourceFailure("BSE captured byTicker input is malformed")
            rows = [{**row, "ticker": ticker} for ticker, group in groups.items() for row in group if isinstance(row, dict)]
            if (len(rows) != sum(map(len, groups.values())) or type(data.get("rowCount")) is not int or
                    data["rowCount"] != len(rows)):
                raise SourceFailure("BSE captured row count is incomplete or malformed")
        else:
            rows = data.get("rows")
        if not isinstance(rows, list):
            raise SourceFailure("Captured event input is malformed")
        for row in rows:
            if not isinstance(row, dict):
                raise SourceFailure("Captured event row is malformed")
            store.catalogue(source, row, at)
            # A supplied exact identifier never falls through to a possibly reused symbol.
            if row.get("isin"):
                company = lookup.get(str(row["isin"]).strip().upper())
            elif row.get("scripCode"):
                company = lookup.get(str(row["scripCode"]))
            else:
                company = lookup.get(row.get("ticker"))
            published = row.get("publishedAt") if trusted else None
            if source == "bse-date-index" and day(row.get("date")) and re.fullmatch(r"\d{2}:\d{2}:\d{2}", row.get("time") or ""):
                published = dt.datetime.fromisoformat(row["date"] + "T" + row["time"]).replace(
                    tzinfo=dt.timezone(dt.timedelta(minutes=330))).astimezone(dt.timezone.utc).isoformat()
            if published:
                try:
                    parsed_clock = dt.datetime.fromisoformat(published.replace("Z", "+00:00"))
                    published = parsed_clock.astimezone(dt.timezone.utc).isoformat() if parsed_clock.tzinfo else None
                    if published and published > at:
                        published = None
                except ValueError:
                    published = None
            links = row.get("sourceUrls") or []
            if not isinstance(links, list):
                raise SourceFailure("Captured source URL list is malformed; raw row retained")
            urls = [row.get("url")] + [x.get("url") if isinstance(x, dict) else x for x in links]
            for url in set(u for u in urls if document_url(u)):
                described = " ".join(str(row.get(k) or "") for k in ["title", "subject", "summary", "description", "subCategory"])
                kind = "financial" if re.search(r"(?:INTEGRATED_FILING_INDAS|/INDAS_|financial.result)", url, re.I) else (
                    "catalyst" if re.search(r"\b(?:orders?|contracts?|capacity|commissioning|capex|expansion)\b|commercial production", described, re.I) else "event")
                store.observe(url, company, kind, source, row, at, published)
        # This checks the saved input, not the upstream exchange. Preserve its actual capture stamp.
        store.check("input:" + source, at, detail={"rows": len(rows), "upstreamCheckedAt": data.get("capturedAt") or data.get("updatedAt"),
            "scope": "saved input only; source freshness not established by this read"})
    store.db.commit()


def read_document(store, reader, doc, at, scratch):
    company_row = store.db.execute("SELECT identity FROM companies WHERE key=?", (doc["company"],)).fetchone()
    if not company_row:
        return  # Unknown issuers remain in the catalogue for later exact-identity reconciliation.
    expected = json.loads(company_row[0])
    urls = [doc["url"]] + [r[0] for r in store.db.execute(
        "SELECT url FROM document_urls WHERE document=? AND url<>? ORDER BY last_seen DESC,url", (doc["id"], doc["url"]))]
    for i, url in enumerate(urls):
        try:
            body = reader.read(url)
            break
        except SourceFailure as error:
            # Only known aliases of this identical document may recover an archived/missing URL.
            # An access refusal is never retried through another URL.
            if error.status not in (404, 410) or i == len(urls) - 1:
                raise
    store.db.execute("UPDATE documents SET url=? WHERE id=?", (url, doc["id"]))
    if b"<" in body[:100] and not body.startswith(b"%PDF"):
        parsed = parse_financial_xml(body, expected)
        parsed["retrievedFrom"] = url
        store.save_version(doc, body, "xbrl", parsed, iso_now())
    elif body.startswith(b"%PDF"):
        # Poppler is free and local on this GitHub runner. Scans stay unreadable; no paid OCR fallback.
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            file = Path(tmp) / "original.pdf"
            file.write_bytes(body)
            result = subprocess.run(["pdftotext", "-f", "1", "-l", "1", "-layout", str(file), "-"],
                capture_output=True, timeout=20, check=True)
            text = result.stdout.decode("utf-8", errors="replace")
        evidence = document_date(text)
        issuer = expected["isin"] in text or any(re.search(r"\b(?:Symbol|Scrip\s*(?:Code|ID))\s*[:.-]?\s*" +
            re.escape(s) + r"\b", text, re.I) for s in expected["symbols"] + expected["bseCodes"])
        store.save_version(doc, body, "pdf", {"issuerMatches": issuer, "documentDate": evidence["date"],
            "dateEvidence": evidence, "retrievedFrom": url,
            "financialExtraction": "unavailable: PDF tables require a verified adapter"}, iso_now())
    else:
        raise SourceFailure("Unsupported document format; retained URL needs a verified adapter")


def collect(store, data_dir, reader, lookup, scratch):
    today = dt.datetime.now(dt.timezone(dt.timedelta(minutes=330))).date()
    at = iso_now()
    if not store.has_capacity():
        store.check("storage-budget", at, "Retained-store ceiling approached; collection paused without deleting history")
        return
    ingest_captured_events(store, data_dir, lookup, at)
    # Keep an explicit initial history boundary. Never slide it forward or forget an interrupted window.
    start = store.get("historyStart") or (today - dt.timedelta(days=3 * 366)).isoformat()
    store.set("historyStart", start)
    store.db.commit()
    total_budget = getattr(reader, "maximum", 200)
    reader.maximum = min(total_budget, reader.used + 60)
    try:
        for family in FAMILIES:
            key = "recentThrough:" + family[0]
            previous = store.get(key)
            overlap = (today - dt.timedelta(days=6)).isoformat()
            initial_key = "recentStart:" + family[0]
            if not store.get(initial_key):
                store.set(initial_key, overlap)
                store.db.commit()  # A first failed interval must survive the next calendar rollover.
            beginning = min(overlap, (dt.date.fromisoformat(previous) - dt.timedelta(days=1)).isoformat()
                if previous else store.get(initial_key))
            end = min(today.isoformat(), (dt.date.fromisoformat(beginning) + dt.timedelta(days=6)).isoformat())
            if capture_window(store, reader, family, beginning, end, lookup):
                store.set(key, end)
                store.db.commit()
        for family in FAMILIES:
            key = "backfill:" + family[0]
            phase = "backfill"
            end = store.get(key) or (today - dt.timedelta(days=7)).isoformat()
            if end < start:
                # Finished history remains stored. Reconcile older windows on a separate rotating cursor.
                key = "reconcile:" + family[0]
                phase = "reconcile"
                end = store.get(key) or (today - dt.timedelta(days=7)).isoformat()
                if end < start:
                    end = (today - dt.timedelta(days=7)).isoformat()
            beginning = max(start, (dt.date.fromisoformat(end) - dt.timedelta(days=6)).isoformat())
            if capture_window(store, reader, family, beginning, end, lookup, phase=phase):
                store.set(key, (dt.date.fromisoformat(beginning) - dt.timedelta(days=1)).isoformat())
                store.db.commit()
    except BudgetExceeded:
        pass
    finally:
        reader.maximum = total_budget
    # Fill exact missing company periods without waiting for the broad weekly archive cursor.
    # This shares the existing request/time ceiling; ordinary discovery and event work retain slots.
    from recommendation_financial_gaps import audit_financial_gaps, fill_financial_gaps
    gaps = audit_financial_gaps(store, iso_now(), persist=False)
    fill_financial_gaps(store, reader, lookup, scratch, gaps)
    # Unused targeted capacity returns to ordinary financial work (up to its original 100).
    # A request slice, rather than only a document count, preserves room for event reads/redirects.
    for kind in ["financial", "event"]:
        maximum = min(100, max(0, total_budget-reader.used-20)) if kind == "financial" else min(20,max(0,total_budget-reader.used))
        reader.maximum = min(total_budget,reader.used+maximum)
        try:
            docs = store.db.execute("""SELECT * FROM documents WHERE company IS NOT NULL AND
            (kind=? OR (?='event' AND kind='catalyst')) AND
            (next_retry IS NULL OR next_retry<=?) AND
            (status='failed' OR checked_at IS NULL OR checked_at<?) ORDER BY kind='catalyst' DESC,
            checked_at IS NOT NULL, checked_at,first_seen,id LIMIT ?""",
            (kind, kind, at, (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)).isoformat(timespec="seconds"), maximum)).fetchall()
            for doc in docs:
                checked = iso_now()
                try:
                    read_document(store, reader, doc, checked, scratch)
                except (SourceFailure, ValueError, ET_PARSE_ERROR, subprocess.SubprocessError, FileNotFoundError) as error:
                    retry = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=24)).isoformat(timespec="seconds")
                    store.db.execute("UPDATE documents SET checked_at=?,status='failed',next_retry=?,error=? WHERE id=?",
                        (checked, retry, type(error).__name__ + ": " + str(error)[:300], doc["id"]))
                    store.db.commit()
        except BudgetExceeded:
            pass
        finally:
            reader.maximum = total_budget
    store.set("lastWalk", {"at": at, "finishedAt": iso_now(), "requests": reader.used,
        "historyStart": start, "backfillPending": any((store.get("backfill:" + f[0]) or today.isoformat()) >= start for f in FAMILIES)})
    store.db.commit()
    audit_financial_gaps(store, iso_now())


# ElementTree exceptions are deliberately handled as document failures, not empty financials.
from xml.etree.ElementTree import ParseError as ET_PARSE_ERROR
