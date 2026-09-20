import {monthKey} from '../../worker/mutual-funds-model.mjs';

export const QUANTUM_PAGE='https://www.quantumamc.com/portfolio/combined/-1/1/0/0';
// This is the public monthly-disclosure API used by Quantum's own page. Its
// unfiltered list includes a September 2013 workbook above August 2026, so never
// infer a reporting period from link order or a download's publication time.
export async function quantumDisclosures(month,readJson) {
  if(monthKey(month)!==month)throw Error('Invalid disclosure month');
  const [year,number]=month.split('-').map(Number),links=new Set();let pages=1;
  for(let page=1;page<=pages;page++) {
    const url=new URL('/ProductPortfolio/GetProductPortfolioPaginatedList',QUANTUM_PAGE);
    url.search=new URLSearchParams({productSchemeId:'-1',yearId:String(year),monthId:String(number),Frequency:'1',pageIndex:String(page)});
    const data=await readJson(url.href);
    if(data.success!==true||data.pageIndex!==page||!Number.isSafeInteger(data.totalPageCount)||data.totalPageCount<0||data.totalPageCount>50||!Array.isArray(data.objProductPortfolioList))throw Error('Incomplete disclosure index');
    if(page>1&&data.totalPageCount!==pages)throw Error('Disclosure index changed');
    pages=data.totalPageCount;
    for(const file of data.objProductPortfolioList) {
      const timestamp=/^\/Date\((\d+)\)\/$/.exec(file.FactSheetDate||'');
      if(!timestamp||new Date(Number(timestamp[1])).toISOString().slice(0,7)!==month||file.SchemeId!==-1||file.FactSheetFreq!==1||file.IsActive!==1)continue;
      let href;try{href=new URL(file.FileUrl);}catch{continue;}
      if(href.origin!=='https://www.quantumamc.com'||!/^\/FileCDN\/FactSheet\/[a-z0-9-]+\.xlsx?$/i.test(href.pathname)||href.search||href.hash)continue;
      links.add(href.href);
    }
  }
  if(!links.size)throw Error('Monthly disclosure unavailable');
  return [...links];
}

// Quantum's FoF sheets append complete portfolios of underlying schemes. Those
// rows are contextual look-through holdings, not shares owned by the FoF. Keep
// the directly held fund units above the explicit appendix heading intact.
export function directPortfolioRows(rows) {
  const at=rows.findIndex(row=>/monthly\s+portfolio\s+statement\s+of\s+the\s+underlying\s+schemes/i.test(row.map(v=>String(v??'')).join(' ')));
  return at<0?rows:rows.slice(0,at);
}
export function parseQuantumWorkbook(buffer,{XLSX,parseAmcWorkbook,opts,month}) {
  const workbook=XLSX.read(buffer,{type:'buffer',cellDates:false}),direct=XLSX.utils.book_new();
  for(const name of workbook.SheetNames) {
    const rows=XLSX.utils.sheet_to_json(workbook.Sheets[name],{header:1,blankrows:true,defval:null,raw:true});
    XLSX.utils.book_append_sheet(direct,XLSX.utils.aoa_to_sheet(directPortfolioRows(rows)),name);
  }
  const schemes=parseAmcWorkbook(XLSX.write(direct,{type:'buffer',bookType:'xlsx'}),opts);
  if(!schemes.length||schemes.some(s=>monthKey(s.asOf)!==month))throw Error('Disclosure month unverified');
  // A changed appendix heading must fail visibly instead of reintroducing
  // look-through shares. Review any future FoF layout that reports direct equity.
  if(schemes.some(s=>/\bfof\b|funds?\s+of\s+funds?/i.test(s.schemeName||'')&&s.holdings.some(h=>/^INE/.test(h.isin||''))))throw Error('Ambiguous FoF ownership');
  return schemes;
}
