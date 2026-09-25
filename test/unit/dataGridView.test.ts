import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  escapeHtml,
  jsonForScript,
  renderDataGridPage,
  tableFromStatement,
  type DataGridViewOptions,
  type GridViewGrid,
  type ResultViewAssets,
} from '../../src/ui/dataGrid/dataGridView';

const grid: GridViewGrid = {
  id: 's1r0',
  table: 'users',
  label: '#1',
  status: 'ok',
  columns: [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'varchar(255)' },
  ],
  rows: [
    [1, "Robert'); DROP TABLE users;--"],
    [2, null],
  ],
  statementSql: 'SELECT * FROM users',
  reveal: { start: 0, end: 18 },
};

const assets: ResultViewAssets = {
  jsUri: 'https://file+.vscode-resource.vscode-cdn.net/dist-webview/resultApp.js',
  cssUri: 'https://file+.vscode-resource.vscode-cdn.net/dist-webview/resultApp.css',
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
};

describe('tableFromStatement', () => {
  it('extracts the table from FROM and INTO clauses', () => {
    assert.equal(tableFromStatement('SELECT * FROM `order details` LIMIT 10'), 'order details');
    assert.equal(tableFromStatement('select id\n  from sales.orders\n where id = 1'), 'orders');
    assert.equal(tableFromStatement('INSERT INTO users (id) VALUES (1);'), 'users');
    assert.equal(tableFromStatement('UPDATE t SET a = 1'), '');
  });

  it('ignores comments and subquery aliases', () => {
    assert.equal(tableFromStatement('-- from nowhere\nSELECT * FROM real_table'), 'real_table');
  });
});

describe('escapeHtml / jsonForScript', () => {
  it('escapes every HTML-sensitive character', () => {
    assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('makes embedded JSON safe inside a script island', () => {
    const encoded = jsonForScript({ text: '</script><script>alert(1)</script>', sep: 'a\u2028b' });
    assert.ok(!encoded.includes('</script>'));
    assert.ok(!encoded.includes('\u2028'));
    assert.deepEqual(JSON.parse(encoded), { text: '</script><script>alert(1)</script>', sep: 'a\u2028b' });
  });
});

describe('renderDataGridPage', () => {
  const page = renderDataGridPage(
    assets,
    { mode: 'table', grids: [grid], activeIndex: 0, pageIndex: 0, pageSize: 100, pageCount: 1, totalRows: 2, cost: 'Cost: 12ms' },
    'DataDock - users',
  );

  it('uses one nonce for the CSP and the island script', () => {
    const nonces = [...page.matchAll(/nonce="([A-Za-z0-9+/=]+)"/g)].map((match) => match[1]);
    assert.equal(nonces.length, 1);
    const csp = /content="([^"]+)"/.exec(page)?.[1] ?? '';
    assert.ok(csp.includes(`'nonce-${nonces[0]}'`));
  });

  it('keeps the CSP strict: no unsafe or remote sources, no fonts or forms', () => {
    const csp = /content="([^"]+)"/.exec(page)?.[1] ?? '';
    assert.equal(csp.match(/\bunsafe-inline\b|\bunsafe-eval\b/g)?.length ?? 0, 0);
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("font-src 'none'"));
    assert.ok(csp.includes("base-uri 'none'"));
    assert.ok(csp.includes("form-action 'none'"));
    assert.ok(csp.includes(`style-src ${assets.cspSource}`));
    assert.ok(csp.includes(`script-src ${assets.cspSource}`));
    assert.ok(csp.includes(`img-src ${assets.cspSource} data:`));
  });

  it('declares the island before the bundle so data is readable at boot', () => {
    const islandAt = page.indexOf('globalThis.__DATADOCK_RESULT__=');
    const bundleAt = page.indexOf(assets.jsUri);
    assert.ok(islandAt >= 0 && bundleAt > islandAt);
  });

  it('serializes options into a parseable island', () => {
    const match = page.match(/globalThis\.__DATADOCK_RESULT__=(\{[\s\S]*?\});\s*<\/script>/);
    assert.ok(match, 'island not found');
    const parsed = JSON.parse(match[1]) as DataGridViewOptions;
    assert.equal(parsed.mode, 'table');
    assert.equal(parsed.grids.length, 1);
    assert.equal(parsed.grids[0].rows[0][1], "Robert'); DROP TABLE users;--");
    assert.equal(parsed.grids[0].rows[1][1], null);
    assert.equal(parsed.totalRows, 2);
  });

  it('escapes hostile markup inside the island and the title', () => {
    const hostile: GridViewGrid = {
      ...grid,
      rows: [['</script><script>alert(1)</script>']],
    };
    const hostilePage = renderDataGridPage(
      assets,
      { mode: 'query', grids: [hostile], activeIndex: 0 },
      '<img src=x onerror=alert(1)> & "q"',
    );
    assert.ok(!hostilePage.includes('</script><script>alert(1)</script>'));
    assert.ok(!hostilePage.includes('<img src=x'));
    assert.ok(hostilePage.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;'));
    const match = hostilePage.match(/globalThis\.__DATADOCK_RESULT__=(\{[\s\S]*?\});\s*<\/script>/);
    assert.ok(match, 'island not found');
    const parsed = JSON.parse(match[1]) as DataGridViewOptions;
    assert.equal(parsed.grids[0].rows[0][0], '</script><script>alert(1)</script>');
  });
});

describe('resultApp.css invariants', () => {
  // Read the stylesheet from the toolchain sources, not from the compiled
  // bundle, so the guardrails protect the developer as well as the page.
  const css = readFileSync(join(__dirname, '..', '..', '..', 'src', 'ui', 'resultView', 'resultApp.css'), 'utf8');
  // Comments mention the banned techniques; strip them before asserting.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('defines no @font-face (font-src is blocked by the CSP)', () => {
    assert.ok(!/@font-face/.test(stripped));
  });

  it('never fakes icons with pseudo-elements or content glyphs', () => {
    assert.ok(!/::before|::after/.test(stripped));
    assert.ok(!/content\s*:\s*["']/.test(stripped));
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(stripped));
  });

  it('keeps the tab fade transition pure CSS (no host-side JS timers)', () => {
    assert.match(css, /\.dd-fade/);
    assert.match(css, /150ms/);
  });
});