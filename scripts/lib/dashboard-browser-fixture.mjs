// Shared local-only server for the real dashboard shell and committed captures.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function dashboardFixture({ respond } = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (respond?.(url, req, res)) return;
    if (req.method !== 'GET') { res.writeHead(503); res.end('{}'); return; }
    if (url.pathname === '/fixture/table') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main id="fixture"></main><script type="module">
        import { scoreTable } from '/js/ui/screener.js';
        window.records = Array.from({ length: 3000 }, (_, i) => ({ id: String(i), title: 'Record ' + i, value: i,
          detail: i % 9 === 0 ? 'Complete variable-height detail. '.repeat(50) : 'Short detail ' + i }));
        window.renderFixture = () => {
          window.disposeFixture?.();
          window.fixtureTable = scoreTable({ rows: records, key: r => r.id, name: r => r.title, showAvatar: false,
            showRank: false, stickyHead: '500px', searchable: r => r.title + ' ' + r.detail,
            columns: [{ label: 'Value', get: r => r.value }, { label: 'Detail', html: true,
              get: r => '<div style="width:320px;white-space:normal">' + r.detail + '</div>' }],
            initialSort: { key: 'Value', dir: 'asc' }, onExport: rows => window.exportedIds = rows.map(r => r.id) });
          document.querySelector('#fixture').innerHTML = fixtureTable.html;
          window.disposeFixture = fixtureTable.wire(document.querySelector('#fixture'));
        }; renderFixture();
      </script>`); return;
    }
    if (url.pathname === '/embed') {
      // The route the dashboard opens on; a fixed allow-list shape, never markup from the query.
      const route = /^[a-z/-]+\?scope=[a-z]+$/.test(url.searchParams.get('route') || '') ? url.searchParams.get('route') : 'news?scope=portfolio';
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><body style="margin:0;overflow:hidden"><main style="position:fixed;inset:16px 16px 16px 64px;display:flex;flex-direction:column"><header style="height:48px;flex:none">Local performance fixture</header><iframe title="Research dashboard" src="/#/research/${route}" style="flex:1;min-height:0;width:100%;border:0"></iframe></main>`); return;
    }
    const api = { '/api/earnings': 'earnings-live.json', '/api/concalls': 'concall-scans.json',
      '/api/nse-announcements': 'nse-announcements.json', '/api/ipo-filings': 'ipo-filings.json' }[url.pathname];
    let path = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (api) path = resolve(root, 'data', api);
    if (url.pathname === '/fixture/chatter/dashboard') path = resolve(root, '../scripts/fixtures/chatter-dashboard.json');
    if (url.pathname.startsWith('/api/') && !api) { res.writeHead(503); res.end('{}'); return; }
    if (!path.startsWith(root + sep) && !url.pathname.startsWith('/fixture/')) { res.writeHead(403); res.end(); return; }
    try { res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)); }
    catch { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin };
}
