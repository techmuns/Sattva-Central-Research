// Shared binary codec; source encryption and browser inflation use the same bytes.
export const encode64 = bytes => {
  if(typeof bytes.toBase64==='function')return bytes.toBase64();
  let out='';for(let at=0;at<bytes.length;at+=8192)out+=String.fromCharCode(...bytes.subarray(at,at+8192));
  return btoa(out);
};
export const decode64 = value => {
  if(typeof Uint8Array.fromBase64==='function')return Uint8Array.fromBase64(value);
  const binary=atob(value),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
};
