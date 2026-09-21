import { previousMonth, targetMonth, validIsin } from '../../worker/mutual-funds-model.mjs';
import { scannerAmc, scannerName } from '../../worker/mutual-funds-scanner-model.mjs';

export const SCANNER_ORIGIN = 'https://mfscanner.com';
const entities = { amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', nbsp:' ', minus:'−' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, key) => {
  if (key[0] !== '#') return entities[key.toLowerCase()] ?? whole;
  const n = key[1].toLowerCase()==='x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
  return n>0 && n<=0x10ffff ? String.fromCodePoint(n) : whole;
});
const text = s => decode(s.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const tags = (s, tag) => [...s.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`,'gi'))].map(m=>m[1]);
const attribute = (s, name) => decode(new RegExp(`\\b${name}=["']([^"']*)["']`,'i').exec(s)?.[1] || '');
const fullMonth = s => {
  const m=/^(January|February|March|April|May|June|July|August|September|October|November|December) (20\d\d)$/.exec(s);
  return m ? `${m[2]}-${String(['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(m[1])+1).padStart(2,'0')}` : null;
};
function quantity(s, { signed=false, nullable=false }={}) {
  if (nullable && ['—','–','-',''].includes(s)) return null;
  if (!(signed?/^[+−-]?\d[\d,]*$/:/^\d[\d,]*$/).test(s)) throw Error('Invalid share quantity');
  const n=Number(s.replaceAll(',','').replace('−','-'));
  if (!Number.isSafeInteger(n) || (!signed && n<0)) throw Error('Invalid share quantity');
  return n;
}
export function parseScannerCatalogue(html) {
  if (!html.includes('</html>')) throw Error('Truncated catalogue');
  const entries=new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["'](\/stock\/[a-z0-9-]+)["'][^>]*>([\s\S]*?)<\/a>/g)) {
    const name=text(m[2]); if (name) entries.set(m[1],{url:SCANNER_ORIGIN+m[1],name});
  }
  const count=Number(/<span[^>]*>\s*(\d+)\s*<\/span>\s*stocks\./.exec(html)?.[1]);
  if (!count || entries.size!==count || count>10000) throw Error('Incomplete stock catalogue');
  return [...entries.values()];
}
export function scannerStockUrl(entries, company) {
  const keys=new Set([company.name,...(company.aliases||[])].map(scannerName).filter(Boolean));
  const candidates=entries.filter(e=>keys.has(scannerName(e.name)) || scannerName(new URL(e.url).pathname.split('/').at(-1))===scannerName(company.ticker));
  if(candidates.length===1)return candidates[0].url;
  if(candidates.length)return null;
  // Discovery may use an abbreviated company name, but capture still requires
  // the exact portfolio ISIN on the resulting page before accepting any facts.
  const tokens=String(company.name||'').toLowerCase().replace(/\b(?:limited|ltd|private|pvt|and|the)\b/g,'').match(/[a-z0-9]+/g)||[];
  if(tokens.length<2)return null;
  const expanded=entries.filter(e=>tokens.every(t=>scannerName(e.name).includes(t)));
  return expanded.length===1?expanded[0].url:null;
}
// Parse only the server-rendered facts. Never execute a source script, treat a
// missing row as an exit, or infer shares from the source's rounded market value.
export function parseScannerStock(html, {isin,url,checkedAt=new Date().toISOString(),now=Date.now()}={}) {
  if (!validIsin(isin) || !/^https:\/\/mfscanner\.com\/stock\/[a-z0-9-]+$/.test(url||'') || !html.includes('</html>')) throw Error('Invalid source page');
  const identity=/<span[^>]*>\s*(IN[A-Z0-9]{10})\s*<\/span>\s*· fund activity/.exec(html)?.[1];
  if (identity!==isin) throw Error('Source stock identity mismatch');
  const canonical=[...html.matchAll(/<link\b[^>]*>/g)].find(m=>attribute(m[0],'rel')==='canonical')?.[0];
  if (attribute(canonical||'','href')!==url) throw Error('Source URL mismatch');
  const tables=tags(html,'table'); if(tables.length!==1) throw Error('Ambiguous source table');
  const headers=tags(tags(tables[0],'thead')[0]||'','th').map(text);
  const prior=fullMonth(headers[2]||''),month=fullMonth(headers[3]||'');
  if(headers.length!==6 || headers[0]!=='Fund' || headers[1]!=='Action' || headers[4]!=='Δ shares' || headers[5]!=='Value (₹Cr)' || !month || month>targetMonth(now) || prior!==previousMonth(month)) throw Error('Invalid disclosure periods');
  const description=[...html.matchAll(/<meta\b[^>]*>/g)].find(m=>attribute(m[0],'name')==='description')?.[0];
  const expected=Number(/— ([\d,]+) schemes,/.exec(attribute(description||'','content'))?.[1]?.replaceAll(',',''));
  const body=tags(tables[0],'tbody'); if(body.length!==1)throw Error('Missing source table');
  const rows=tags(body[0],'tr'), funds=[], ids=new Set();let currentCount=0,unknownAmcs=0;
  for (const row of rows) {
    const cells=tags(row,'td'); if(cells.length!==6)throw Error('Incomplete fund row');
    const link=/<a\b[^>]*href=["'](\/fund\/[a-z0-9-]+)["'][^>]*>([\s\S]*?)<\/a>/.exec(cells[0]);
    const code=text(tags(cells[0],'span').at(-1)||''),amc=scannerAmc(code);
    if(!link || ids.has(link[1]))throw Error('Duplicate or missing scheme identity');ids.add(link[1]);
    const action=text(cells[1]),p=quantity(text(cells[2]),{nullable:true}),c=quantity(text(cells[3]),{nullable:true}),delta=quantity(text(cells[4]),{signed:true,nullable:true});
    if(!['new','exited','held','increased','decreased','pending'].includes(action))throw Error('Unknown fund action');
    if(action==='pending') { if(c!==null || delta!==null)throw Error('Pending report has shares'); }
    else if(c===null || p===null || delta!==c-p || (action==='new' && !(p===0&&c>0)) || (action==='exited' && !(c===0&&p>0)) || (action==='held' && c!==p) || (action==='increased' && !(c>p&&p>0)) || (action==='decreased' && !(p>c&&c>0))) throw Error('Inconsistent monthly share change');
    if(c>0)currentCount++;
    if(!amc){unknownAmcs++;continue;}
    const point=(shares,period)=>({shares,valueCr:null,pctOfAum:null,checkedAt,sourceUrl:url,source:'MF Scanner',absenceVerified:shares===0,reportedMonth:period});
    funds.push({id:`scanner:${link[1].slice(6)}`,name:text(link[2]),amc,months:{[prior]:point(p,prior),[month]:point(c,month)}});
  }
  if(!Number.isSafeInteger(expected)||!rows.length||rows.length>5000||currentCount!==expected)throw Error('Incomplete fund inventory');
  const pending=Number(/(\d+) funds that held this stock in/.exec(text(html))?.[1]||0);
  return {isin,month,priorMonth:prior,checkedAt,sourceUrl:url,funds,reportedFunds:currentCount,unreportedFunds:pending,unknownAmcs};
}
