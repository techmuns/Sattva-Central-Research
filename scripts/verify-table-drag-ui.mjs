// Native scrollbar gestures against the shipped table styles and renderer. Local fixtures only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const inlineStyles = readFileSync(resolve(root, 'index.html'), 'utf8').match(/<style>[\s\S]*?<\/style>/g).join('\n');
const baseline = process.env.PERF_BASE_REF;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css">
      ${inlineStyles}<style>main { width:900px; margin:24px; }</style><main id="fixture"></main>
      <script type="module">
      import { scoreTable } from '/js/ui/screener.js';
      window.mount = (mode = 'windowed') => {
        window.dispose?.();
        window.records = Array.from({ length:3000 }, (_, i) => ({ id:String(i), name:'Record ' + i,
          detail:i % 9 === 0 ? 'Variable height evidence. '.repeat(60) : 'Short evidence ' + i }));
        window.table = scoreTable({ rows:records, key:r => r.id, name:r => r.name, showAvatar:false,
          showRank:false, stickyHead:'500px', fillMode:mode, searchable:r => r.name + ' ' + r.detail,
          columns:[{ label:'Evidence', html:true, get:r => '<div style="width:320px;white-space:normal">' + r.detail + '</div>' }],
          onExport:rows => window.exported = rows.map(r => r.id) });
        fixture.innerHTML = table.html; window.dispose = table.wire(fixture);
      };
      mount();
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      window.scrollWrites = [];
      Object.defineProperty(Element.prototype, 'scrollTop', { ...descriptor, set(value) {
        scrollWrites.push(value); descriptor.set.call(this, value);
      }});
      window.ready = true;
      </script>`);
    return;
  }
  const file = resolve(root, '.' + path);
  if (req.method !== 'GET' || !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('content-type', { '.js':'text/javascript', '.css':'text/css', '.json':'application/json' }[extname(file)] || 'text/plain');
    // Keep the corrected CSS while reproducing the old renderer's thumb drift, if requested.
    res.end(baseline && path === '/js/ui/windowed-list.js'
      ? execFileSync('git', ['show', `${baseline}:public${path}`]) : readFileSync(file));
  } catch { res.writeHead(404).end('{}'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath:process.env.CHROME_PATH } : {}),
  ignoreDefaultArgs:['--hide-scrollbars'] });
try {
  const context = await browser.newContext({ viewport:{ width:1200, height:850 }, serviceWorkers:'block' });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/')
    ? route.continue() : route.fulfill({ status:503, body:'{}' }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.ready);
  const frames = () => page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
  });
  await frames();
  const scroller = page.locator('[data-table-scroll]');
  const reading = () => scroller.evaluate(el => {
    const boundary = el.getBoundingClientRect().top + el.querySelector('thead').offsetHeight;
    const row = [...el.querySelectorAll('tr[data-row-key]')].find(row => row.getBoundingClientRect().bottom > boundary);
    return { key:row?.dataset.rowKey, offset:row ? row.getBoundingClientRect().top - boundary : null };
  });
  for (const mode of ['windowed', 'virtual']) {
    await page.evaluate(mode => mount(mode), mode);
    await frames();
    for (const theme of ['light', 'dark']) {
      await page.locator('html').evaluate((el, theme) => el.dataset.theme = theme, theme);
      const box = await scroller.boundingBox();
      const dimensions = await scroller.evaluate(el => ({ width:el.clientWidth, height:el.clientHeight,
        gutter:el.offsetWidth - el.clientWidth, color:getComputedStyle(el).scrollbarColor }));
      assert.equal(dimensions.gutter, 14, 'the actual draggable track is 14px, not an overridden pseudo-element declaration');
      assert.equal(dimensions.color, 'auto', 'the standard colour property does not disable thumb sizing');
      let maxDrift = 0;
      for (const downward of [true, false]) {
        const x = box.x + dimensions.width + dimensions.gutter / 2;
        const y = fraction => box.y + 24 + fraction * (dimensions.height - 48);
        await page.mouse.move(x, y(downward ? 0 : 1));
        await page.mouse.down();
        await page.evaluate(() => scrollWrites = []);
        let previous = downward ? 0 : 1;
        for (let step = 1; step <= 30; step++) {
          const target = downward ? step / 30 : 1 - step / 30;
          await page.mouse.move(x, y(target));
          await frames();
          if (mode === 'windowed' && theme === 'light' && downward && [10, 20].includes(step)) {
            const update = await page.evaluate(step => {
              const row = document.querySelector('tr[data-row-key]');
              const changedKey = row.dataset.rowKey;
              records = [{ id:'arrival-' + step, name:'New arrival ' + step, detail:'Late source evidence' },
                ...records.map(record => ({ ...record, name:record.id === changedKey ? 'Corrected ' + changedKey : record.name }))];
              table.updateData(records);
              return { total:records.length, changedKey };
            }, step);
            await frames();
            assert((await scroller.locator(`tr[data-row-key="${update.changedKey}"]`).innerText()).includes('Corrected'), 'same-ID corrections appear during the drag');
            assert((await page.locator('[data-row-count]').textContent()).includes(String(update.total)), 'incoming records enter the complete model during the drag');
          }
          const state = await scroller.evaluate(el => {
            const box = el.getBoundingClientRect(), head = el.querySelector('thead').getBoundingClientRect();
            const rows = [...el.querySelectorAll('tr[data-row-key]')];
            return { fraction:el.scrollTop / (el.scrollHeight - el.clientHeight), mounted:rows.length,
              visible:rows.some(row => row.getBoundingClientRect().bottom > head.bottom && row.getBoundingClientRect().top < box.bottom),
              writes:scrollWrites.length };
          });
          maxDrift = Math.max(maxDrift, Math.abs(state.fraction - target));
          assert(Math.abs(state.fraction - target) < 0.035, `${mode}/${theme}: thumb follows the pointer (${state.fraction} vs ${target})`);
          assert(downward ? state.fraction >= previous - 0.002 : state.fraction <= previous + 0.002, 'dragging never reverses direction');
          assert(state.visible && state.mounted <= 100, 'every drag step paints a bounded, nonempty row window');
          assert.equal(state.writes, 0, 'row measurements do not write scrollTop during a native drag');
          previous = state.fraction;
        }
        const held = await reading();
        await page.mouse.up();
        await frames();
        const settled = await reading();
        assert.equal(settled.key, held.key, 'releasing the thumb preserves the visible record');
        assert(Math.abs(settled.offset - held.offset) < 2, 'releasing the thumb preserves its reading offset');
        if (downward) assert(await scroller.locator('tr[data-row-key="2999"]').count(), 'drag reaches the final record');
        else {
          assert.equal(await scroller.evaluate(el => el.scrollTop), 0, 'reverse drag reaches the top');
          assert.equal(await scroller.locator('tr[data-row-key]').first().getAttribute('data-row-key'),
            await page.evaluate(() => records[0].id), 'queued arrivals appear automatically after release');
        }
      }
      console.log(`PASS ${mode}/${theme}: native down/up drag, max thumb drift ${(maxDrift * 100).toFixed(2)}%, stable release and full history reachability`);
    }
  }
  await page.locator('[data-export]').click();
  assert.deepEqual(await page.evaluate(() => exported), Array.from({ length:3000 }, (_, i) => String(i)));
  await page.locator('[data-table-search]').fill('Record 2999');
  await page.waitForFunction(() => !document.querySelector('[data-table-loading]') && document.querySelectorAll('tr[data-row-key]').length === 1);
  assert.equal(await page.locator('tr[data-row-key]').getAttribute('data-row-key'), '2999');
  // Overlay scrollbars have no layout gutter. Hide only the visual track to exercise the same
  // real client-box geometry on every CI platform, then dispatch its edge hit explicitly.
  for (const finish of ['pointercancel', 'blur', 'removal']) {
    await page.evaluate(() => mount('windowed'));
    await scroller.evaluate(el => { el.style.scrollbarWidth = 'none'; });
    await frames();
    await scroller.evaluate(el => {
      const box = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, button:0, pointerId:7,
        pointerType:'mouse', clientX:box.right - 6, clientY:box.top + 8 }));
      el.scrollTop = 50000;
      scrollWrites = [];
    });
    await frames();
    assert.equal(await scroller.evaluate(el => el.offsetWidth - el.clientWidth), 0, 'overlay fixture has no gutter');
    assert.equal(await page.evaluate(() => scrollWrites.length), 0, 'overlay-edge drag also defers measurements');
    const held = await reading();
    if (finish === 'removal') {
      await page.evaluate(key => {
        records = records.filter(row => row.id !== key);
        table.updateData(records);
      }, held.key);
      assert.equal(await scroller.locator(`tr[data-row-key="${held.key}"]`).count(), 0, 'revoked rows disappear even while the thumb is held');
    } else {
      await page.evaluate(finish => {
        records = [{ id:'late', name:'Late arrival', detail:'Retained evidence' }, ...records];
        table.updateData(records);
        if (finish === 'blur') window.dispatchEvent(new Event('blur'));
        else document.dispatchEvent(new PointerEvent('pointercancel', { bubbles:true, pointerId:7 }));
      }, finish);
      await frames();
      const settled = await reading();
      assert.equal(settled.key, held.key, `${finish} preserves the visible record`);
      assert(Math.abs(settled.offset - held.offset) < 2, `${finish} preserves the visible offset`);
    }
    await page.locator('[data-export]').click();
    assert.deepEqual(await page.evaluate(() => exported), await page.evaluate(() => records.map(row => row.id)), 'latest arrivals and removals survive gesture cleanup');
  }
  assert.deepEqual(errors, [], 'zero application exceptions');
  console.log('PASS live arrivals/corrections, overlay hit testing, cancellation/blur, immediate removals, complete export and offscreen search');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
