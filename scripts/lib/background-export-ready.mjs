// A merge starts the runner and static deployment independently. Wait only for
// the read-only migration/configuration API; never retry a paid claim or send.
export async function backgroundExportReady(read,{valid=value=>value?.ok===true&&Array.isArray(value.tables),now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms)),timeout=8*60000}={}){
 const deadline=now()+timeout;
 do{try{const value=await read();if(valid(value))return value;}catch{/* Deployment or source not yet readable. */}await sleep(15000);}while(now()<deadline);
 throw Error('Read-only background transfer API is not ready');
}
