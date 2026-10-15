// Authenticated encryption for private GitHub-hosted snapshots. No plaintext
// supplemental facts, credentials or portfolio identities are public assets.
const text = new TextEncoder();
export const encode64 = bytes => {
  let out='';for(let at=0;at<bytes.length;at+=8192)out+=String.fromCharCode(...bytes.subarray(at,at+8192));
  return btoa(out);
};
export const decode64 = value => Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
async function aes(material,context) {
  const key=await crypto.subtle.importKey('raw',material,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:text.encode('mutual-funds-github-v1'),info:text.encode(context)},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function secretKey(secret,context='runner-state') {
  if(typeof secret!=='string'||secret.length<20)throw Error('Snapshot key unavailable');
  return aes(text.encode(secret),context);
}
export async function seal(bytes,key,context) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:text.encode(context)},key,bytes);
  return {version:1,context,iv:encode64(iv),body:encode64(new Uint8Array(body))};
}
export async function open(envelope,key,context) {
  if(envelope?.version!==1||envelope.context!==context)throw Error('Invalid snapshot envelope');
  return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(envelope.iv),additionalData:text.encode(context)},key,decode64(envelope.body)));
}
// Each runtime keeps its existing secret. Only the derived X25519 PUBLIC key
// travels to the runner; the Worker's GitHub credential never leaves the Worker.
export async function readerKeys(secret) {
  if(typeof secret!=='string'||secret.length<20)throw Error('Reader key unavailable');
  const seed=new Uint8Array(await crypto.subtle.digest('SHA-256',text.encode(`mf-reader-v1:${secret}`)));
  const prefix=Uint8Array.from([48,46,2,1,0,48,5,6,3,43,101,110,4,34,4,32]);
  const pkcs8=new Uint8Array(prefix.length+32);pkcs8.set(prefix);pkcs8.set(seed,prefix.length);
  const privateKey=await crypto.subtle.importKey('pkcs8',pkcs8,'X25519',false,['deriveBits']);
  const base=new Uint8Array(32);base[0]=9;
  const baseKey=await crypto.subtle.importKey('raw',base,'X25519',false,[]);
  const publicKey=new Uint8Array(await crypto.subtle.deriveBits({name:'X25519',public:baseKey},privateKey,256));
  return {privateKey,publicKey,kid:await hash(publicKey)};
}
async function agreement(privateKey,publicBytes) {
  const publicKey=await crypto.subtle.importKey('raw',publicBytes,'X25519',false,[]);
  return aes(new Uint8Array(await crypto.subtle.deriveBits({name:'X25519',public:publicKey},privateKey,256)),'reader-payload');
}
export async function sealForReader(bytes,recipient,context) {
  const pair=await crypto.subtle.generateKey('X25519',true,['deriveBits']);
  const key=await agreement(pair.privateKey,decode64(recipient.publicKey));
  return {...await seal(bytes,key,context),kid:recipient.kid,ephemeral:encode64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)))};
}
export async function openForReader(envelope,secret,context) {
  const keys=await readerKeys(secret);
  if(envelope.kid!==keys.kid)throw Error('Reader key changed; awaiting next GitHub capture');
  return open(envelope,await agreement(keys.privateKey,decode64(envelope.ephemeral)),context);
}
