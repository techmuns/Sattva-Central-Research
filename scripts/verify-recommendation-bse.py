#!/usr/bin/env python3
"""Offline original BSE financial-history, identity, scaling and bounded-queue contracts."""
import copy
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock
import urllib.error
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts/lib"))
from recommendation_bse import bse_index_url, bse_recent_url, parse_bse_ixbrl, result_links, reporting_end_hint
from recommendation_foundation import Store, canonical
from recommendation_sources import BudgetExceeded, PublicReader, SourceFailure, capture_bse_company, read_document
from recommendation_financial_gaps import audit_financial_gaps, company_gap, collection_queue, fill_financial_gaps
from recommendation_models import financials, MODEL_VERSION, POLICY

FIX = ROOT / "scripts/fixtures/recommendation-bse"
AT = "2026-10-22T08:00:00+00:00"
ISSUER = {"isin": "INE111F01024", "name": "Paushak Ltd", "symbols": ["PAUSHAKLTD"], "nseSymbols": [], "bseCodes": ["532742"]}
ROWS = json.loads((FIX / "bse-company-results.json").read_text())["Table"]
BODY = (FIX / "paushak-sep-2026.html").read_bytes()


class FixtureReader:
    def __init__(self, rows=None, bodies=None):
        self.rows = ROWS if rows is None else rows
        self.bodies = bodies or {}
        self.maximum, self.used, self.deadline, self.urls = 200, 0, time.monotonic()+600, []
    def read(self, url, limit=None):
        if self.used >= self.maximum:
            raise BudgetExceeded("Fixture request budget")
        self.used += 1; self.urls.append(url)
        if url == bse_index_url("532742"):
            return canonical({"Table": self.rows}).encode()
        if url not in self.bodies:
            raise SourceFailure("Original fixture unavailable", status=404)
        return self.bodies[url]


class BSETests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / ".cache/recommendation-bse-tests"; scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.store = Store(Path(self.tmp.name) / "state.sqlite")
        self.store.db.execute("INSERT INTO companies VALUES(?,?)", (ISSUER["isin"], canonical(ISSUER)))
        self.store.db.commit()
        self.lookup = {ISSUER["isin"]: ISSUER, "532742": ISSUER}
    def tearDown(self):
        self.store.db.close(); self.tmp.cleanup()
    def fill(self, reader, **kwargs):
        with mock.patch("recommendation_financial_gaps.iso_now", return_value=AT), mock.patch("recommendation_sources.iso_now", return_value=AT):
            fill_financial_gaps(self.store, reader, self.lookup, Path(self.tmp.name), audit_financial_gaps(self.store, AT, persist=False), **kwargs)
    def mutation(self, change):
        root = ET.fromstring(BODY); change(root)
        # ElementTree drops xmlns declarations used only inside QName text/attributes.
        body = ET.tostring(root)
        namespaces = {}
        for _, pair in ET.iterparse(io.BytesIO(BODY), events=["start-ns"]): namespaces[pair[0]] = pair[1]
        end = body.index(b">")
        declarations = b"".join((' xmlns:' + k + '="' + v + '"').encode() for k,v in namespaces.items() if k and ("xmlns:"+k+"=").encode() not in body[:end])
        return body[:end] + declarations + body[end:]
    def test_original_fixtures_have_verifiable_source_hashes_and_observed_links(self):
        sources = json.loads((FIX / "fixture-sources.json").read_text())
        for entry in sources["files"]:
            self.assertEqual(hashlib.sha256((FIX/entry["file"]).read_bytes()).hexdigest(), entry["sha256"])
        self.assertEqual(len(ROWS), 119)
        self.assertTrue(any(result_links(r) for r in ROWS))
    def test_actual_scaled_money_eps_sign_and_board_date(self):
        parsed = parse_bse_ixbrl(BODY, ISSUER)
        self.assertTrue(parsed["issuerMatches"]); self.assertFalse(parsed["inlineIssues"])
        facts = {(f["metric"], f["context"]): f for f in parsed["facts"]}
        self.assertEqual(facts[("revenue", "OneD")]["value"], "893233000")
        self.assertEqual(facts[("revenue", "OneD")]["decimals"], "-3")
        self.assertEqual(facts[("eps_diluted_total", "OneD")]["value"], "5.48")
        self.assertEqual(facts[("operating_cash_flow", "FourD")]["value"], "407199000")
        self.assertTrue(all(f["eligible"] for f in facts.values()))
        self.assertEqual(parsed["documentDate"], "2026-10-16")
        self.assertTrue(any(f["attributes"].get("sign") == "-" for f in parsed["inlineFacts"]))
    def test_actual_standalone_and_consolidated_are_not_mixed(self):
        issuer = {"isin":"INE817A01019", "bseCodes":["532307"], "symbols":[]}
        result = parse_bse_ixbrl((FIX/"melstar-consolidated.html").read_bytes(), issuer)
        self.assertTrue(result["issuerMatches"]);self.assertFalse(result["inlineIssues"])
        self.assertEqual({f["basis"] for f in result["facts"]}, {"Consolidated"})
        self.assertEqual(next(f["value"] for f in result["facts"] if f["metric"]=="net_profit" and f["context"]=="OneD"), "8696000")
        wrong = parse_bse_ixbrl(BODY, issuer)
        self.assertFalse(wrong["issuerMatches"]);self.assertFalse(any(f["eligible"] for f in wrong["facts"]))
    def test_unknown_transformation_and_rebound_prefix_fail_closed(self):
        for body in [BODY.replace(b"2020-02-12", b"2099-01-01"), BODY.replace(b"numdotdecimalin", b"numcommadecimal")]:
            parsed = parse_bse_ixbrl(body, ISSUER)
            self.assertTrue(parsed["inlineIssues"]);self.assertFalse(any(f["eligible"] for f in parsed["facts"]))
        body=BODY.replace(b'name="in-capmkt:RevenueFromOperations"', b'xmlns:in-capmkt="https://invalid.example/taxonomy" name="in-capmkt:RevenueFromOperations"',1)
        if body==BODY:
            body=BODY.replace(b"name='in-capmkt:RevenueFromOperations'",b"xmlns:in-capmkt='https://invalid.example/taxonomy' name='in-capmkt:RevenueFromOperations'",1)
        self.assertNotEqual(body,BODY)
        self.assertFalse(any(f["eligible"] for f in parse_bse_ixbrl(body,ISSUER)["facts"]))
    def test_bad_grouping_negative_sign_and_scale_are_not_guessed(self):
        for original, replacement in [(b"8,932.33",b"8,93.233"),(b'scale="5"',b'scale="99"')]:
            # Source uses single or double quotation marks depending on the generator.
            body = BODY.replace(original,replacement)
            if body == BODY: body = BODY.replace(original.replace(b'"',b"'"), replacement.replace(b'"',b"'"))
            self.assertNotEqual(body,BODY)
            self.assertFalse(any(f["eligible"] for f in parse_bse_ixbrl(body,ISSUER)["facts"]))
    def test_nil_is_not_zero_and_reported_negative_sign_is_preserved(self):
        def change(root):
            node=next(n for n in root.iter() if n.get("name","").endswith(":RevenueFromOperations"))
            node.set("{http://www.w3.org/2001/XMLSchema-instance}nil","true")
            node=next(n for n in root.iter() if n.get("name","").endswith(":OtherIncome"))
            node.set("sign","-")
        parsed=parse_bse_ixbrl(self.mutation(change),ISSUER)
        self.assertFalse(any(f["metric"]=="revenue" and f["context"]=="OneD" for f in parsed["facts"]))
        self.assertEqual(next(f["value"] for f in parsed["facts"] if f["metric"]=="other_income" and f["context"]=="OneD"),"-20294000")
    def test_duplicate_context_entity_currency_and_segments_cannot_supply_totals(self):
        def wrong_entity(root):
            next(n for n in root.iter() if n.tag.endswith("}identifier")).text="500325"
        parsed=parse_bse_ixbrl(self.mutation(wrong_entity),ISSUER)
        self.assertFalse(any(f["eligible"] for f in parsed["facts"]))
        def duplicate(root):
            root.append(copy.deepcopy(next(n for n in root.iter() if n.tag.endswith("}context"))))
        with self.assertRaises(ValueError):parse_bse_ixbrl(self.mutation(duplicate),ISSUER)
        parsed=parse_bse_ixbrl(BODY.replace(b"http://www.xbrl.org/2003/iso4217",b"https://invalid.example/currency"),ISSUER)
        self.assertFalse(any(f["eligible"] for f in parsed["facts"]))
        self.assertFalse(any(f["eligible"] and parsed["contexts"][f["context"]]["dimensional"] for f in parsed["facts"]))
    def test_conflicting_same_context_facts_and_periods_remain_ineligible(self):
        def conflicting(root):
            node=copy.deepcopy(next(n for n in root.iter() if n.get("name","").endswith(":RevenueFromOperations")))
            node.text="999.99";root.append(node)
        parsed=parse_bse_ixbrl(self.mutation(conflicting),ISSUER)
        self.assertFalse(any(f["eligible"] for f in parsed["facts"] if f["metric"]=="revenue" and f["context"]=="OneD"))
        def period_conflict(root):
            node=next(n for n in root.iter() if n.get("name","").endswith(":DateOfStartOfReportingPeriod"))
            node.text="01-04-2026"
        parsed=parse_bse_ixbrl(self.mutation(period_conflict),ISSUER)
        self.assertTrue(any(i["reason"]=="period-context-conflict" for i in parsed["issues"]))
        self.assertFalse(any(f["eligible"] for f in parsed["facts"] if f["context"]=="OneD"))
        with self.assertRaises(ValueError):parse_bse_ixbrl(b'<!DOCTYPE x [<!ENTITY x "unsafe">]><html/>',ISSUER)
    def test_index_retains_all_rows_versions_and_unknown_publication_clock(self):
        reader=FixtureReader()
        self.assertTrue(capture_bse_company(self.store,reader,"532742",ISSUER["isin"],self.lookup))
        expected=len({canonical(r) for r in ROWS})
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM catalogue").fetchone()[0],expected)
        receipt=self.store.get("bseResultsReceipt:"+ISSUER["isin"]+":532742")
        self.assertEqual(receipt["archiveCompleteness"],"unverified");self.assertEqual(receipt["publicationClock"],"unverified")
        url=next(u for r in ROWS for u in result_links(r) if u.endswith("16102026185930_IFIndAs.html"))
        doc=self.store.db.execute("SELECT * FROM documents WHERE url=?",(url,)).fetchone()
        read_document(self.store,FixtureReader(bodies={url:BODY}),doc,AT,Path(self.tmp.name))
        dates=self.store.date_assessment(doc["id"])
        self.assertIn("exchange-publication-unverified",dates["issues"]);self.assertFalse(dates["eligibleForNewCatalyst"])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM observations WHERE published_at IS NOT NULL").fetchone()[0],0)
        self.assertEqual(self.store.db.execute("SELECT format FROM versions").fetchone()[0],"ixbrl")
    def test_ignored_filter_and_ambiguous_directory_code_never_assign_facts(self):
        reader=FixtureReader(rows=[{**ROWS[0],"Scrip_cd":500325}])
        self.assertFalse(capture_bse_company(self.store,reader,"532742",ISSUER["isin"],self.lookup))
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM documents").fetchone()[0],0)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM catalogue").fetchone()[0],1)
        reader=FixtureReader()
        self.assertFalse(capture_bse_company(self.store,reader,"532742",ISSUER["isin"],{"532742":None}))
        self.assertEqual(reader.used,0)
    def test_unsupported_original_paths_remain_gaps(self):
        for value in ("../x.xml", "https://invalid.example/x.xml", "FourOneUploadDocument/a.js"):
            with self.assertRaises(ValueError):result_links({"XMLName":value})
        for code in ("-1","532742&FlagDur=1"):
            with self.assertRaises(ValueError):bse_index_url(code)
        self.assertIsNone(reporting_end_hint({"quarter_code":"OTHER2026-2027"}))
    def test_history_resumes_and_keeps_actual_isin_change_as_an_eps_gap(self):
        rows=[];bodies={}
        for period,file in [("SQ2026-2027","paushak-sep-2026.html"),("SQ2025-2026","paushak-sq2025-2026.html"),("MC2025-2026","paushak-mc2025-2026.html")]:
            row=next(r for r in ROWS if r["quarter_code"]==period and str(r.get("XMLName")).endswith(".html"));rows.append(row)
            bodies[result_links(row)[0]]=(FIX/file).read_bytes()
        policy=copy.deepcopy(POLICY);reader=FixtureReader(rows=rows,bodies=bodies)
        self.fill(reader,maximum=1)
        walk=json.loads(self.store.db.execute("SELECT state FROM financial_gap_walks").fetchone()[0])
        self.assertTrue(walk["bseIndexRead"]);self.assertEqual(walk["status"],"budget-pending")
        reader=FixtureReader(rows=rows,bodies=bodies);self.fill(reader,maximum=12)
        self.assertFalse(any("/api/" in u for u in reader.urls))
        fin=financials(self.store,ISSUER["isin"],AT)
        self.assertEqual(fin["quarter"],("2026-07-01","2026-09-30","Standalone"))
        self.assertTrue(fin["prior"])
        # The actual March filing reports a different ISIN. Do not bridge that identity
        # change, mix its EPS into this security or pretend the valuation gap is filled.
        self.assertIsNone(fin["valuationEPS"])
        gap=company_gap(self.store,ISSUER["isin"],ISSUER,AT)
        self.assertEqual(gap["cashFlow"]["state"],"available");self.assertTrue(gap["needsBackfill"])
        self.assertIn("annual-or-TTM:diluted-EPS",gap["missing"])
        self.assertEqual(POLICY,policy);self.assertEqual(MODEL_VERSION,"catalysts-1")
        self.assertEqual(self.store.get("financialGapLastWalk")["collectionOrderVersion"],3)
    def test_real_melstar_history_supplies_comparisons_and_annual_eps_in_same_basis(self):
        issuer={"isin":"INE817A01019","name":"Melstar","bseCodes":["532307"],"symbols":[],"nseSymbols":[]}
        rows=json.loads((FIX/"melstar-results.json").read_text())["Table"]
        for period,file in [("SQ2026-2027","melstar-consolidated.html"),("SQ2025-2026","melstar-sq2025-2026.html"),("MC2025-2026","melstar-mc2025-2026.html")]:
            row=next(r for r in rows if r["quarter_code"]==period and str(r.get("Consol_XMLName")).endswith(".html"))
            url="https://www.bseindia.com/XBRLFILES/"+row["Consol_XMLName"]
            key=self.store.observe(url,issuer,"financial","bse:financial-results",row,AT)
            doc=self.store.db.execute("SELECT * FROM documents WHERE id=?",(key,)).fetchone()
            read_document(self.store,FixtureReader(bodies={url:(FIX/file).read_bytes()}),doc,AT,Path(self.tmp.name))
        fin=financials(self.store,issuer["isin"],AT)
        self.assertEqual(fin["quarter"],("2026-07-01","2026-09-30","Consolidated"))
        self.assertTrue(fin["prior"]);self.assertIsNotNone(fin["valuationEPS"])
        self.assertEqual(fin["valuationPeriod"],"annual")
    def test_current_exchange_response_discovers_only_verified_bse_only_issuers(self):
        entries=json.loads((FIX/"recent-bse-only-identities.json").read_text())
        lookup={str(r["sourceRow"]["Scrip_cd"]):r["identity"] for r in entries}
        reader=mock.Mock();reader.read.return_value=(FIX/"bse-today-results.json").read_bytes()
        self.assertTrue(capture_bse_company(self.store,reader,None,None,lookup))
        reader.read.assert_called_once_with(bse_recent_url())
        self.assertEqual(self.store.db.execute("SELECT count(DISTINCT company) FROM documents").fetchone()[0],len(entries))
        receipt=self.store.get("bseRecentResultsReceipt")
        self.assertEqual(receipt["rows"],217);self.assertEqual(receipt["archiveCompleteness"],"unverified")
        self.assertGreater(receipt["unresolvedRows"],0)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM observations WHERE published_at IS NOT NULL").fetchone()[0],0)
    def test_recent_new_original_wakes_a_company_waiting_for_weekly_refresh(self):
        url=result_links(ROWS[0])[0]
        self.store.observe(url,ISSUER,"financial","bse:financial-results:recent",ROWS[0],AT)
        gap=company_gap(self.store,ISSUER["isin"],ISSUER,AT)
        walks={ISSUER["isin"]:{"lastAttempt":"2026-10-21T00:00:00+00:00","nextRetry":"2026-10-28T00:00:00+00:00","status":"bse-response-read-gaps-remain"}}
        self.assertTrue(collection_queue(self.store,{"companies":[gap]},walks,AT))
        walks[ISSUER["isin"]]["status"]="source-failed"
        self.assertEqual(collection_queue(self.store,{"companies":[gap]},walks,AT),[])
    def test_bse_priority_keeps_nearest_first_fairness_and_global_limits(self):
        base=company_gap(self.store,ISSUER["isin"],ISSUER,AT)
        rows=[{**base,"company":str(i),"symbol":"NSE" if i<5 else None,"bseCode":None if i<5 else "532742"} for i in range(12)]
        profiles={str(i):{"knownBlockers":[],"otherRequirements":[],"verifiedScore":100-i} for i in range(1,12)}
        with mock.patch("recommendation_financial_gaps.collection_profiles",return_value=profiles):
            queue=collection_queue(self.store,{"companies":rows},{},AT)
        self.assertEqual(queue[0][0]["company"],"1");self.assertEqual(queue[1][0]["company"],"5")
        self.assertEqual(queue[1][2],"bse-priority");self.assertEqual(queue[3][2],"oldest-waiting")
        self.assertEqual(len({g["company"] for g,_,_ in queue}),12)
    def test_completed_bse_companies_remain_in_automatic_refresh_rotation(self):
        base={**company_gap(self.store,ISSUER["isin"],ISSUER,AT),"needsBackfill":False}
        with mock.patch("recommendation_financial_gaps.collection_profiles",return_value={}):
            self.assertEqual(len(collection_queue(self.store,{"companies":[base]},{},AT)),1)
            walks={ISSUER["isin"]:{"lastSuccess":AT,"nextRetry":"2026-10-29T08:00:00+00:00"}}
            self.assertEqual(collection_queue(self.store,{"companies":[base]},walks,AT),[])
    def test_bse_refusal_stops_host_and_does_not_rotate_or_call_paid_sources(self):
        opener=mock.Mock();url=bse_index_url("532742")
        opener.open.side_effect=urllib.error.HTTPError(url,403,"refused",{},None)
        reader=PublicReader(self.store,maximum=200,opener=opener,sleep=lambda _:None)
        with self.assertRaises(SourceFailure):reader.read(url)
        with self.assertRaises(SourceFailure):reader.read(url)
        self.assertEqual(reader.used,1);self.assertEqual(opener.open.call_count,1)
        headers=dict(opener.open.call_args[0][0].header_items())
        self.assertEqual(headers["Referer"],"https://www.bseindia.com/")
        self.assertIn("Chrome/",headers["User-agent"])
        self.assertEqual(self.store.db.execute("SELECT error FROM checks WHERE key='host:api.bseindia.com'").fetchone()[0],"access-refused")


if __name__ == "__main__": unittest.main(verbosity=2)
