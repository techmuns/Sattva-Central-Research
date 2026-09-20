import fs from 'node:fs';
export function atomicJson(file,value) {
  fs.writeFileSync(`${file}.tmp`,JSON.stringify(value));
  fs.renameSync(`${file}.tmp`,file);
}
