// Alternate discovery routes on the fund houses' own public disclosure sites.
// No portfolio/company identifiers leave the collector: these are industry reports.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {monthKey,previousMonth} from '../../worker/mutual-funds-model.mjs';
const run=promisify(execFile);
const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
export const PUBLIC_PAGES={
  '360-one':'https://www.360.one/asset/mutual-funds/downloads/',
  quant:'https://quantmutual.com/statutory-disclosures',
  mirae:'https://www.miraeassetmf.co.in/downloads/portfolio',
  union:'https://www.unionmf.com/about-us/downloads',
  lic:'https://www.licmf.com/downloads/monthly-portfolio',
  sundaram:'https://www.sundarammutual.com/portfolio',
  'angel-one':'https://www.angelonemf.com/downloads',
  axis:'https://www.axismf.com/statutory-disclosures/monthly-portfolio',
};
const allowed={
  '360-one':url=>url.origin==='https://www.360.one'||url.origin==='https://s3.ap-south-1.amazonaws.com'&&url.pathname.startsWith('/x-web-s3.360.one/'),
  quant:url=>url.origin==='https://quantmutual.com',mirae:url=>url.origin==='https://www.miraeassetmf.co.in',
  union:url=>url.origin==='https://www.unionmf.com',lic:url=>url.origin==='https://www.licmf.com',
  sundaram:url=>url.origin==='https://www.sundarammutual.com',
  'angel-one':url=>['https://www.angelonemf.com','https://cms.angelonemf.com'].includes(url.origin),
  axis:url=>url.origin==='https://www.axismf.com',
};
export function publicUrl(slug,input) {
  const url=new URL(input,PUBLIC_PAGES[slug]);
  if(url.username||url.password||url.hash||!allowed[slug]?.(url))throw Error('Unexpected disclosure host');
  return url.href;
}
// curl uses the runner's normal network configuration. Refusals stop further
// requests to that host for this pass; no alternate identity, proxy or challenge.
export function publicReader(slug,{execute=run}={}) {
  const refused=new Set();
  return async function read(input,{body,contentType='application/json',headers={}}={}) {
    const url=publicUrl(slug,input),host=new URL(url).host;
    if(refused.has(host))throw Error('Source refused access');
    const args=['--silent','--show-error','--fail','--globoff','--max-time','20','--max-filesize','25000000','--proto','=https'];
    // No redirects: every accepted URL is a link on the verified disclosure host.
    for(const [key,value] of Object.entries(headers))args.push('-H',`${key}: ${value}`);
    if(body!==undefined)args.push('-H',`Content-Type: ${contentType}`,'--data-raw',typeof body==='string'?body:JSON.stringify(body));
    args.push('--write-out','\n%{http_code}',url);
    try {
      const {stdout}=await execute('curl',args,{encoding:'buffer',maxBuffer:25_001_024,timeout:22000});
      const status=Number(stdout.subarray(-3).toString());
      if(status!==200)throw Object.assign(Error('Disclosure HTTP failure'),{status});
      return stdout.subarray(0,-4);
    } catch(error) {
      const status=error.status||Number(/error:\s*(401|403|429)/i.exec(String(error.stderr||''))?.[1]);
      if([401,403,429].includes(status))refused.add(host);
      throw Error([401,403,429].includes(status)?'Source refused access':'Disclosure download failed');
    }
  };
}
const plain=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
export function anchorFiles(html,base) {
  const out=[];
  for(const match of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url=new URL(match[1].replace(/&amp;/g,'&'),base);
    if(/\.xlsx?$/i.test(url.pathname))out.push({url:url.href,text:plain(match[2])});
  }
  return out;
}
function uniqueFiles(slug,links) {
  const found=new Map();
  for(const link of links){
    const url=publicUrl(slug,link.url);
    if(!/\.xlsx?$/i.test(new URL(url).pathname))throw Error('Unexpected disclosure format');
    if(found.has(url)&&found.get(url).disclosureMonth!==link.disclosureMonth)throw Error('Disclosure file period ambiguous');
    found.set(url,{...link,url});
  }
  if(!found.size)throw Error('Monthly disclosure unavailable');
  return [...found.values()];
}
export function oneDisclosures(html,month) {
  const text=html.replace(/\\"/g,'"').replace(/\\\//g,'/'),links=[];
  // The latest year now has month:"null" with August/July in fileName instead.
  for(const match of text.matchAll(/"fileName":"([A-Za-z]+)"\s*,\s*"fileUrl":"(https:[^"]+\/IN_MF_MONTHLY_PORTFOLIO_([A-Za-z]+)_?(20\d{2})[^"/]*\.xlsx?)"/g)) {
    const label=monthKey(`${match[1].slice(0,3)}-${match[4]}`),file=monthKey(`${match[3].slice(0,3)}-${match[4]}`);
    if(label===month&&file===month)links.push({url:match[2],text:month});
  }
  return uniqueFiles('360-one',links);
}
const jsonReply=buffer=>JSON.parse(buffer.toString('utf8'));
// Readers are injected for deterministic pagination, rollover and failure tests.
export async function publicDisclosures(slug,month,read,{axisPublicToken,includeHistory=false}={}) {
  if(monthKey(month)!==month)throw Error('Invalid disclosure month');
  const [year,num]=month.split('-').map(Number),name=months[num-1],page=PUBLIC_PAGES[slug];let links=[];
  const json=async(url,options)=>jsonReply(await read(url,options));
  const html=async(url,options)=>(await read(url,options)).toString('utf8');
  if(slug==='360-one')return oneDisclosures(await html(page),month);
  if(slug==='quant') {
    const data=await json('https://quantmutual.com/statutorydisclosures.aspx/displaydisclouser2',{body:{id:String(num),cat:'MONTHLY PORTFOLIO - FUND - WISE',tab:String(year)}});
    if(typeof data.d!=='string')throw Error('Invalid disclosure index');
    links=anchorFiles(data.d,page);
    if(links.some(l=>!new RegExp(`_\\d{1,2}_${name.slice(0,3)}_${year}\\.xlsx?$`,'i').test(new URL(l.url).pathname)))throw Error('Disclosure index month mismatch');
  } else if(slug==='mirae') {
    const wanted=new Set([month]);if(includeHistory){let prior=month;for(let i=0;i<3;i++){prior=previousMonth(prior);wanted.add(prior);}}
    // Read the complete published catalogue, not just the first ten results or
    // guessed filenames. Page counts and unique IDs establish traversal coverage.
    let total=null,received=0;const ids=new Set();
    for(let pgno=1;pgno<=100;pgno++) {
      const data=await json('https://www.miraeassetmf.co.in/AjaxService/GetDownloadsData',{body:{request:{modulename:'portfolio_tab1',pgno,pgsize:100}}});
      if(data.ReturnCode!=='0'||!Array.isArray(data.Data)||!Number.isSafeInteger(data.DataCount)||data.DataCount<0)throw Error('Invalid disclosure index');
      if(total!==null&&data.DataCount!==total)throw Error('Disclosure index changed');total=data.DataCount;
      if(!data.Data.length&&received<total)throw Error('Incomplete disclosure index');
      for(const item of data.Data) {
        if(!item.Id||ids.has(item.Id))throw Error('Repeated disclosure page');ids.add(item.Id);received++;
        const date=/as on (\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(20\d{2})/i.exec(item.Title||'');
        const disclosed=date&&monthKey(`${date[2].slice(0,3)}-${date[3]}`);
        if(wanted.has(disclosed))links.push({url:new URL('/'+String(item.URL).replace(/^\//,''),page).href,text:plain(item.Title).replace(/^.*?\sfor\s+/i,''),disclosureMonth:disclosed});
      }
      if(received===total)break;
      if(received>total||pgno===100)throw Error('Incomplete disclosure index');
    }
  } else if(slug==='union') {
    // Filter at the source, then page every match; newer non-portfolio documents
    // previously pushed this month's reports outside the unfiltered first page.
    const query=`contains(Title,'Monthly Portfolio') and contains(Title,'-${String(num).padStart(2,'0')}-${year}')`;
    let total=null,received=0;const ids=new Set();
    for(let p=0;p<100;p++) {
      const url=new URL('/api/downloads/documents',page);url.search=new URLSearchParams({'$filter':query,'$top':'100','$skip':String(p*100),'$count':'true','$orderby':'Id'});
      const data=await json(url.href);
      if(!Array.isArray(data.value)||!Number.isSafeInteger(data['@odata.count'])||data['@odata.count']<0)throw Error('Invalid disclosure index');
      if(total!==null&&data['@odata.count']!==total)throw Error('Disclosure index changed');total=data['@odata.count'];
      for(const item of data.value) {
        if(!item.Id||ids.has(item.Id))throw Error('Repeated disclosure page');ids.add(item.Id);received++;
        if(!new RegExp(`\\d{2}-${String(num).padStart(2,'0')}-${year}$`).test(item.Title||''))throw Error('Disclosure index month mismatch');
        links.push({url:new URL(item.Url,page).href,text:plain(item.Title).replace(/^Monthly Portfolio Report\s+/i,'').replace(/\s+\d{2}-\d{2}-\d{4}$/,'')});
      }
      if(received===total)break;
      if(!data.value.length||received>total||p===99)throw Error('Incomplete disclosure index');
    }
  } else if(slug==='lic') {
    const catalogue=await html('https://www.licmf.com/downloads/consolidated-portfolio',{body:'',contentType:'application/x-www-form-urlencoded'});
    const id=/<option\s+value=["'](\d+)["'][^>]*>\s*Monthly Portfolio\s*<\/option>/i.exec(catalogue)?.[1];
    if(!id)throw Error('Monthly catalogue missing');
    const data=await html('https://www.licmf.com/downloads/consolidated-portfolio-files',{body:new URLSearchParams({id,month:String(num),year:String(year)}).toString(),contentType:'application/x-www-form-urlencoded'});
    links=anchorFiles(data,page);
    if(!links.some(l=>/Equity/i.test(l.text))||!links.some(l=>/Debt/i.test(l.text)))throw Error('Incomplete consolidated disclosure');
    if(links.some(l=>!new RegExp(`${name}\\s+\\d{1,2},\\s*${year}`,'i').test(l.text)))throw Error('Disclosure index month mismatch');
  } else if(slug==='sundaram') {
    const data=await json('https://www.sundarammutual.com/Upload/JSON/Fund_Card_data.json');
    if(!Array.isArray(data))throw Error('Invalid disclosure index');
    for(const item of data) {
      if(!item.PORTFOLIO_PATH)continue;
      if(!/\/Portfolio_Archives\//.test(item.PORTFOLIO_PATH))throw Error('Unknown portfolio path');
      links.push({url:new URL(item.PORTFOLIO_PATH,page).href,text:item.GROUP_NAME});
    }
    if(links.some(l=>!new RegExp(`/Portfolio_Archives/${year}/${name.slice(0,3)}/`,'i').test(new URL(l.url).pathname)))throw Error('Disclosure index month mismatch');
  } else if(slug==='angel-one') {
    links=anchorFiles(await html(page),page).filter(l=>new RegExp(`/Monthly-Portfolio-${name}-${year}-`,'i').test(new URL(l.url).pathname));
    links=links.map(l=>({...l,text:decodeURIComponent(new URL(l.url).pathname.split('/').pop()).replace(new RegExp(`^Monthly-Portfolio-${name}-${year}-`,'i'),'').replace(/\.xlsx?$/i,'').replace(/-/g,' ')}));
  } else if(slug==='axis') {
    // Public website client token supplied by the reviewed, pinned AMC adapter.
    // No user session or account credential is acquired or persisted here.
    if(!/^Bearer [a-f0-9]+$/i.test(axisPublicToken||''))throw Error('Public website client unavailable');
    const data=await json('https://www.axismf.com/cms/get-scheme-documents',{headers:{Authorization:axisPublicToken},body:{sdType:'yearMonthSchemeDocs',sdID:'sdMonthSchemePortfolio',schemeTypeID:'ALL',year:String(year),month:name}});
    const docs=data?.data?.documentList;if(!Array.isArray(docs))throw Error('Invalid disclosure index');
    links=docs.filter(d=>new RegExp(`^Monthly Portfolio[ -]+\\d{2}[ -]${String(num).padStart(2,'0')}[ -]${year}$`,'i').test(d.documentName||'')).map(d=>({url:d.docuementURL,text:d.documentName}));
    if(links.length!==1)throw Error('Consolidated disclosure ambiguous');
  } else throw Error('Unknown public disclosure provider');
  if(includeHistory&&slug==='mirae'&&!links.some(l=>l.disclosureMonth===month))throw Error('Current monthly disclosure unavailable');
  return uniqueFiles(slug,links).sort((a,b)=>String(b.disclosureMonth||month).localeCompare(String(a.disclosureMonth||month)));
}

const baseName=name=>String(name||'').split(/\s*[-–]\s*an?\s+open[ -]ended/i)[0].toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function retainDisclosedNames(schemes,prior=[]) {
  const names=new Map();
  for(const scheme of prior){const key=baseName(scheme.schemeName);if(!names.has(key))names.set(key,new Set());names.get(key).add(scheme.schemeName);}
  return schemes.map(s=>{const known=names.get(baseName(s.schemeName));return known?.size===1?{...s,schemeName:[...known][0]}:s;});
}
// Some gold, overnight and overseas-only reports contain no Indian shares or units,
// so the equity parser correctly returns no positions. Verify that exact case
// without treating an arbitrary empty/malformed workbook as an empty portfolio.
export function verifiedNonIndianRows(rows,name,month) {
  if(!/\b(?:gold etf|silver etf|overnight fund|1d rate liquid etf|global.*(?:\bfof|fund of fund)|S&P 500.*ETF|NYSE FANG.*ETF|Hang Seng.*ETF)\b/i.test(name||''))return false;
  const heading=rows.slice(0,15).flat().map(v=>String(v??'')).join(' ').replace(/[-,]/g,' ').replace(/\s+/g,' ');
  const [year,num]=month.split('-').map(Number),end=new Date(Date.UTC(year,num,0)).getUTCDate(),mon=months[num-1];
  const dates=[...heading.matchAll(/(?:as on|month ended|period ended)\s+(\d{1,2}\s+[A-Za-z]+\s+20\d{2}|[A-Za-z]+\s+\d{1,2}\s+20\d{2})/gi)];
  if(!dates.length||dates.some(d=>!new RegExp(`^(?:${end} ${mon}(?: |$)|${mon} ${end} )`,'i').test(d[1].replace(new RegExp(mon.slice(0,3)+'(?= )','i'),mon))||!d[1].endsWith(String(year))))return false;
  const header=rows.findIndex(r=>r.some(v=>/^ISIN(?:\s+Code)?$/i.test(String(v||''))));
  if(header<0)return false;
  const cols=rows[header],isin=cols.findIndex(v=>/^ISIN(?:\s+Code)?$/i.test(String(v||''))),pct=cols.findIndex(v=>/%|percentage/i.test(String(v||''))&&/nav|net asset/i.test(String(v||''))),instrument=cols.findIndex(v=>/name.*instrument/i.test(String(v||'')));
  if(pct<0||instrument<0)return false;
  // Check the whole document, not just the first section or first parsed sheet.
  if(rows.flat().some(v=>/\bIN[EF][A-Z0-9]{9}\b/i.test(String(v??'')))||rows.slice(header+1).some(r=>/^IN[EF]/i.test(String(r[isin]||'').trim())))return false;
  const grand=rows.find(r=>r.some(v=>/^grand total(?:\s*\(aum\))?$/i.test(String(v||'').trim())));
  if(!grand||![1,100].some(n=>Math.abs(Number(grand[pct])-n)<0.0001))return false;
  for(const row of rows.slice(header+1)) {
    if(typeof row[pct]!=='number'||row[pct]===0)continue;
    const label=String(row[instrument]||'').trim(),id=String(row[isin]||'').trim();
    if(/total|net current|net receivable|cash|treps|repo|gold|silver|margin|collateral|^clearing corporation of india limited$/i.test(label))continue;
    if(/^[A-Z]{2}[A-Z0-9]{10}$/.test(id)&&!id.startsWith('IN'))continue;
    return false;
  }
  return true;
}
export function parsePublicWorkbook(buffer,{XLSX,parseAmcWorkbook,parseVerifiedWorkbook,opts,month,link}) {
  try{
    const schemes=parseVerifiedWorkbook(buffer,{XLSX,parseAmcWorkbook,opts,month});
    for(const scheme of schemes)if(/^mutual fund units$/i.test(scheme.schemeName)) {
      const book=XLSX.read(buffer,{type:'buffer',cellDates:false}),sheet=book.Sheets[scheme.schemeCode];
      const row=sheet&&XLSX.utils.sheet_to_json(sheet,{header:1,blankrows:true,defval:null,raw:true})[0];
      if(!row||row[0]!==scheme.schemeCode||!/^Axis .+ FOF$/.test(row[1]||''))throw Error('Scheme title unverified');
      scheme.schemeName=row[1];scheme.validatedSchemeHeader=true;
      if(scheme.holdings?.some(h=>/^INE/.test(h.isin||'')))throw Error('Ambiguous FoF ownership');
    }
    return schemes;
  }
  catch(error) {
    const book=XLSX.read(buffer,{type:'buffer',cellDates:false});
    if(book.SheetNames.length!==1)throw error;
    const rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,blankrows:true,defval:null,raw:true});
    if(!verifiedNonIndianRows(rows,link.text,month))throw error;
    return [{schemeCode:book.SheetNames[0],schemeName:link.text,asOf:month+'-'+new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate(),holdings:[],validatedNoIndianHoldings:true}];
  }
}
export async function readDisclosures(links,{read,parse,month,concurrency=4,onCheckpoint=()=>{}}) {
  let cursor=0;const results=new Array(links.length).fill(undefined),failures=[];
  const settled=await Promise.allSettled(Array.from({length:Math.min(concurrency,links.length)},async()=>{
    while(cursor<links.length) {
      const index=cursor++,link=links[index];
      try {
        const buffer=await read(link.url);
        if(/^\s*(?:<!doctype|<html)/i.test(buffer.subarray(0,100).toString()))throw Error('Unexpected HTML');
        const schemes=parse(buffer,link);
        if(!schemes.length||schemes.some(s=>monthKey(s.asOf)!==(link.disclosureMonth||month)))throw Error('Disclosure month unverified');
        results[index]=schemes.map(s=>({...s,sourceUrl:link.url}));
      } catch {failures.push(index);results[index]=[];}
      // Persist completed files before another slow file can time out the child.
      await onCheckpoint({schemes:results.flatMap(s=>s||[]),failedFiles:failures.length,pendingFiles:results.filter(s=>s===undefined).length,expectedFiles:links.length,completedFiles:results.filter(Boolean).length,lastCompletedMonth:link.disclosureMonth||month});
    }
  }));
  if(settled.some(r=>r.status==='rejected'))throw Error('Disclosure checkpoint failed');
  return {schemes:results.flatMap(s=>s||[]),failedFiles:failures.length,expectedFiles:links.length,completedFiles:links.length};
}
