import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  escapeHtml,
  gridStyles,
  jsonForScript,
  renderDataGridBody,
  renderDataGridPage,
  tableFromStatement,
  type GridViewGrid,
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
    { mode: 'table', grids: [grid], activeIndex: 0, pageIndex: 0, pageCount: 1, totalRows: 2, cost: 'Page size 100' },
    'DataDock - users',
  );

  it('uses one nonce for the CSP, the style and the script', () => {
    // The CSP meta carries `nonce-X`; style/script attributes carry the bare
    // value, so every distinct nonce on the page must be exactly one value.
    const metaNonces = [...page.matchAll(/nonce-([A-Za-z0-9+/=]+)/g)].map((match) => match[1]);
    const attrNonces = [...page.matchAll(/nonce="([A-Za-z0-9+/=]+)"/g)].map((match) => match[1]);
    assert.ok(metaNonces.length >= 1);
    assert.ok(attrNonces.length >= 2);
    assert.deepEqual(new Set([...metaNonces, ...attrNonces]).size, 1);
  });

  it('escapes hostile cell text in the markup', () => {
    // The raw text may only appear inside the JSON data island (safe, escaped
    // for `<`), never as unescaped markup.
    const withoutIsland = page.replace(/var GRIDS = .*;/, '');
    assert.ok(!withoutIsland.includes("Robert'); DROP TABLE"));
    assert.ok(page.includes('Robert&#39;); DROP TABLE users;--'));
  });

  it('renders the full design chrome', () => {
    assert.ok(page.includes('id="export-open"'));
    assert.ok(page.includes('id="export-dialog"'));
    assert.ok(page.includes('id="ctx-menu"'));
    assert.ok(page.includes('id="filter-pop"'));
    assert.ok(page.includes('data-sort-col="id"'));
    assert.ok(page.includes('data-filter-col="name"'));
    assert.ok(page.includes('Total 2'));
  });

  it('marks null cells and keeps the expander gutter', () => {
    assert.ok(page.includes('<td class="null" data-col="name">NULL</td>'));
    assert.ok(page.includes('data-expand="0"'));
  });
});

describe('renderDataGridBody', () => {
  it('reuses the caller nonce instead of minting its own', () => {
    const body = renderDataGridBody({ mode: 'query', grids: [grid], activeIndex: 0 }, 'NONCE123');
    assert.ok(body.includes('nonce="NONCE123"'));
    const nonces = [...body.matchAll(/nonce="([A-Za-z0-9+/=]+)"/g)].map((match) => match[1]);
    assert.deepEqual(new Set(nonces).size, 1);
  });

  it('embeds the grid rows as a data island for the client script', () => {
    const body = renderDataGridBody({ mode: 'query', grids: [grid], activeIndex: 0 }, 'N');
    assert.match(body, /var GRIDS = /);
    assert.ok(body.includes('DROP TABLE users'));
  });

  it('keeps style and script CSP-safe', () => {
    const page = renderDataGridPage({ mode: 'query', grids: [grid], activeIndex: 0 }, 'x');
    assert.ok(gridStyles('probe').includes('<style nonce="probe">'));
    assert.ok(page.includes("default-src 'none'"));
  });

  it('shows the real redacted driver error text in the error box', () => {
    const errorGrid: GridViewGrid = { ...grid, status: 'error', error: 'Unknown column \'age\' in \'field list\' (1054)' };
    const body = renderDataGridBody({ mode: 'query', grids: [errorGrid], activeIndex: 0 }, 'N');
    assert.ok(body.includes('Unknown column &#39;age&#39; in &#39;field list&#39; (1054)'));
    assert.ok(body.includes('class="error-box"'));
    assert.ok(!body.includes('This statement failed'));
  });

  it('shows a fallback only when no driver error text exists', () => {
    const errorGrid: GridViewGrid = { ...grid, status: 'error' };
    const body = renderDataGridBody({ mode: 'query', grids: [errorGrid], activeIndex: 0 }, 'N');
    assert.ok(body.includes('Statement failed.'));
  });

  it('reports mutation results only from real driver data', () => {
    const affected: GridViewGrid = { ...grid, status: 'mutation', rowsAffected: 3, columns: [], rows: [] };
    const body = renderDataGridBody({ mode: 'query', grids: [affected], activeIndex: 0 }, 'N');
    assert.ok(body.includes('Statement executed; 3 row(s) affected.'));
    assert.ok(!body.includes('0 row(s) affected'));
    assert.ok(!body.includes('<table class="grid">'));
  });

  it('never invents an affected-rows count', () => {
    const bare: GridViewGrid = { ...grid, status: 'mutation', columns: [], rows: [] };
    const body = renderDataGridBody({ mode: 'query', grids: [bare], activeIndex: 0 }, 'N');
    assert.ok(body.includes('Statement executed.'));
    assert.ok(!body.includes('row(s) affected'));
  });

  it('marks skipped statements with a note instead of an empty grid', () => {
    const skippedGrid: GridViewGrid = { ...grid, status: 'skipped' };
    const body = renderDataGridBody({ mode: 'query', grids: [skippedGrid], activeIndex: 0 }, 'N');
    assert.ok(body.includes('class="skipped-note"'));
    assert.ok(!body.includes('<table class="grid">'));
  });

  it('shows row numbers in the gutter', () => {
    const body = renderDataGridBody({ mode: 'query', grids: [grid], activeIndex: 0 }, 'N');
    assert.ok(body.includes('<span class="rownum">1</span>'));
    assert.ok(body.includes('<span class="rownum">2</span>'));
  });

  it('does not render dead SQL-runner or row-editing UI', () => {
    const body = renderDataGridBody({ mode: 'query', grids: [grid], activeIndex: 0 }, 'N');
    assert.ok(!body.includes('sql-panel'));
    assert.ok(!body.includes('sql-input'));
    assert.ok(!body.includes('id="run-sql"'));
    assert.ok(!body.includes('insert-btn'));
    assert.ok(!body.includes('delete-btn'));
    assert.ok(!body.includes('full-btn'));
    assert.ok(!body.includes('insert-row'));
    assert.ok(!body.includes('delete-rows'));
  });

  it('labels multi-result-set statements distinctly per set', () => {
    const first: GridViewGrid = { ...grid, id: 's1r0', label: '#1.1' };
    const second: GridViewGrid = { ...grid, id: 's1r1', label: '#1.2' };
    const body = renderDataGridBody({ mode: 'query', grids: [first, second], activeIndex: 0 }, 'N');
    assert.ok(body.includes('#1.1'));
    assert.ok(body.includes('#1.2'));
    assert.ok(body.includes('data-tab="0"'));
    assert.ok(body.includes('data-tab="1"'));
  });
});
