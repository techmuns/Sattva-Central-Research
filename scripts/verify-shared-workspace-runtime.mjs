import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join, delimiter, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const location = process.env.WRANGLER_PACKAGE || process.env.PATH.split(delimiter).map(dir => join(dir, 'wrangler')).find(existsSync);
if (!location) throw Error('Set WRANGLER_PACKAGE or use npx --package=wrangler@4.119.0');
const require = createRequire(realpathSync(location)), { Miniflare } = require('miniflare'), { build } = require('esbuild');
const built = await build({ stdin: { contents: `import {handleWorkspace} from './worker/workspace.mjs';export {CaptureRegistry} from './worker/capture-registry-object.mjs';export default {fetch:(r,e)=>handleWorkspace(r,{...e,SHARED_WATCHLIST_LIMITER:{limit:async()=>({success:true})}})};`, resolveDir: resolve('.') }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
const directory = mkdtempSync(join(tmpdir(), 'shared-workspace-runtime-'));
let worker;
const start = async () => {
  worker = new Miniflare({ resourcePersistencePath: directory, workers: [{ name: 'sattva-shared-workspace-test', modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-05-23',
    durableObjects: { SHARED_WATCHLIST: { className: 'CaptureRegistry', useSQLite: true } },
    outboundService: () => { throw Error('Workspace runtime tests must not contact production sources'); } }] });
  await worker.ready;
};
const call = async intent => {
  const response = await worker.dispatchFetch('https://local.test/api/workspace', intent ? { method: 'POST', headers: { origin: 'https://local.test', 'content-type': 'application/json' }, body: JSON.stringify(intent) } : {});
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const tab = { id: 'view-00000000-0000-4000-8000-000000000001', title: 'Capital Raises', source: 'corp-announcements', scope: 'universe', subview: null, params: {}, reading: { extras: { categories: ['capital-raise'], period: '7' } } };
try {
  await start(); assert.equal((await call()).tabs.length, 0);
  await call({ id: 'runtime-create', op: 'put', tab });
  await call({ id: 'runtime-reorder', op: 'move', tabId: tab.id, targetId: 'alerts', after: false });
  await call({ id: 'runtime-columns', op: 'columns-move', table: 'corp-announcements', group: '$', column: '$/Company:0', target: '$/Subject:0', siblings: ['$/Company:0', '$/Subject:0'], after: true });
  await worker.dispose(); await start();
  let snapshot = await call(); assert.equal(snapshot.order[0], tab.id); assert.equal(snapshot.tabs[0].title, 'Capital Raises');
  assert.deepEqual(snapshot.tabs[0].reading.extras.categories, ['capital-raise']);
  assert.deepEqual(snapshot.columnLayouts['corp-announcements'].$, ['$/Subject:0', '$/Company:0'], 'shared columns survive a real Worker restart');
  await call({ id: 'runtime-remove', op: 'remove', tabId: tab.id, expected: snapshot.tabs[0].revision });
  await worker.dispose(); await start();
  snapshot = await call({ id: 'runtime-create', op: 'put', tab });
  assert.equal(snapshot.tabs.length, 0, 'replayed creation cannot resurrect a removed view after Worker restart');
  console.log('PASS shared workspace crosses real Worker RPC/SQLite and keeps definitions, universal order and removals across restarts without touching a live source');
} finally { await worker?.dispose(); rmSync(directory, { recursive: true, force: true }); }
