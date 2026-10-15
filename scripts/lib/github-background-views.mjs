import {gzipSync} from 'node:zlib';
import {sealForReader,hash} from '../../worker/mutual-funds-seal.mjs';
export const backgroundViewContext=(repo,feature,name)=>`${repo}:github-prepared:${feature}:${name}:v1`;
export async function sealBackgroundView(value,recipient,{repo,feature,name,maxBytes=5*1024*1024}) {
  if(!/^[a-z][a-z0-9-]{1,30}$/.test(feature)||!/^[a-z0-9-]{1,180}\.json$/.test(name)||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))throw Error('Invalid prepared view address');
  const plain=Buffer.from(JSON.stringify(value));if(plain.length>maxBytes)throw Error('Prepared view exceeds delivery budget');
  const packed=Buffer.from(JSON.stringify({format:'gzip-json',gzip:gzipSync(plain).toString('base64')}));
  if(packed.length>5*1024*1024)throw Error('Compressed view exceeds delivery budget');
  const sealed=await sealForReader(packed,recipient,backgroundViewContext(repo,feature,name));
  const bytes=Buffer.from(JSON.stringify(sealed));return {bytes,hash:await hash(bytes)};
}
