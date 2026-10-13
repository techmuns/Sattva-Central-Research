#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  if (path === '/') { res.setHeader('content-type', 'text/html'); res.end('<style>body{margin:0}#scroll{height:400px;width:640px;overflow:auto;scrollbar-gutter:stable}.row{box-sizing:border-box;border-bottom:1px solid #eee}</style><div id="scroll"><div id="content"></div></div>'); return; }
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(file)); } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async () => {
    const { mountWindowedList } = await import('/js/ui/windowed-list.js');
    window.rows = Array.from({ length: 50000 }, (_, i) => ({ id: String(i), height: 43 + i % 5 * 17 }));
    window.scrollBox = document.querySelector('#scroll');
    const row = r => `<div class="row" data-row-key="${r.id}" style="height:${r.height}px">Record ${r.id}</div>`;
    window.list = mountWindowedList({ scroller: scrollBox, content: document.querySelector('#content'), items: rows,
      key: r => r.id, rowSelector: '.row', estimateHeight: 120,
      renderRows: (all, from, to) => all.slice(from, to).map(row).join(''),
      renderParts: (all, from, to) => all.slice(from, to).map(row),
      spacerHtml: (height, where) => `<div data-window-spacer="${where}" style="height:${height}px"></div>` });
    window.held = () => { const top = scrollBox.getBoundingClientRect().top; const el = [...document.querySelectorAll('.row')].find(el => el.getBoundingClientRect().bottom > top); return { key: el?.dataset.rowKey, offset: el?.getBoundingClientRect().top - top }; };
  });
  // Read before any animation frame: initial spacers must already use actual row heights.
  const initial = await page.evaluate(() => ({ natural: [...document.querySelectorAll('.row')].reduce((n, el) => n + el.getBoundingClientRect().height, 0), top: parseFloat(document.querySelector('[data-window-spacer="top"]').style.height), bottom: parseFloat(document.querySelector('[data-window-spacer="bottom"]').style.height), count: document.querySelectorAll('.row').length }));
  assert.equal(initial.top, 0); assert.equal(initial.bottom, (50000 - initial.count) * 120);
  await page.evaluate(() => { scrollBox.scrollTop = 900; scrollBox.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(50);
  const replacements = await page.evaluate(() => {
    const before = held();
    rows = [{ id: 'new', height: 81 }, ...rows.map(row => ({ ...row, height: row.height + 19 }))];
    list.update(rows);
    return { before, after: held() };
  });
  assert.equal(replacements.after.key, replacements.before.key);
  assert(Math.abs(replacements.after.offset - replacements.before.offset) <= 1, 'replacement heights settle in the same task');
  const badge = await page.evaluate(() => {
    const before = held();
    const el = document.querySelector('.row'); el.style.height = `${el.getBoundingClientRect().height + 31}px`;
    list.refresh(); return { before, after: held() };
  });
  assert.equal(badge.after.key, badge.before.key);
  assert(Math.abs(badge.after.offset - badge.before.offset) <= 1);
  const drag = await page.evaluate(() => {
    const box = scrollBox.getBoundingClientRect();
    scrollBox.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: box.right - 2, clientY: box.top + 150 }));
    const height = scrollBox.scrollHeight;
    const before = held();
    const next = [{ id: 'arrival', height: 100 }, ...rows.map(row => ({ ...row, height: row.height + 6 }))];
    list.update(next); rows = next;
    return { before, after: held(), height, during: scrollBox.scrollHeight, arrival: !!document.querySelector('[data-row-key="arrival"]') };
  });
  assert.equal(drag.arrival, false, 'safe additions wait for thumb release');
  assert.equal(drag.after.key, drag.before.key, 'corrections do not reorder the held row mid-drag');
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { button: 0 })));
  await page.waitForTimeout(60);
  const afterDrag = await page.evaluate(() => held());
  assert.equal(afterDrag.key, drag.after.key, 'release retains the actual visible record');
  const removed = await page.evaluate(() => { const id = held().key; rows = rows.filter(row => row.id !== id); list.update(rows); return { present: !!document.querySelector(`[data-row-key="${id}"]`), count: document.querySelectorAll('.row').length, total: rows.length }; });
  assert.equal(removed.present, false); assert(removed.count <= 100); assert.equal(removed.total, 50001);
  await page.evaluate(() => list.destroy());
  // A sticky table header hides part of the mounted window. An arrival between the hidden
  // row and the first readable row must preserve the readable row, even when that insertion
  // leaves the old geometric anchor unchanged. Fixed heights make this deterministic on
  // both overlay-scrollbar and native-gutter browsers.
  const sticky = await page.evaluate(async () => {
    const { mountWindowedList } = await import('/js/ui/windowed-list.js');
    document.body.innerHTML = '<div id="scroll"><table style="border-collapse:collapse;width:100%"><thead style="position:sticky;top:0;background:white"><tr><th style="height:60px;padding:0">Sticky header</th></tr></thead><tbody id="content"></tbody></table></div>';
    const scroller = document.querySelector('#scroll'), content = document.querySelector('#content');
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
    const markup = r => `<tr data-row-key="${r.id}"><td style="height:86px;padding:0">Record ${r.id}</td></tr>`;
    const list = mountWindowedList({ scroller, content, items: rows, key: r => r.id,
      rowSelector: 'tr[data-row-key]', estimateHeight: 86,
      viewportInset: () => scroller.querySelector('thead').offsetHeight,
      renderRows: (all, from, to) => all.slice(from, to).map(markup).join(''),
      renderParts: (all, from, to) => all.slice(from, to).map(markup),
      spacerHtml: (height, where) => `<tr><td data-window-spacer="${where}" style="height:${height}px;padding:0;border:0"></td></tr>` });
    scroller.scrollTop = 900;
    await new Promise(requestAnimationFrame);
    const boundary = () => scroller.getBoundingClientRect().top + scroller.querySelector('thead').offsetHeight;
    const visible = () => [...content.querySelectorAll('tr[data-row-key]')].find(row => row.getBoundingClientRect().bottom > boundary());
    const row = visible(), key = row.dataset.rowKey, before = row.getBoundingClientRect().top - boundary();
    const insertion = rows.findIndex(row => row.id === key);
    list.update([...rows.slice(0, insertion), { id: 'arrival-under-header' }, ...rows.slice(insertion)]);
    const after = [...content.querySelectorAll('tr[data-row-key]')].find(row => row.dataset.rowKey === key).getBoundingClientRect().top - boundary();
    const first = visible().dataset.rowKey;
    list.destroy();
    return { key, first, before, after };
  });
  assert(Math.abs(sticky.after - sticky.before) <= 1, `sticky-header reading row moved ${sticky.after - sticky.before}px`);
  assert.equal(sticky.first, sticky.key, 'an insertion below the sticky header preserves the first readable record');
  assert.deepEqual(errors, []);
  console.log('PASS natural row measurement, replacement anchors, badge changes, thumb-drag additions/corrections, release, immediate removal over 50,000 records and sticky-header reading anchors');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
