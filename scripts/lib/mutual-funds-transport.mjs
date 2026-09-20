import {companyRevision} from '../../worker/mutual-funds-model.mjs';
// Split at observation boundaries, including when a single fund has a long history.
export function companyFragments(company,limit=512*1024) {
  const {funds,...header}=company,items=[];let batch=[],bytes=JSON.stringify(header).length;
  for(const fund of funds) {
    const {months,...metadata}=fund;
    for(const [month,point] of Object.entries(months)) {
      const next={...metadata,months:{[month]:point}},size=Buffer.byteLength(JSON.stringify(next));
      if(size+Buffer.byteLength(JSON.stringify(header))>limit)throw Error('One source observation exceeds the transport limit');
      if(batch.length&&bytes+size>limit){items.push({...header,funds:batch});batch=[];bytes=JSON.stringify(header).length;}
      batch.push(next);bytes+=size;
    }
  }
  if(batch.length||!items.length)items.push({...header,funds:batch});
  const revision=companyRevision(company);
  return items.map((company,part)=>({company,part,parts:items.length,revision}));
}
export function reportBatches(reports,limit=1024*1024) {
  const batches=[];let batch=[],bytes=0;
  for(const report of reports){const size=Buffer.byteLength(JSON.stringify(report));if(size>limit)throw Error('One source report exceeds the transport limit');if(batch.length&&(batch.length>=100||bytes+size>limit)){batches.push(batch);batch=[];bytes=0;}batch.push(report);bytes+=size;}
  if(batch.length)batches.push(batch);return batches;
}
