import {decode64,hash} from './mutual-funds-seal.mjs';
export const NEWSLETTER_PDF_CHUNK_BYTES=256*1024;
export const NEWSLETTER_GITHUB_PDF_BYTES=64*1024*1024;

// Each private record stays small. A complete recovery edition is streamed from its
// authenticated static chunks; the Worker never buffers or calculates the full PDF.
export function newsletterPdfResponse(value,read,headers){
  if(value.format!=='chunked-pdf-v1')return new Response(decode64(value.body),{headers});
  if(!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>NEWSLETTER_GITHUB_PDF_BYTES||
    !Array.isArray(value.parts)||!value.parts.length||value.parts.length>256||
    value.parts.some(p=>!/^[-a-z0-9]{1,128}$/.test(p.id)||!Number.isSafeInteger(p.bytes)||p.bytes<1||p.bytes>NEWSLETTER_PDF_CHUNK_BYTES||!/^[a-f0-9]{64}$/.test(p.sha256))||
    value.parts.reduce((n,p)=>n+p.bytes,0)!==value.bytes)throw Error('Invalid newsletter PDF manifest');
  let next=0,cancelled=false;
  const stream=new ReadableStream({async pull(controller){
    if(cancelled)return;
    try{
      if(next===value.parts.length){controller.close();return;}
      const part=value.parts[next++],record=await read(part.id);
      if(!record||typeof record.body!=='string')throw Error('Newsletter PDF part unavailable');
      const bytes=decode64(record.body);
      if(bytes.length!==part.bytes||await hash(bytes)!==part.sha256)throw Error('Newsletter PDF part invalid');
      if(!cancelled)controller.enqueue(bytes);
    }catch(error){controller.error(error);}
  },cancel(){cancelled=true;}});
  return new Response(stream,{headers:{...headers,'content-length':String(value.bytes)}});
}
