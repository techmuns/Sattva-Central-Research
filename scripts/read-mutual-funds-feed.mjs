import fs from 'node:fs';
import {loadSharedHoldings} from './lib/mutual-funds-feed.mjs';
if(!process.env.AMFIBEAS_PATH)throw Error('AMFIBEAS_PATH required');
const {snapshots,amcs,manifest}=loadSharedHoldings(process.env.AMFIBEAS_PATH);
fs.mkdirSync('artifacts',{recursive:true});
fs.writeFileSync('artifacts/mutual-funds-source.json',JSON.stringify({sourceRevision:process.env.AMFIBEAS_REVISION,manifest},null,2));
console.log(`Verified ${snapshots.length} shared snapshots; ${amcs.length} source checks; source publication ${manifest.generatedAt}`);
