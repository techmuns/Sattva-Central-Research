const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'})+' IST':'Not checked';
export function supplementStatus(meta={}) {
  if(meta.supplementReadFailed)return 'MF Scanner read unavailable · primary disclosures shown';
  if(meta.supplementAccess==='access')return 'Private MF Scanner access unavailable';
  const source=meta.supplement;
  if(!source)return meta.supplementAccess==='no-session'?'Sign in through Munshot for private MF Scanner holdings':'';
  const checked=(source.companies||[]).map(c=>c.checkedAt).filter(v=>Number.isFinite(Date.parse(v))).sort().at(-1);
  const catalogue=source.catalogue;
  return `MF Scanner ${source.currentCompanies}/${source.expectedCompanies} companies checked · Latest page check ${time(checked)}${catalogue?.state&&catalogue.state!=='ok'?` · Catalogue check unavailable (${time(catalogue.lastAttemptAt)})`:''}`;
}
