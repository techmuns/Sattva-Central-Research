#!/usr/bin/env node
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {recoverTechnicals} from './lib/technical-recovery.mjs';
const data=resolve('public/data/technicals.json'),state=resolve('public/data/technical-history-recovery.json');
const atomic=(path,value)=>{writeFileSync(path+'.pending',JSON.stringify(value)+'\n');renameSync(path+'.pending',path);};
let ledger={};try{ledger=JSON.parse(readFileSync(state,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const result=await recoverTechnicals(JSON.parse(readFileSync(data,'utf8')),ledger,{
  checkpoint:(payload,next)=>{atomic(data,payload);atomic(state,next);},
});
console.log(JSON.stringify(result.summary));
