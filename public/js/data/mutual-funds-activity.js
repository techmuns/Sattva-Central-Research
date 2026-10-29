// Company Holdings activity policy; deliberately separate from the NAV taxonomy.
// Arbitrage is a hybrid category there, but is excluded from this reading.
export const ACTIVITY_BASIS = 'equity-hybrid-ex-arbitrage-v1';
export const ACTIVITY_LABEL = 'Equity & hybrid activity · Arbitrage and fixed income excluded';
const text = value => typeof value === 'string' ? value.toLowerCase().replace(/[\u2010-\u2015_-]/g,' ').replace(/\s+/g,' ').trim() : '';
export function schemeActivity(fund) {
  const name=text(fund.name), labels=[fund.classification,fund.category,fund.assetClass].map(text).filter(Boolean);
  const all=[name,...labels].join(' ');
  const result=(category,basis)=>({eligible:category==='equity'||category==='hybrid',category,basis});
  // Exclusions take precedence over a broad Equity/Hybrid label and equity words.
  if(/\barbitrage\b/.test(all))return result('arbitrage','Scheme name/category');
  if(/\b(?:long short|market neutral)\b/.test(all))return result('unclassified','Outside verified equity/hybrid categories');
  if(labels.some(s=>/^(?:debt|fixed income|money market)(?:\b|\s*:)/.test(s)))return result('fixed-income','Source category');
  if(labels.some(s=>/^hybrid\b/.test(s)))return result('hybrid','Source category');
  if(labels.some(s=>/^equity\b/.test(s)))return result('equity','Source category');
  if(labels.length)return result('unclassified','Source category needs verification');
  if(/\b(?:hybrid|balanced|equity savings|equity\s*(?:&|and)\s*debt|multi asset|dynamic asset allocation)\b/.test(name))return result('hybrid','Scheme name');
  // This explicitly named equity/debt index is hybrid, not a pure G-Sec fund.
  // NSE definition: https://niftyindices.com/Press_Release/ind_prs10022026.pdf
  if(/\bnifty largemidcap250 plus (?:8\s*13 yr )?g\s*sec 70\s*:\s*30\b/.test(name))return result('hybrid','Named equity/debt hybrid index');
  // "Income" alone proves no debt mandate: the former Templeton India Equity
  // Income Fund is an equity dividend-yield scheme. Unclear income plans remain
  // unclassified rather than being silently included as equity or hybrid.
  if(/\b(?:debt|fixed income|liquid|overnight|money market|duration|maturity|gilt|g\s*sec|gsec|sdl|bond|treasury|floater|credit risk|fmp|tmf)\b/.test(name))return result('fixed-income','Scheme name');
  if(/\b(?:gold|silver|commodity|commodities|long short|fund of funds|fof)\b/.test(name))return result('unclassified','Outside verified equity/hybrid categories');
  // Only explicit equity/category/strategy words qualify a name-only disclosure.
  // Owning an equity ISIN, an AMC name or a generic "Growth Fund" proves no mandate.
  if(/\b(?:equity|large\s*(?:&|and)?\s*mid\s*cap|large\s*cap|mid\s*cap|small\s*cap|flexi\s*cap|multi\s*cap|focused|elss|tax sav(?:er|ing)|dividend yield|value|contra|nifty(?:\d+)?|sensex|bse|msci|banking and financial services|banking & financial services|infrastructure|manufacturing|consumption|business cycles?|pharma|healthcare|technology|digital|innovation|momentum|quant|esg|mnc|special opportunities|transportation|logistics|services opportunities)\b/.test(name))return result('equity','Scheme name');
  return result('unclassified','Equity/hybrid category not verified');
}
