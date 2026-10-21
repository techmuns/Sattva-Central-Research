#!/usr/bin/env python3
"""Offline financial evidence regressions, including actual source context/rounding pitfalls."""
import copy
import datetime as dt
import gzip
import hashlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error
import xml.etree.ElementTree as ET
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts/lib"))
from recommendation_foundation import Store, day, document_date, document_key, document_url, parse_financial_xml
from recommendation_sources import BudgetExceeded, FAMILIES, PublicReader, SourceFailure, capture_window, collect, index_page, index_url, read_document
from recommendation_github import GithubState

FIXTURES = ROOT / "scripts/fixtures/recommendation-foundation"
RELIANCE = {"isin": "INE002A01018", "symbols": ["RELIANCE"], "bseCodes": ["500325"]}
PRECISION = {"isin": "INE372C01037", "symbols": ["PRECWIRE"], "bseCodes": ["523539"]}
ALPEX = {"isin": "INE0R4701017", "symbols": ["ALPEXSOLAR", "ALPEXSOLAR-SM"], "bseCodes": []}
URL = "https://nsearchives.nseindia.com/corporate/ALPEXSOLAR_14012026141348_Intimation_of_receiving_an_order.pdf"
AT = "2026-10-21T08:00:00+00:00"


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / ".cache/recommendation-foundation-tests"
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.store = Store(Path(self.tmp.name) / "state.sqlite")

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def test_real_rounding_is_precision_not_scale(self):
        parsed = parse_financial_xml((FIXTURES / "reliance-2025.xml").read_bytes(), RELIANCE)
        self.assertTrue(parsed["issuerMatches"])
        revenue = next(f for f in parsed["facts"] if f["metric"] == "revenue" and f["context"] == "OneD")
        self.assertEqual(revenue["value"], "1282600000000.00")
        self.assertEqual(revenue["decimals"], "-7")
        self.assertTrue(revenue["eligible"])
        # The actual source's FourD context says October while its reporting-start fact says April.
        self.assertTrue(any(x["reason"] == "period-context-conflict" for x in parsed["issues"]))
        self.assertFalse(any(f["eligible"] for f in parsed["facts"] if f["context"] == "FourD"))

    def test_real_integrated_filing_and_issuer_mismatch(self):
        body = (FIXTURES / "precision-wires-2026.xml").read_bytes()
        parsed = parse_financial_xml(body, PRECISION)
        self.assertTrue(parsed["issuerMatches"])
        self.assertTrue(any(f["eligible"] and f["start"] == "2026-04-01" and f["end"] == "2026-06-30" for f in parsed["facts"]))
        wrong = parse_financial_xml(body, RELIANCE)
        self.assertFalse(wrong["issuerMatches"])
        self.assertFalse(any(f["eligible"] for f in wrong["facts"]))

    def test_segments_nil_values_and_xml_entities(self):
        root = ET.fromstring((FIXTURES / "precision-wires-2026.xml").read_bytes())
        revenue = next(n for n in root if n.tag.endswith("}RevenueFromOperations"))
        segment = copy.deepcopy(revenue)
        segment.attrib["contextRef"] = "OneExpenses1D"
        segment.text = "999999999999999"
        root.append(segment)
        parsed = parse_financial_xml(ET.tostring(root), PRECISION)
        self.assertFalse(any(f["value"] == segment.text for f in parsed["facts"]))
        revenue.set("{http://www.w3.org/2001/XMLSchema-instance}nil", "true")
        revenue.text = ""
        parsed = parse_financial_xml(ET.tostring(root), PRECISION)
        self.assertFalse(any(f["metric"] == "revenue" for f in parsed["facts"]))
        revenue.set("{http://www.w3.org/2001/XMLSchema-instance}nil", "1")
        revenue.text = "0"
        parsed = parse_financial_xml(ET.tostring(root), PRECISION)
        self.assertFalse(any(f["metric"] == "revenue" for f in parsed["facts"]))
        with self.assertRaises(ValueError):
            parse_financial_xml(b'<!DOCTYPE x [<!ENTITY a "unsafe">]><x/>', PRECISION)

    def test_old_document_is_never_redated_by_capture_or_filename(self):
        key = self.store.observe(URL, ALPEX, "event", "captured", {"date": "2026-10-20"}, AT)
        self.store.observe(URL, ALPEX, "event", "captured", {"date": "2026-10-17"}, AT)
        doc = self.store.db.execute("SELECT * FROM documents WHERE id=?", (key,)).fetchone()
        evidence = document_date("ALPEX SOLAR LIMITED\nDate: January 14, 2026\nSymbol: ALPEXSOLAR")
        self.assertEqual(evidence["date"], "2026-01-14")
        self.store.save_version(doc, b"original-test-body", "pdf", {"issuerMatches": True,
            "documentDate": evidence["date"], "dateEvidence": evidence}, AT)
        result = self.store.date_assessment(key)
        self.assertEqual(result["firstObservedAt"], AT)
        self.assertIn("same-document-multiple-reported-dates", result["issues"])
        self.assertIn("reported-date-differs-from-document-date", result["issues"])
        self.assertFalse(result["eligibleForNewCatalyst"])
        self.assertIsNone(document_date("Old dates in filename: ALPEX_14012026.pdf")["date"])

    def test_ambiguous_and_unreadable_dates(self):
        self.assertEqual(document_date("Date: January 14, 2026\nDate: October 20, 2026")["status"], "ambiguous")
        self.assertEqual(document_date("")["status"], "unavailable")
        self.assertIsNone(day("2026-02-30"))

    def test_idempotency_corrections_and_point_in_time(self):
        body = (FIXTURES / "precision-wires-2026.xml").read_bytes()
        url = "https://nsearchives.nseindia.com/corporate/xbrl/filing.xml"
        key = self.store.observe(url, PRECISION, "financial", "nse", {"date": "2026-08-10"}, AT)
        self.store.observe(url, PRECISION, "financial", "nse", {"date": "2026-08-10"}, "2026-10-22T08:00:00+00:00")
        doc = self.store.db.execute("SELECT * FROM documents WHERE id=?", (key,)).fetchone()
        parsed = parse_financial_xml(body, PRECISION)
        self.store.save_version(doc, body, "xbrl", parsed, AT)
        self.store.save_version(doc, body, "xbrl", parsed, "2026-10-22T08:00:00+00:00")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM versions").fetchone()[0], 1)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM observations").fetchone()[0], 1)
        self.assertEqual(self.store.financial_history(PRECISION["isin"], "2026-10-20"), [])
        before = len(self.store.financial_history(PRECISION["isin"], AT))
        corrected = body.replace(b"Precision Wires India Limited", b"Precision Wires India Limited ")
        self.store.save_version(doc, corrected, "xbrl", parse_financial_xml(corrected, PRECISION), "2026-10-22T08:00:00+00:00")
        self.assertEqual(len(self.store.financial_history(PRECISION["isin"], AT)), before)
        self.assertGreater(len(self.store.financial_history(PRECISION["isin"], "2026-10-23")), before)

    def test_publication_date_needs_actual_exchange_evidence(self):
        key = self.store.observe(URL, ALPEX, "event", "nse-rss", {"date": "2026-01-14"}, AT,
            "2026-01-14T08:45:00+00:00")
        doc = self.store.db.execute("SELECT * FROM documents WHERE id=?", (key,)).fetchone()
        self.store.save_version(doc, b"verified", "pdf", {"issuerMatches": True, "documentDate": "2026-01-14"}, AT)
        self.assertTrue(self.store.date_assessment(key)["eligibleForNewCatalyst"])
        self.assertEqual(self.store.date_assessment(key)["firstObservedAt"], AT)
        # eligibleForNewCatalyst verifies dates only; age still belongs to future catalyst selection.

    def test_source_failures_preserve_last_success_and_history(self):
        self.store.check("source:test", AT, detail={"records": 1})
        self.store.check("source:test", "2026-10-22", "access-refused", cooldown="2026-10-23")
        check = self.store.db.execute("SELECT * FROM checks WHERE key='source:test'").fetchone()
        self.assertEqual(check["success_at"], AT)
        self.assertEqual(check["error"], "access-refused")

    def test_pagination_shortfalls_governance_and_moving_counts_fail(self):
        row = {"symbol": "PRECWIRE", "type": "Integrated Filing- Financials", "seq_Id": "1"}
        family = FAMILIES[0]
        for payload in [{"data": [row], "size": 100, "page": 0, "totalCount": 101},
                        {"data": [{**row, "type": "Integrated Filing- Governance"}], "size": 100, "page": 0, "totalCount": 1}]:
            with self.assertRaises(SourceFailure):
                index_page(json.dumps(payload).encode(), family, 1)

    def test_interrupted_pagination_resumes_and_keeps_every_page(self):
        class Reader:
            def __init__(self): self.calls = 0
            def read(self, url):
                self.calls += 1
                if self.calls == 2: raise BudgetExceeded()
                rows = [{"symbol": "PRECWIRE", "type": "Integrated Filing- Financials", "seq_Id": str(i),
                    "creation_Date": "05-Oct-2026 10:00:00"} for i in range(100)]
                return json.dumps({"data": rows, "totalCount": 101, "size": 100, "page": 0}).encode()
        with self.assertRaises(BudgetExceeded):
            capture_window(self.store, Reader(), FAMILIES[0], "2026-10-01", "2026-10-07", {})
        progress = self.store.get("index:integrated-equity:2026-10-01:2026-10-07")
        self.assertEqual(progress["nextPage"], 2)
        self.assertEqual(len(progress["seen"]), 100)
        class Resume:
            def read(self, url):
                self_outer.assertIn("page=2", url)
                return json.dumps({"data": [{"symbol": "PRECWIRE", "type": "Integrated Filing- Financials", "seq_Id": "100",
                    "creation_Date": "05-Oct-2026 10:00:00"}],
                    "totalCount": 101, "size": 100, "page": 1}).encode()
        self_outer = self
        self.assertTrue(capture_window(self.store, Resume(), FAMILIES[0], "2026-10-01", "2026-10-07", {}))

    def test_refusal_cooldown_and_no_paid_destination(self):
        class Refuse:
            def __init__(self): self.calls = 0
            def open(self, request, timeout):
                self.calls += 1
                raise urllib.error.HTTPError(request.full_url, 403, "Refused", {}, None)
        opener = Refuse()
        reader = PublicReader(self.store, opener=opener, sleep=lambda _: None)
        for _ in range(2):
            with self.assertRaises(SourceFailure): reader.read(URL)
        self.assertEqual(opener.calls, 1)
        with self.assertRaises(SourceFailure): reader.read("https://paid-provider.example/financials")
        self.assertEqual(opener.calls, 1)
        self.assertIsNone(document_url("https://nsearchives.nseindia.com.evil.example/corporate/file.xml"))

    def test_unsupported_numeric_namespace_and_exponents(self):
        root = ET.fromstring((FIXTURES / "precision-wires-2026.xml").read_bytes())
        for n in root:
            if n.tag.endswith("}RevenueFromOperations"):
                n.tag = "{https://unverified.example/taxonomy}RevenueFromOperations"
        parsed = parse_financial_xml(ET.tostring(root), PRECISION)
        self.assertFalse(any(f["metric"] == "revenue" for f in parsed["facts"]))
        root = ET.fromstring((FIXTURES / "precision-wires-2026.xml").read_bytes())
        for n in root:
            if n.tag.endswith("}RevenueFromOperations"):
                n.text = "1e999999999"
        parsed = parse_financial_xml(ET.tostring(root), PRECISION)
        self.assertFalse(any(f["metric"] == "revenue" for f in parsed["facts"]))

    def test_ignored_date_filter_never_advances_backfill(self):
        class Reader:
            def read(self, url):
                return json.dumps({"data": [{"symbol": "PRECWIRE", "seq_Id": "1", "type": "Integrated Filing- Financials",
                    "creation_Date": "20-Oct-2026 10:00:00"}], "totalCount": 1, "size": 100, "page": 0}).encode()
        self.assertFalse(capture_window(self.store, Reader(), FAMILIES[0], "2026-10-01", "2026-10-07", {}))
        self.assertIsNone(self.store.get("index:integrated-equity:2026-10-01:2026-10-07"))
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM catalogue").fetchone()[0], 1)

    def test_real_legacy_index_covers_non_fo_and_exchange_dissemination(self):
        body = (FIXTURES / "legacy-index.json").read_bytes()
        family = next(f for f in FAMILIES if f[0] == "legacy-equity-quarterly")
        self.assertNotIn("fo_sec", index_url(family, "2025-01-13", "2025-01-19"))
        class Reader:
            def read(self, url): return body
        self.assertTrue(capture_window(self.store, Reader(), family, "2025-01-13", "2025-01-19", {}))
        observation = self.store.db.execute("SELECT published_at FROM observations ORDER BY published_at DESC").fetchone()
        self.assertEqual(observation[0], "2025-01-19T08:43:31+00:00")

    def test_git_hub_state_private_empty_and_incomplete_publication(self):
        client = GithubState(env={"GITHUB_REPOSITORY": "techmuns/Sattva-Central-Research", "GITHUB_TOKEN": "fixture"})
        with mock.patch.object(client, "request", return_value={"private": True, "full_name": client.repo}):
            with self.assertRaises(ValueError): client.public_guard()
        with mock.patch.object(client, "public_guard"), mock.patch.object(client, "releases", return_value=[
                {"tag_name": "recommendation-foundation-2026-10", "id": 1}]), mock.patch.object(client, "assets", return_value=[]):
            with self.assertRaises(ValueError): client.restore(Path(self.tmp.name) / "missing.sqlite")
        # An unacknowledged upload cannot delete or mutate previously retained local history.
        self.store.set("repository", client.repo)
        self.store.db.commit()
        client.env = {**client.env, "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_SHA": "a" * 40}
        def request(suffix, *args, **kwargs):
            return {"id": 1} if suffix.startswith("/releases/tags/") else {"state": "open"}
        with mock.patch.object(client, "publisher_guard"), mock.patch.object(client, "public_guard"), \
                mock.patch.object(client, "assets", return_value=[]), mock.patch.object(client, "request", side_effect=request):
            with self.assertRaises(ValueError): client.publish(Path(self.tmp.name) / "state.sqlite")
        self.assertEqual(self.store.get("repository"), client.repo)

    def test_offline_complete_walk_stores_financials_and_quarantines_old_event(self):
        directory = Path(self.tmp.name) / "data"
        (directory / "filing-capture").mkdir(parents=True)
        rows = [{"url": URL, "ticker": "ALPEXSOLAR", "date": date} for date in ["2026-10-17", "2026-10-20"]]
        captured = directory / "filing-capture/announcements-recent.json"
        captured.write_text(json.dumps({"rows": rows}))
        (directory / "nse-announcements.json").write_text(json.dumps({"rows": [{"url": URL,
            "ticker": "ALPEXSOLAR", "publishedAt": "2026-01-14T08:45:00Z"}]}))
        (directory / "corp-announcements.json").write_text('{"rows":[]}')
        original = captured.read_bytes()
        fixture = (FIXTURES / "precision-wires-2026.xml").read_bytes()
        financial_url = "https://nsearchives.nseindia.com/corporate/xbrl/financial.xml"
        now_ist = dt.datetime.now(dt.timezone(dt.timedelta(minutes=330))) - dt.timedelta(minutes=1)
        class Reader:
            used = 0
            def read(self, url):
                self.used += 1
                if url == financial_url: return fixture
                if url == URL: return b"%PDF-fixture"
                query = parse_qs(urlsplit(url).query)
                if "integrated-filing-results" in url:
                    rows = [{"symbol": "PRECWIRE", "seq_Id": "1", "type": "Integrated Filing- Financials",
                        "creation_Date": now_ist.strftime("%d-%b-%Y %H:%M:%S"), "xbrl": financial_url}] if \
                        dt.datetime.strptime(query["from_date"][0], "%d-%m-%Y").date() <= now_ist.date() <= \
                        dt.datetime.strptime(query["to_date"][0], "%d-%m-%Y").date() else []
                    return json.dumps({"data": rows, "totalCount": len(rows), "size": 100, "page": 0}).encode()
                return b"[]"
        with mock.patch("recommendation_sources.subprocess.run", return_value=SimpleNamespace(
                stdout=b"ALPEX SOLAR LIMITED\nDate: January 14, 2026\nSymbol: ALPEXSOLAR")):
            collect(self.store, directory, Reader(), {"PRECWIRE": PRECISION, "ALPEXSOLAR": ALPEX}, self.tmp.name)
        self.assertTrue(self.store.financial_history(PRECISION["isin"], "9999"))
        self.assertFalse(self.store.date_assessment(document_key(URL))["eligibleForNewCatalyst"])
        self.assertEqual(captured.read_bytes(), original, "source files and reader inputs are never rewritten")
        self.assertEqual(self.store.summary(AT)["status"], "partial")
        self.assertTrue(self.store.get("lastWalk")["backfillPending"])

    def test_streamed_restore_checks_hash_repository_and_integrity(self):
        client = GithubState(env={"GITHUB_REPOSITORY": "techmuns/Sattva-Central-Research", "GITHUB_TOKEN": "fixture"})
        self.store.set("repository", client.repo)
        self.store.db.commit()
        body = gzip.compress((Path(self.tmp.name) / "state.sqlite").read_bytes(), mtime=0)
        name = "foundation-1-1-" + hashlib.sha256(body).hexdigest() + ".sqlite.gz"
        release = {"id": 1, "tag_name": "recommendation-foundation-2026-10"}
        url = "https://github.com/" + client.repo + "/releases/download/" + release["tag_name"] + "/" + name
        asset = {"id": 1, "name": name, "state": "uploaded", "size": len(body), "browser_download_url": url}
        destination = Path(self.tmp.name) / "restored.sqlite"
        with mock.patch.object(client, "public_guard"), mock.patch.object(client, "releases", return_value=[release]), \
                mock.patch.object(client, "assets", return_value=[asset]), mock.patch("recommendation_github.urllib.request.urlopen",
                    return_value=io.BytesIO(body)) as download:
            self.assertTrue(client.restore(destination))
            download.assert_called_once_with(url, timeout=120)  # No Authorization header goes to the CDN.
        with sqlite3.connect(destination) as db:
            self.assertEqual(json.loads(db.execute("SELECT value FROM meta WHERE key='repository'").fetchone()[0]), client.repo)
        with mock.patch.object(client, "public_guard"), mock.patch.object(client, "releases", return_value=[release]), \
                mock.patch.object(client, "assets", return_value=[asset]), mock.patch("recommendation_github.urllib.request.urlopen",
                    return_value=io.BytesIO(body[:-1] + b"X")):
            with self.assertRaises(ValueError): client.restore(Path(self.tmp.name) / "corrupt.sqlite")
        self.assertFalse((Path(self.tmp.name) / "corrupt.sqlite").exists())

    def test_conflicting_board_dates_and_ist_rollover_are_quarantined(self):
        root = ET.fromstring((FIXTURES / "precision-wires-2026.xml").read_bytes())
        original = next(n for n in root if n.tag.endswith("}DateOfBoardMeetingWhenFinancialResultsWereApproved"))
        conflict = copy.deepcopy(original)
        conflict.text = "2026-08-11"
        root.append(conflict)
        parsed = parse_financial_xml(ET.tostring(root), PRECISION)
        self.assertIsNone(parsed["documentDate"])
        self.assertIn("ambiguous-document-dates", parsed["dateIssues"])
        key = self.store.observe(URL, ALPEX, "event", "nse", {}, AT, "2026-10-20T18:15:00+00:00")
        self.store.observe(URL, ALPEX, "event", "nse", {}, AT, "2026-10-20T19:00:00+00:00")
        self.assertIn("same-document-multiple-publication-days", self.store.date_assessment(key)["issues"])

    def test_unknown_isin_does_not_fall_back_to_a_reused_symbol(self):
        from recommendation_sources import ingest_captured_events
        directory = Path(self.tmp.name) / "identity-data"
        (directory / "filing-capture").mkdir(parents=True)
        (directory / "filing-capture/announcements-recent.json").write_text(json.dumps({"rows": [
            {"isin": "INE000A01010", "ticker": "ALPEXSOLAR", "url": URL, "sourceUrls": None}]}))
        ingest_captured_events(self.store, directory, {"ALPEXSOLAR": ALPEX}, AT)
        self.assertIsNone(self.store.db.execute("SELECT company FROM documents").fetchone()[0])

    def test_known_bse_archive_alias_recovers_404_but_never_access_refusal(self):
        name = "8e7253fb-1150-42d8-9764-bd3c39db7c33.pdf"
        live = "https://www.bseindia.com/xml-data/corpfiling/AttachLive/" + name
        history = "https://www.bseindia.com/xml-data/corpfiling/AttachHis/" + name
        key = self.store.observe(live, PRECISION, "event", "bse", {}, AT)
        self.store.observe(history, PRECISION, "event", "bse", {}, AT)
        doc = self.store.db.execute("SELECT * FROM documents WHERE id=?", (key,)).fetchone()
        class Reader:
            calls = []
            refusal = 404
            def read(self, url):
                self.calls.append(url)
                if url == live: raise SourceFailure("fixture", status=self.refusal)
                return b"%PDF-fixture"
        reader = Reader()
        with mock.patch("recommendation_sources.subprocess.run", return_value=SimpleNamespace(
                stdout=b"Date: August 10, 2026\nSymbol: PRECWIRE")):
            read_document(self.store, reader, doc, AT, self.tmp.name)
        self.assertEqual(reader.calls, [live, history])
        self.assertEqual(self.store.db.execute("SELECT url FROM documents WHERE id=?", (key,)).fetchone()[0], history)
        reader.calls, reader.refusal = [], 403
        with self.assertRaises(SourceFailure): read_document(self.store, reader, doc, AT, self.tmp.name)
        self.assertEqual(reader.calls, [live])

    def test_bse_document_move_keeps_identity(self):
        name = "8e7253fb-1150-42d8-9764-bd3c39db7c33.pdf"
        self.assertEqual(document_key("https://www.bseindia.com/xml-data/corpfiling/AttachLive/" + name),
            document_key("https://www.bseindia.com/xml-data/corpfiling/AttachHis/" + name))

    def test_no_runtime_ui_or_paid_storage(self):
        workflow = (ROOT / ".github/workflows/recommendation-foundation.yml").read_text()
        self.assertIn("runs-on: ubuntu-latest", workflow)
        self.assertIn("github.event.repository.private == false", workflow)
        self.assertNotIn("upload-artifact", workflow)
        self.assertNotIn("actions/cache", workflow)
        self.assertIn("always() && steps.restore.outcome == 'success'", workflow)
        client = GithubState(env={"GITHUB_REPOSITORY": "techmuns/Sattva-Central-Research", "GITHUB_TOKEN": "fixture"})
        with self.assertRaises(ValueError): client.publisher_guard()


if __name__ == "__main__":
    unittest.main(verbosity=2)
