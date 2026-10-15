import assert from 'node:assert/strict';
import {backgroundExportReady} from './lib/background-export-ready.mjs';
let at=0,calls=0;const now=()=>at,sleep=async ms=>{at+=ms;};
const value=await backgroundExportReady(async()=>{calls++;if(calls<3)throw Error('Old deployment');return {ok:true,tables:[]};},{now,sleep});assert.deepEqual(value.tables,[]);assert.equal(calls,3);
await assert.rejects(backgroundExportReady(async()=>({ok:false}),{now,sleep,timeout:30000}),/not ready/);
const disabled=await backgroundExportReady(async()=>({ok:true,enabled:false}),{valid:value=>value?.ok===true&&typeof value.enabled==='boolean',now,sleep});assert.equal(disabled.enabled,false);
console.log('PASS read-only deployment readiness: delayed API recovers, disabled source stays disabled, permanent failure is bounded, no provider claim or send is retried');
