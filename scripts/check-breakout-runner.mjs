import {ensureBreakoutRunner} from './lib/breakout-handover.mjs';
await ensureBreakoutRunner().then(result=>console.log('Automatic quote runner:',JSON.stringify(result))).catch(()=>{console.error('Automatic quote-runner handover is unavailable; scheduled recovery remains configured.');process.exitCode=1;});
