// Local page/iframe scrolling over a long card model; no collectors or production requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"></head><body style="margin:0;padding:24px;background:#f6f7fb"><header style="height:180px"><h1>Local alert grid</h1></header><section id="cards" role="feed"></section><script type="module">
import { mountAlertCardGrid } from '/js/ui/alert-card-grid.js';
window.cards=Array.from({length:500},(_,i)=>({key:'C'+i,title:'Company '+i,height:320+(i%3)*90}));
window.renders=0;
window.grid=mountAlertCardGrid({element:document.querySelector('#cards'),
 renderCard:card=>'<article data-ai-card data-ai-key="'+card.key+'" class="rounded-xl bg-white p-4" style="min-height:'+card.height+'px"><h2>'+card.title+'</h2><details><summary>Evidence</summary><p>Original source remains available.</p></details><button type="button">Open '+card.key+'</button></article>',
 onWindow:()=>window.renders++});
window.grid.update(window.cards);
</script></body></html>`;
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
 if(path==='/embed'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><body style="margin:0;overflow:hidden"><header style="height:64px">Local host</header><iframe title="Alerts" src="/" style="border:0;width:100vw;height:calc(100vh - 64px)"></iframe></body></html>');return;}
 const file=resolve(root,'.'+path);if(!file.startsWith(root+sep)){res.writeHead(404);res.end();return;}
 try{res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream');res.end(readFileSync(file));}catch{res.writeHead(404);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:503,body:'{}'}));
 await page.goto(origin);await page.locator('[data-ai-card]').first().waitFor();
 assert((await page.locator('[data-ai-card]').count())<=12);
 assert.equal(await page.locator('#cards').getAttribute('data-ai-total'),'500');
 await page.mouse.wheel(0,2000);
 await page.waitForFunction(()=>document.querySelector('[data-ai-card]')?.dataset.aiKey!=='C0');
 await page.evaluate(()=>{
  window.reader=[...document.querySelectorAll('[data-ai-card]')].find(node=>node.getBoundingClientRect().bottom>0);
  window.readerKey=window.reader.dataset.aiKey;window.readerTop=window.reader.getBoundingClientRect().top;
  window.reader.querySelector('details').open=true;
  window.reader.querySelector('button').focus({preventScroll:true});
  window.cards=[{key:'NEW',title:'New source arrival',height:400},...window.cards.map(card=>card.key===window.readerKey?{...card,title:card.title+' corrected'}:card)];
  window.grid.update(window.cards);
 });
 await page.waitForTimeout(100);
 const held=await page.evaluate(()=>({same:document.querySelector('[data-ai-key="'+window.readerKey+'"]')===window.reader,
  top:window.reader.getBoundingClientRect().top,before:window.readerTop,open:window.reader.querySelector('details').open,
  focused:window.reader.contains(document.activeElement),text:window.reader.textContent}));
 assert(held.same&&held.open&&held.focused,'a new source retains the reading node, expanded evidence and focus');
 assert(Math.abs(held.top-held.before)<=2,JSON.stringify(held));assert(held.text.includes('corrected'));
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);
 assert((await page.locator('[data-ai-card]').count())<=6);
 assert(await page.evaluate(()=>!!document.querySelector('[data-ai-key="'+window.readerKey+'"]')),'responsive regrouping retains the company being read');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
 await page.locator('[data-ai-key="C499"]').waitFor();
 assert((await page.locator('[data-ai-card]').count())<=6);
 await page.evaluate(()=>window.scrollTo(0,0));await page.locator('[data-ai-key="NEW"]').waitFor();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.scrollY),0,'returning to the top keeps the toolbar visible');
 const before=await page.evaluate(()=>{window.grid.destroy();return window.renders;});
 await page.mouse.wheel(0,1000);await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.renders),before,'disposal removes scroll/resize work');
 assert.equal(await page.evaluate(()=>document.documentElement.style.overflowAnchor),'');
 await page.setViewportSize({width:1280,height:900});await page.goto(origin+'/embed');
 const frame=page.frames().find(frame=>frame.url()===origin+'/');await frame.locator('[data-ai-card]').first().waitFor();
 await page.mouse.move(600,650);await page.mouse.wheel(0,2200);
 await frame.waitForFunction(()=>document.querySelector('[data-ai-card]')?.dataset.aiKey!=='C0');
 await frame.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
 await frame.locator('[data-ai-key="C499"]').waitFor();
 assert((await frame.locator('[data-ai-card]').count())<=12);
 assert.deepEqual(errors,[]);
 console.log('PASS 500-company automatic page/iframe scrolling, complete tail/back access, bounded desktop/mobile DOM, source corrections, reading anchors, focus, responsive regrouping and disposal.');
}finally{await browser.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
