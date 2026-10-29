// Isolated layout regression, no captured data, production requests or model/provider calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../public');
const html=`<style>#s{height:240px;overflow:auto;overflow-anchor:none;border:1px solid;width:420px}table{border-collapse:collapse;width:100%}thead{position:sticky;top:0;background:white}td{padding:0;border:0}#before{height:600px}#held{height:100px}#tail{height:1000px}</style><main id=root><div id=s data-table-scroll><table><thead><tr><th>Header</th></tr></thead><tbody><tr><td id=before></td></tr><tr data-row-key=held><td id=held>Reading this update</td></tr><tr><td id=tail></td></tr></tbody></table></div></main><script>window.MunshotDashboardSDK={createClient:()=>({getContext:()=>({session:{token:'fixture-only',email:'fixture@example.test'}}),onMessage:()=>()=>{}})};window.SATTVA_CHATTER_URL=location.origin+'/chatter';</script><script type=module>import{captureTablePosition,restoreTablePositionAfterPaint}from'/js/tabs/daily-alerts.js';window.measure=()=>{const s=document.querySelector('#s'),row=s.querySelector('[data-row-key]'),boundary=s.getBoundingClientRect().top+s.querySelector('thead').offsetHeight;return{key:row.dataset.rowKey,offset:row.getBoundingClientRect().top-boundary};};window.capture=()=>captureTablePosition(document.querySelector('#root'));window.restore=p=>restoreTablePositionAfterPaint(document.querySelector('#root'),p);window.ready=true;</script>`;
const server=createServer((req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}const file=resolve(root,'.'+pathname);if(!file.startsWith(root+sep))throw Error('Invalid path');res.setHeader('content-type',{'.js':'text/javascript','.json':'application/json'}[extname(file)]||'text/plain');res.end(readFileSync(file));}catch{res.writeHead(404).end('{}');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.fulfill({status:503,body:'{}'}));await page.goto(origin);await page.waitForFunction(()=>window.ready);
 const setup=async()=>{await page.evaluate(()=>{document.querySelector('#root').dispatchEvent(new WheelEvent('wheel',{bubbles:true}));document.querySelector('#before').style.height='600px';document.querySelector('#s').scrollTop=640;});await page.waitForTimeout(100);return page.evaluate(()=>window.capture());};
 const before=await setup();
 await page.evaluate(position=>{window.restore(position);let frames=0;const resize=()=>{if(++frames<4)requestAnimationFrame(resize);else document.querySelector('#before').style.height='607px';};requestAnimationFrame(resize);},before);
 await page.waitForFunction(()=>document.querySelector('#before').style.height==='607px');await page.waitForFunction(offset=>Math.abs(window.measure().offset-offset)<=1,before.offset);const after=await page.evaluate(()=>window.measure());
 assert.equal(after.key,before.key);assert(Math.abs(after.offset-before.offset)<=1,`Deferred row layout moved the reader: ${JSON.stringify({before,after})}`);
 const original=await setup();
 await page.evaluate(position=>{window.restore(position);requestAnimationFrame(()=>{document.querySelector('#before').style.height='604px';window.restore(window.capture());requestAnimationFrame(()=>requestAnimationFrame(()=>{document.querySelector('#before').style.height='611px';}));});},original);
 await page.waitForFunction(()=>document.querySelector('#before').style.height==='611px');await page.waitForFunction(offset=>Math.abs(window.measure().offset-offset)<=1,original.offset);const overlapping=await page.evaluate(()=>window.measure());
 assert.equal(overlapping.key,original.key);assert(Math.abs(overlapping.offset-original.offset)<=1,'Overlapping feed paints retain the original reading offset');
 const input=await setup();await page.evaluate(position=>{window.restore(position);document.querySelector('#root').dispatchEvent(new WheelEvent('wheel',{bubbles:true}));document.querySelector('#s').scrollTop=500;},input);
 await page.evaluate(()=>new Promise(resolve=>{let frames=0;const tick=()=>{if(++frames===10)resolve();else requestAnimationFrame(tick);};requestAnimationFrame(tick);}));assert.equal(await page.locator('#s').evaluate(s=>s.scrollTop),500,'Fresh reader input cancels every pending correction');
 assert.deepEqual(errors,[],'No browser exceptions');
 console.log('PASS reading anchor: delayed row geometry, overlapping paints and reader input without source/network data');
}finally{await browser.close();await new Promise(r=>server.close(r));}
