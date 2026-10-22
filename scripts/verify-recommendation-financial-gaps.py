#!/usr/bin/env python3
"""Offline regressions for exact gaps, original NSE history and resumable free-source filling."""
import copy
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'scripts/lib'))
from recommendation_foundation import Store,canonical,parse_financial_xml
from recommendation_sources import FAMILIES,PublicReader,SourceFailure,BudgetExceeded,capture_window,index_url,index_page
from recommendation_models import financials,score_models,evidence_date,schema as model_schema,MODEL_VERSION,POLICY
from recommendation_financial_gaps import audit_financial_gaps,company_gap,fill_financial_gaps,relevant_documents,collection_profiles,collection_queue

FIX=ROOT/'scripts/fixtures/recommendation-financial-gaps'
AT='2026-10-22T00:00:00+00:00'
BEFORE='2026-10-21T17:00:00+00:00'
ISSUER={'isin':'INE010V01017','name':'L&T Technology Services Ltd','symbols':['LTTS'],'bseCodes':['540115']}
ORIGINAL=json.loads((FIX/'integrated-ltts.json').read_text())
METADATA=json.loads((FIX/'fixture-sources.json').read_text())


class FixtureReader:
    def __init__(self, maximum=200, rows=None, bodies=None):
        self.maximum=maximum;self.used=0;self.deadline=time.monotonic()+600;self.urls=[]
        self.rows=rows if rows is not None else [r for r in ORIGINAL['data'] if r['xbrl'] in {m['url'] for m in METADATA}]
        self.bodies=bodies or {m['url']:(FIX/m['file']).read_bytes() for m in METADATA}
    def read(self,url,limit=None):
        if self.used>=self.maximum:raise BudgetExceeded('fixture budget')
        self.used+=1;self.urls.append(url)
        if '/api/' in url:
            q=parse_qs(urlsplit(url).query)
            if 'integrated-filing-results' in url:
                return canonical({'data':self.rows,'totalCount':len(self.rows),'page':int(q['page'][0])-1,'size':100}).encode()
            return b'[]'
        if url not in self.bodies:raise SourceFailure('Fixture has no supported original body')
        return self.bodies[url]


class GapTests(unittest.TestCase):
    def setUp(self):
        scratch=ROOT/'.cache/recommendation-financial-gap-tests';scratch.mkdir(parents=True,exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=scratch);self.store=Store(Path(self.tmp.name)/'state.sqlite')
        self.store.db.execute('INSERT INTO companies VALUES(?,?)',(ISSUER['isin'],canonical(ISSUER)));self.store.db.commit()
        self.store.set('historyStart','2023-10-19')
        self.lookup={'LTTS':ISSUER,ISSUER['isin']:ISSUER}
        self.seed('ltts-30-sep-2026.xml',BEFORE)
    def tearDown(self):
        self.store.db.close();self.tmp.cleanup()
    def seed(self,file,at):
        m=next(m for m in METADATA if m['file']==file);row=next(r for r in ORIGINAL['data'] if r['xbrl']==m['url'])
        key=self.store.observe(m['url'],ISSUER,'financial','fixture',row,at)
        doc=self.store.db.execute('SELECT * FROM documents WHERE id=?',(key,)).fetchone();body=(FIX/file).read_bytes()
        self.store.save_version(doc,body,'xml',parse_financial_xml(body,ISSUER),at)
    def fill(self,reader=None,**kwargs):
        reader=reader or FixtureReader()
        with mock.patch('recommendation_financial_gaps.iso_now',return_value=AT),mock.patch('recommendation_sources.iso_now',return_value=AT):
            fill_financial_gaps(self.store,reader,self.lookup,Path(self.tmp.name),audit_financial_gaps(self.store,AT,persist=False),**kwargs)
        return reader
    def test_actual_source_contract_and_original_hashes(self):
        rows,total=index_page((FIX/'integrated-ltts.json').read_bytes(),FAMILIES[0],1)
        self.assertEqual(total,20);self.assertTrue(all(r['symbol']=='LTTS' for r in rows))
        self.assertEqual(len(index_page((FIX/'legacy-ltts.json').read_bytes(),FAMILIES[2],1)[0]),2)
        for meta in METADATA:self.assertEqual(hashlib.sha256((FIX/meta['file']).read_bytes()).hexdigest(),meta['sha256'])
    def test_exact_fields_periods_and_annual_gap(self):
        gap=company_gap(self.store,ISSUER['isin'],ISSUER,AT)
        self.assertEqual(gap['quarter'],('2026-07-01','2026-09-30','Consolidated'))
        self.assertEqual(gap['expectedYearEarlierQuarter'],('2025-07-01','2025-09-30','Consolidated'))
        self.assertIn('year-earlier:revenue',gap['missing']);self.assertIn('annual-or-TTM:diluted-EPS',gap['missing'])
        self.assertTrue(all(f['state']=='available' for f in gap['fields'] if f['periodRole']=='current'))
    def test_stale_or_newer_known_quarter_stays_in_the_gap_queue(self):
        self.seed('ltts-30-sep-2025.xml',BEFORE);self.seed('ltts-31-mar-2026.xml',BEFORE)
        stale=company_gap(self.store,ISSUER['isin'],ISSUER,'2027-04-01T00:00:00+00:00')
        self.assertIn('current:recent-quarter',stale['missing'])
        later='2027-01-15T00:00:00+00:00'
        self.store.observe('https://nsearchives.nseindia.com/corporate/new-quarter.xml',ISSUER,'financial','fixture',
            {'qe_Date':'31-DEC-2026'},later)
        gap=company_gap(self.store,ISSUER['isin'],ISSUER,later)
        self.assertIn('current:newer-known-period',gap['missing']);self.assertEqual(gap['latestKnownReportingEnd'],'2026-12-31')
    def test_real_prior_and_annual_filings_fill_without_rewriting_history(self):
        original=[tuple(r) for r in self.store.db.execute('SELECT * FROM versions')]
        policy=copy.deepcopy(POLICY);reader=self.fill()
        gap=company_gap(self.store,ISSUER['isin'],ISSUER,AT)
        self.assertFalse(gap['needsBackfill'],gap);self.assertEqual(gap['valuation']['dilutedEPS'],'120.53')
        self.assertEqual(gap['valuation']['period'],'annual')
        self.assertEqual(gap['yearEarlierQuarter'],('2025-07-01','2025-09-30','Consolidated'))
        self.assertEqual(POLICY,policy)
        self.assertTrue(all(r in [tuple(v) for v in self.store.db.execute('SELECT * FROM versions')] for r in original))
        self.assertIsNone(financials(self.store,ISSUER['isin'],BEFORE)['prior'])
        self.assertIsNone(financials(self.store,ISSUER['isin'],BEFORE)['valuationEPS'])
        self.assertTrue(all(parse_qs(urlsplit(u).query)['symbol']==['LTTS'] for u in reader.urls if '/api/' in u))
    def test_interruption_keeps_window_and_resumes(self):
        self.fill(FixtureReader(maximum=1))
        state=json.loads(self.store.db.execute('SELECT state FROM financial_gap_walks').fetchone()[0])
        self.assertEqual(state['status'],'budget-pending');self.assertTrue(state['inProgress'])
        boundary=(state['from'],state['to'])
        self.fill()
        state=json.loads(self.store.db.execute('SELECT state FROM financial_gap_walks').fetchone()[0])
        self.assertEqual((state['from'],state['to']),boundary);self.assertFalse(state['inProgress'])
    def test_ignored_symbol_and_conflicting_isin_never_close_target_window(self):
        for change in [{'symbol':'OTHER'},{'isin':'INE000000000'}]:
            row={**ORIGINAL['data'][0],**change}
            ok=capture_window(self.store,FixtureReader(rows=[row]),FAMILIES[0],'2025-01-01','2026-10-21',self.lookup,
                symbol='LTTS',expected_isin=ISSUER['isin'])
            self.assertFalse(ok)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM versions').fetchone()[0],1)
        self.assertNotEqual(index_url(FAMILIES[0],'2025-01-01','2026-10-21',symbol='LTTS'),index_url(FAMILIES[0],'2025-01-01','2026-10-21'))
    def test_nonpositive_cash_and_losses_are_not_called_missing(self):
        self.seed('ltts-30-sep-2025.xml',BEFORE);self.seed('ltts-31-mar-2026.xml',BEFORE)
        self.store.db.execute("UPDATE facts SET value='-100' WHERE metric IN ('operating_cash_flow','net_profit')")
        gap=company_gap(self.store,ISSUER['isin'],ISSUER,AT)
        self.assertEqual(gap['cashFlow']['state'],'nonpositive');self.assertFalse(gap['needsBackfill'],gap)
        self.assertTrue(any(f['metric']=='net_profit' and f['state']=='nonpositive' for f in gap['fields']))
        self.assertFalse(score_models(financials(self.store,ISSUER['isin'],AT))['earnings']['qualified'])
        self.assertEqual(self.fill().used,0)
    def test_conflicting_annual_eps_is_not_called_absent_or_resolved_by_ranking(self):
        self.seed('ltts-30-sep-2025.xml',BEFORE);self.seed('ltts-31-mar-2026.xml',BEFORE)
        body=(FIX/'ltts-31-mar-2026.xml').read_bytes();parsed=parse_financial_xml(body,ISSUER)
        for f in parsed['facts']:
            if f['metric']=='eps_diluted_total' and f['start']=='2025-04-01':f['value']='999'
        key=self.store.observe('https://nsearchives.nseindia.com/corporate/contradictory-annual.xml',ISSUER,'financial','fixture',{},BEFORE)
        doc=self.store.db.execute('SELECT * FROM documents WHERE id=?',(key,)).fetchone()
        self.store.save_version(doc,b'contradictory test fixture','xbrl',parsed,BEFORE)
        gap=company_gap(self.store,ISSUER['isin'],ISSUER,AT)
        self.assertEqual(gap['valuation']['state'],'conflicting');self.assertNotIn('annual-or-TTM:diluted-EPS',gap['missing'])
        self.assertTrue(gap['conflicts']);self.assertFalse(score_models(financials(self.store,ISSUER['isin'],AT))['earnings']['qualified'])
    def test_unverified_issuer_is_not_retried_in_a_loop_within_one_walk(self):
        reader=FixtureReader()
        def unverified(store,reader,doc,at,scratch):
            reader.read(doc['url'])
            store.db.execute("UPDATE documents SET status='issuer-unverified',checked_at=? WHERE id=?",(AT,doc['id']))
        with mock.patch('recommendation_financial_gaps.read_document',side_effect=unverified):self.fill(reader)
        source_urls=[u for u in reader.urls if '/api/' not in u]
        self.assertEqual(len(source_urls),len(set(source_urls)))
        self.assertLess(reader.used,reader.maximum)
    def test_bse_only_and_ambiguous_symbols_stay_explicit(self):
        for symbols,expected in [([], 'bse-only-adapter-unavailable'),(['OLD','NEW'],'ambiguous-symbol')]:
            identity={**ISSUER,'symbols':symbols}
            self.store.db.execute('UPDATE companies SET identity=?',(canonical(identity),));self.store.db.commit()
            row=audit_financial_gaps(self.store,AT)['companies'][0]
            self.assertEqual(row['sourceSupport'],expected);self.assertTrue(row['needsBackfill'])
            self.assertEqual(self.fill().used,0)
    def test_source_refusal_retains_cooldown_and_does_not_spend_requests(self):
        self.store.check('host:www.nseindia.com',BEFORE,'access-refused',{},'2026-10-23T00:00:00+00:00')
        opener=mock.Mock();reader=PublicReader(self.store,maximum=200,opener=opener,sleep=lambda n:None)
        self.fill(reader)
        opener.open.assert_not_called();self.assertEqual(reader.used,0)
        self.assertEqual(self.store.db.execute("SELECT cooldown_until FROM checks WHERE key='host:www.nseindia.com'").fetchone()[0],'2026-10-23T00:00:00+00:00')
    def test_request_and_time_slices_restore_existing_global_limits(self):
        reader=FixtureReader();maximum,deadline=reader.maximum,reader.deadline
        self.fill(reader,maximum=1,seconds=1)
        self.assertEqual(reader.maximum,maximum);self.assertEqual(reader.deadline,deadline);self.assertEqual(reader.used,1)
        walk=self.store.get('financialGapLastWalk');self.assertEqual(walk['requestCeiling'],1)
    def discover(self,file):
        m=next(m for m in METADATA if m['file']==file);row=next(r for r in ORIGINAL['data'] if r['xbrl']==m['url'])
        return self.store.observe(m['url'],ISSUER,'financial','fixture',row,BEFORE)
    def assessment(self,model='earnings',at=BEFORE,**changes):
        model_schema(self.store)
        doc=self.store.db.execute("SELECT * FROM documents WHERE status='read' LIMIT 1").fetchone()
        self.store.db.execute('UPDATE observations SET published_at=? WHERE document=?',('2026-10-19T04:33:50+00:00',doc['id']))
        version=self.store.db.execute('SELECT id FROM versions WHERE document=?',(doc['id'],)).fetchone()[0]
        result={'company':ISSUER['isin'],'model':model,'at':at,'modelVersion':MODEL_VERSION,'document':doc['id'],
            'version':version,'timing':{'publishedAt':'2026-10-19T04:33:50+00:00'},'fieldEvidence':{},
            'score':99,'missing':['Positive verified TTM/annual diluted EPS and P/E no greater than 40']}
        result.update(changes)
        self.store.db.execute('INSERT INTO recommendation_assessments VALUES(?,?,?,?,?)',
            (model+at+str(changes),ISSUER['isin'],model,at,canonical(result)));self.store.db.commit()
        return result
    def test_known_filings_close_gaps_with_two_reads_and_no_index_rediscovery(self):
        self.discover('ltts-30-sep-2025.xml');self.discover('ltts-31-mar-2026.xml')
        reader=self.fill(maximum=2)
        self.assertEqual(reader.used,2);self.assertFalse(any('/api/' in u for u in reader.urls))
        self.assertFalse(company_gap(self.store,ISSUER['isin'],ISSUER,AT)['needsBackfill'])
    def test_completed_index_family_is_not_spent_again_after_document_interruption(self):
        self.fill(FixtureReader(maximum=2))
        walk=json.loads(self.store.db.execute('SELECT state FROM financial_gap_walks').fetchone()[0])
        self.assertEqual(walk['family'],1);self.assertEqual(walk['status'],'budget-pending')
        reader=self.fill()
        self.assertEqual(reader.used,1);self.assertFalse(any('/api/' in u for u in reader.urls))
    def test_profile_uses_current_facts_and_does_not_accept_stored_or_future_scores(self):
        self.assessment();self.assessment(at='2026-10-23T00:00:00+00:00',score=100,missing=[])
        gaps={ISSUER['isin']:company_gap(self.store,ISSUER['isin'],ISSUER,AT)}
        before=[tuple(r) for r in self.store.db.execute('SELECT * FROM recommendation_assessments')]
        p=collection_profiles(self.store,gaps,AT)[ISSUER['isin']]
        self.assertEqual(p['verifiedScore'],score_models(financials(self.store,ISSUER['isin'],AT))['earnings']['score'])
        self.assertNotEqual(p['verifiedScore'],99);self.assertEqual(p['assessmentAt'],BEFORE)
        self.assertFalse(p['knownBlockers']);self.assertFalse(p['otherRequirements'])
        self.assertEqual(before,[tuple(r) for r in self.store.db.execute('SELECT * FROM recommendation_assessments')])
        self.store.set('identityConflict:'+p['document'],['different-issuer']);self.store.db.commit()
        self.assertEqual(collection_profiles(self.store,gaps,AT),{})
    def test_known_losses_and_high_pe_are_not_treated_as_fillable_absences(self):
        self.assessment()
        self.store.db.execute("UPDATE facts SET value='-1' WHERE metric='net_profit'")
        gaps={ISSUER['isin']:company_gap(self.store,ISSUER['isin'],ISSUER,AT)}
        p=collection_profiles(self.store,gaps,AT)[ISSUER['isin']]
        self.assertIn('Reported quarterly loss/nonpositive metric',p['knownBlockers'])
        self.seed('ltts-31-mar-2026.xml',BEFORE)
        self.store.db.execute('DELETE FROM recommendation_assessments')
        self.assessment(priceAtAssessment={'close':'100000'})
        gaps={ISSUER['isin']:company_gap(self.store,ISSUER['isin'],ISSUER,AT)}
        self.assertIn('Verified P/E exceeds policy',collection_profiles(self.store,gaps,AT)[ISSUER['isin']]['knownBlockers'])
    def test_changed_original_requires_reassessment_before_old_terms_rank_collection(self):
        result=self.assessment()
        version=self.store.db.execute('SELECT * FROM versions WHERE id=?',(result['version'],)).fetchone()
        doc=self.store.db.execute('SELECT * FROM documents WHERE id=?',(result['document'],)).fetchone()
        self.store.save_version(doc,b'changed original regression',version['format'],json.loads(version['parsed']),AT)
        gap=company_gap(self.store,ISSUER['isin'],ISSUER,AT)
        statements=[];self.store.db.set_trace_callback(statements.append)
        self.assertEqual(collection_profiles(self.store,{ISSUER['isin']:gap},AT),{})
        self.store.db.set_trace_callback(None)
        self.assertFalse(any('recommendation_outcomes' in sql for sql in statements))
    def test_all_three_models_rank_real_financial_gaps_and_keep_nonfinancial_gates(self):
        gap=company_gap(self.store,ISSUER['isin'],ISSUER,AT)
        for model in ('earnings','orders','capacity'):
            with self.subTest(model=model):
                model_schema(self.store);self.store.db.execute('DELETE FROM recommendation_assessments')
                self.assessment(model=model,fieldEvidence={'orderValue':{'value':'1000000','page':1,'offset':10}})
                p=collection_profiles(self.store,{ISSUER['isin']:gap},AT)[ISSUER['isin']]
                self.assertEqual(p['model'],model);self.assertTrue(p['financialRequirements'])
                if model!='earnings':self.assertTrue(p['otherRequirements'])
    def test_newest_failing_catalyst_takes_priority_over_an_older_apparent_pass(self):
        fields={k:{'value':v,'page':1,'offset':10} for k,v in [('firmOrder',True),('orderValue','10000000'),('executionMonths',6)]}
        self.assessment(model='orders',fieldEvidence=fields)
        self.assessment(model='orders',fieldEvidence={},timing={'publishedAt':'2026-10-20T00:00:00+00:00'})
        gap=company_gap(self.store,ISSUER['isin'],ISSUER,AT)
        p=collection_profiles(self.store,{ISSUER['isin']:gap},AT)[ISSUER['isin']]
        self.assertIn('Unambiguous firm order; LOIs and framework agreements excluded',p['otherRequirements'])
        self.assertLess(p['verifiedScore'],40)
    def test_a_second_required_filing_is_read_even_after_the_first_fills_the_gap(self):
        self.seed('ltts-30-sep-2025.xml',BEFORE)
        self.discover('ltts-31-mar-2026.xml')
        m=next(m for m in METADATA if m['file']=='ltts-31-mar-2026.xml')
        row=next(r for r in ORIGINAL['data'] if r['xbrl']==m['url'])
        url='https://nsearchives.nseindia.com/corporate/another-annual.xml'
        self.store.observe(url,ISSUER,'financial','fixture',row,BEFORE)
        body=(FIX/'ltts-31-mar-2026.xml').read_bytes()
        reader=FixtureReader(bodies={m['url']:body,url:body})
        self.fill(reader)
        self.assertEqual(set(reader.urls),{m['url'],url});self.assertEqual(reader.used,2)
    def test_every_fourth_turn_serves_oldest_waiting_and_cooldowns_are_respected(self):
        base=company_gap(self.store,ISSUER['isin'],ISSUER,AT)
        rows=[{**base,'company':str(i),'missing':['one'] if i else ['many']*9} for i in range(10)]
        profiles={str(i):{'knownBlockers':[],'otherRequirements':[],'verifiedScore':i} for i in range(1,9)}
        walks={'9':{'nextRetry':'2026-10-23T00:00:00+00:00'}}
        with mock.patch('recommendation_financial_gaps.collection_profiles',return_value=profiles):
            queue=collection_queue(self.store,{'companies':rows},walks,AT)
        self.assertEqual([g['company'] for g,_,_ in queue[:4]],['8','7','6','0'])
        self.assertEqual(queue[3][2],'oldest-waiting');self.assertEqual(len(queue),9)
        self.assertEqual(len({g['company'] for g,_,_ in queue}),9)
    def test_one_company_yields_its_request_turn_without_losing_its_cursor(self):
        empty={**company_gap(self.store,ISSUER['isin'],ISSUER,AT),'company':'INE000000000','symbol':'OTHER'}
        self.store.db.execute('INSERT INTO companies VALUES(?,?)',(empty['company'],canonical({'isin':empty['company'],'symbols':['OTHER']})))
        gap=company_gap(self.store,ISSUER['isin'],ISSUER,AT)
        reader=FixtureReader(rows=[])
        with mock.patch('recommendation_financial_gaps.collection_queue',return_value=[(gap,None,'priority'),(empty,None,'oldest-waiting')]):
            self.fill(reader,maximum=4,company_maximum=2)
        self.assertEqual(reader.used,4)
        walks=[json.loads(r[0]) for r in self.store.db.execute('SELECT state FROM financial_gap_walks')]
        self.assertEqual(len(walks),2);self.assertTrue(all(w['family']==2 and w['status']=='budget-pending' for w in walks))
        self.assertEqual(self.store.get('financialGapLastWalk')['companyRequestCeiling'],2)
    def test_audit_is_separate_from_recommendation_scores_and_includes_whole_directory(self):
        self.store.db.execute('INSERT INTO companies VALUES(?,?)',('INE000000000',canonical({'isin':'INE000000000','name':'Uncaptured','symbols':[]})))
        audit=audit_financial_gaps(self.store,AT)
        self.assertEqual(audit['summary']['universe']['companies'],2)
        self.assertEqual(audit['summary']['currentQuarterCompanies']['withQuarter'],1)
        self.assertFalse(audit['summary']['modelRulesChanged']);self.assertEqual(audit['summary']['status'],'partial')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM financial_gap_state').fetchone()[0],2)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM financial_gap_audits').fetchone()[0],1)
    def test_public_delivery_keeps_global_checks_and_explicit_archived_company_counts(self):
        spec=importlib.util.spec_from_file_location('gap_reader_runner',ROOT/'scripts/run-recommendation-models.py')
        runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        for i in range(500):self.store.check('gap-source:company-'+str(i)+':integrated-equity',AT,'source-unavailable',{'company':i})
        self.store.check('host:www.nseindia.com',AT,detail={'httpStatus':200})
        self.store.check('source:integrated-equity:recent',AT,detail={'records':20})
        audit_financial_gaps(self.store,AT)
        report=runner.analyze(self.store,Path(self.tmp.name),at=AT,extract=False)
        inventory=report['coverage']['sourceCheckInventory']
        self.assertEqual(inventory['total'],502);self.assertEqual(inventory['included'],2)
        self.assertEqual(inventory['archivedCompanyChecks'],500)
        self.assertEqual(inventory['summaryRows'],1)
        self.assertTrue(all(not c['key'].startswith('gap-source:') for c in report['coverage']['sourceChecks']))
        self.assertEqual(len(report['coverage']['sourceChecks']),3)
        summary=report['coverage']['sourceChecks'][-1]
        self.assertIn('500 failed',summary['key']);self.assertIn(AT,summary['key'])
        self.assertIn('500 of 500',summary['error']);self.assertIsNone(summary['success_at'])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM checks WHERE key LIKE 'gap-source:%'").fetchone()[0],500)
        self.assertEqual(report['coverage']['financialHistory']['targetedCollection']['failedSourceChecks'],500)
        self.assertEqual(report['policy'],POLICY)
        def check(at,success,error=None):
            return {'key':'gap-source:company:integrated-equity','attempted_at':at,'success_at':success,'error':error}
        earlier='2026-10-20T12:00:00+00:00'
        checks,inventory=runner.reader_source_checks([check(earlier,earlier),check(AT,AT)])
        self.assertEqual(checks[0]['success_at'],earlier);self.assertIsNone(checks[0]['error'])
        checks,_=runner.reader_source_checks([check(AT,earlier,'source-unavailable')])
        self.assertIsNone(checks[0]['success_at']);self.assertIn('1 of 1',checks[0]['error'])
        checks,inventory=runner.reader_source_checks([])
        self.assertEqual(checks,[]);self.assertEqual(inventory['summaryRows'],0)


if __name__=='__main__':unittest.main(verbosity=2)
