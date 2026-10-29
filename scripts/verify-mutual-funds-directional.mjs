import assert from 'node:assert/strict';
import {ACTIVITY_BASIS,schemeActivity} from '../public/js/data/mutual-funds-activity.js';
import {readableOwnership} from '../public/js/data/mutual-funds-ownership.js';
import {fundHouseLead,activityNotes,netVolumeCr} from '../public/js/data/mutual-funds-insight.js';
import {comparisonStatus} from '../public/js/data/mutual-funds-status.js';
import {projectCompany,summaryOf} from '../worker/mutual-funds-model.mjs';
import {supplementCompany} from '../worker/mutual-funds-scanner-model.mjs';
for(const [name,category] of [
  ['HDFC Arbitrage Fund','arbitrage'],['ICICI Prudential Equity-Arbitrage Fund','arbitrage'],
  ['Kotak Liquid Fund','fixed-income'],['SBI Corporate Bond Fund','fixed-income'],
  ['Nifty Bharat Bond Index Fund','fixed-income'],['HDFC Short Duration Fund','fixed-income'],
  ['HDFC Equity Savings Fund','hybrid'],['HDFC Hybrid Debt Fund','hybrid'],
  ['360 ONE Multi Asset Allocation Fund - investing in equity, debt and gold','hybrid'],
  ['Bank of India Conservative Hybrid Fund','hybrid'],['HDFC Balanced Advantage Fund','hybrid'],
  ['Zerodha Nifty LargeMidcap250 Plus 8-13 yr G-Sec 70:30 Index Fund','hybrid'],
  ['ZERODHA NIFTY LARGEMIDCAP250 PLUS G-SEC 70:30 INDEX FUND','hybrid'],
  ['Franklin India Dividend Yield Fund (Formerly known as Templeton India Equity Income Fund) ^','equity'],
  ['Retirement Income Generation Scheme','unclassified'],['Equity Market Neutral Fund','unclassified'],
  ['SBI Smallcap Fund','equity'],['HDFC Nifty 50 ETF','equity'],['Axis Nifty500 Quality 50 Index Fund','equity'],
  ['Growth Fund','unclassified'],['HDFC Gold ETF','unclassified'],['ALTIVA Hybrid Long-Short Fund','unclassified']
])assert.equal(schemeActivity({name}).category,category,name);
assert.equal(schemeActivity({name:'Equity Arbitrage Fund',classification:'Hybrid'}).eligible,false);
assert.equal(schemeActivity({name:'Nifty Equity Opportunity Fund',classification:'Debt : Credit Risk'}).eligible,false);
assert.equal(schemeActivity({name:'Fixture Fund',category:'Equity : Sectoral'}).eligible,true);
assert.equal(schemeActivity({name:'Fixture Fund',classification:'Hybrid : Conservative Hybrid'}).eligible,true);
assert.equal(schemeActivity({name:'Fixture Equity Fund',classification:'SIF'}).eligible,false);
const now=Date.parse('2026-10-21T12:00:00Z'),checkedAt='2026-10-20T08:00:00Z';
const fund=(id,name,amc,before,after)=>({id,name,amc,months:{'2026-08':{shares:before,checkedAt},'2026-09':{shares:after,checkedAt}}});
const raw={isin:'INE090A01021',name:'Fixture Bank',funds:[
  fund('hdfc:small','HDFC Small Cap Fund','HDFC Mutual Fund',100,180),
  fund('hdfc:hybrid','HDFC Hybrid Debt Fund','HDFC Mutual Fund',100,70),
  fund('sbi:equity','SBI Equity Fund','SBI Mutual Fund',100,40),
  fund('hdfc:arbitrage','HDFC Arbitrage Fund','HDFC Mutual Fund',100,10000),
  fund('sbi:bond','SBI Corporate Bond Fund','SBI Mutual Fund',10000,0),
  fund('mystery:a','Unverified Growth Fund','Mystery',0,9000),
  {...fund('sbi:pending','SBI Equity Savings Fund','SBI Mutual Fund',100,200),months:{'2026-09':{shares:200,checkedAt}}}
]};
const row=projectCompany(raw,{now});
assert.equal(row.activityBasis,ACTIVITY_BASIS);
assert.equal(row.netChange,-10,'Excluded flows must not reverse directional selling');
assert.equal(row.addedShares,80);assert.equal(row.reducedShares,90);
assert.equal(row.addedFunds,1);assert.equal(row.reducedFunds,2);
assert.equal(row.pendingFunds,1);assert.equal(row.comparableFunds,3);
assert.equal(row.totalShares,19490,'Reported total ownership is retained independently of the activity policy');
assert.deepEqual(row.excludedFunds,{arbitrage:1,'fixed-income':1,unclassified:1});
assert.equal(row.funds.length,7,'Excluded source history is retained');
assert.equal(row.funds.find(f=>f.id==='hdfc:arbitrage').change,9900);
assert.deepEqual(row.fundHouses.map(h=>[h.id,h.change]),[['sbi',-60],['hdfc',50]],'AMC aggregation nets opposite scheme moves');
assert.equal(fundHouseLead(row),'Net selling: −10 shares · Buyers: HDFC · Sellers: SBI');
assert.match(activityNotes(row),/1 awaiting comparable reports.*1 arbitrage, 1 fixed income, 1 unclassified excluded/);
assert.equal(netVolumeCr(row,10000000),-10);
const onlyExcluded=projectCompany({...raw,funds:raw.funds.slice(3,6)},{now});
assert.equal(onlyExcluded.netChange,null);assert.equal(onlyExcluded.addedFunds,0);assert.equal(onlyExcluded.pendingFunds,0);
assert.equal(comparisonStatus(onlyExcluded).label,'No eligible schemes');
const old={...summaryOf(row),activityBasis:undefined,netChange:9999,topBuyer:{name:'Arbitrage',change:9999}};
const saved=readableOwnership(old,now);assert.equal(saved.totalShares,row.totalShares);assert.equal(saved.netChange,null);assert.equal(saved.topBuyer,null);
assert.equal(netVolumeCr(saved,100),null);assert.match(comparisonStatus(saved).insight,/withheld/);
assert.equal(readableOwnership(row,now).netChange,-10);
// Private backup-only excluded schemes cannot leak into the default activity.
const primary={...raw,month:'2026-09',funds:[raw.funds[0]]};
const backup={...raw,month:'2026-09',funds:[fund('scanner:arb','SBI Arbitrage Fund','sbi',5,999999),fund('scanner:hyb','Kotak Equity Savings Fund','kotak',4,8)]};
const merged=supplementCompany(primary,backup,{now});assert.equal(merged.netChange,84);assert.equal(merged.excludedFunds.arbitrage,1);
assert.equal(merged.funds.find(f=>f.id==='scanner:arb').months['2026-09'].shares,999999);
assert.equal(raw.funds[0].months['2026-09'].checkedAt,checkedAt,'Projection does not advance source checks');
console.log('PASS MF directional policy: equity/hybrid eligibility, arbitrage/debt/unknown exclusions, AMC netting, partial comparisons, retained facts, legacy withholding and private supplement');
