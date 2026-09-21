import { projectCompany, previousMonth, targetMonth } from './mutual-funds-model.mjs';

const AMC={ANGELONE:'angel-one',CANARA:'canara-robeco',EDELWEISS:'edelweiss',HDFC:'hdfc',NAVI:'navi',SAMCO:'samco',TATA:'tata',UNION:'union',WHITEOAK:'whiteoak-capital',
  AXIS:'axis',BANDHAN:'bandhan',BAJAJ:'bajaj-finserv',BARODA:'baroda-bnp-paribas',BOI:'bank-of-india',DSP:'dsp',FRANKLIN:'franklin-templeton',GROWW:'groww',HSBC:'hsbc',ICICI:'icici-pru',INVESCO:'invesco',ITI:'iti',JM:'jm-financial',KOTAK:'kotak',LIC:'lic',MAHINDRA:'mahindra',MIRAE:'mirae',MOTILAL:'motilal-oswal',NIPPON:'nippon',OLDBRIDGE:'old-bridge',PPFAS:'ppfas',PGIM:'pgim-india',QUANT:'quant',QUANTUM:'quantum',SBI:'sbi',SHRIRAM:'shriram',SUNDARAM:'sundaram',TAURUS:'taurus',TRUST:'trust',UNIFI:'unifi',UTI:'uti',ZERODHA:'zerodha',ASK:'ask',CARNELIAN:'carnelian',LAKSHYA:'lakshya',MONARCH:'monarch',NUVAMA:'nuvama',
  ABSL:'absl',JIOBLACKROCK:'jio-blackrock',HELIOS:'helios','360ONE':'360-one',NJ:'nj',ABAKKUS:'abakkus',WEALTHCO:'the-wealth-company',CHOICE:'choice',CAPITALMIND:'capitalmind'};
export const scannerAmc=code=>AMC[code]||null;
export const scannerName=value=>String(value||'').toLowerCase().replace(/^the\s+/,'').replace(/\b(?:eqp|equipments)\b/g,'equipment').replace(/\b(?:limited|ltd|private|pvt|and)\b/g,'').replace(/[^a-z0-9]/g,'');
// Formatting and share-class suffixes are not distinct equity portfolios. Keep
// strategy words (including ETF, index and retirement sub-plans) in the key.
export const scannerFundKey=name=>String(name||'').toLowerCase().replace(/\(\s*an open[- ]ended[\s\S]*$/,'')
  .replace(/\b(?:fund|scheme|direct|regular|growth|option|and)\b/g,'').replace(/[^a-z0-9]/g,'');
const amcOf=f=>f.id.startsWith('scanner:')?f.amc:f.id.split(':')[0];
const quantity=p=>Number.isSafeInteger(p?.shares)&&p.shares>=0;

export function supplementCompany(primary, supplemental, {amcs=[],month=null,now=Date.now()}={}) {
  const latest=month||primary?.month||supplemental?.month||targetMonth(now);
  const base=primary||{isin:supplemental.isin,name:supplemental.name,funds:[]};
  const funds=structuredClone(base.funds||[]), keys=new Map(), supplementalKeys=new Map();
  for(const f of funds) {const k=`${amcOf(f)}:${scannerFundKey(f.name)}`;keys.set(k,[...(keys.get(k)||[]),f]);}
  for(const f of supplemental?.funds||[]) {const k=`${amcOf(f)}:${scannerFundKey(f.name)}`;supplementalKeys.set(k,[...(supplementalKeys.get(k)||[]),f]);}
  let supplemented=0,ambiguous=0,conflicts=0;const unmatched=new Set();
  for(const [key,list] of supplementalKeys) {
    const matches=keys.get(key)||[];
    if(list.length!==1 || matches.length>1){ambiguous+=list.length;continue;}
    const incoming=list[0],slug=amcOf(incoming),existing=matches[0];
    if(!existing) {
      // An unmatched name with identical overlapping quantities may be a rename.
      // Withhold it rather than count the same scheme twice by guessing identity.
      if(funds.some(f=>amcOf(f)===slug && Object.entries(incoming.months).some(([m,p])=>p.shares>0&&f.months[m]?.shares===p.shares))){ambiguous++;continue;}
    }
    const out=existing||{...incoming,months:{}};
    for(const [m,point] of Object.entries(incoming.months)) {
      if(!quantity(point))continue;
      const current=out.months[m];
      if(quantity(current)) {if(current.shares!==point.shares)conflicts++;continue;}
      // Complete primary AMC months have first authority, including schemes
      // absent from the stock table. A backup never expands that inventory.
      if(!existing && amcs.some(a=>a.slug===slug&&a.status==='ok'&&a.month===m))continue;
      out.months[m]=point;if(m===latest)supplemented++;
    }
    if(!existing&&Object.keys(out.months).length){funds.push(out);unmatched.add(out.id);}
  }
  // Different names must not turn conflicting source inventories into an
  // inflated union. If unmatched additions exceed both sources' AMC totals,
  // withhold those identities until they can be reconciled, retaining raw history.
  const totals=list=>{
    const map=new Map();for(const f of list)for(const [m,p]of Object.entries(f.months))if(quantity(p)){const k=`${amcOf(f)}:${m}`;map.set(k,(map.get(k)||0)+p.shares);}return map;
  };
  const primaryTotals=totals(base.funds||[]),sourceTotals=totals(supplemental?.funds||[]),mergedTotals=totals(funds);
  const unsafe=new Set([...mergedTotals].filter(([k,n])=>n>Math.max(primaryTotals.get(k)||0,sourceTotals.get(k)||0)).map(([k])=>k));
  const selected=funds.filter(f=>{
    if(!unmatched.has(f.id)||!Object.entries(f.months).some(([m,p])=>p.shares>0&&unsafe.has(`${amcOf(f)}:${m}`)))return true;
    ambiguous++;if(quantity(f.months[latest]))supplemented--;return false;
  });
  const result=projectCompany({...base,funds:selected},{month:latest,now});
  const usedPoints=selected.flatMap(f=>[f.months[latest],f.months[previousMonth(latest)]]).filter(p=>p?.source==='MF Scanner'&&quantity(p));
  const available=[...new Set([...(primary?.availableMonths||[]),...(supplemental?.availableMonths||[]),...funds.flatMap(f=>Object.keys(f.months))])].filter(m=>m<=targetMonth(now)).sort().reverse();
  return {...result,months:[latest,previousMonth(latest),previousMonth(previousMonth(latest))],availableMonths:available,
    supplement:{source:'MF Scanner',used:usedPoints.length>0,checkedAt:usedPoints.map(p=>p.checkedAt).filter(Boolean).sort().at(-1)||supplemental?.checkedAt||null,month:supplemental?.month||null,supplementedFunds:supplemented,ambiguousFunds:ambiguous,conflictingObservations:conflicts,unreportedFunds:supplemental?.unreportedFunds||0,unknownAmcs:supplemental?.unknownAmcs||0}};
}
