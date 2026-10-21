#!/usr/bin/env python3
"""Offline regressions for point-in-time scoring, source contracts and honest outcome accounting."""
import copy
import datetime as dt
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from decimal import Decimal as D
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts/lib"))
from recommendation_foundation import Store, canonical, parse_financial_xml
from recommendation_models import schema, score_models, extract_catalyst, financials, assess, MODEL_VERSION, evidence_date
from recommendation_backtest import outcome, summarize, backtest
from recommendation_market import parse_prices, parse_indices, parse_actions, collect_market
from recommendation_sources import PublicReader, SourceFailure
from recommendation_github import GithubState

AT = '2026-10-21T16:00:00+00:00'
ISSUER = {"isin": "INE372C01037", "name": "Fixture company", "symbols": ["PRECWIRE"], "bseCodes": ["523539"]}


def fin_fixture():
    period = ('2026-07-01', '2026-09-30', 'Consolidated')
    prior = ('2025-07-01', '2025-09-30', 'Consolidated')
    annual = ('2025-04-01', '2026-03-31', 'Consolidated')
    data = {'revenue': (D(1300), D(1000)), 'net_profit': (D(150), D(100)), 'pbt_before_exceptional': (D(180), D(120)),
        'eps_diluted_total': (D(15), D(10)), 'other_income': (D(5), D(4)), 'exceptional_before_tax': (D(0), D(0))}
    facts = {(k, *p): {'value': pair[i], 'versions': ['fixture']} for k, pair in data.items() for i, p in enumerate([period, prior])}
    facts[('operating_cash_flow', *annual)] = {'value': D(500), 'versions': ['fixture']}
    get = lambda metric, p=None: facts.get((metric, *(p or period)), {}).get('value')
    return {'facts': facts, 'quarter': period, 'prior': prior, 'basis': 'Consolidated', 'conflicts': [], 'get': get,
        'baselineRevenue': D(4000), 'baselinePeriod': annual[1], 'valuationEPS': D(40), 'valuationPeriod': 'annual', 'annual': annual}


class ModelTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / '.cache/recommendation-model-tests'
        scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=scratch)
        self.store = Store(Path(self.tmp.name) / 'state.sqlite')
        schema(self.store)

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def test_all_three_positive_and_missing_evidence(self):
        f = fin_fixture()
        fields = extract_catalyst('We received a firm purchase order.\nOrder value INR 60 crore excluding GST.\nExecution within 6 months.\f'
            'The project successfully commissioned.\nExisting capacity utilisation: 85%.\nCapacity addition: 25%.\nFunded entirely through internal accruals.\nSigned offtake agreement.')
        # Values are in rupees; baseline uses the same exact units in this hypothetical fixture.
        f['baselineRevenue'] = D(4000000000)
        result = score_models(f, fields)
        self.assertTrue(all(r['qualified'] for r in result.values()), result)
        self.assertEqual(fields['orderValue']['value'], '600000000')
        self.assertEqual(fields['commissioned']['page'], 2)
        self.assertIn('successfully commissioned', fields['commissioned']['quote'])
        self.assertFalse(score_models(f)['orders']['qualified'])
        self.assertFalse(score_models(f)['capacity']['qualified'])
        self.assertFalse(any(r['qualified'] for r in score_models({'quarter': None}).values()))

    def test_orders_no_loi_cancellation_jv_or_ambiguous_amount(self):
        f = fin_fixture(); f['baselineRevenue'] = D(4000000000)
        text = 'We received a purchase order.\nOrder value INR 60 crore.\nExecution 6 months.'
        self.assertTrue(score_models(f, extract_catalyst(text))['orders']['qualified'])
        for extra in ['Letter of intent', 'The contract was cancelled', 'A consortium', 'inclusive of GST', '\nOrder value INR 90 crore.']:
            self.assertFalse(score_models(f, extract_catalyst(text + '\n' + extra))['orders']['qualified'], extra)

    def test_capacity_proposal_does_not_become_production(self):
        f = fin_fixture()
        text = 'Proposed capacity addition 40%.\nExisting utilisation 90%.\nFunding will be arranged.\nDemand is expected.'
        r = score_models(f, extract_catalyst(text))['capacity']
        self.assertFalse(r['qualified'])
        self.assertNotIn('Commercial production has commenced', r['reasons'])

    def test_negations_proposals_and_unlinked_projects_never_qualify(self):
        f=fin_fixture();f['baselineRevenue']=D(4000000000)
        order='We received a purchase order.\nOrder value INR 60 crore.\nExecution 6 months.'
        for text in [order.replace('received','have not received'),order.replace('received','expect we will receive'),order.replace('\nOrder value','\fOrder value'),order+'\nTwo new contracts.']:
            self.assertFalse(score_models(f,extract_catalyst(text))['orders']['qualified'],text)
        capacity='Successfully commissioned.\nExisting capacity utilisation 85%.\nCapacity addition 25%.\nFully funded.\nSigned offtake agreement.'
        self.assertTrue(score_models(f,extract_catalyst(capacity))['capacity']['qualified'])
        for text in [capacity.replace('Successfully','Will be successfully'),capacity.replace('Fully funded','Not fully funded'),capacity.replace('Signed offtake','No signed offtake'),capacity.replace('\nFully funded','\fFully funded'),capacity+'\nSeveral new projects.']:
            self.assertFalse(score_models(f,extract_catalyst(text))['capacity']['qualified'],text)

    def test_sign_changes_missing_cash_conflicts_and_one_offs(self):
        f = fin_fixture()
        self.assertTrue(score_models(f)['earnings']['qualified'])
        key = ('operating_cash_flow', *f['annual']); del f['facts'][key]
        self.assertFalse(score_models(f)['earnings']['qualified'])
        f = fin_fixture(); f['facts'][('net_profit', *f['prior'])]['value'] = D(-10)
        self.assertFalse(score_models(f)['earnings']['qualified'])
        f = fin_fixture(); f['facts'][('exceptional_before_tax', *f['quarter'])]['value'] = D(100)
        self.assertFalse(score_models(f)['earnings']['qualified'])
        f = fin_fixture(); f['conflicts'] = [['revenue', 'period']]
        self.assertFalse(score_models(f)['earnings']['qualified'])

    def test_actual_financial_versions_do_not_leak_future_corrections(self):
        body = (ROOT / 'scripts/fixtures/recommendation-foundation/precision-wires-2026.xml').read_bytes()
        key = self.store.observe('https://nsearchives.nseindia.com/corporate/xbrl/results.xml', ISSUER, 'financial', 'fixture', {'date':'2026-10-21'}, AT, AT)
        doc = self.store.db.execute('SELECT * FROM documents WHERE id=?', (key,)).fetchone()
        parsed = parse_financial_xml(body, ISSUER)
        self.store.save_version(doc, body, 'xbrl', parsed, AT)
        first = financials(self.store, ISSUER['isin'], AT)
        self.assertTrue(first['quarter'])
        before = first['get']('revenue')
        changed = copy.deepcopy(parsed)
        for fact in changed['facts']:
            if fact['metric'] == 'revenue': fact['value'] = str(D(fact['value']) * 2)
        self.store.save_version(doc, body+b' ', 'xbrl', changed, '2026-10-22T16:00:00+00:00')
        self.assertEqual(financials(self.store, ISSUER['isin'], AT)['get']('revenue'), before)
        self.assertEqual(financials(self.store, ISSUER['isin'], '2026-10-23T16:00:00+00:00')['get']('revenue'), before*2)
        # A conflicting independent filing cannot silently become the preferred number.
        other = self.store.observe('https://nsearchives.nseindia.com/corporate/xbrl/other.xml', ISSUER, 'financial', 'fixture', {}, AT)
        doc2 = self.store.db.execute('SELECT * FROM documents WHERE id=?', (other,)).fetchone()
        self.store.save_version(doc2, body, 'xbrl', changed, AT)
        self.assertTrue(financials(self.store, ISSUER['isin'], AT)['conflicts'])

    def test_old_document_and_later_publication_do_not_create_fresh_signal(self):
        key = self.store.observe('https://nsearchives.nseindia.com/corporate/order.pdf', ISSUER, 'catalyst', 'fixture', {'date':'2026-10-21'}, AT, AT)
        doc = self.store.db.execute('SELECT * FROM documents WHERE id=?', (key,)).fetchone()
        self.store.save_version(doc, b'fixture', 'pdf', {'issuerMatches':True, 'documentDate':'2026-01-14'}, AT)
        self.assertIsNone(evidence_date(self.store, key, AT))
        self.assertIsNone(evidence_date(self.store, key, '2026-10-20T16:00:00+00:00'))

    def test_ist_rollover_and_publication_offsets_are_actual_instants(self):
        at='2026-10-21T19:00:00+00:00'
        key=self.store.observe('https://nsearchives.nseindia.com/corporate/rollover.pdf',ISSUER,'catalyst','fixture',{'date':'2026-10-22'},at,'2026-10-22T00:10:00+05:30')
        doc=self.store.db.execute('SELECT * FROM documents WHERE id=?',(key,)).fetchone()
        self.store.save_version(doc,b'fixture','pdf',{'issuerMatches':True,'documentDate':'2026-10-22'},at)
        self.assertTrue(evidence_date(self.store,key,at),'The current IST day is valid before the UTC rollover')
        self.store.db.execute('UPDATE observations SET published_at=? WHERE document=?',('2026-10-21T19:30:00+00:00',key))
        self.assertIsNone(evidence_date(self.store,key,at),'A future publication instant cannot enter the decision')

    def test_real_daily_source_contracts(self):
        folder = ROOT / 'scripts/fixtures/recommendation-models'
        with io.BytesIO() as b:
            with zipfile.ZipFile(b,'w') as z: z.writestr('bhav.csv', (folder/'bhavcopy.csv').read_bytes())
            body = b.getvalue()
        rows = parse_prices(body, '2026-10-19')
        self.assertTrue(rows)
        with self.assertRaisesRegex(ValueError, 'session'): parse_prices(body, '2026-10-20')
        index = parse_indices((folder/'indices.csv').read_bytes(), '2026-10-19')
        self.assertEqual(index[0][1], 'Nifty 500')
        with self.assertRaises(ValueError): parse_indices((folder/'indices.csv').read_bytes(), '2026-10-20')
        self.assertTrue(parse_actions((folder/'actions.json').read_bytes(), '2026-10-01', '2026-10-21'))
        with self.assertRaises(ValueError): parse_actions((folder/'actions.json').read_bytes(), '2026-10-02', '2026-10-21')

    def prepare_signal(self):
        signal = {'id':'signal-1', 'company':ISSUER['isin'], 'model':'earnings', 'catalyst':'doc', 'model_version':MODEL_VERSION,
            'issued_at':'2026-01-05T04:00:00+00:00', 'payload':'{}'}
        self.store.db.execute('INSERT INTO recommendation_signals VALUES(?,?,?,?,?,?,?)', tuple(signal.values()))
        dates = ['2026-01-06','2026-01-07','2026-01-08']
        for i, date in enumerate(dates):
            self.store.db.execute('INSERT INTO market_prices VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', (date, ISSUER['isin'], 'PRECWIRE', 'EQ', '100','120','90',str(110+i*5),'10000','20000000',AT,'fixture'))
            self.store.db.execute('INSERT INTO market_indices VALUES(?,?,?,?,?,?)', (date, 'Nifty 500', '1000', '1050', AT, 'fixture'))
        self.store.check('market:actions', AT, detail={'from':'2025-01-01','to':'2026-10-21'})
        return signal

    def test_next_session_costs_benchmark_and_immutable_ledger(self):
        signal = self.prepare_signal()
        r = outcome(self.store, signal, 3, AT)
        self.assertEqual(r['status'], 'measured')
        self.assertEqual(r['entrySession'], '2026-01-06')
        self.assertEqual(D(r['netReturnPct']), D('19.5'))
        self.assertEqual(D(r['benchmarkReturnPct']), D(5))
        self.assertEqual(D(r['excessReturnPct']), D('14.5'))
        backtest(self.store, AT)
        backtest(self.store, AT)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM recommendation_outcomes').fetchone()[0], 2)
        self.assertEqual(self.store.db.execute('SELECT issued_at FROM recommendation_signals').fetchone()[0], signal['issued_at'])

    def test_unpriced_actions_calendar_and_pending_stay_in_denominator(self):
        signal = self.prepare_signal()
        self.assertEqual(outcome(self.store, signal, 63, AT)['status'], 'pending')
        self.store.db.execute("DELETE FROM market_prices WHERE session='2026-01-07'")
        self.assertEqual(outcome(self.store, signal, 3, AT)['status'], 'unpriced')
        self.store.db.execute("DELETE FROM market_indices WHERE session='2026-01-07'")
        self.assertEqual(outcome(self.store, signal, 2, AT)['status'], 'calendar-unverified')
        self.store.db.execute("INSERT INTO market_holidays VALUES('2026-01-07','Verified holiday',?,'fixture')", (AT,))
        self.assertEqual(outcome(self.store, signal, 2, AT)['status'], 'measured')
        self.store.db.execute('INSERT INTO market_actions VALUES(?,?,?,?,?,?)', ('action',ISSUER['isin'],'2026-01-08','Bonus 1:1',AT,'{}'))
        self.assertEqual(outcome(self.store, signal, 2, AT)['status'], 'corporate-action')
        report = summarize([{'status':'pending'},{'status':'unpriced'},{'status':'corporate-action'}])
        self.assertEqual(report['signals'], 3)
        self.assertIsNone(report['winRate'])
        self.assertEqual(report['validation'], 'insufficient-history')

    def test_scores_are_not_called_probabilities_or_historical_performance(self):
        report = backtest(self.store, AT)
        self.assertEqual(report['strategyValidation'], 'not-established')
        self.assertIn('unavailable', report['historicalReconstruction'])
        self.assertEqual(report['models']['earnings']['63']['signals'], 0)
        client = GithubState(env={'GITHUB_REPOSITORY':'techmuns/Sattva-Central-Research','GITHUB_TOKEN':'fixture'})
        with self.assertRaises(ValueError): client.publish_recommendations('absent', {})

    def test_no_signals_when_price_or_financial_evidence_missing(self):
        self.store.db.execute('INSERT INTO companies VALUES(?,?)', (ISSUER['isin'],canonical(ISSUER)))
        result = assess(self.store, AT)
        self.assertEqual(result['rows'], [])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM recommendation_signals').fetchone()[0], 0)

    def test_qualifying_case_requotes_reprints_and_withdrawal_preserve_first_decision(self):
        key = self.store.observe('https://nsearchives.nseindia.com/corporate/earnings.xml', ISSUER, 'financial', 'fixture', {'date':'2026-10-21'}, AT, AT)
        doc = self.store.db.execute('SELECT * FROM documents WHERE id=?',(key,)).fetchone()
        f = fin_fixture()
        fact = {'metric':'revenue','start':f['quarter'][0],'end':f['quarter'][1],'basis':f['basis'],'value':'1300','unitRef':'INR','eligible':True,'unitDefinition':'<measure>iso4217:INR</measure>'}
        parsed = {'issuerMatches':True,'documentDate':'2026-10-21','facts':[fact]}
        self.store.save_version(doc,b'fixture1','xbrl',parsed,AT)
        date = dt.date(2026,10,21); sessions=[]
        while len(sessions)<20:
            if date.weekday()<5:sessions.append(date.isoformat())
            date-=dt.timedelta(days=1)
        for date in sessions:
            self.store.db.execute('INSERT INTO market_prices VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(date,ISSUER['isin'],'PRECWIRE','EQ','100','110','90','100','100000','20000000',AT,'fixture'))
            self.store.db.execute('INSERT INTO market_indices VALUES(?,?,?,?,?,?)',(date,'Nifty 500','1000','1010',AT,'fixture'))
        self.store.check('market:actions',AT,detail={'from':'2025-01-01','to':'2026-10-23'})
        with mock.patch('recommendation_models.financials',return_value=f):
            first=assess(self.store,AT)
        self.assertEqual(len(first['rows']),1,first)
        sid=first['rows'][0]['id']
        saved=self.store.db.execute('SELECT * FROM recommendation_signals WHERE id=?',(sid,)).fetchone()
        original_payload=saved['payload']
        tomorrow='2026-10-22T16:00:00+00:00'
        other=self.store.observe('https://nsearchives.nseindia.com/corporate/repeated-earnings.xml',ISSUER,'financial','fixture',{'date':'2026-10-22'},tomorrow,tomorrow)
        other_doc=self.store.db.execute('SELECT * FROM documents WHERE id=?',(other,)).fetchone()
        self.store.save_version(other_doc,b'fixture2','xbrl',{**parsed,'documentDate':'2026-10-22'},tomorrow)
        with mock.patch('recommendation_models.financials',return_value=f):
            again=assess(self.store,tomorrow)
        self.assertEqual(again['rows'][0]['id'],sid,'Reprints/new evidence update one evolving case')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM recommendation_signals').fetchone()[0],1)
        self.assertEqual(self.store.db.execute('SELECT payload FROM recommendation_signals WHERE id=?',(sid,)).fetchone()[0],original_payload)
        weakened=fin_fixture();weakened['facts'][('exceptional_before_tax',*weakened['quarter'])]['value']=D(500)
        with mock.patch('recommendation_models.financials',return_value=weakened):
            withdrawn=assess(self.store,'2026-10-23T16:00:00+00:00')
        self.assertEqual(withdrawn['rows'],[])
        review=self.store.db.execute('SELECT payload FROM recommendation_reviews WHERE signal=? ORDER BY at DESC LIMIT 1',(sid,)).fetchone()[0]
        self.assertFalse(json.loads(review)['qualified'])
        self.assertEqual(self.store.db.execute('SELECT issued_at FROM recommendation_signals').fetchone()[0],AT)

    def test_liquidity_does_not_skip_zero_or_missing_sessions(self):
        from recommendation_models import market_snapshot
        self.test_qualifying_case_requotes_reprints_and_withdrawal_preserve_first_decision()
        self.assertTrue(market_snapshot(self.store,ISSUER['isin'],AT)['liquid'])
        self.store.db.execute("DELETE FROM market_prices WHERE session='2026-10-20'")
        self.assertFalse(market_snapshot(self.store,ISSUER['isin'],AT)['liquid'])

    def test_failed_market_intervals_remain_a_separate_retry_queue(self):
        folder=ROOT/'scripts/fixtures/recommendation-models'
        with io.BytesIO() as data:
            with zipfile.ZipFile(data,'w') as z:z.writestr('bhav.csv',(folder/'bhavcopy.csv').read_bytes())
            zipped=data.getvalue()
        requested=[]
        class Reader:
            def read(inner,url):
                requested.append(url)
                if 'corporates-corporateActions' in url:return b'[]'
                if 'holiday-master' in url:return b'{"CM":[{"tradingDate":"20-Oct-2026","description":"Verified source fixture holiday"}]}'
                if '20261019_F' in url:return zipped
                if 'ind_close_all_19102026' in url:return (folder/'indices.csv').read_bytes()
                raise SourceFailure('Original source HTTP 404',404)
        self.store.check('market:indices:2026-10-01','2026-10-01T00:00:00+00:00','Interrupted response')
        collect_market(self.store,Reader(),dt.date(2026,10,21),days_per_walk=10)
        self.assertTrue(any('ind_close_all_01102026' in u for u in requested),'Index-only failures are retried independently of backfill cursor')
        self.assertTrue(self.store.db.execute("SELECT error FROM checks WHERE key='market:indices:2026-10-01'").fetchone()[0])
        self.assertTrue(self.store.db.execute("SELECT success_at FROM checks WHERE key='market:indices:2026-10-19'").fetchone()[0])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM market_holidays').fetchone()[0],1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
