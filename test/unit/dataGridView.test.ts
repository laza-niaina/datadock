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

  it('forwards the compact density flag into the boot island', () => {
    const compactPage = renderDataGridPage(
      assets,
      { mode: 'table', grids: [grid], activeIndex: 0, compact: true },
      'DataDock - users',
    );
    assert.ok(compactPage.includes('"compact":true'));
    assert.ok(!page.includes('"compact":true'));
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

  it('keeps the resize affordance on the library handle (no second system)', () => {
    // umy-table's own `.plx-resizable` element does the dragging; this
    // stylesheet only paints it. The hand-made `.dd-col-resize` span is gone:
    // two resize systems would disagree about which width is authoritative.
    assert.match(css, /\.plx-header--column \.plx-resizable\s*\{/);
    assert.match(css, /cursor:\s*col-resize/);
    assert.ok(!/\.dd-col-resize/.test(stripped));
    assert.ok(!/↔|↕|⇔|⇕|⟷|⟺/.test(css));
  });

  it('styles no invented index column', () => {
    // Result columns are the driver's own; `#`/`index`/`id` are data, and a
    // dedicated green gutter column must not come back through the CSS.
    assert.ok(!/\.col--index/.test(stripped));
  });

  it('takes its palette from the shared token file', () => {
    assert.match(css, /@import '\.\.\/shared\/tokens\.css'/);
    // The token file owns the colours; nothing hard-codes a value here.
    assert.ok(!/#[0-9a-f]{3,6}\b/i.test(stripped.replace(/rgba\(0, 0, 0,[^)]*\)/g, '')));
  });

  it('keeps the executed statement, the cell detail and the NULL style', () => {
    assert.match(css, /\.dd-sql\b/);
    assert.match(css, /\.dd-sql-text\b/);
    assert.match(css, /\.dd-detail\b/);
    assert.match(css, /\.dd-cell-detail\b/);
    assert.match(css, /\.dd-null\s*\{[^}]*color:\s*var\(--dd-muted\)/);
  });

  it('ships no transition rule that no component renders', () => {
    // A dead `.dd-fade` block was the previous state: it described a <transition>
    // the app never rendered. Remounting the grid to animate a tab switch would
    // cost more than it shows, so the rule must stay gone.
    assert.ok(!/\.dd-fade/.test(css));
  });
});

describe('result grid wiring', () => {
  // Source guards: the webview bundle is a template-literal program, so the
  // refactors that must never regress are asserted where they are written.
  const app = readFileSync(join(__dirname, '..', '..', '..', 'src', 'ui', 'resultView', 'resultApp.ts'), 'utf8');
  const viewer = readFileSync(join(__dirname, '..', '..', '..', 'src', 'ui', 'tableViewerPanel.ts'), 'utf8');
  const resultPanel = readFileSync(join(__dirname, '..', '..', '..', 'src', 'ui', 'queryResultPanel.ts'), 'utf8');
  const commands = readFileSync(join(__dirname, '..', '..', '..', 'src', 'commands', 'queryCommands.ts'), 'utf8');

  it('leaves column resizing to umy-table and re-measures through its API', () => {
    assert.match(app, /resizable: true/);
    assert.match(app, /"header-dragend"/);
    assert.match(app, /resetColumn\(true\)/);
    // The hand-made drag system and its stale width channel are gone.
    assert.ok(!/beginResize/.test(app));
    assert.ok(!/dd-col-resize/.test(app));
    assert.ok(!/widths\[this\.grid\.id\]/.test(app));
  });

  it('renders only the columns the driver returned', () => {
    assert.ok(!/type: "index"/.test(app));
    assert.ok(!/col--index/.test(app));
    assert.match(app, /fieldsFor\(/);
  });

  it('gives the grid a keyboard cursor and tears its listeners down', () => {
    assert.match(app, /tabindex: "0"/);
    assert.match(app, /"aria-activedescendant"/);
    assert.match(app, /beforeDestroy\(\)/);
    assert.match(app, /removeEventListener\("keydown", this\.onGlobalKeydown\)/);
    assert.match(app, /removeEventListener\("resize", this\.onWindowResize\)/);
    assert.ok(!/window\.addEventListener\("keydown", \(/.test(app), 'listeners must be named, not inline');
    assert.ok(!/window\.addEventListener\("resize", \(/.test(app), 'listeners must be named, not inline');
  });

  it('labels every icon action and exposes its overlays to assistive tech', () => {
    // Icon-only buttons carry a tooltip and report the state they toggle.
    assert.match(app, /"aria-haspopup": "dialog"/);
    assert.match(app, /"aria-expanded": this\.columnsOpen \? "true" : "false"/);
    assert.match(app, /"aria-pressed": this\.compact \? "true" : "false"/);
    // The three popovers and the cell detail are labelled dialogs, never
    // anonymous divs a screen reader would skip.
    assert.ok((app.match(/role: "dialog"/g) ?? []).length >= 4);
    assert.match(app, /"aria-label": "Columns"/);
    assert.match(app, /"aria-label": "Export Format"/);
    assert.match(app, /"aria-label": `Filter:/);
    // Loading and error states are announced rather than painted silently.
    assert.match(app, /role: "status"/);
    assert.match(app, /"aria-busy"/);
  });

  it('paints table-viewer failures as a banner over the kept grid', () => {
    // A bare `<h1>` page loses the toolbar, the pager and the VS Code chrome.
    assert.ok(!/<h1>/.test(viewer));
    assert.ok(!/escapeHtml/.test(viewer));
    assert.ok(!/randomBytes/.test(viewer));
    assert.match(viewer, /error: this\.error/);
    // Two requests in flight must not paint in the wrong order.
    assert.match(viewer, /sequence !== this\.sequence/);
    // And the page must not be reloaded from the webview's own `ready`.
    assert.match(viewer, /this\.page === undefined && this\.error === undefined/);
  });

  it('marks declared keys with a drawn icon rather than a glyph', () => {
    // Both grids get the marks: the table viewer knows its relation outright,
    // and a query result resolves the relation the statement reads.
    assert.match(viewer, /primaryKey: column\.isPrimaryKey/);
    assert.match(viewer, /foreignKey: column\.isForeignKey/);
    assert.match(app, /keyMarkVNodes\(h, field\)/);
    assert.match(app, /iconKeyMark\(\)/);
    assert.match(app, /iconHashtagMark\(\)/);
    // The mark is an image with a name, so the shape is not the only channel.
    assert.match(app, /role: "img"/);
    assert.match(app, /"aria-label": label/);
    // Never the `#` character, never a pseudo-element, never an emoji: those
    // would either impersonate a real column named `#` or breach the CSS rule.
    assert.ok(!/dd-col-mark[^}]*content:/.test(app));
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(app));
  });

  it('resolves a query result\'s keys without ever failing the batch', () => {
    // A result set carries only names and types, so the flags come from a
    // catalog lookup keyed by the statement's own table.
    assert.match(resultPanel, /columnKeys\?\.\[table\]/);
    assert.match(resultPanel, /readonly columnKeys\?: ColumnKeyMap/);
    assert.match(commands, /async function resolveColumnKeys/);
    assert.match(commands, /await resolveColumnKeys\(/);
    // Every lookup is best-effort: metadata is decoration on an already
    // successful run, so a failing or unlocatable relation is swallowed.
    assert.match(commands, /catch \{\s*\n\s*continue;/);
    assert.match(commands, /return \{\};/);
  });

  it('relabels the library sort carets instead of showing its own wording', () => {
    // The two carets that actually sort are umy-table's markup, and its
    // template ships their tooltips in Chinese. They are relabelled after
    // render rather than removed: the click handler that sorts lives on them.
    assert.match(app, /labelSortHandles\(\): number/);
    assert.match(app, /classList\.contains\("plx-sort--asc-btn"\)/);
    assert.match(app, /Sort ascending: lowest to highest/);
    assert.match(app, /Sort descending: highest to lowest/);
    // The selection column's header toggle is the library's markup too, and
    // carries the same Chinese wording; it is rewritten in the same pass.
    assert.match(app, /SELECT_ALL_TITLE = "Select or clear all rows"/);
    assert.match(app, /\.plx-table--header \.plx-cell--checkbox/);
    // The carets appear one flush after mount, so the walk is retried from
    // `updated` until it has found one, and then costs a boolean check.
    assert.match(app, /updated\(\): void \{\s*\n\s*if \(!this\.sortHandlesLabelled\)/);
    assert.match(app, /this\.sortHandlesLabelled = handles\.length > 0;/);
    assert.match(app, /this\.labelSortHandles\(\)/);
    assert.match(app, /activeFields\(\): void \{\s*\n\s*this\.sortHandlesLabelled = false;\s*\n\s*this\.\$nextTick\(\(\) => this\.labelSortHandles\(\)\);/);
    // No CJK text may be left anywhere in the app source.
    assert.ok(!/[\u4e00-\u9fff]/.test(app));
  });
});